import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresBackupRepository } from '../src/modules/backup/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

describe.skipIf(!databaseUrl)('BR5 backup worker PostgreSQL concurrency', () => {
  const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  let pool: Pool;
  let repository: PostgresBackupRepository;
  const schema = `br5_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!adminPool) return;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
    });
    repository = new PostgresBackupRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  it('claims a queued run once under concurrent FOR UPDATE SKIP LOCKED calls', async () => {
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_at)
       VALUES ($1, 'QUEUED', 'SCHEDULED', 'DATABASE', 'DAILY', $2)`,
      [runId, new Date('2026-08-23T00:00:00Z')],
    );
    const now = new Date('2026-08-23T01:00:00Z');
    const claims = await Promise.all([
      repository.claimNextRun(now, randomUUID(), new Date('2026-08-23T01:01:00Z')),
      repository.claimNextRun(now, randomUUID(), new Date('2026-08-23T01:01:00Z')),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const row = await pool.query<{ status: string; phase: string; lease_token: string | null }>(
      'SELECT status, phase, lease_token FROM backup_runs WHERE id = $1',
      [runId],
    );
    expect(row.rows[0]).toMatchObject({ status: 'RUNNING', phase: 'PREFLIGHT' });
    expect(row.rows[0]!.lease_token).not.toBeNull();
    await pool.query(
      `UPDATE backup_runs SET status = 'FAILED', failure_code = 'WORKER_LOST',
                              failure_summary = 'test', completed_at = NOW(),
                              lease_token = NULL, lease_until = NULL, heartbeat_at = NULL
       WHERE id = $1`,
      [runId],
    );
  });

  it('holds the shared advisory lock on one session and releases it after work', async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = repository.tryWithBackupExclusionLock(async () => {
      entered();
      await gate;
      return 'held';
    });
    await enteredPromise;
    await expect(repository.tryWithBackupExclusionLock(async () => 'blocked')).resolves.toBeNull();
    release();
    await expect(holder).resolves.toBe('held');
    await expect(repository.tryWithBackupExclusionLock(async () => 'released')).resolves.toBe('released');
  });

  it('rejects stale lease mutation and accepts a heartbeat from the current owner', async () => {
    const runId = randomUUID();
    const token = randomUUID();
    const leaseStartedAt = new Date(Date.now() - 1_000);
    const leaseUntil = new Date(Date.now() + 60_000);
    await pool.query(
      `INSERT INTO backup_runs (id, status, phase, origin, scope, retention_class, created_at,
                                started_at, lease_token, lease_until, heartbeat_at)
       VALUES ($1, 'RUNNING', 'PREFLIGHT', 'SCHEDULED', 'DATABASE', 'DAILY', $2, $2, $3, $4, $2)`,
      [runId, leaseStartedAt, token, leaseUntil],
    );
    await expect(repository.advancePhase(runId, 'PREFLIGHT', 'DATABASE_DUMP', randomUUID())).resolves.toBeNull();
    await expect(repository.heartbeatRun(
      runId,
      token,
      new Date(),
      new Date(Date.now() + 60_000),
    )).resolves.toBe(true);
    await expect(repository.advancePhase(runId, 'PREFLIGHT', 'DATABASE_DUMP', token)).resolves.toMatchObject({
      phase: 'DATABASE_DUMP',
    });
    await pool.query(
      `UPDATE backup_runs SET status = 'FAILED', failure_code = 'WORKER_LOST',
                              failure_summary = 'test', completed_at = NOW(),
                              lease_token = NULL, lease_until = NULL, heartbeat_at = NULL
       WHERE id = $1`,
      [runId],
    );
  });

  it('terminalizes non-cleanup orphans and only reclaims cleanup with complete proof', async () => {
    const orphanId = randomUUID();
    const orphanToken = randomUUID();
    await pool.query(
      `INSERT INTO backup_runs (id, status, phase, origin, scope, retention_class, created_at,
                                started_at, lease_token, lease_until, heartbeat_at)
       VALUES ($1, 'RUNNING', 'PACKAGE', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NOW(), $2,
               NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute')`,
      [orphanId, orphanToken],
    );
    const recovered = await repository.recoverExpiredRuns(new Date());
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ status: 'FAILED', phase: 'PACKAGE', failureCode: 'WORKER_LOST' });

    const cleanupId = randomUUID();
    await pool.query(
      `INSERT INTO backup_runs (id, status, phase, origin, scope, retention_class, created_at,
                                started_at, remote_key, size_bytes, sha256, lease_token,
                                lease_until, heartbeat_at)
       VALUES ($1::uuid, 'RUNNING', 'CLEANUP', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NOW(),
               'production/test/v1/daily/' || $1::text || '.sbk.age', 123, $2, $3,
               NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute')`,
      [cleanupId, 'a'.repeat(64), randomUUID()],
    );
    const freshToken = randomUUID();
    const claim = await repository.claimExpiredCleanupRun(
      new Date(),
      freshToken,
      new Date(Date.now() + 60_000),
    );
    expect(claim).toMatchObject({ run: { id: cleanupId, phase: 'CLEANUP' }, leaseToken: freshToken });
    await expect(repository.completeRun(
      cleanupId,
      { completedAt: new Date(), cleanupWarning: null },
      freshToken,
    )).resolves.toMatchObject({ status: 'SUCCESS', verifiedAt: expect.any(Date) });
  });

  it('consumes one scheduled slot durably and allows a second process to observe it', async () => {
    const slotKey = 'UTC|2026-08-23|02:30';
    const input = {
      id: randomUUID(),
      scope: 'DATABASE' as const,
      retentionClass: 'DAILY' as const,
      createdAt: new Date('2026-08-23T02:31:00Z'),
      slotKey,
      localDate: '2026-08-23',
      scheduledFor: new Date('2026-08-23T02:30:00Z'),
    };
    await expect(repository.enqueueScheduledRun(input)).resolves.toMatchObject({ kind: 'created' });
    await expect(repository.enqueueScheduledRun({ ...input, id: randomUUID() })).resolves.toEqual({ kind: 'already-consumed' });
    const audit = await pool.query<{ event_type: string; actor_user_id: string | null }>(
      `SELECT event_type, actor_user_id FROM audit_events WHERE subject_id = $1 ORDER BY created_at`,
      [input.id],
    );
    expect(audit.rows).toEqual(expect.arrayContaining([
      { event_type: 'BACKUP_REQUESTED', actor_user_id: null },
    ]));
  });
});
