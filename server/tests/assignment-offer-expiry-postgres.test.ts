import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  PostgresAssignmentOfferExpiryRepository,
  createAssignmentOfferExpiryWorker,
} from '../src/modules/job-cards/assignment-offer-expiry-worker.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { MINUTE_MS, readDbBaseline } from './support/db-clock-baseline.js';

/**
 * JOB-010 release 2b — assignment offer expiry worker
 * (`docs/features/assignment-acceptance-sla.md` "Expiry worker", §6).
 *
 * The worker is a clock-only, opt-in background job: it never decides
 * lateness (the server does that per request) and never cancels a JobCard. It
 * sends the single halfway reminder and closes an unanswered offer as
 * `EXPIRED`, at most once per offer and kind, under the JobCard row lock.
 *
 * With `JOB_ASSIGNMENT_WINDOW_ENABLED=false` (the production default) the
 * worker is never constructed; that wiring assertion is not reachable from a
 * database test and is left to the config/index review, so this file only
 * exercises the constructed worker.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `job010exp_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, name = 'JOB-010 Süre Klinik'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [name],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
  name = `${role} User`,
  isActive = true,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, $5) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role, isActive],
  )).rows[0]!.id;
}

type FixtureJob = { id: string; version: number; status: string };

async function insertJob(pool: Pool, input: {
  organizationId: string;
  assignedTo: string;
  createdBy: string;
  scheduledAt: Date;
  scheduledEndsAt: Date;
}): Promise<FixtureJob> {
  const row = (await pool.query<{ id: string; version: number; status: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        scheduled_at, scheduled_ends_at, engagement_kind)
     VALUES ($1, 'SALES_MEETING', 'NEW', 'Süre dolumu testi', $2, $3,
             $4::timestamptz, $5::timestamptz, 'SALES_MEETING')
     RETURNING id, version, status`,
    [input.organizationId, input.assignedTo, input.createdBy, input.scheduledAt, input.scheduledEndsAt],
  )).rows[0]!;
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
        organization_timezone, source, created_by, created_at)
     VALUES ($1, $2, 1, $3, $4, 'Europe/Istanbul', 'CREATE', $5, $6)`,
    [
      input.organizationId, row.id, input.scheduledAt, input.scheduledEndsAt,
      input.createdBy, new Date(input.scheduledAt.getTime() - 60 * MINUTE_MS),
    ],
  );
  return { id: row.id, version: Number(row.version), status: String(row.status) };
}

type OfferRow = {
  id: string;
  state: string;
  opened_at: Date;
  acceptance_due_at: Date;
  closed_at: Date | null;
  closed_by: string | null;
  close_reason: string | null;
};

async function insertOffer(pool: Pool, input: {
  organizationId: string;
  jobCardId: string;
  assigneeUserId: string;
  openedBy: string;
  openedAt: Date;
  acceptanceDueAt: Date;
}): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_assignment_offers
       (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason, opened_by,
        acceptance_due_at, state)
     VALUES ($1, $2, $3, $4, 'CREATE', $5, $6, 'OPEN')
     RETURNING id`,
    [
      input.organizationId, input.jobCardId, input.assigneeUserId, input.openedAt,
      input.openedBy, input.acceptanceDueAt,
    ],
  )).rows[0]!.id;
}

async function readOffer(pool: Pool, offerId: string): Promise<OfferRow> {
  return (await pool.query<OfferRow>(
    `SELECT id, state, opened_at, acceptance_due_at, closed_at, closed_by, close_reason
       FROM job_card_assignment_offers WHERE id = $1`,
    [offerId],
  )).rows[0]!;
}

async function readOfferNotifications(pool: Pool, offerId: string) {
  return (await pool.query<{ kind: string; sent_at: Date }>(
    `SELECT kind, sent_at FROM job_card_assignment_offer_notifications
      WHERE offer_id = $1 ORDER BY kind ASC`,
    [offerId],
  )).rows;
}

async function selectNotifications(pool: Pool, organizationId: string, jobCardId: string) {
  return (await pool.query<{ recipient_user_id: string; kind: string }>(
    `SELECT recipient_user_id, kind FROM in_app_notifications
      WHERE organization_id = $1 AND entity_type = 'job-card' AND entity_id = $2
      ORDER BY created_at ASC, id ASC`,
    [organizationId, jobCardId],
  )).rows;
}

async function selectActivities(pool: Pool, jobCardId: string): Promise<string[]> {
  return (await pool.query<{ event_type: string }>(
    `SELECT event_type FROM job_card_activity_logs
      WHERE job_card_id = $1 ORDER BY created_at ASC, id ASC`,
    [jobCardId],
  )).rows.map((row) => row.event_type);
}

async function readJob(pool: Pool, jobCardId: string) {
  return (await pool.query<{
    status: string; version: number; assigned_to: string;
  }>(
    `SELECT status, version, assigned_to FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

function buildWorker(pool: Pool, options: { batchSize?: number } = {}) {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  const repository = new PostgresAssignmentOfferExpiryRepository(
    new PostgresJobCardRepository(pool),
    false,
  );
  const worker = createAssignmentOfferExpiryWorker(repository, {
    now: () => new Date(),
    pollIntervalMs: 60_000,
    batchSize: options.batchSize ?? 50,
    publisher,
    onReport: () => undefined,
    onError: () => undefined,
  });
  return { worker, published };
}

/** Halfway between open and deadline, truncated to the millisecond. */
function halfway(openedAt: Date, acceptanceDueAt: Date): Date {
  const opened = openedAt.getTime();
  return new Date(opened + Math.floor((acceptanceDueAt.getTime() - opened) / 2));
}

