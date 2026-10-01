import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import type { ReverseGeocoder } from '../src/modules/job-cards/reverse-geocoder.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import {
  gatePoolStatements,
  insertProofJob,
  insertProofOrg,
  insertProofUser,
  readDbClock,
  waitFor,
  withIntentSchema,
} from './support/lifecycle-intent-harness.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const HEX_HASH = 'cc'.repeat(32);

function intentClaim(organizationId: string, userId: string, jobCardId: string, clientActionId: string) {
  return {
    organizationId,
    userId,
    clientActionId,
    operationKey: `JOB_START:${jobCardId}`,
    command: 'START' as const,
    requestHash: HEX_HASH,
    expectedVersion: 1,
  };
}

describe.skipIf(!databaseUrl)('049 concurrency proofs', () => {
  it('P3: reserved_at is sampled after the JobCard lock wait, not before it', async () => {
    await withIntentSchema(databaseUrl, async (pool, schema) => {
      const organizationId = await insertProofOrg(pool, 'P3 Org');
      const userId = await insertProofUser(pool, organizationId, 'STAFF');
      const jobCardId = await insertProofJob(pool, organizationId, userId);
      const schemaOptions = `-c search_path=${schema},public`;

      // A acquires and HOLDS the target JobCard row lock.
      const holder = new Pool({ connectionString: databaseUrl, options: schemaOptions });
      const holderClient = await holder.connect();
      try {
        await holderClient.query('BEGIN');
        await holderClient.query(
          'SELECT id FROM job_cards WHERE organization_id = $1 AND id = $2 FOR UPDATE',
          [organizationId, jobCardId],
        );

        // B starts a real reservation and must block on A's row lock.
        const blockedPool = new Pool({
          connectionString: databaseUrl,
          options: schemaOptions,
          max: 1,
          application_name: 'ovr49-p3-b',
        });
        try {
          const repository = new PostgresJobCardRepository(blockedPool);
          const pending = repository.reserveLifecycleIntent(
            intentClaim(organizationId, userId, jobCardId, randomUUID()),
            { jobCardId, ttlMs: 60_000 },
          );
          // Prove B is actually blocked on the row lock (no sleep-based assumption).
          await waitFor(async () => {
            const waiting = await pool.query<{ n: string }>(
              `SELECT COUNT(*) AS n FROM pg_stat_activity
                WHERE application_name = 'ovr49-p3-b'
                  AND wait_event_type = 'Lock'`,
            );
            return waiting.rows[0]!.n !== '0';
          }, 5_000, 'B waiting on the JobCard row lock');
          // Witness clock sampled WHILE B is confirmed blocked.
          const blockedAt = await readDbClock(pool);
          await holderClient.query('COMMIT');
          const reserved = await pending;
          expect(reserved.kind).toBe('reserved');
          if (reserved.kind !== 'reserved') return;
          // An implementation sampling reserved_at before the lock wait
          // would produce a time earlier than the blocked witness.
          expect(reserved.reservation.reservedAt.getTime()).toBeGreaterThanOrEqual(blockedAt.getTime());
        } finally {
          await blockedPool.end();
        }
      } finally {
        await holderClient.query('ROLLBACK').catch(() => undefined);
        holderClient.release();
        await holder.end();
      }
    });
  });

  it('P1: committed PENDING is visible during provider block and the JobCard lock is free', async () => {
    await withIntentSchema(databaseUrl, async (pool, schema) => {
      const schemaOptions = `-c search_path=${schema},public`;
      const organizationId = await insertProofOrg(pool, 'P1 Org');
      const staffId = await insertProofUser(pool, organizationId, 'STAFF');
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'P1 Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      const staff = { id: staffId, organizationId, role: 'STAFF' } as JobCardActor;

      // Provider barrier: the fake geocoder blocks until the test releases it.
      let providerEnteredFlag = false;
      let releaseProvider: (() => void) | null = null;
      const providerGate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const geocoder: ReverseGeocoder = {
        reverse: async () => {
          providerEnteredFlag = true;
          await providerGate;
          return { neighborhood: 'N', district: 'D', city: 'C', approximateLabel: 'N, D' };
        },
      };
      const service = new JobCardService(
        new PostgresJobCardRepository(pool),
        () => new Date(),
        { publish: () => undefined },
        { enabled: true, reverseGeocoder: geocoder },
      );
      const created = await service.create(staff, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'P1 işi',
        description: null,
        customerId,
        contactId: null,
        assignedTo: staffId,
        priority: 'normal',
        dueDate: null,
        scheduledAt: null,
        scheduledEndsAt: null,
        engagementKind: null,
      }) as unknown as { id: string; version: number };

      const started = service.start(staff, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: created.version,
        locationCapture: {
          outcome: 'captured',
          latitude: 39.9,
          longitude: 32.8,
          accuracyMeters: 10,
          capturedAt: new Date().toISOString(),
        },
      });
      try {
        await waitFor(async () => providerEnteredFlag, 5_000, 'provider call started');
        // While the provider is blocked: the PENDING reservation is
        // externally visible on a SECOND connection ...
        const pending = (await pool.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM job_card_lifecycle_intents
            WHERE job_card_id = $1 AND state = 'PENDING'`,
          [created.id],
        )).rows[0]!.n;
        expect(pending).toBe('1');
        // ... and the JobCard row itself is free (provider holds no lock).
        const observer = new Pool({ connectionString: databaseUrl, options: schemaOptions });
        try {
          await observer.query(
            'SELECT id FROM job_cards WHERE organization_id = $1 AND id = $2 FOR UPDATE NOWAIT',
            [organizationId, created.id],
          );
        } finally {
          await observer.end();
        }
      } finally {
        releaseProvider?.();
      }
      const detail = await started as unknown as { status: string };
      expect(detail.status).toBe('IN_PROGRESS');
    });
  });

  it('P4: second expiry fence rejects without arbitrary sleep (TTL setup + observed clock)', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'P4 Org');
      const staffId = await insertProofUser(pool, organizationId, 'STAFF');
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'P4 Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      const staff = { id: staffId, organizationId, role: 'STAFF' } as JobCardActor;
      const createInput = {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'P4 işi',
        description: null,
        customerId,
        contactId: null,
        assignedTo: staffId,
        priority: 'normal',
        dueDate: null,
        scheduledAt: null,
        scheduledEndsAt: null,
        engagementKind: null,
      } as const;
      const created = await new JobCardService(new PostgresJobCardRepository(pool)).create(
        staff,
        { ...createInput },
      ) as unknown as { id: string; version: number };
      // Short TTL is configuration (JOB_CARD_LIFECYCLE_INTENT_TTL_MS), not a
      // production clock bypass: production still runs 60_000. The gate is
      // installed only for the START call below.
      const gate = gatePoolStatements(pool, 'UPDATE job_cards');
      const service = new JobCardService(
        new PostgresJobCardRepository(gate.pool),
        () => new Date(),
        { publish: () => undefined },
        { enabled: false },
        { enabled: false },
        { enabled: false, reminderLeadMinutes: 30 },
        { intentTtlMs: 2_000 },
      );
      const started = service.start(staff, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: created.version,
      });
      try {
        // Business work has entered after the first expiry fence and pauses at its write ...
        await gate.arrived;
        const expires = (await pool.query<{ expires_at: Date }>(
          'SELECT expires_at FROM job_card_lifecycle_intents WHERE job_card_id = $1',
          [created.id],
        )).rows[0]!.expires_at;
        // ... the observer confirms the authoritative DB clock reached the
        // expiry (bounded poll, never a guessed fixed delay) ...
        await waitFor(async () => {
          const clock = await readDbClock(pool);
          return clock.getTime() >= expires.getTime();
        }, 5_000, 'DB clock reaching expires_at');
        // ... only then the second check executes and must reject.
        gate.release();
        await expect(started).rejects.toMatchObject({
          code: 'LIFECYCLE_INTENT_EXPIRED',
          statusCode: 409,
        });
      } finally {
        gate.release();
      }
      const job = (await pool.query(
        'SELECT status, version FROM job_cards WHERE id = $1',
        [created.id],
      )).rows[0] as Record<string, unknown>;
      expect(job).toMatchObject({ status: 'ACCEPTED', version: created.version });
      // The barrier genuinely engaged: the START finalization reached it.
      expect(gate.arrivalCount()).toBeGreaterThanOrEqual(1);
    });
  });

  it('ambiguous COMMIT never marks FAILED blindly and surfaces for retry', async () => {
    await withIntentSchema(databaseUrl, async (pool, schema) => {
      const schemaOptions = `-c search_path=${schema},public`;
      const organizationId = await insertProofOrg(pool, 'Ambig Org');
      const userId = await insertProofUser(pool, organizationId, 'STAFF');
      const jobCardId = await insertProofJob(pool, organizationId, userId);
      const terminating = new Pool({
        connectionString: databaseUrl,
        options: schemaOptions,
        max: 1,
        application_name: 'ovr49-ambig',
      });
      // pg_terminate_backend deliberately kills this pool's single connection.
      // node-pg surfaces that socket error as a pool 'error' event; register an
      // expected-event sink so the deliberate termination cannot escape as an
      // unhandled error while the test still asserts the ambiguous outcome.
      terminating.on('error', () => undefined);
      try {
        const repository = new PostgresJobCardRepository(terminating);
        const claim = intentClaim(organizationId, userId, jobCardId, randomUUID());
        const reserved = await repository.reserveLifecycleIntent(claim, { jobCardId, ttlMs: 60_000 });
        expect(reserved.kind).toBe('reserved');
        if (reserved.kind !== 'reserved') return;
        // Kill the finalizer backend between the COMPLETED update and the
        // COMMIT: the outcome is genuinely ambiguous.
        const killer = gatePoolStatements(terminating, 'COMMIT');
        const gatedRepository = new PostgresJobCardRepository(killer.pool);
        const finalizing = (async () => {
          const gate = killer;
          const pending = gatedRepository.finalizeLifecycleIntent<{ ok: boolean }>(            claim,
            reserved.reservation,
            async (tx) => {
              await tx.transitionWithVersion({
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
              return { response: { ok: true }, realtimeEvents: [] };
            },
            { jobCardId },
          );
          await gate.arrived;
          const pid = (await pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE application_name = 'ovr49-ambig' AND pid <> pg_backend_pid()`,
          )).rows[0]?.pid;
          expect(pid).toBeDefined();
          await pool.query('SELECT pg_terminate_backend($1)', [pid]);
          gate.release();
          return pending;
        })();
        await expect(finalizing).rejects.toBeDefined();
        killer.release();
        // The COMMIT interception genuinely engaged.
        expect(killer.arrivalCount()).toBeGreaterThanOrEqual(1);
        // No blind FAILED: the intent is still PENDING and the business
        // write did not survive. Exact retries observe PENDING until expiry;
        // the identity is never re-reserved with a new business timestamp.
        const intent = (await pool.query(
          'SELECT state FROM job_card_lifecycle_intents WHERE id = $1',
          [reserved.reservation.intentId],
        )).rows[0] as Record<string, unknown>;
        expect(intent.state).toBe('PENDING');
        const job = (await pool.query(
          'SELECT status, version FROM job_cards WHERE id = $1',
          [jobCardId],
        )).rows[0] as Record<string, unknown>;
        expect(job).toMatchObject({ status: 'NEW', version: 1 });
        await expect(pool.query('SELECT 1')).resolves.toBeDefined();
      } finally {
        await terminating.end();
      }
    });
  });

  it('controlled overlap: reserve/finalize serialize with one mutation and no deadlock', async () => {
    await withIntentSchema(databaseUrl, async (pool, schema) => {
      const organizationId = await insertProofOrg(pool, 'Deadlock Org');
      const userId = await insertProofUser(pool, organizationId, 'STAFF');
      const jobCardId = await insertProofJob(pool, organizationId, userId);
      const contenderName = `ovr49-overlap-${randomUUID()}`;
      const contenders = new Pool({ connectionString: databaseUrl,
        options: `-c search_path=${schema},public -c lock_timeout=4000`, application_name: contenderName });
      const repository = new PostgresJobCardRepository(pool);
      const contenderRepository = new PostgresJobCardRepository(contenders);
      const clientActionId = randomUUID();
      const owner = intentClaim(organizationId, userId, jobCardId, clientActionId);
      const reservedOwner = await repository.reserveLifecycleIntent(owner, { jobCardId, ttlMs: 60_000 });
      expect(reservedOwner.kind).toBe('reserved');
      if (reservedOwner.kind !== 'reserved') return;

      // A finalizes while holding intent+job locks, paused at the business write.
      const gate = gatePoolStatements(pool, 'SET status = $4::varchar(30)');
      const gatedRepository = new PostgresJobCardRepository(gate.pool);
      const finalizingA = gatedRepository.finalizeLifecycleIntent<{ by: string }>(
        owner,
        reservedOwner.reservation,
        async (tx) => {
          await tx.transitionWithVersion({
            organizationId,
            jobCardId,
            expectedVersion: 1,
            command: 'START',
            status: 'IN_PROGRESS',
            occurredAt: reservedOwner.reservation.reservedAt,
            actorId: userId,
            note: null,
            revisionReason: null,
            cancelReason: null,
            followUpProposal: null,
          });
          return { response: { by: 'a' }, realtimeEvents: [] };
        },
        { jobCardId },
      );
      try {
        await gate.arrived;
        // B (same identity) and C (new identity, stale version) overlap A
        // while A holds the locks.
        const replayB = contenderRepository.reserveLifecycleIntent(owner, { jobCardId, ttlMs: 60_000 });
        const conflictC = contenderRepository.reserveLifecycleIntent(
          { ...owner, clientActionId: randomUUID() },
          { jobCardId, ttlMs: 60_000 },
        ).then(
          () => 'unexpected-reserved',
          (error: unknown) => (error as { code?: unknown }).code,
        );
        await waitFor(async () => {
          const waiting = await pool.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM pg_stat_activity
             WHERE application_name=$1 AND wait_event_type='Lock'
               AND cardinality(pg_blocking_pids(pid)) > 0`, [contenderName]);
          return waiting.rows[0]!.count === 2;
        }, 2_000, 'both reservation contenders blocked on the held JobCard');
        gate.release();
        const [doneA, doneB, doneC] = await Promise.all([finalizingA, replayB, conflictC]);
        expect(doneA.kind).toBe('completed');
        // B replays A's receipt instead of conflicting or deadlocking.
        expect(doneB).toEqual({
          kind: 'replay',
          response: { by: 'a' },
          reservedAt: reservedOwner.reservation.reservedAt,
        });
        // C is a genuinely new attempt on a stale version.
        expect(doneC).toBe('VERSION_CONFLICT');
      } finally {
        gate.release();
        await contenders.end();
      }
      const job = (await pool.query(
        'SELECT status, version FROM job_cards WHERE id = $1',
        [jobCardId],
      )).rows[0] as Record<string, unknown>;
      expect(job).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
      const intents = (await pool.query(
        'SELECT COUNT(*) AS count FROM job_card_lifecycle_intents',
      )).rows[0] as Record<string, unknown>;
      // A completed exactly one intent; C's failed attempt left no row.
      expect(intents.count).toBe('1');
    });
  });
});
