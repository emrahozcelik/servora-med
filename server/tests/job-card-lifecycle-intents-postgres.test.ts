import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdtemp, rm } from 'node:fs/promises';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `lcint_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      store: new PostgresMigrationStore(pool),
    });
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

describe.skipIf(!databaseUrl)('049 job_card_lifecycle_intents migration', () => {
  it('catalog head is 052 with 52 migrations', async () => {
    const catalog = await loadMigrationCatalog(MIGRATIONS_DIRECTORY);
    expect(catalog.head?.version).toBe('052_weekly_report_recurrence');
    expect(catalog.count).toBe(52);
  });

  it('applies 001 -> 052 on an empty schema with an empty intent table', async () => {
    await withSchema(async (pool) => {
      const applied = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(applied.rows.map((row) => row.version).at(-1)).toBe('052_weekly_report_recurrence');
      expect(applied.rows).toHaveLength(52);
      const count = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM job_card_lifecycle_intents',
      );
      expect(count.rows[0]!.count).toBe('0');
    });
  });

  it('applies 049 -> 052 as the upgrade tail', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `lcint_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    let subsetDir: string | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      const files = (await readdir(MIGRATIONS_DIRECTORY))
        .filter(
          (file) => file.endsWith('.sql')
            && file !== '049_job_card_lifecycle_intents.sql'
            && file !== '050_overdue_incident_scanner_source.sql'
            && file !== '051_weekly_report_foundation.sql'
            && file !== '052_weekly_report_recurrence.sql',
        )
        .sort();
      expect(files).toHaveLength(48);
      subsetDir = await mkdtemp(path.join(tmpdir(), 'lcint-049-'));
      const { copyFile } = await import('node:fs/promises');
      for (const file of files) {
        await copyFile(path.join(MIGRATIONS_DIRECTORY, file), path.join(subsetDir, file));
      }
      const store = new PostgresMigrationStore(pool);
      await runMigrations({ migrationsDirectory: subsetDir, store });
      const result = await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store });
      expect(result).toEqual({
        appliedVersions: [
          '049_job_card_lifecycle_intents',
          '050_overdue_incident_scanner_source',
          '051_weekly_report_foundation',
          '052_weekly_report_recurrence',
        ],
      });
      const head = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      expect(head.rows[0]!.version).toBe('052_weekly_report_recurrence');
    } finally {
      await pool?.end();
      if (subsetDir) await rm(subsetDir, { recursive: true, force: true });
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});

const HEX_HASH_A = 'aa'.repeat(32);
const HEX_HASH_B = 'bb'.repeat(32);

async function insertIntentOrg(pool: Pool, name: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [name],
  )).rows[0]!.id;
}

async function insertIntentUser(pool: Pool, organizationId: string, role: 'MANAGER' | 'STAFF'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, `intent-${randomUUID()}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function insertIntentJob(pool: Pool, organizationId: string, userId: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
     VALUES ($1, 'GENERAL_TASK', 'Intent job', $2, $2) RETURNING id`,
    [organizationId, userId],
  )).rows[0]!.id;
}