describe.skipIf(!databaseUrl)('JOB-010 release 2b — assignment offer expiry worker', () => {
  it('sends the halfway reminder once and expires the offer once at the deadline', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const inactiveManagerId = await insertUser(pool, organizationId, 'MANAGER', 'Pasif Müdür', false);
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const job = await insertJob(pool, {
        organizationId, assignedTo: staffId, createdBy: managerId,
        scheduledAt: new Date(baseline.getTime() + 120 * MINUTE_MS),
        scheduledEndsAt: new Date(baseline.getTime() + 180 * MINUTE_MS),
      });
      const offerId = await insertOffer(pool, {
        organizationId, jobCardId: job.id, assigneeUserId: staffId, openedBy: managerId,
        openedAt: baseline,
        acceptanceDueAt: new Date(baseline.getTime() + 60 * MINUTE_MS),
      });
      const offer = await readOffer(pool, offerId);
      const reminderAt = halfway(offer.opened_at, offer.acceptance_due_at);
      expect(reminderAt.getTime()).toBe(baseline.getTime() + 30 * MINUTE_MS);

      const { worker } = buildWorker(pool);

      // Before the halfway point nothing happens.
      await worker.runOnce(new Date(reminderAt.getTime() - 1_000));
      expect(await readOfferNotifications(pool, offerId)).toHaveLength(0);
      expect(await selectNotifications(pool, organizationId, job.id)).toHaveLength(0);
      expect((await readOffer(pool, offerId)).state).toBe('OPEN');

      // At the halfway point the assignee gets exactly one reminder.
      await worker.runOnce(reminderAt);
      const reminderNotifications = (await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.acceptance_reminder');
      expect(reminderNotifications.map((notification) => notification.recipient_user_id))
        .toEqual([staffId]);
      const reminderDelivery = await readOfferNotifications(pool, offerId);
      expect(reminderDelivery).toHaveLength(1);
      expect(reminderDelivery[0]!.kind).toBe('ACCEPTANCE_REMINDER');
      expect(reminderDelivery[0]!.sent_at.toISOString()).toBe(reminderAt.toISOString());
      // A reminder is not an expiry: the offer stays open and the job stays NEW.
      expect((await readOffer(pool, offerId)).state).toBe('OPEN');
      expect(await readJob(pool, job.id)).toMatchObject({ status: 'NEW', assigned_to: staffId });

      // Repeated scans, in the same process and after a restart, never repeat it.
      await worker.runOnce(new Date(reminderAt.getTime() + 5 * MINUTE_MS));
      const restarted = buildWorker(pool);
      await restarted.worker.runOnce(new Date(reminderAt.getTime() + 10 * MINUTE_MS));
      expect((await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.acceptance_reminder')).toHaveLength(1);
      expect(await readOfferNotifications(pool, offerId)).toHaveLength(1);

      // At the deadline (equality is late) the offer expires exactly once.
      const dueAt = offer.acceptance_due_at;
      await worker.runOnce(dueAt);
      const expiredOffer = await readOffer(pool, offerId);
      expect(expiredOffer).toMatchObject({ state: 'EXPIRED', closed_by: null, close_reason: null });
      expect(expiredOffer.closed_at?.toISOString()).toBe(dueAt.toISOString());

      const expiredDelivery = await readOfferNotifications(pool, offerId);
      expect(expiredDelivery.map((entry) => entry.kind).sort())
        .toEqual(['ACCEPTANCE_EXPIRED', 'ACCEPTANCE_REMINDER']);
      expect(expiredDelivery.find((entry) => entry.kind === 'ACCEPTANCE_EXPIRED')?.sent_at.toISOString())
        .toBe(dueAt.toISOString());

      const expiredNotifications = (await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.acceptance_expired');
      expect(expiredNotifications.map((notification) => notification.recipient_user_id).sort())
        .toEqual([adminId, managerId].sort());
      for (const excluded of [staffId, inactiveManagerId]) {
        expect(expiredNotifications.map((notification) => notification.recipient_user_id))
          .not.toContain(excluded);
      }

      const activities = await selectActivities(pool, job.id);
      expect(activities.filter((event) => event === 'JOB_ASSIGNMENT_OFFER_EXPIRED'))
        .toHaveLength(1);
      // Expiry is not a lifecycle transition and never cancels the JobCard.
      expect(activities).not.toContain('JOB_CANCELLED');
      expect(await readJob(pool, job.id)).toMatchObject({
        status: 'NEW', version: job.version, assigned_to: staffId,
      });

      // Further scans (same scan time included) stay converged.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await worker.runOnce(new Date(dueAt.getTime() + attempt * MINUTE_MS));
      }
      expect(await readOfferNotifications(pool, offerId)).toHaveLength(2);
      expect((await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.acceptance_expired')).toHaveLength(2);
      expect((await selectActivities(pool, job.id))
        .filter((event) => event === 'JOB_ASSIGNMENT_OFFER_EXPIRED')).toHaveLength(1);
    });
  });

  it('never expires an offer with an in-flight reservation taken before the deadline', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const dueAt = new Date(baseline.getTime() + 60 * MINUTE_MS);

      const makeOffer = async (offsetMinutes: number) => {
        const job = await insertJob(pool, {
          organizationId, assignedTo: staffId, createdBy: managerId,
          scheduledAt: new Date(baseline.getTime() + (offsetMinutes + 120) * MINUTE_MS),
          scheduledEndsAt: new Date(baseline.getTime() + (offsetMinutes + 180) * MINUTE_MS),
        });
        const offerId = await insertOffer(pool, {
          organizationId, jobCardId: job.id, assigneeUserId: staffId, openedBy: managerId,
          openedAt: baseline, acceptanceDueAt: dueAt,
        });
        return { job, offerId };
      };
      const insertReservation = async (input: {
        jobCardId: string;
        reservedAt: Date;
        expiresAt: Date;
        command?: 'ACCEPT_ASSIGNMENT' | 'DECLINE_ASSIGNMENT';
      }) => pool.query(
        `INSERT INTO job_card_lifecycle_intents
           (organization_id, job_card_id, user_id, client_action_id, operation_key, command,
            expected_version, state, reserved_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 'PENDING', $7, $8)`,
        [
          organizationId, input.jobCardId, staffId, randomUUID(),
          `TEST:${input.command ?? 'ACCEPT_ASSIGNMENT'}`, input.command ?? 'ACCEPT_ASSIGNMENT',
          input.reservedAt, input.expiresAt,
        ],
      );

      const accepting = await makeOffer(0);
      const declining = await makeOffer(10);
      const stale = await makeOffer(20);

      // Two live reservations reserved before the deadline (one ACCEPT, one
      // DECLINE) win over clock-only expiry.
      await insertReservation({
        jobCardId: accepting.job.id,
        reservedAt: new Date(dueAt.getTime() - 1_000),
        expiresAt: new Date(dueAt.getTime() + 5 * MINUTE_MS),
      });
      await insertReservation({
        jobCardId: declining.job.id,
        reservedAt: new Date(dueAt.getTime() - 1_000),
        expiresAt: new Date(dueAt.getTime() + 5 * MINUTE_MS),
        command: 'DECLINE_ASSIGNMENT',
      });
      // A reservation taken after the deadline cannot exist for a real
      // request (the server rejects it) and must not block expiry.
      await insertReservation({
        jobCardId: stale.job.id,
        reservedAt: new Date(dueAt.getTime() + 1_000),
        expiresAt: new Date(dueAt.getTime() + 5 * MINUTE_MS),
      });

      const { worker } = buildWorker(pool);
      await worker.runOnce(new Date(dueAt.getTime() + 1_000));

      expect((await readOffer(pool, accepting.offerId)).state).toBe('OPEN');
      expect((await readOffer(pool, declining.offerId)).state).toBe('OPEN');
      expect((await readOfferNotifications(pool, accepting.offerId))
        .filter((entry) => entry.kind === 'ACCEPTANCE_EXPIRED')).toHaveLength(0);
      expect(await selectActivities(pool, accepting.job.id))
        .not.toContain('JOB_ASSIGNMENT_OFFER_EXPIRED');
      expect((await readJob(pool, accepting.job.id)).status).toBe('NEW');

      // A reservation taken after the deadline does not protect the offer.
      expect((await readOffer(pool, stale.offerId)).state).toBe('EXPIRED');
      expect(await selectActivities(pool, stale.job.id))
        .toContain('JOB_ASSIGNMENT_OFFER_EXPIRED');

      // Once the in-flight accept really ends, the next scan expires the offer.
      await pool.query(
        `UPDATE job_card_lifecycle_intents
            SET state = 'FAILED', expires_at = $1, failed_at = $1,
                failure_code = 'LIFECYCLE_INTENT_EXPIRED'
          WHERE job_card_id = $2 AND state = 'PENDING'`,
        [new Date(dueAt.getTime() + 2 * MINUTE_MS), accepting.job.id],
      );
      await worker.runOnce(new Date(dueAt.getTime() + 2 * MINUTE_MS));
      expect((await readOffer(pool, accepting.offerId)).state).toBe('EXPIRED');
      expect((await selectNotifications(pool, organizationId, accepting.job.id))
        .filter((notification) => notification.kind === 'job.acceptance_expired'))
        .toHaveLength(1);
    });
  });

  it('respects the bounded batch and keeps scanning the rest', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const dueAt = new Date(baseline.getTime() + 60 * MINUTE_MS);
      const jobs = [] as Array<{ id: string; offerId: string }>;
      for (let index = 0; index < 3; index += 1) {
        const job = await insertJob(pool, {
          organizationId, assignedTo: staffId, createdBy: managerId,
          scheduledAt: new Date(baseline.getTime() + (120 + index * 10) * MINUTE_MS),
          scheduledEndsAt: new Date(baseline.getTime() + (180 + index * 10) * MINUTE_MS),
        });
        const offerId = await insertOffer(pool, {
          organizationId, jobCardId: job.id, assigneeUserId: staffId, openedBy: managerId,
          openedAt: baseline, acceptanceDueAt: dueAt,
        });
        jobs.push({ id: job.id, offerId });
      }

      const { worker } = buildWorker(pool, { batchSize: 1 });
      await worker.runOnce(dueAt);
      await worker.runOnce(new Date(dueAt.getTime() + MINUTE_MS));
      await worker.runOnce(new Date(dueAt.getTime() + 2 * MINUTE_MS));

      for (const job of jobs) {
        expect((await readOffer(pool, job.offerId)).state).toBe('EXPIRED');
        expect((await selectNotifications(pool, organizationId, job.id))
          .filter((notification) => notification.kind === 'job.acceptance_expired'))
          .toHaveLength(1);
      }
    });
  });
});
