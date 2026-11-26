import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresBackupRepository } from '../src/modules/backup/repository.js';
import { BackupService } from '../src/modules/backup/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

type AuditEventType = 'BACKUP_STARTED' | 'BACKUP_FAILED' | 'BACKUP_COMPLETED';
type RunPhase = 'PREFLIGHT' | 'DATABASE_DUMP' | 'PACKAGE' | 'CLEANUP';

type AuditRow = {
  event_type: string;
  subject_type: string;
  organization_id: string | null;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
};

/**
 * BR5 audit atomicity: every worker-driven transition must commit together
 * with its SYSTEM audit row. Fault injection proves the transition rolls back
 * when the audit INSERT fails; the happy paths prove one row per event with
 * the unchanged metadata shape.
 */
describe.skipIf(!databaseUrl)('BR5 backup worker audit atomicity', () => {
  const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  let pool: Pool;
  let repository: PostgresBackupRepository;
  let service: BackupService;
  const schema = `br5_audit_${randomUUID().replaceAll('-', '')}`;
  const triggerName = 'inject_audit_failure';

  beforeAll(async () => {
    if (!adminPool) return;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
    });
    repository = new PostgresBackupRepository(pool);
    service = new BackupService(repository);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  beforeEach(async () => {
    // Each test owns the schema; the single-active-run index requires the
    // previous fixture to be gone before the next one starts.
    await pool.query('DELETE FROM audit_events');
    await pool.query('DELETE FROM backup_runs');
  });

  async function insertQueuedRun(id: string): Promise<void> {
    await pool.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_at)
       VALUES ($1, 'QUEUED', 'SCHEDULED', 'DATABASE', 'DAILY', NOW())`,
      [id],
    );
  }

  async function insertRunningRun(input: {
    id: string;
    phase: RunPhase;
    leaseToken: string;
    leaseUntil?: Date;
  }): Promise<void> {
    const proven = input.phase === 'CLEANUP';
    await pool.query(
      `INSERT INTO backup_runs
         (id, status, phase, origin, scope, retention_class, created_at, started_at,
          remote_key, size_bytes, sha256, lease_token, lease_until, heartbeat_at)
       VALUES ($1, 'RUNNING', $2, 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NOW(),
               $3, $4, $5, $6, $7, NOW())`,
      [
        input.id,
        input.phase,
        proven ? `production/test/v1/daily/${input.id}.sbk.age` : null,
        proven ? 123 : null,
        proven ? 'a'.repeat(64) : null,
        input.leaseToken,
        input.leaseUntil ?? new Date(Date.now() + 60_000),
      ],
    );
  }

  function auditEvents(runId: string) {
    return pool.query<AuditRow>(
      `SELECT event_type, subject_type, organization_id, actor_user_id, metadata
         FROM audit_events
        WHERE subject_type = 'BACKUP_RUN' AND subject_id = $1
        ORDER BY created_at, event_type`,
      [runId],
    );
  }

  function runRow(runId: string) {
    return pool.query<{
      status: string;
      phase: string | null;
      lease_token: string | null;
      verified_at: Date | null;
      failure_code: string | null;
      started_at: Date | null;
    }>(
      `SELECT status, phase, lease_token, verified_at, failure_code, started_at
         FROM backup_runs WHERE id = $1`,
      [runId],
    );
  }

  async function installAuditFailureTrigger(eventType: AuditEventType): Promise<void> {
    await pool.query(
      `CREATE OR REPLACE FUNCTION ${schema}.inject_audit_failure() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.event_type = TG_ARGV[0] THEN
           RAISE EXCEPTION 'injected audit failure for %', NEW.event_type;
         END IF;
         RETURN NEW;
       END;
       $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_events
         FOR EACH ROW EXECUTE FUNCTION ${schema}.inject_audit_failure('${eventType}')`,
    );
  }

  async function dropAuditFailureTrigger(): Promise<void> {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_events`);
  }

  it('commits the QUEUED -> RUNNING claim with exactly one BACKUP_STARTED', async () => {
    const runId = randomUUID();
    await insertQueuedRun(runId);
    const claim = await repository.claimNextRun(
      new Date(),
      randomUUID(),
      new Date(Date.now() + 60_000),
    );
    expect(claim?.run).toMatchObject({ id: runId, status: 'RUNNING', phase: 'PREFLIGHT' });

    const audits = await auditEvents(runId);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({
      event_type: 'BACKUP_STARTED',
      subject_type: 'BACKUP_RUN',
      organization_id: null,
      actor_user_id: null,
    });
    expect(audits.rows[0]!.metadata).toEqual({
      origin: 'SCHEDULED',
      scope: 'DATABASE',
      retentionClass: 'DAILY',
      phase: 'PREFLIGHT',
      actorType: 'SYSTEM',
      backupId: runId,
    });
  });

  it('rolls the claim back when BACKUP_STARTED cannot be written', async () => {
    const runId = randomUUID();
    await insertQueuedRun(runId);
    await installAuditFailureTrigger('BACKUP_STARTED');
    try {
      await expect(
        repository.claimNextRun(new Date(), randomUUID(), new Date(Date.now() + 60_000)),
      ).rejects.toThrow(/injected audit failure/);
    } finally {
      await dropAuditFailureTrigger();
    }

    const row = await runRow(runId);
    expect(row.rows[0]).toMatchObject({ status: 'QUEUED', phase: null, lease_token: null, started_at: null });
    expect((await auditEvents(runId)).rows).toHaveLength(0);
  });

  it('reclaims an expired CLEANUP run without duplicating BACKUP_STARTED', async () => {
    const runId = randomUUID();
    await insertRunningRun({
      id: runId,
      phase: 'CLEANUP',
      leaseToken: randomUUID(),
      leaseUntil: new Date(Date.now() - 60_000),
    });

    const first = await repository.claimExpiredCleanupRun(
      new Date(),
      randomUUID(),
      new Date(Date.now() + 60_000),
    );
    expect(first).toMatchObject({ run: { id: runId, phase: 'CLEANUP' } });

    // The reclaim lease goes stale again; a second reclaim of the same run
    // must not append a second BACKUP_STARTED.
    await pool.query(
      `UPDATE backup_runs SET lease_until = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [runId],
    );
    const second = await repository.claimExpiredCleanupRun(
      new Date(),
      randomUUID(),
      new Date(Date.now() + 60_000),
    );
    expect(second?.run.id).toBe(runId);

    const audits = await auditEvents(runId);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]!.metadata).toEqual({
      origin: 'SCHEDULED',
      scope: 'DATABASE',
      retentionClass: 'DAILY',
      phase: 'CLEANUP',
      actorType: 'SYSTEM',
      backupId: runId,
    });
  });

  it('rolls a cleanup reclaim back when BACKUP_STARTED cannot be written', async () => {
    const runId = randomUUID();
    const staleToken = randomUUID();
    await insertRunningRun({
      id: runId,
      phase: 'CLEANUP',
      leaseToken: staleToken,
      leaseUntil: new Date(Date.now() - 60_000),
    });
    await installAuditFailureTrigger('BACKUP_STARTED');
    try {
      await expect(
        repository.claimExpiredCleanupRun(new Date(), randomUUID(), new Date(Date.now() + 60_000)),
      ).rejects.toThrow(/injected audit failure/);
    } finally {
      await dropAuditFailureTrigger();
    }

    const row = await runRow(runId);
    expect(row.rows[0]).toMatchObject({ status: 'RUNNING', phase: 'CLEANUP', lease_token: staleToken });
    expect((await auditEvents(runId)).rows).toHaveLength(0);
  });

  it('commits expired-run recovery with exactly one BACKUP_FAILED', async () => {
    const runId = randomUUID();
    await insertRunningRun({
      id: runId,
      phase: 'PACKAGE',
      leaseToken: randomUUID(),
      leaseUntil: new Date(Date.now() - 60_000),
    });

    const recovered = await repository.recoverExpiredRuns(new Date());
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      id: runId,
      status: 'FAILED',
      phase: 'PACKAGE',
      failureCode: 'WORKER_LOST',
    });

    const audits = await auditEvents(runId);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({
      event_type: 'BACKUP_FAILED',
      subject_type: 'BACKUP_RUN',
      organization_id: null,
      actor_user_id: null,
    });
    expect(audits.rows[0]!.metadata).toEqual({
      status: 'FAILED',
      phase: 'PACKAGE',
      failureCode: 'WORKER_LOST',
      actorType: 'SYSTEM',
      backupId: runId,
    });
  });

  it('rolls recovery back when BACKUP_FAILED cannot be written', async () => {
    const runId = randomUUID();
    await insertRunningRun({
      id: runId,
      phase: 'PACKAGE',
      leaseToken: randomUUID(),
      leaseUntil: new Date(Date.now() - 60_000),
    });
    await installAuditFailureTrigger('BACKUP_FAILED');
    try {
      await expect(repository.recoverExpiredRuns(new Date()))
        .rejects.toThrow(/injected audit failure/);
    } finally {
      await dropAuditFailureTrigger();
    }

    const row = await runRow(runId);
    expect(row.rows[0]).toMatchObject({ status: 'RUNNING', phase: 'PACKAGE', failure_code: null });
    expect((await auditEvents(runId)).rows).toHaveLength(0);
  });

  it('commits markFailed with BACKUP_FAILED and leaves audit-free callers unchanged', async () => {
    const runId = randomUUID();
    const token = randomUUID();
    await insertRunningRun({ id: runId, phase: 'DATABASE_DUMP', leaseToken: token });

    const failed = await service.markFailed(
      runId,
      'PG_DUMP_FAILED',
      'pg_dump failed',
      token,
      { eventType: 'BACKUP_FAILED' },
    );
    expect(failed).toMatchObject({
      status: 'FAILED',
      failureCode: 'PG_DUMP_FAILED',
      failureSummary: 'pg_dump failed',
    });

    const audits = await auditEvents(runId);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({
      event_type: 'BACKUP_FAILED',
      subject_type: 'BACKUP_RUN',
      organization_id: null,
      actor_user_id: null,
    });
    expect(audits.rows[0]!.metadata).toEqual({
      failureCode: 'PG_DUMP_FAILED',
      failureSummary: 'pg_dump failed',
      actorType: 'SYSTEM',
      backupId: runId,
    });

    // Engine callers (BR2/BR3/BR4) pass no descriptor and keep their previous
    // behavior: the terminal transition writes no BACKUP_FAILED row.
    const engineRunId = randomUUID();
    const engineToken = randomUUID();
    await insertRunningRun({ id: engineRunId, phase: 'PACKAGE', leaseToken: engineToken });
    await service.markFailed(engineRunId, 'PACKAGE_FAILED', 'engine failure', engineToken);
    expect((await auditEvents(engineRunId)).rows).toHaveLength(0);
  });

  it('rolls markFailed back when BACKUP_FAILED cannot be written', async () => {
    const runId = randomUUID();
    const token = randomUUID();
    await insertRunningRun({ id: runId, phase: 'DATABASE_DUMP', leaseToken: token });
    await installAuditFailureTrigger('BACKUP_FAILED');
    try {
      await expect(
        service.markFailed(runId, 'PG_DUMP_FAILED', 'pg_dump failed', token, { eventType: 'BACKUP_FAILED' }),
      ).rejects.toThrow(/injected audit failure/);
    } finally {
      await dropAuditFailureTrigger();
    }

    const row = await runRow(runId);
    expect(row.rows[0]).toMatchObject({ status: 'RUNNING', phase: 'DATABASE_DUMP', failure_code: null });
    expect((await auditEvents(runId)).rows).toHaveLength(0);
  });

  it('commits completeRun with exactly one BACKUP_COMPLETED', async () => {
    const runId = randomUUID();
    const token = randomUUID();
    await insertRunningRun({ id: runId, phase: 'CLEANUP', leaseToken: token });

    const completed = await service.completeRun(
      runId,
      { systemAudit: { eventType: 'BACKUP_COMPLETED' } },
      token,
    );
    expect(completed).toMatchObject({
      status: 'SUCCESS',
      verifiedAt: expect.any(Date),
      warningCode: null,
    });

    const audits = await auditEvents(runId);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({
      event_type: 'BACKUP_COMPLETED',
      subject_type: 'BACKUP_RUN',
      organization_id: null,
      actor_user_id: null,
    });
    expect(audits.rows[0]!.metadata).toEqual({
      status: 'SUCCESS',
      warningCode: null,
      actorType: 'SYSTEM',
      backupId: runId,
    });

    const warnedRunId = randomUUID();
    const warnedToken = randomUUID();
    await insertRunningRun({ id: warnedRunId, phase: 'CLEANUP', leaseToken: warnedToken });
    await service.completeRun(
      warnedRunId,
      { cleanupWarning: 'workspace cleanup failed', systemAudit: { eventType: 'BACKUP_COMPLETED' } },
      warnedToken,
    );
    const warnedAudit = await auditEvents(warnedRunId);
    expect(warnedAudit.rows).toHaveLength(1);
    expect(warnedAudit.rows[0]!.metadata).toEqual({
      status: 'SUCCESS',
      warningCode: 'CLEANUP_FAILED',
      actorType: 'SYSTEM',
      backupId: warnedRunId,
    });
  });

  it('rolls completeRun back when BACKUP_COMPLETED cannot be written', async () => {
    const runId = randomUUID();
    const token = randomUUID();
    await insertRunningRun({ id: runId, phase: 'CLEANUP', leaseToken: token });
    await installAuditFailureTrigger('BACKUP_COMPLETED');
    try {
      await expect(
        service.completeRun(runId, { systemAudit: { eventType: 'BACKUP_COMPLETED' } }, token),
      ).rejects.toThrow(/injected audit failure/);
    } finally {
      await dropAuditFailureTrigger();
    }

    const row = await runRow(runId);
    expect(row.rows[0]).toMatchObject({
      status: 'RUNNING',
      phase: 'CLEANUP',
      verified_at: null,
      lease_token: token,
    });
    expect((await auditEvents(runId)).rows).toHaveLength(0);
  });
});
