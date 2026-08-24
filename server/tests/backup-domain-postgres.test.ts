import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool, type Pool as PoolType } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { AppError } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresBackupRepository } from '../src/modules/backup/repository.js';
import { BackupService } from '../src/modules/backup/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

function actorWith(role: 'ADMIN' | 'MANAGER' | 'STAFF', organizationId: string, id: string): SafeUser {
  return {
    id,
    organizationId,
    name: 'Backup Actor',
    email: `actor-${id}@test.local`,
    role,
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

async function createOrganizationAndAdmin(pool: PoolType, label: string) {
  const organization = await pool.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [label],
  );
  const organizationId = organization.rows[0]!.id;
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'test-hash', 'ADMIN') RETURNING id`,
    [organizationId, `${label} Admin`, `${randomUUID()}@test.local`],
  );
  return { organizationId, adminId: admin.rows[0]!.id };
}

async function expectAppError(promise: Promise<unknown>, code: string, statusCode: number) {
  await expect(promise).rejects.toMatchObject({ code, statusCode });
}

describe.skipIf(!databaseUrl)('Backup domain PostgreSQL integration', () => {
  const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  let pool: PoolType | null = null;
  let repository: PostgresBackupRepository | null = null;
  let service: BackupService | null = null;
  let organizationId = '';
  let adminId = '';
  let managerActor: SafeUser;
  let staffActor: SafeUser;
  let adminActor: SafeUser;
  const schema = `bak_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!adminPool) return;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
    });
    repository = new PostgresBackupRepository(pool);
    let clock = new Date('2026-08-22T10:00:00Z').getTime();
    service = new BackupService(repository, () => new Date((clock += 1_000)));

    const fixture = await createOrganizationAndAdmin(pool, 'Backup Domain Org');
    organizationId = fixture.organizationId;
    adminId = fixture.adminId;
    adminActor = actorWith('ADMIN', organizationId, adminId);
    managerActor = actorWith('MANAGER', organizationId, randomUUID());
    staffActor = actorWith('STAFF', organizationId, randomUUID());
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('migration applies and seeds singletons', async () => {
    const version = await pool!.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
    expect(version.rows[0]!.version).toBe('034_demo_data_foundation');

    const policyCount = await pool!.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM backup_policy',
    );
    expect(policyCount.rows[0]!.count).toBe(1);
    const storage = await pool!.query<{ prefix: string; enabled: boolean; provider: string }>(
      'SELECT prefix, enabled, provider FROM backup_storage',
    );
    expect(storage.rows[0]).toMatchObject({ prefix: 'production/', enabled: false, provider: 'CLOUDFLARE_R2' });
  });

  it('backup domain tables are installation-scoped (no organization_id)', async () => {
    const columns = await pool!.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = $1 AND column_name = 'organization_id'
          AND table_name IN ('backup_runs', 'backup_policy', 'backup_storage', 'restore_runs')`,
      [schema],
    );
    expect(columns.rows).toEqual([]);
  });

  it('rejects invalid enum values and enforces failure/warning invariants', async () => {
    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_at)
       VALUES ($1, 'PAUSED', 'SCHEDULED', 'DATABASE', 'DAILY', NOW())`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, phase, origin, scope, retention_class, created_at)
       VALUES ($1, 'QUEUED', 'TEA_BREAK', 'SCHEDULED', 'DATABASE', 'DAILY', NOW())`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_by, created_at, failure_code)
       VALUES ($1, 'SUCCESS', 'MANUAL', 'DATABASE', 'MANUAL', $2, NOW(), 'PG_DUMP_FAILED')`,
      [randomUUID(), adminId],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_at, failure_code)
       VALUES ($1, 'FAILED', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NULL)`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_by, created_at, completed_at, warning_code, warning_summary)
       VALUES ($1, 'SUCCESS', 'MANUAL', 'DATABASE', 'MANUAL', $2, NOW(), NOW(), 'CLEANUP_FAILED', 'geçici dizin silinemedi')`,
      [randomUUID(), adminId],
    )).resolves.toBeDefined();

    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_by, created_at, completed_at, warning_code)
       VALUES ($1, 'FAILED', 'SCHEDULED', 'DATABASE', 'DAILY', $2, NOW(), NOW(), 'CLEANUP_FAILED')`,
      [randomUUID(), adminId],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects malformed sha256, negative sizes, and non-terminal incoherence', async () => {
    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_at, completed_at, sha256)
       VALUES ($1, 'SUCCESS', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NOW(), 'ABC')`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_at, completed_at, size_bytes)
       VALUES ($1, 'SUCCESS', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NOW(), -1)`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_at)
       VALUES ($1, 'CANCELLED', 'SCHEDULED', 'DATABASE', 'DAILY', NOW())`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_at, verified_at)
       VALUES ($1, 'FAILED', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NOW())`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces max one active run via the partial unique index', async () => {
    const queued = randomUUID();
    await pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_at)
       VALUES ($1, 'QUEUED', 'SCHEDULED', 'DATABASE', 'DAILY', NOW())`,
      [queued],
    );
    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_by, created_at)
       VALUES ($1, 'QUEUED', 'MANUAL', 'DATABASE', 'MANUAL', $2, NOW())`,
      [randomUUID(), adminId],
    )).rejects.toMatchObject({ code: '23505', constraint: 'backup_runs_single_active_unique' });
    await expect(pool!.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_at, started_at, phase)
       VALUES ($1, 'RUNNING', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NOW(), 'PREFLIGHT')`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23505', constraint: 'backup_runs_single_active_unique' });

    await pool!.query(`UPDATE backup_runs SET status = 'CANCELLED', completed_at = NOW() WHERE id = $1`, [queued]);
    const next = await pool!.query<{ id: string }>(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_by, created_at)
       VALUES ($1, 'QUEUED', 'MANUAL', 'DATABASE', 'MANUAL', $2, NOW()) RETURNING id`,
      [randomUUID(), adminId],
    );
    expect(next.rows).toHaveLength(1);
    await pool!.query(`UPDATE backup_runs SET status = 'CANCELLED', completed_at = NOW() WHERE id = $1`, [next.rows[0]!.id]);
  });

  it('restore runs: nullable DR backup id, name-only target database, single running', async () => {
    const created = await repository!.createRestoreRun({
      id: randomUUID(),
      backupId: null,
      mode: 'DISASTER_RECOVERY',
      initiatedBy: 'operator@recovery-host',
      targetDatabase: 'servora_restore_target_1',
      preRestoreBackupId: null,
    });
    expect(created.status).toBe('RUNNING');
    expect(created.backupId).toBeNull();

    await expect(pool!.query(
      `INSERT INTO restore_runs (id, mode, status, initiated_by, target_database)
       VALUES ($1, 'REHEARSAL', 'RUNNING', 'op', 'postgres://nope/db')`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(pool!.query(
      `INSERT INTO restore_runs (id, mode, status, initiated_by, target_database)
       VALUES ($1, 'REHEARSAL', 'RUNNING', 'op', 'another_target')`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23505', constraint: 'restore_runs_single_running_unique' });

    await pool!.query(`UPDATE restore_runs SET status = 'CANCELLED', completed_at = NOW() WHERE id = $1`, [created.id]);
  });

  it('manual request creates a QUEUED/MANUAL run atomically with its audit event', async () => {
    const created = await service!.requestManualBackup(adminActor, { clientActionId: 'manual-create-1' });
    expect(created).toMatchObject({
      status: 'QUEUED',
      origin: 'MANUAL',
      retentionClass: 'MANUAL',
      scope: 'DATABASE',
      createdBy: adminId,
      failureCode: null,
      sha256: null,
      verifiedAt: null,
    });

    const audit = await pool!.query<{ event_type: string; metadata: Record<string, unknown> }>(
      `SELECT event_type, metadata FROM audit_events
        WHERE subject_type = 'BACKUP_RUN' AND subject_id = $1 AND event_type = 'BACKUP_REQUESTED'`,
      [created.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      backupId: created.id,
      scope: 'DATABASE',
      origin: 'MANUAL',
      retentionClass: 'MANUAL',
      status: 'QUEUED',
    });
    expect(Object.keys(audit.rows[0]!.metadata).sort()).toEqual(
      ['backupId', 'origin', 'retentionClass', 'scope', 'status'],
    );

    await pool!.query(`UPDATE backup_runs SET status = 'CANCELLED', completed_at = NOW() WHERE id = $1`, [created.id]);
  });

  it('conflicts while a backup or restore is active', async () => {
    const active = await service!.requestManualBackup(adminActor, { clientActionId: 'manual-active' });
    await expectAppError(
      service!.requestManualBackup(adminActor, { clientActionId: 'manual-conflict' }),
      'BACKUP_RUN_ACTIVE',
      409,
    );
    await service!.markCancelled(active.id);

    const restore = await repository!.createRestoreRun({
      id: randomUUID(),
      backupId: null,
      mode: 'REHEARSAL',
      initiatedBy: 'op',
      targetDatabase: 'rehearsal_target',
      preRestoreBackupId: null,
    });
    await expectAppError(
      service!.requestManualBackup(adminActor, { clientActionId: 'manual-restore-conflict' }),
      'RESTORE_IN_PROGRESS',
      409,
    );
    await pool!.query(`UPDATE restore_runs SET status = 'CANCELLED', completed_at = NOW() WHERE id = $1`, [restore.id]);
  });

  it('two truly concurrent requests cannot create two active runs', async () => {
    const results = await Promise.allSettled([
      service!.requestManualBackup(adminActor, { clientActionId: 'race-a' }),
      service!.requestManualBackup(adminActor, { clientActionId: 'race-b' }),
    ]);
    const statuses = results.map((result) => (result.status === 'fulfilled' ? 'ok' : (result.reason as AppError).code));
    const okCount = statuses.filter((value) => value === 'ok').length;
    const conflictCount = statuses.filter((value) => value === 'BACKUP_RUN_ACTIVE').length;
    expect(okCount).toBe(1);
    expect(conflictCount).toBe(1);

    const active = await repository!.findActiveBackupRun();
    expect(active).not.toBeNull();
    await service!.markCancelled(active!.id);
  });

  it('idempotent replay returns the original run without duplicating', async () => {
    const first = await service!.requestManualBackup(adminActor, { clientActionId: 'replay-1' });
    const second = await service!.requestManualBackup(adminActor, { clientActionId: 'replay-1' });
    expect(second.id).toBe(first.id);

    const runs = await pool!.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM backup_runs WHERE created_by = $1 AND origin = 'MANUAL' AND id = $2`,
      [adminId, first.id],
    );
    expect(runs.rows[0]!.count).toBe(1);
    await service!.markCancelled(first.id);
  });

  it('MANAGER and STAFF are denied on every service surface (backend RBAC)', async () => {
    for (const denied of [managerActor, staffActor]) {
      await expectAppError(service!.requestManualBackup(denied, { clientActionId: 'x' }), 'FORBIDDEN', 403);
      await expectAppError(service!.listRuns(denied, { limit: 20, cursor: null }), 'FORBIDDEN', 403);
      await expectAppError(service!.getRun(denied, randomUUID()), 'FORBIDDEN', 403);
      await expectAppError(service!.getPolicy(denied), 'FORBIDDEN', 403);
      await expectAppError(
        service!.updatePolicy(denied, {
          enabled: false, scheduleTimeLocal: '02:30', timezone: 'UTC',
          dailyRetention: 7, weeklyRetention: 4, monthlyRetention: 6, defaultScope: 'DATABASE',
        }),
        'FORBIDDEN',
        403,
      );
      await expectAppError(service!.getStorageState(denied), 'FORBIDDEN', 403);
    }
  });

  it('state machine: valid transitions, linear phases, terminal protection', async () => {
    const run = await service!.requestManualBackup(adminActor, { clientActionId: 'sm-1' });

    const started = await service!.startRun(run.id);
    expect(started).toMatchObject({ status: 'RUNNING', phase: 'PREFLIGHT', startedAt: expect.any(Date) });

    // DATABASE scope: FILES_ARCHIVE is not required and may be skipped.
    await service!.advancePhase(run.id, 'DATABASE_DUMP', false);
    await service!.advancePhase(run.id, 'MANIFEST', false);
    // Same-phase re-entry is a retry, not a violation.
    await service!.advancePhase(run.id, 'MANIFEST', false);
    // Backward transition is rejected.
    await expectAppError(service!.advancePhase(run.id, 'DATABASE_DUMP', false), 'BACKUP_INVALID_TRANSITION', 409);
    // Skipping non-FILES_ARCHIVE phases is rejected.
    await expectAppError(service!.advancePhase(run.id, 'REMOTE_VERIFY', false), 'BACKUP_INVALID_TRANSITION', 409);

    for (const phase of ['CHECKSUM', 'PACKAGE', 'ENCRYPT', 'UPLOAD'] as const) {
      await service!.advancePhase(run.id, phase, false);
    }

    // Verification evidence is only accepted at REMOTE_VERIFY — not earlier.
    const sha256 = 'a'.repeat(64);
    await expectAppError(
      service!.recordVerification(run.id, { remoteKey: `production/inst/v1/manual/${run.id}.sbk.age`, sizeBytes: 1024, sha256 }),
      'BACKUP_INVALID_TRANSITION',
      409,
    );
    await service!.advancePhase(run.id, 'REMOTE_VERIFY', false);
    const verifiedRun = await service!.recordVerification(run.id, {
      remoteKey: `production/inst/v1/manual/${run.id}.sbk.age`,
      sizeBytes: 1024,
      sha256,
    });
    expect(verifiedRun).toMatchObject({ status: 'RUNNING', sha256, verifiedAt: null, completedAt: null });

    await service!.advancePhase(run.id, 'CLEANUP', false);

    const completed = await service!.completeRun(run.id);
    expect(completed).toMatchObject({
      status: 'SUCCESS',
      sha256,
      verifiedAt: expect.any(Date),
      completedAt: expect.any(Date),
      failureCode: null,
      warningCode: null,
    });

    // Terminal states never return to RUNNING; SUCCESS never carries failure codes.
    await expectAppError(service!.startRun(run.id), 'BACKUP_INVALID_TRANSITION', 409);
    await expectAppError(service!.markFailed(run.id, 'PG_DUMP_FAILED', 'dump failed'), 'BACKUP_INVALID_TRANSITION', 409);

    // Warning semantics: SUCCESS keeps its verified restore point.
    const warned = await service!.markCleanupWarning(run.id, 'geçici dizin silinemedi');
    expect(warned).toMatchObject({ status: 'SUCCESS', warningCode: 'CLEANUP_FAILED', sha256 });
  });

  it('B2: canonical REMOTE_VERIFY → CLEANUP → SUCCESS with cleanup-warning branch', async () => {
    const run = await service!.requestManualBackup(adminActor, { clientActionId: 'sm-clean-warn' });
    await service!.startRun(run.id);
    for (const phase of ['DATABASE_DUMP', 'MANIFEST', 'CHECKSUM', 'PACKAGE', 'ENCRYPT', 'UPLOAD'] as const) {
      await service!.advancePhase(run.id, phase, false);
    }
    // Direct SUCCESS from REMOTE_VERIFY (CLEANUP not processed) is rejected.
    await service!.advancePhase(run.id, 'REMOTE_VERIFY', false);
    await service!.recordVerification(run.id, {
      remoteKey: `production/inst/v1/manual/${run.id}.sbk.age`,
      sizeBytes: 2048,
      sha256: 'b'.repeat(64),
    });
    await expectAppError(service!.completeRun(run.id), 'BACKUP_INVALID_TRANSITION', 409);

    // CLEANUP runs, then terminal transition may carry the cleanup warning.
    await service!.advancePhase(run.id, 'CLEANUP', false);
    const completed = await service!.completeRun(run.id, { cleanupWarning: 'geçici dizin silinemedi' });
    expect(completed).toMatchObject({
      status: 'SUCCESS',
      sha256: 'b'.repeat(64),
      verifiedAt: expect.any(Date),
      warningCode: 'CLEANUP_FAILED',
      failureCode: null,
    });
  });

  it('B2: completing without verification evidence is rejected', async () => {
    const run = await service!.requestManualBackup(adminActor, { clientActionId: 'sm-no-verify' });
    await service!.startRun(run.id);
    for (const phase of ['DATABASE_DUMP', 'MANIFEST', 'CHECKSUM', 'PACKAGE', 'ENCRYPT', 'UPLOAD', 'REMOTE_VERIFY', 'CLEANUP'] as const) {
      await service!.advancePhase(run.id, phase, false);
    }
    await expectAppError(service!.completeRun(run.id), 'BACKUP_INVALID_TRANSITION', 409);
    await service!.markFailed(run.id, 'REMOTE_CHECKSUM_MISMATCH', 'uzaktan doğrulama başarısız');
  });

  it('B1: FILES_ARCHIVE requirement is execution context, not scope alone', async () => {
    // FULL_DATA with configured persistent files: FILES_ARCHIVE is required.
    const required = await service!.requestManualBackup(adminActor, { clientActionId: 'sm-full-required', scope: 'FULL_DATA' });
    await service!.startRun(required.id);
    await service!.advancePhase(required.id, 'DATABASE_DUMP', true);
    await expectAppError(service!.advancePhase(required.id, 'MANIFEST', true), 'BACKUP_INVALID_TRANSITION', 409);
    await service!.advancePhase(required.id, 'FILES_ARCHIVE', true);
    await service!.advancePhase(required.id, 'MANIFEST', true);
    await service!.markFailed(required.id, 'PG_DUMP_FAILED', 'test sonlandırma');

    // FULL_DATA WITHOUT configured persistent files: FILES_ARCHIVE is skipped.
    const skipped = await service!.requestManualBackup(adminActor, { clientActionId: 'sm-full-skip', scope: 'FULL_DATA' });
    await service!.startRun(skipped.id);
    await service!.advancePhase(skipped.id, 'DATABASE_DUMP', false);
    await service!.advancePhase(skipped.id, 'MANIFEST', false);
    await service!.markCancelled(skipped.id);
  });

  it('state machine: failure paths keep invariants', async () => {
    const run = await service!.requestManualBackup(adminActor, { clientActionId: 'sm-fail' });
    await service!.startRun(run.id);
    await service!.advancePhase(run.id, 'DATABASE_DUMP', false);

    const failed = await service!.markFailed(run.id, 'PG_DUMP_FAILED', 'pg_dump sağlıklı dump üretemedi');
    expect(failed).toMatchObject({
      status: 'FAILED',
      failureCode: 'PG_DUMP_FAILED',
      completedAt: expect.any(Date),
      warningCode: null,
    });
    await expectAppError(service!.markCleanupWarning(run.id, 'x'), 'BACKUP_INVALID_TRANSITION', 409);
    await expectAppError(service!.markCancelled(run.id), 'BACKUP_INVALID_TRANSITION', 409);
  });

  it('idempotency namespace does not block sequential distinct requests from the same admin', async () => {
    const first = await service!.requestManualBackup(adminActor, { clientActionId: 'seq-A' });
    await service!.markCancelled(first.id);
    const second = await service!.requestManualBackup(adminActor, { clientActionId: 'seq-B' });
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ status: 'QUEUED', createdBy: adminId });
    await service!.markCancelled(second.id);
  });

  it('policy: seeded defaults, validated updates, audit event, malformed rejection', async () => {
    const seeded = await service!.getPolicy(adminActor);
    expect(seeded).toMatchObject({
      enabled: false,
      scheduleTimeLocal: '02:30',
      timezone: 'UTC',
      dailyRetention: 7,
      weeklyRetention: 4,
      monthlyRetention: 6,
      defaultScope: 'DATABASE',
    });

    const updated = await service!.updatePolicy(adminActor, {
      enabled: true,
      scheduleTimeLocal: '03:15',
      timezone: 'Europe/Istanbul',
      dailyRetention: 7,
      weeklyRetention: 4,
      monthlyRetention: 6,
      defaultScope: 'FULL_DATA',
    });
    expect(updated).toMatchObject({ enabled: true, scheduleTimeLocal: '03:15', timezone: 'Europe/Istanbul', defaultScope: 'FULL_DATA', updatedBy: adminId });

    const audit = await pool!.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE subject_type = 'BACKUP_POLICY' AND event_type = 'BACKUP_POLICY_UPDATED'`,
    );
    expect(audit.rows).toHaveLength(1);

    const base = {
      enabled: true, scheduleTimeLocal: '03:15', timezone: 'Europe/Istanbul',
      dailyRetention: 7, weeklyRetention: 4, monthlyRetention: 6, defaultScope: 'DATABASE' as const,
    };
    await expectAppError(service!.updatePolicy(adminActor, { ...base, scheduleTimeLocal: '25:00' }), 'VALIDATION_ERROR', 400);
    await expectAppError(service!.updatePolicy(adminActor, { ...base, timezone: 'Not/AZone' }), 'VALIDATION_ERROR', 400);
    await expectAppError(service!.updatePolicy(adminActor, { ...base, dailyRetention: 0 }), 'VALIDATION_ERROR', 400);
    await expectAppError(service!.updatePolicy(adminActor, { ...base, weeklyRetention: 53 }), 'VALIDATION_ERROR', 400);
    await expectAppError(service!.updatePolicy(adminActor, { ...base, monthlyRetention: 121 }), 'VALIDATION_ERROR', 400);
    await expectAppError(service!.updatePolicy(adminActor, { ...base, defaultScope: 'WHATEVER' as never }), 'VALIDATION_ERROR', 400);
  });

  it('storage state exposes safe configuration only', async () => {
    const state = await service!.getStorageState(adminActor);
    expect(state).toMatchObject({ provider: 'CLOUDFLARE_R2', bucketAlias: null, prefix: 'production/', enabled: false });
    expect(Object.keys(state).sort()).toEqual(
      ['bucketAlias', 'enabled', 'lastConnectionTestAt', 'lastConnectionTestOk', 'prefix', 'provider'],
    );
  });

  it('history pagination: stable ordering, cursor continuation, no gaps or duplicates', async () => {
    const created: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const run = await service!.requestManualBackup(adminActor, { clientActionId: `page-${index}` });
      created.push(run.id);
      await service!.markCancelled(run.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await service!.listRuns(adminActor, { limit: 2, cursor: cursor ? decodeCursorValue(cursor) : null });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ? encodeCursorValue(page.nextCursor) : null;
    } while (cursor);

    const groundTruth = await pool!.query<{ id: string; created_at: Date }>(
      'SELECT id, created_at FROM backup_runs ORDER BY created_at DESC, id DESC',
    );
    expect(seen).toEqual(groundTruth.rows.map((row) => row.id));
    expect(new Set(seen).size).toBe(seen.length);
    // Cursor walk is strictly newest-first: created_at never increases.
    const timestamps = groundTruth.rows.map((row) => row.created_at.getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it('getRun: uuid validation and unknown ids resolve to 404', async () => {
    await expectAppError(service!.getRun(adminActor, 'not-a-uuid'), 'BACKUP_NOT_FOUND', 404);
    await expectAppError(service!.getRun(adminActor, randomUUID()), 'BACKUP_NOT_FOUND', 404);
  });
});

function encodeCursorValue(cursor: { createdAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id })).toString('base64url');
}

function decodeCursorValue(value: string): { createdAt: Date; id: string } {
  const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt: string; id: string };
  return { createdAt: new Date(parsed.createdAt), id: parsed.id };
}
