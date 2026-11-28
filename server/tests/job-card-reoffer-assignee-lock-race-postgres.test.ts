import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { AppError } from '../src/errors/index.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { HOUR_MS } from './support/db-clock-baseline.js';
import {
  gatePoolStatements,
  insertProofOrg,
  insertProofUser,
  readDbClock,
  withIntentSchema,
} from './support/lifecycle-intent-harness.js';

/**
 * JOB-010 release 2b re-offer lock-target fence.
 *
 * `reofferAssignment` reads an unlocked snapshot, then takes the assignee
 * User lock from that snapshot and only afterwards locks the JobCard row.
 * A concurrent reassignment that commits inside that window makes the locked
 * row's assignee (and version) differ from the snapshot. The re-offer must not
 * then test occupancy and open an offer for the new assignee while holding
 * only the previous assignee's User lock (SCH-001 §1: the assignee locks that
 * make the occupancy check race-free are core).
 *
 * The interleaving is proven without timing guesses: the service's first
 * `FOR NO KEY UPDATE` User lock is gated, the unlocked snapshot has already
 * returned, a real committed reassignment runs on a second pool, and only then
 * is the gate released. The competing row change is the only fake; the
 * re-offer transaction, its reads, locks and writes are real PostgreSQL 17.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const WINDOW_ON = { enabled: true } as const;

type Seed = {
  organizationId: string;
  manager: JobCardActor;
  staffA: JobCardActor;
  staffB: JobCardActor;
  jobCardId: string;
};

function buildService(pool: Pool, clock: { now: Date }) {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  const service = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    publisher,
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
    {},
    WINDOW_ON,
  );
  return { service, published };
}

async function seed(pool: Pool, baseline: Date): Promise<Seed> {
  const organizationId = await insertProofOrg(pool, 'REOFFER-LOCK-FENCE');
  const managerId = await insertProofUser(pool, organizationId, 'MANAGER');
  const staffAId = await insertProofUser(pool, organizationId, 'STAFF');
  const staffBId = await insertProofUser(pool, organizationId, 'STAFF');
  const scheduledAt = new Date(baseline.valueOf() + 48 * HOUR_MS);
  const scheduledEndsAt = new Date(scheduledAt.valueOf() + HOUR_MS);
  const jobCardId = (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        scheduled_at, scheduled_ends_at, engagement_kind)
     VALUES ($1, 'SALES_MEETING', 'NEW', 'Klinik ziyareti', $2, $3, $4, $5, 'SALES_MEETING')
     RETURNING id`,
    [organizationId, staffAId, managerId, scheduledAt, scheduledEndsAt],
  )).rows[0]!.id;
  // The newest answer releases the reservation (RESCUE-004/A), so the
  // re-offer is allowed to re-acquire the interval for the current assignee.
  await pool.query(
    `INSERT INTO job_card_assignment_offers
       (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason,
        opened_by, acceptance_due_at, state, closed_at, closed_by, close_reason, close_text)
     VALUES ($1, $2, $3, $4, 'CREATE', $5, $6, 'DECLINED', $4, $3, 'OTHER', 'Uygun değil')`,
    [
      organizationId, jobCardId, staffAId,
      new Date(baseline.valueOf() - HOUR_MS), managerId,
      new Date(baseline.valueOf() - HOUR_MS + 10 * 60_000),
    ],
  );
  return {
    organizationId,
    manager: { id: managerId, organizationId, role: 'MANAGER' },
    staffA: { id: staffAId, organizationId, role: 'STAFF' },
    staffB: { id: staffBId, organizationId, role: 'STAFF' },
    jobCardId,
  };
}

async function readJob(pool: Pool, jobCardId: string) {
  return (await pool.query<{ version: number; assigned_to: string }>(
    `SELECT version, assigned_to FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

async function readOffers(pool: Pool, jobCardId: string) {
  return (await pool.query<{ state: string; assignee_user_id: string }>(
    `SELECT state, assignee_user_id FROM job_card_assignment_offers
      WHERE job_card_id = $1 ORDER BY opened_at ASC, id ASC`,
    [jobCardId],
  )).rows;
}

async function rejectionOf(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (caught) {
    return caught as AppError;
  }
  throw new Error('Expected promise to reject');
}

describe.skipIf(!databaseUrl)('re-offer assignee lock fence', () => {
  it('fails closed when a reassignment commits between the unlocked snapshot and the JobCard lock', async () => {
    await withIntentSchema(databaseUrl, async (pool, schema) => {
      const baseline = await readDbClock(pool);
      const seedData = await seed(pool, baseline);
      const gate = gatePoolStatements(pool, 'FOR NO KEY UPDATE');
      const { service, published } = buildService(gate.pool, { now: baseline });
      const competingPool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      try {
        const before = await readJob(pool, seedData.jobCardId);
        expect(before).toMatchObject({ version: 1, assigned_to: seedData.staffA.id });
        const pending = service.reofferAssignment(seedData.manager, seedData.jobCardId, {
          clientActionId: randomUUID(),
          // The version the concurrent reassignment is about to create.
          expectedVersion: before.version + 1,
        });
        await gate.arrived;
        const reassigned = await competingPool.query(
          `UPDATE job_cards
              SET assigned_to = $2, version = version + 1, updated_at = NOW()
            WHERE organization_id = $1 AND id = $3 AND version = $4`,
          [seedData.organizationId, seedData.staffB.id, seedData.jobCardId, before.version],
        );
        expect(reassigned.rowCount).toBe(1);
        gate.release();

        const error = await rejectionOf(pending);
        expect(error).toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
        // No offer, occupancy acquisition, activity or version bump may be
        // written for the assignee whose User lock was never held.
        expect(await readJob(pool, seedData.jobCardId)).toMatchObject({
          version: before.version + 1,
          assigned_to: seedData.staffB.id,
        });
        expect(await readOffers(pool, seedData.jobCardId)).toEqual([
          { state: 'DECLINED', assignee_user_id: seedData.staffA.id },
        ]);
        expect(published).toEqual([]);
      } finally {
        gate.release();
        await competingPool.end();
      }
    });
  }, 30_000);

  it('keeps re-offering for an unchanged assignee after an unrelated concurrent version bump', async () => {
    await withIntentSchema(databaseUrl, async (pool, schema) => {
      const baseline = await readDbClock(pool);
      const seedData = await seed(pool, baseline);
      const gate = gatePoolStatements(pool, 'FOR NO KEY UPDATE');
      const { service, published } = buildService(gate.pool, { now: baseline });
      const competingPool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      try {
        const before = await readJob(pool, seedData.jobCardId);
        const pending = service.reofferAssignment(seedData.manager, seedData.jobCardId, {
          clientActionId: randomUUID(),
          expectedVersion: before.version + 1,
        });
        await gate.arrived;
        // Same assignee: the lock target is still correct, so this fence must
        // not reject a re-offer that is otherwise current.
        const bumped = await competingPool.query(
          `UPDATE job_cards SET title = title, version = version + 1, updated_at = NOW()
            WHERE organization_id = $1 AND id = $2 AND version = $3`,
          [seedData.organizationId, seedData.jobCardId, before.version],
        );
        expect(bumped.rowCount).toBe(1);
        gate.release();

        const receipt = await pending;
        expect(receipt.jobCardId).toBe(seedData.jobCardId);
        expect(await readJob(pool, seedData.jobCardId)).toMatchObject({
          version: before.version + 2,
          assigned_to: seedData.staffA.id,
        });
        expect(await readOffers(pool, seedData.jobCardId)).toEqual([
          { state: 'DECLINED', assignee_user_id: seedData.staffA.id },
          { state: 'OPEN', assignee_user_id: seedData.staffA.id },
        ]);
        expect(published.length).toBeGreaterThan(0);
      } finally {
        gate.release();
        await competingPool.end();
      }
    });
  }, 30_000);
});
