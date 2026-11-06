import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { CurrentTimeEvidence } from '../../ops/scripts/trusted-time.mjs';
import type { BackupVerificationProof } from '../src/modules/backup/trusted-evidence.js';
import { createPostgresBackupHealth } from '../src/modules/health/postgres-backup-health.js';
import { timeAt } from './backup-time-fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const T0 = Date.parse('2026-11-04T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const SHA = 'a'.repeat(64);

describe.skipIf(!databaseUrl)('BR5 scheduled failure ordering', () => {
  const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  let pool: Pool;
  let organizationId: string;
  let adminId: string;
  const schema = `br5order_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!adminPool) return;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
    organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone) VALUES ('BR5 ordering', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    adminId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Ordering Admin', 'ordering@example.test', 'test-hash', 'ADMIN') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `UPDATE backup_worker_state
          SET worker_heartbeat_at = NULL, worker_heartbeat_time_evidence = NULL,
              scheduler_last_tick_at = NULL, scheduler_last_tick_time_evidence = NULL,
              last_scheduled_slot_key = NULL, last_scheduled_local_date = NULL,
              last_scheduled_for = NULL, last_scheduled_run_id = NULL
        WHERE singleton`,
    );
    await pool.query('DELETE FROM backup_runs');
  });

  async function setPointer(runId: string | null): Promise<void> {
    if (runId === null) {
      await pool.query(
        `UPDATE backup_worker_state
            SET last_scheduled_slot_key = NULL, last_scheduled_local_date = NULL,
                last_scheduled_for = NULL, last_scheduled_run_id = NULL
          WHERE singleton`,
      );
      return;
    }
    await pool.query(
      `UPDATE backup_worker_state
          SET last_scheduled_slot_key = 'Europe/Istanbul|2026-11-04|02:30',
              last_scheduled_local_date = '2026-11-04',
              last_scheduled_for = $2,
              last_scheduled_run_id = $1
        WHERE singleton`,
      [runId, new Date(T0)],
    );
  }

  async function insertScheduledSuccess(input: {
    id?: string;
    createdAt: number;
    beforeMs: number;
    verifiedAtMs: number;
    withEvidence?: boolean;
  }): Promise<{ id: string; proof: BackupVerificationProof; before: CurrentTimeEvidence }> {
    const id = input.id ?? randomUUID();
    const before = timeAt(input.beforeMs);
    const after = timeAt(input.verifiedAtMs);
    const remoteKey = `production/instance/v1/scheduled/${id}.sbk.age`;
    const proof: BackupVerificationProof = {
      proofVersion: 2,
      runId: id,
      artifactGenerationId: randomUUID(),
      artifactSha256: SHA,
      sizeBytes: 1024,
      remoteAttemptId: randomUUID(),
      origin: 'SCHEDULED',
      remoteKey,
      generationStartedAt: before.wallAtUTC,
      verificationAttemptStartedAt: new Date(input.verifiedAtMs - 30_000).toISOString(),
      verifiedAt: after.wallAtUTC,
      before,
      after,
    };
    const withEvidence = input.withEvidence ?? true;
    await pool.query(
      `INSERT INTO backup_runs
        (id, status, phase, origin, scope, retention_class, created_at, started_at,
         completed_at, remote_key, size_bytes, sha256, verified_at,
         artifact_generation_id, artifact_generation_time_evidence,
         verification_time_evidence)
       VALUES ($1, 'SUCCESS', 'CLEANUP', 'SCHEDULED', 'DATABASE', 'DAILY', $2, $2,
               $3, $4, 1024, $5, $3, $6, $7::jsonb, $8::jsonb)`,
      [
        id,
        new Date(input.createdAt),
        new Date(input.verifiedAtMs),
        remoteKey,
        SHA,
        withEvidence ? proof.artifactGenerationId : null,
        withEvidence ? JSON.stringify(before) : null,
        withEvidence ? JSON.stringify(proof) : null,
      ],
    );
    return { id, proof, before };
  }

  async function insertScheduledFailure(input: {
    id?: string;
    createdAt: number;
    completedAt: number;
    failureCode?: string;
  }): Promise<{ id: string }> {
    const id = input.id ?? randomUUID();
    await pool.query(
      `INSERT INTO backup_runs
        (id, status, phase, origin, scope, retention_class, created_at, started_at,
         completed_at, failure_code, failure_summary)
       VALUES ($1, 'FAILED', 'CLEANUP', 'SCHEDULED', 'DATABASE', 'DAILY', $2, $2,
               $3, $4, 'scheduled attempt failed')`,
      [
        id,
        new Date(input.createdAt),
        new Date(input.completedAt),
        input.failureCode ?? 'PG_DUMP_FAILED',
      ],
    );
    return { id };
  }

  async function insertQueuedScheduled(input: { createdAt: number }): Promise<{ id: string }> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO backup_runs
        (id, status, origin, scope, retention_class, created_at, format_version)
       VALUES ($1, 'QUEUED', 'SCHEDULED', 'DATABASE', 'DAILY', $2, 1)`,
      [id, new Date(input.createdAt)],
    );
    return { id };
  }

  async function insertManualFailure(input: { createdAt: number }): Promise<{ id: string }> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO backup_runs
        (id, status, phase, origin, scope, retention_class, created_by, created_at,
         started_at, completed_at, failure_code, failure_summary)
       VALUES ($1, 'FAILED', 'CLEANUP', 'MANUAL', 'DATABASE', 'MANUAL', $2, $3,
               $3, $4, 'PG_DUMP_FAILED', 'manual attempt failed')`,
      [id, adminId, new Date(input.createdAt), new Date(input.createdAt + MIN)],
    );
    return { id };
  }

  async function insertManualSuccess(input: { createdAt: number }): Promise<{ id: string }> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO backup_runs
        (id, status, phase, origin, scope, retention_class, created_by, created_at,
         started_at, completed_at, remote_key, size_bytes, sha256, verified_at)
       VALUES ($1, 'SUCCESS', 'CLEANUP', 'MANUAL', 'DATABASE', 'MANUAL', $2, $3,
               $3, $4, $5, 1024, $6, $4)`,
      [
        id,
        adminId,
        new Date(input.createdAt),
        new Date(input.createdAt + MIN),
        `production/instance/v1/manual/${id}.sbk.age`,
        SHA,
      ],
    );
    return { id };
  }

  async function check(input: {
    current?: CurrentTimeEvidence | null;
    workerEnabled?: boolean;
  } = {}) {
    const reader = createPostgresBackupHealth(pool, {
      workerEnabled: input.workerEnabled ?? false,
      sampleTime: async () => input.current ?? null,
    });
    return reader.check();
  }

  it('selects the durable successful scheduled generation after wall-clock rollback', async () => {
    const old = await insertScheduledSuccess({
      createdAt: T0,
      beforeMs: T0,
      verifiedAtMs: T0 + MIN,
    });
    // This run is later in scheduler order, but the host clock rolled back:
    // both created_at and verified_at are earlier than the first success.
    const latest = await insertScheduledSuccess({
      createdAt: T0 - 30 * MIN,
      beforeMs: T0 - 30 * MIN,
      verifiedAtMs: T0 - 29 * MIN,
    });
    await setPointer(latest.id);

    const result = await check({ current: timeAt(T0 + HOUR) });
    // Global diagnostic latest-by-wall remains the old run. Scheduled slot
    // progress must use the durable identity and return the second run.
    expect(result.latestVerifiedAt).toBe(new Date(T0 + MIN).toISOString());
    expect(result.latestScheduledVerifiedAt).toBe(new Date(T0 - 29 * MIN).toISOString());
    expect(result.latestScheduledRunStatus).toBe('SUCCESS');
    expect(result.providerStatus).toBe('unavailable'); // OT3 remains BLOCKED
    expect(old.id).not.toBe(latest.id);
  });

  it('does not promote an older success when the durable latest scheduled slot has no proof', async () => {
    const first = await insertScheduledSuccess({
      createdAt: T0,
      beforeMs: T0,
      verifiedAtMs: T0 + MIN,
    });
    const noProof = await insertScheduledSuccess({
      createdAt: T0 - HOUR,
      beforeMs: T0 - HOUR,
      verifiedAtMs: T0 - HOUR + MIN,
      withEvidence: false,
    });
    await setPointer(noProof.id);

    const result = await check({ current: timeAt(T0 + HOUR) });
    expect(result.latestScheduledRunStatus).toBe('SUCCESS');
    expect(result.latestScheduledVerifiedAt).toBe(new Date(T0 - HOUR + MIN).toISOString());
    expect(result.providerStatus).toBe('unavailable');
    expect(first.id).not.toBe(noProof.id);
  });

  it('uses the durable latest scheduled attempt when clock rollback makes FAILED older', async () => {
    await insertScheduledSuccess({ createdAt: T0, beforeMs: T0, verifiedAtMs: T0 + MIN });
    const failed = await insertScheduledFailure({
      createdAt: T0 - HOUR,
      completedAt: T0 + 30 * MIN,
    });
    await setPointer(failed.id);

    const result = await check({ current: timeAt(T0 + HOUR) });

    expect(result.latestScheduledRunStatus).toBe('FAILED');
    expect(result.providerStatus).toBe('failed');
    expect(result.status).toBe('unavailable');
  });

  it('still gives a real-time newer FAILED priority over a fresh prior success', async () => {
    await insertScheduledSuccess({ createdAt: T0, beforeMs: T0, verifiedAtMs: T0 + MIN });
    const failed = await insertScheduledFailure({
      createdAt: T0 + 2 * MIN,
      completedAt: T0 + 3 * MIN,
    });
    await setPointer(failed.id);

    const result = await check({ current: timeAt(T0 + HOUR) });

    expect(result.latestScheduledRunStatus).toBe('FAILED');
    expect(result.providerStatus).toBe('failed');
  });

  it('does not require a current trusted sample to report the scheduled failure', async () => {
    await insertScheduledSuccess({ createdAt: T0, beforeMs: T0, verifiedAtMs: T0 + MIN });
    const failed = await insertScheduledFailure({
      createdAt: T0 - HOUR,
      completedAt: T0 + 30 * MIN,
    });
    await setPointer(failed.id);

    const result = await check({ current: null });

    expect(result.latestScheduledRunStatus).toBe('FAILED');
    expect(result.providerStatus).toBe('failed');
  });

  it('returns healthy after a later scheduled success replaces the failed pointer', async () => {
    const first = await insertScheduledSuccess({
      createdAt: T0,
      beforeMs: T0,
      verifiedAtMs: T0 + MIN,
    });
    const failed = await insertScheduledFailure({
      createdAt: T0 + HOUR,
      completedAt: T0 + HOUR + MIN,
    });
    await setPointer(failed.id);
    expect((await check({ current: timeAt(T0 + 2 * HOUR) })).providerStatus).toBe('failed');

    const second = await insertScheduledSuccess({
      createdAt: T0 + 2 * HOUR,
      beforeMs: T0 + 2 * HOUR,
      verifiedAtMs: T0 + 2 * HOUR + MIN,
    });
    await setPointer(second.id);

    const result = await check({ current: timeAt(T0 + 3 * HOUR) });
    expect(result.latestScheduledRunStatus).toBe('SUCCESS');
    expect(result.latestScheduledVerifiedAt).toBe(new Date(T0 + 2 * HOUR + MIN).toISOString());
    expect(result.providerStatus).toBe('unavailable');
    expect(first.id).not.toBe(second.id);
  });

  it('never lets a manual failure become the scheduled authority', async () => {
    const scheduled = await insertScheduledSuccess({
      createdAt: T0,
      beforeMs: T0,
      verifiedAtMs: T0 + MIN,
    });
    await insertManualFailure({ createdAt: T0 + 2 * HOUR });
    await setPointer(scheduled.id);

    const result = await check({ current: timeAt(T0 + HOUR) });

    expect(result.latestScheduledRunStatus).toBe('SUCCESS');
    expect(result.providerStatus).toBe('unavailable');
  });

  it('keeps a fresh prior proof when the latest scheduled attempt is QUEUED', async () => {
    const success = await insertScheduledSuccess({
      createdAt: T0,
      beforeMs: T0,
      verifiedAtMs: T0 + MIN,
    });
    const queued = await insertQueuedScheduled({ createdAt: T0 + HOUR });
    await setPointer(queued.id);

    const result = await check({ current: timeAt(T0 + HOUR + MIN) });

    expect(result.latestScheduledRunStatus).toBe('QUEUED');
    expect(result.providerStatus).toBe('unavailable');
    expect(success.id).not.toBe(queued.id);
  });

  it('fails closed when the durable scheduled pointer is missing', async () => {
    await insertScheduledSuccess({ createdAt: T0, beforeMs: T0, verifiedAtMs: T0 + MIN });
    await setPointer(null);

    const result = await check({ current: timeAt(T0 + HOUR) });

    expect(result.latestScheduledRunStatus).toBeNull();
    expect(result.providerStatus).toBe('unavailable');
    expect(result.status).toBe('unavailable');
  });

  it('fails closed when the durable pointer references a manual run', async () => {
    await insertScheduledSuccess({ createdAt: T0, beforeMs: T0, verifiedAtMs: T0 + MIN });
    const manual = await insertManualSuccess({ createdAt: T0 + MIN });
    await setPointer(manual.id);

    const result = await check({ current: timeAt(T0 + HOUR) });

    expect(result.latestScheduledRunStatus).toBeNull();
    expect(result.providerStatus).toBe('unavailable');
  });

  it('fails closed for a legacy scheduled SUCCESS without trusted evidence', async () => {
    const legacy = await insertScheduledSuccess({
      createdAt: T0,
      beforeMs: T0,
      verifiedAtMs: T0 + MIN,
      withEvidence: false,
    });
    await setPointer(legacy.id);

    const result = await check({ current: timeAt(T0 + HOUR) });

    expect(result.latestScheduledRunStatus).toBe('SUCCESS');
    expect(result.latestScheduledVerifiedAt).toBe(new Date(T0 + MIN).toISOString());
    expect(result.providerStatus).toBe('unavailable');
  });

  it('does not use created_at ordering as a wall-clock fallback', async () => {
    // The success row has the newest wall-clock created_at. The failed row was
    // created later in real time but carries an earlier wall clock after a
    // rollback; only the durable pointer can identify it.
    await insertScheduledSuccess({ createdAt: T0, beforeMs: T0, verifiedAtMs: T0 + MIN });
    const failed = await insertScheduledFailure({
      createdAt: T0 - 26 * HOUR,
      completedAt: T0 + 30 * MIN,
    });
    await setPointer(failed.id);

    const result = await check({ current: timeAt(T0 + HOUR) });

    expect(result.latestScheduledRunStatus).toBe('FAILED');
    expect(result.providerStatus).toBe('failed');
  });
});