describe.skipIf(!databaseUrl)('049 lifecycle intent reservation', () => {
  it('reserves, finalizes, replays exact retries and rejects hash mismatch', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertIntentOrg(pool, 'Intent Org');
      const userId = await insertIntentUser(pool, organizationId, 'STAFF');
      const jobCardId = await insertIntentJob(pool, organizationId, userId);
      const repository = new PostgresJobCardRepository(pool);
      const claim = {
        organizationId,
        userId,
        clientActionId: randomUUID(),
        operationKey: `JOB_START:${jobCardId}`,
        command: 'START' as const,
        requestHash: HEX_HASH_A,
        expectedVersion: 1,
      };

      const reserved = await repository.reserveLifecycleIntent(claim, { jobCardId, ttlMs: 60_000 });
      expect(reserved.kind).toBe('reserved');
      if (reserved.kind !== 'reserved') return;
      expect(reserved.reservation.intentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(reserved.reservation.reservedAt).toBeInstanceOf(Date);

      const intentRow = (await pool.query(
        `SELECT state, reserved_at, expires_at, expected_version, request_hash,
                reserved_at = date_trunc('milliseconds', reserved_at) AS millisecond_exact
           FROM job_card_lifecycle_intents WHERE id = $1`,
        [reserved.reservation.intentId],
      )).rows[0] as Record<string, unknown>;
      expect(intentRow.state).toBe('PENDING');
      const reservedAt = reserved.reservation.reservedAt.getTime();
      expect(new Date(intentRow.reserved_at as string).getTime()).toBe(reservedAt);
      // Millisecond normalization: no sub-millisecond residue.
      expect(intentRow.millisecond_exact).toBe(true);
      expect(new Date(intentRow.expires_at as string).getTime() - reservedAt).toBe(60_000);
      expect(intentRow.expected_version).toBe(1);
      expect(intentRow.request_hash).toBe(HEX_HASH_A);

      const finalized = await repository.finalizeLifecycleIntent<{ ok: boolean }>(
        claim,
        reserved.reservation,
        async (tx) => {
          const updated = await tx.transitionWithVersion({
            organizationId,
            jobCardId,
            expectedVersion: 1,
            command: 'START',
            status: 'IN_PROGRESS',
            occurredAt: reserved.reservation.reservedAt,
            actorId: userId,
            note: null,
            revisionReason: null,
            cancelReason: null,
            followUpProposal: null,
          });
          expect(updated?.version).toBe(2);
          return { response: { ok: true }, realtimeEvents: [] };
        },
        { jobCardId },
      );
      expect(finalized.kind).toBe('completed');

      const completedRow = (await pool.query(
        `SELECT i.state,p.response_body FROM job_card_lifecycle_intents i JOIN processed_actions p USING (organization_id,user_id,client_action_id,operation_key) WHERE i.id=$1`,
        [reserved.reservation.intentId],
      )).rows[0] as Record<string, unknown>;
      expect(completedRow.state).toBe('COMPLETED');
      expect(completedRow.response_body).toEqual({ ok: true });

      // Exact retry replays the immutable receipt.
      const replay = await repository.reserveLifecycleIntent(claim, { jobCardId, ttlMs: 60_000 });
      expect(replay).toEqual({
        kind: 'replay',
        response: { ok: true },
        reservedAt: reserved.reservation.reservedAt,
      });

      // Same identity with a different hash is a reuse conflict, not a rerun.
      await expect(repository.reserveLifecycleIntent(
        { ...claim, requestHash: HEX_HASH_B },
        { jobCardId, ttlMs: 60_000 },
      )).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
    });
  });

  it('D1: definitive failure on a max=1 pool preserves the domain error and marks FAILED', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `lcint_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      // Migrate with a setup pool: the migration runner itself needs more
      // than one connection. The max=1 pool below is only for the test.
      const setupPool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      try {
        await runMigrations({
          migrationsDirectory: MIGRATIONS_DIRECTORY,
          store: new PostgresMigrationStore(setupPool),
        });
      } finally {
        await setupPool.end();
      }
      // max=1 + short acquisition timeout: any second pool.connect() while
      // the business connection is held fails loudly instead of hanging.
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
        max: 1,
        connectionTimeoutMillis: 2_000,
      });
      const organizationId = await insertIntentOrg(pool, 'D1 Org');
      const userId = await insertIntentUser(pool, organizationId, 'STAFF');
      const jobCardId = await insertIntentJob(pool, organizationId, userId);
      const repository = new PostgresJobCardRepository(pool);
      const claim = {
        organizationId,
        userId,
        clientActionId: randomUUID(),
        operationKey: `JOB_START:${jobCardId}`,
        command: 'START' as const,
        requestHash: HEX_HASH_A,
        expectedVersion: 1,
      };
      const reserved = await repository.reserveLifecycleIntent(claim, { jobCardId, ttlMs: 60_000 });
      expect(reserved.kind).toBe('reserved');
      if (reserved.kind !== 'reserved') return;

      // Deterministic business failure AFTER the reservation: a stale
      // version write that the service layer reports as VERSION_CONFLICT.
      const failure = await repository.finalizeLifecycleIntent(
        claim,
        reserved.reservation,
        async (tx) => {
          const updated = await tx.transitionWithVersion({
            organizationId,
            jobCardId,
            expectedVersion: 999,
            command: 'START',
            status: 'IN_PROGRESS',
            occurredAt: reserved.reservation.reservedAt,
            actorId: userId,
            note: null,
            revisionReason: null,
            cancelReason: null,
            followUpProposal: null,
          });
          if (!updated) {
            const { AppError } = await import('../src/errors/index.js');
            throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
          }
          return { response: { ok: true }, realtimeEvents: [] };
        },
        { jobCardId },
      ).then(
        () => { throw new Error('finalize should have thrown'); },
        (error: unknown) => error,
      );
      // The original domain error wins: never a pool timeout, acquisition
      // error, or secondary UPDATE failure.
      expect(failure).toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });

      // Business mutation rolled back.
      const job = (await pool.query(
        'SELECT status, version FROM job_cards WHERE id = $1',
        [jobCardId],
      )).rows[0] as Record<string, unknown>;
      expect(job).toMatchObject({ status: 'NEW', version: 1 });

      // No lifecycle/accountability/OVR/process side effects.
      for (const table of [
        'job_card_activity_logs',
        'job_card_accountability_facts',
        'job_card_overdue_incidents',
        'job_card_submission_episode_activations',
        'processed_actions',
      ]) {
        const count = (await pool.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0] as Record<string, unknown>;
        expect(count.count).toBe('0');
      }

      // Definitive failure is recorded exactly once.
      const intent = (await pool.query(
        'SELECT state, completed_at, failed_at, failure_code FROM job_card_lifecycle_intents WHERE id = $1',
        [reserved.reservation.intentId],
      )).rows[0] as Record<string, unknown>;
      expect(intent.state).toBe('FAILED');
      await expect(repository.reserveLifecycleIntent(claim, { jobCardId, ttlMs: 60_000 }))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
      expect((await pool.query('SELECT reserved_at FROM job_card_lifecycle_intents WHERE id=$1',
        [reserved.reservation.intentId])).rows[0]!.reserved_at).toEqual(reserved.reservation.reservedAt);
      expect(intent.completed_at).toBeNull();
      expect(intent.failed_at).not.toBeNull();
      expect(intent.failure_code).toBe('VERSION_CONFLICT');

      // The pool remains usable after the failure.
      await expect(pool.query('SELECT 1')).resolves.toBeDefined();
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('D1: bounded concurrent failures share a small pool without masking errors', async () => {

    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `lcint_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
        max: 2,
        connectionTimeoutMillis: 5_000,
      });
      await runMigrations({
        migrationsDirectory: MIGRATIONS_DIRECTORY,
        store: new PostgresMigrationStore(pool),
      });
      const organizationId = await insertIntentOrg(pool, 'D1 pressure Org');
      const userId = await insertIntentUser(pool, organizationId, 'STAFF');
      const repository = new PostgresJobCardRepository(pool);
      const reservations = [];
      for (let index = 0; index < 3; index += 1) {
        const jobCardId = await insertIntentJob(pool, organizationId, userId);
        const claim = {
          organizationId,
          userId,
          clientActionId: randomUUID(),
          operationKey: `JOB_START:${jobCardId}`,
          command: 'START' as const,
          requestHash: HEX_HASH_A,
          expectedVersion: 1,
        };
        const reserved = await repository.reserveLifecycleIntent(claim, { jobCardId, ttlMs: 60_000 });
        if (reserved.kind !== 'reserved') throw new Error('reservation failed in pressure setup');
        reservations.push({ claim, jobCardId, reservation: reserved.reservation });
      }
      const { AppError } = await import('../src/errors/index.js');
      const outcomes = await Promise.all(reservations.map(async ({ claim, jobCardId, reservation }) =>
        repository.finalizeLifecycleIntent(
          claim,
          reservation,
          async () => { throw new AppError('FORBIDDEN', 403, 'reddedildi'); },
          { jobCardId },
        ).then(
          () => 'unexpected-success',
          (error: unknown) => (error as { code?: unknown }).code,
        ),
      ));
      expect(outcomes).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);
      const failed = (await pool.query(
        "SELECT COUNT(*) AS count FROM job_card_lifecycle_intents WHERE state = 'FAILED'",
      )).rows[0] as Record<string, unknown>;
      expect(failed.count).toBe('3');
      await expect(pool.query('SELECT 1')).resolves.toBeDefined();
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('same pending identity reports ACTION_IN_PROGRESS', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertIntentOrg(pool, 'Pending Org');
      const userId = await insertIntentUser(pool, organizationId, 'STAFF');
      const jobCardId = await insertIntentJob(pool, organizationId, userId);
      const repository = new PostgresJobCardRepository(pool);
      const claim = {
        organizationId,
        userId,
        clientActionId: randomUUID(),
        operationKey: `JOB_START:${jobCardId}`,
        command: 'START' as const,
        requestHash: HEX_HASH_A,
        expectedVersion: 1,
      };
      const first = await repository.reserveLifecycleIntent(claim, { jobCardId, ttlMs: 60_000 });
      expect(first.kind).toBe('reserved');
      await expect(repository.reserveLifecycleIntent(claim, { jobCardId, ttlMs: 60_000 }))
        .rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS', statusCode: 409 });
    });
  });

  it('D2: exact retry racing a completion replays instead of VERSION_CONFLICT', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertIntentOrg(pool, 'D2 Org');
      const userId = await insertIntentUser(pool, organizationId, 'STAFF');
      const jobCardId = await insertIntentJob(pool, organizationId, userId);
      // Two independent service instances behind one pool, as in production.
      const instanceA = new PostgresJobCardRepository(pool);
      const instanceB = new PostgresJobCardRepository(pool);
      const identity = {
        organizationId,
        userId,
        clientActionId: randomUUID(),
        operationKey: `JOB_START:${jobCardId}`,
        command: 'START' as const,
        requestHash: HEX_HASH_A,
        expectedVersion: 1,
      };
      // B performs the service-level completed lookup and finds nothing.
      await expect(instanceB.findCompletedLifecycleIntent(identity)).resolves.toBeNull();
      // A completes the exact same action: version 1 -> 2, receipt durable.
      const reservedA = await instanceA.reserveLifecycleIntent(identity, { jobCardId, ttlMs: 60_000 });
      expect(reservedA.kind).toBe('reserved');
      if (reservedA.kind !== 'reserved') return;
      const doneA = await instanceA.finalizeLifecycleIntent<{ receipt: string }>(
        identity,
        reservedA.reservation,
        async (tx) => {
          await tx.transitionWithVersion({
            organizationId,
            jobCardId,
            expectedVersion: 1,
            command: 'START',
            status: 'IN_PROGRESS',
            occurredAt: reservedA.reservation.reservedAt,
            actorId: userId,
            note: null,
            revisionReason: null,
            cancelReason: null,
            followUpProposal: null,
          });
          return { response: { receipt: 'a-completed' }, realtimeEvents: [] };
        },
        { jobCardId },
      );
      expect(doneA.kind).toBe('completed');
      // B now obtains the authoritative JobCard lock via its reservation.
      // Same identity + same hash: exact replay, never VERSION_CONFLICT.
      const replayB = await instanceB.reserveLifecycleIntent(identity, { jobCardId, ttlMs: 60_000 });
      expect(replayB).toEqual({
        kind: 'replay',
        response: { receipt: 'a-completed' },
        reservedAt: reservedA.reservation.reservedAt,
      });
      // One business mutation, one intent row, one completed receipt.
      const job = (await pool.query(
        'SELECT status, version FROM job_cards WHERE id = $1',
        [jobCardId],
      )).rows[0] as Record<string, unknown>;
      expect(job).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
      const intents = (await pool.query(
        'SELECT COUNT(*) AS count FROM job_card_lifecycle_intents',
      )).rows[0] as Record<string, unknown>;
      expect(intents.count).toBe('1');
    });
  });

  it('D2 companion: same identity with a different hash after completion is CLIENT_ACTION_REUSED', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertIntentOrg(pool, 'D2 hash Org');
      const userId = await insertIntentUser(pool, organizationId, 'STAFF');
      const jobCardId = await insertIntentJob(pool, organizationId, userId);
      const instanceA = new PostgresJobCardRepository(pool);
      const instanceB = new PostgresJobCardRepository(pool);
      const clientActionId = randomUUID();
      const operationKey = `JOB_START:${jobCardId}`;
      await expect(instanceB.findCompletedLifecycleIntent({
        organizationId, userId, clientActionId, operationKey,
        command: 'START', requestHash: HEX_HASH_B, expectedVersion: 1,
      })).resolves.toBeNull();
      const reservedA = await instanceA.reserveLifecycleIntent({
        organizationId, userId, clientActionId, operationKey,
        command: 'START', requestHash: HEX_HASH_A, expectedVersion: 1,
      }, { jobCardId, ttlMs: 60_000 });
      expect(reservedA.kind).toBe('reserved');
      if (reservedA.kind !== 'reserved') return;
      await instanceA.finalizeLifecycleIntent(
        {
          organizationId, userId, clientActionId, operationKey,
          command: 'START', requestHash: HEX_HASH_A, expectedVersion: 1,
        },
        reservedA.reservation,
        async () => ({ response: { ok: true }, realtimeEvents: [] }),
        { jobCardId },
      );
      await expect(instanceB.reserveLifecycleIntent({
        organizationId, userId, clientActionId, operationKey,
        command: 'START', requestHash: HEX_HASH_B, expectedVersion: 1,
      }, { jobCardId, ttlMs: 60_000 }))
        .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
    });
  });

  it('stale expectedVersion on a new attempt is VERSION_CONFLICT with no intent row', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertIntentOrg(pool, 'Version Org');
      const userId = await insertIntentUser(pool, organizationId, 'STAFF');
      const jobCardId = await insertIntentJob(pool, organizationId, userId);
      const repository = new PostgresJobCardRepository(pool);
      await expect(repository.reserveLifecycleIntent({
        organizationId,
        userId,
        clientActionId: randomUUID(),
        operationKey: `JOB_START:${jobCardId}`,
        command: 'START',
        requestHash: HEX_HASH_A,
        expectedVersion: 7,
      }, { jobCardId, ttlMs: 60_000 }))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
      const count = (await pool.query(
        'SELECT COUNT(*) AS count FROM job_card_lifecycle_intents',
      )).rows[0] as Record<string, unknown>;
      expect(count.count).toBe('0');
    });
  });

  it('expired same key never renews; only a new key obtains a new reservation', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertIntentOrg(pool, 'Expiry Org');
      const userId = await insertIntentUser(pool, organizationId, 'STAFF');
      const jobCardId = await insertIntentJob(pool, organizationId, userId);
      const repository = new PostgresJobCardRepository(pool);
      const claim = { organizationId, userId, clientActionId: randomUUID(),
        operationKey: `JOB_START:${jobCardId}`, command: 'START' as const,
        requestHash: HEX_HASH_A, expectedVersion: 1 };
      const first = await repository.reserveLifecycleIntent(claim, { jobCardId, ttlMs: 60_000 });
      expect(first.kind).toBe('reserved');
      if (first.kind !== 'reserved') throw new Error('reservation required');
      await pool.query(`UPDATE job_card_lifecycle_intents SET
        reserved_at = date_trunc('milliseconds', clock_timestamp()) - interval '120 seconds',
        expires_at = date_trunc('milliseconds', clock_timestamp()) - interval '60 seconds'
        WHERE id = $1`, [first.reservation.intentId]);
      const before = (await pool.query('SELECT reserved_at, expires_at FROM job_card_lifecycle_intents WHERE id=$1', [first.reservation.intentId])).rows[0];
      await expect(repository.reserveLifecycleIntent(claim, { jobCardId, ttlMs: 60_000 }))
        .rejects.toMatchObject({ code: 'LIFECYCLE_INTENT_EXPIRED', statusCode: 409 });
      expect((await pool.query('SELECT reserved_at, expires_at FROM job_card_lifecycle_intents WHERE id=$1', [first.reservation.intentId])).rows[0]).toEqual(before);
      const next = await repository.reserveLifecycleIntent({ ...claim, clientActionId: randomUUID() }, { jobCardId, ttlMs: 60_000 });
      expect(next.kind).toBe('reserved');
      if (next.kind !== 'reserved') throw new Error('new reservation required');
      expect(next.reservation.intentId).not.toBe(first.reservation.intentId);
    });
  });

  it('first fence: an own reservation that lapsed expires without running work', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertIntentOrg(pool, 'Fence Org');
      const userId = await insertIntentUser(pool, organizationId, 'STAFF');
      const jobCardId = await insertIntentJob(pool, organizationId, userId);
      const repository = new PostgresJobCardRepository(pool);
      const claim = {
        organizationId,
        userId,
        clientActionId: randomUUID(),
        operationKey: `JOB_START:${jobCardId}`,
        command: 'START' as const,
        requestHash: HEX_HASH_A,
        expectedVersion: 1,
      };
      const reserved = await repository.reserveLifecycleIntent(claim, { jobCardId, ttlMs: 60_000 });
      expect(reserved.kind).toBe('reserved');
      if (reserved.kind !== 'reserved') return;
      // Lapse our own reservation window into the past (never inverted).
      // Re-read the row: this models the same cycle, only older.
      await pool.query(
        `UPDATE job_card_lifecycle_intents
            SET reserved_at = date_trunc('milliseconds', clock_timestamp()) - interval '120 seconds',
                expires_at = date_trunc('milliseconds', clock_timestamp()) - interval '60 seconds'
          WHERE id = $1`,
        [reserved.reservation.intentId],
      );
      const row = (await pool.query(
        'SELECT reserved_at FROM job_card_lifecycle_intents WHERE id = $1',
        [reserved.reservation.intentId],
      )).rows[0] as { reserved_at: Date };
      const lapsedReservation = { intentId: reserved.reservation.intentId, reservedAt: row.reserved_at };
      let workRan = false;
      await expect(repository.finalizeLifecycleIntent(
        claim,
        lapsedReservation,
        async () => {
          workRan = true;
          return { response: { ok: true }, realtimeEvents: [] };
        },
        { jobCardId },
      )).rejects.toMatchObject({ code: 'LIFECYCLE_INTENT_EXPIRED', statusCode: 409 });
      expect(workRan).toBe(false);
      const job = (await pool.query(
        'SELECT status, version FROM job_cards WHERE id = $1',
        [jobCardId],
      )).rows[0] as Record<string, unknown>;
      expect(job).toMatchObject({ status: 'NEW', version: 1 });
      // Expiry is a definitive failure: no business write survived and the
      // identity is terminal — the 049 contract says expired identities
      // require a new client action key, so the lapse is recorded as FAILED
      // instead of leaving an unfinishable PENDING row behind.
      const state = (await pool.query(
        'SELECT state, failure_code FROM job_card_lifecycle_intents WHERE id = $1',
        [reserved.reservation.intentId],
      )).rows[0] as Record<string, unknown>;
      expect(state.state).toBe('FAILED');
      expect(state.failure_code).toBe('LIFECYCLE_INTENT_EXPIRED');
    });
  });
});

describe.skipIf(!databaseUrl)('049 lifecycle service integration', () => {
  it('START reserves first: started_at and receipt time equal reserved_at, replay is stable', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertIntentOrg(pool, 'Service Org');
      const staffId = await insertIntentUser(pool, organizationId, 'STAFF');
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Intent Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      const staff = { id: staffId, organizationId, role: 'STAFF' } as JobCardActor;
      const service = new JobCardService(new PostgresJobCardRepository(pool));
      const created = await service.create(staff, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Intent servis işi',
        description: null,
        customerId,
        contactId: null,
        assignedTo: staffId,
        priority: 'normal',
        dueDate: null,
        scheduledAt: null,
        scheduledEndsAt: null,
        engagementKind: null,
      }) as unknown as { id: string; version: number; status: string };
      // Self-assigned staff creation auto-accepts.
      expect(created.status).toBe('ACCEPTED');
      const startActionId = randomUUID();
      const started = await service.start(staff, created.id, {
        clientActionId: startActionId,
        expectedVersion: created.version,
      }) as unknown as { status: string; version: number };
      expect(started.status).toBe('IN_PROGRESS');

      // The START intent is COMPLETED exactly once with DB-sampled business time.
      const intents = (await pool.query(
        `SELECT state, reserved_at, expires_at, expected_version, p.response_body
           FROM job_card_lifecycle_intents i JOIN processed_actions p USING (organization_id,user_id,client_action_id,operation_key)
          WHERE organization_id = $1 AND job_card_id = $2 AND operation_key = $3`,
        [organizationId, created.id, `JOB_START:${created.id}`],
      )).rows as Record<string, unknown>[];
      expect(intents).toHaveLength(1);
      expect(intents[0]!.state).toBe('COMPLETED');
      const reservedAt = (intents[0]!.reserved_at as Date).getTime();
      expect(new Date(intents[0]!.expires_at as Date).getTime() - reservedAt).toBe(60_000);
      // Receipt evaluatedAt is the reservation instant, never service-entry time.
      expect((intents[0]!.response_body as Record<string, unknown>).evaluatedAt)
        .toBe(new Date(reservedAt).toISOString());

      // Lifecycle business time: started_at and receipt evaluatedAt equal reserved_at.
      const job = (await pool.query(
        'SELECT status, version, started_at FROM job_cards WHERE id = $1',
        [created.id],
      )).rows[0] as Record<string, unknown>;
      expect(job).toMatchObject({ status: 'IN_PROGRESS', version: created.version + 1 });
      expect(new Date(job.started_at as string).getTime()).toBe(reservedAt);

      // The lifecycle receipt commits in processed_actions with the business mutation.
      const processed = (await pool.query(
        'SELECT COUNT(*) AS count FROM processed_actions WHERE operation_key = $1',
        [`JOB_START:${created.id}`],
      )).rows[0] as Record<string, unknown>;
      expect(processed.count).toBe('1');

      // Exact replay: same result, no new intent, no version bump.
      const replayed = await service.start(staff, created.id, {
        clientActionId: startActionId,
        expectedVersion: created.version,
      }) as unknown as { status: string; version: number };
      expect(replayed.status).toBe('IN_PROGRESS');
      expect(replayed.version).toBe(started.version);
      const intentCount = (await pool.query(
        'SELECT COUNT(*) AS count FROM job_card_lifecycle_intents WHERE job_card_id = $1',
        [created.id],
      )).rows[0] as Record<string, unknown>;
      expect(intentCount.count).toBe('1');
    });
  });
});
