import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { AppError } from '../src/errors/index.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import type { CalendarActor } from '../src/modules/calendar/types.js';
import { findEarliestFollowUpSlot } from '../src/modules/job-cards/follow-up-auto-scheduler.js';
import { suggestedFollowUpInstant } from '../src/modules/job-cards/follow-up-policy.js';
import { canonicalScheduledDurationMs } from '../src/modules/job-cards/job-card-duration.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  FollowUpCreateInput,
  JobCardActor,
  JobCardType,
  NormalizedJobCardCreateInput,
  ProductDeliveryCreateInput,
} from '../src/modules/job-cards/types.js';
import { PostgresStaffOffboardingService } from '../src/modules/people/offboarding.js';
import {
  baselineAlignedToGrid,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  readDbBaseline,
} from './support/db-clock-baseline.js';
import { saleTime, standaloneSale, withSaleFixture } from './support/sale-harness.js';

/**
 * Core staff occupancy (SCH-001 / JOB-012 fix) — acceptance scenarios A1–A14.
 *
 * Contract: scratchpad `occupancy-contract.md` (owner direction 2026-11-25).
 * Planning and staff occupancy are CORE: every conflict check is independent of
 * the `CALENDAR_ENABLED` module flag. Manual `calendar_events` contribute to
 * occupancy ONLY while the Calendar module is enabled; jobs always count.
 *
 * The suite is black-box: it drives the public services (JobCardService,
 * CalendarService, PostgresStaffOffboardingService) against PostgreSQL and
 * asserts the 409 CALENDAR_CONFLICT code plus that nothing was written. Every
 * test constructs its service with an explicit calendar state so OFF/ON is
 * never implicit. Written from the contract, not from current behaviour.
 *
 * Scenario -> test:
 *   A1  -> "A1: ..." (job overlap; adjacency control; Staff projection)
 *   A2  -> "A2: ..." (manual event only, calendar OFF -> allowed)
 *   A3  -> "A3: ..." (manual event only, calendar ON -> 409)
 *   A4  -> "A4: ..." (product delivery create)
 *   A5  -> "A5: ..." (follow-up create)
 *   A6  -> "A6: ..." (management reschedule)
 *   A7  -> "A7: ..." (JOB-012 proposal recorded into an occupied slot)
 *   A8  -> "A8: ..." (JOB-012 proposal approval after the slot got occupied)
 *   A9  -> "A9: ..." (SALE approval delivery)
 *   A10 -> "A10: ..." (available slots OFF / ON)
 *   A11 -> "A11: ..." (follow-up auto-scheduler OFF / ON)
 *   A12 -> "A12: ..." (offboarding transfer)
 *   A13 -> "A13: ..." (Calendar module creating a manual event)
 *   A14 -> "A14: ..." (concurrent creates OFF / ON)
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

/** Calendar module OFF: only jobs occupy. */
const CALENDAR_OFF = { enabled: false, reminderLeadMinutes: 30 } as const;
/** Calendar module ON: ACTIVE manual events contribute as well. */
const CALENDAR_ON = { enabled: true, reminderLeadMinutes: 30 } as const;
type CalendarState = typeof CALENDAR_OFF | typeof CALENDAR_ON;

const WINDOW_ON = { enabled: true } as const;
const WINDOW_OFF = { enabled: false } as const;

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `occupancy_${randomUUID().replaceAll('-', '')}`;
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

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

type Seed = {
  organizationId: string;
  manager: JobCardActor;
  admin: JobCardActor;
  staff: JobCardActor;
  otherStaff: JobCardActor;
  productId: string;
};

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
  name: string,
): Promise<JobCardActor> {
  const id = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
  if (role === 'STAFF') {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, 'Saha Personeli')`,
      [organizationId, id],
    );
  }
  return { id, organizationId, role };
}

async function seedOrganization(pool: Pool, label: string): Promise<Seed> {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [`Doluluk ${label}`],
  )).rows[0]!.id;
  const manager = await insertUser(pool, organizationId, 'MANAGER', `${label} Müdür`);
  const admin = await insertUser(pool, organizationId, 'ADMIN', `${label} Yönetici`);
  const staff = await insertUser(pool, organizationId, 'STAFF', `${label} Saha Personeli`);
  const otherStaff = await insertUser(pool, organizationId, 'STAFF', `${label} Diğer Personel`);
  const productId = (await pool.query<{ id: string }>(
    `INSERT INTO products (organization_id, name, unit) VALUES ($1, 'İmplant Seti', 'adet') RETURNING id`,
    [organizationId],
  )).rows[0]!.id;
  return { organizationId, manager, admin, staff, otherStaff, productId };
}

async function insertCustomer(pool: Pool, organizationId: string, name?: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, name ?? `Klinik ${randomUUID().slice(0, 8)}`],
  )).rows[0]!.id;
}

type FixtureJob = { id: string; version: number; scheduledAt: string; scheduledEndsAt: string };

/**
 * Direct fixture insert of an existing planned on-site job. The commands under
 * test are the unit here; the job only has to satisfy the persisted lifecycle
 * constraints (with its baseline schedule/assignment history).
 */
async function insertJob(pool: Pool, input: {
  organizationId: string;
  type: Extract<JobCardType, 'SALES_MEETING' | 'PRODUCT_DELIVERY'>;
  status?: 'NEW' | 'ACCEPTED';
  assignedTo: string;
  createdBy: string;
  title?: string;
  scheduledAt: string;
  scheduledEndsAt: string;
}): Promise<FixtureJob> {
  const status = input.status ?? 'NEW';
  const acceptedAt = status === 'ACCEPTED' ? '2026-01-01T08:00:00.000Z' : null;
  const row = (await pool.query<{ id: string; version: number }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, assigned_to, created_by,
        accepted_at, accepted_by, scheduled_at, scheduled_ends_at, engagement_kind)
     VALUES ($1, $2, $3, $4, NULL, $5, $6,
             $7::timestamptz, $8::uuid, $9::timestamptz, $10::timestamptz, $11)
     RETURNING id, version`,
    [
      input.organizationId, input.type, status,
      input.title ?? 'Mevcut planlı iş',
      input.assignedTo, input.createdBy,
      acceptedAt, acceptedAt === null ? null : input.assignedTo,
      input.scheduledAt, input.scheduledEndsAt,
      input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null,
    ],
  )).rows[0]!;
  const createdAt = new Date(Date.parse(input.scheduledAt) - 60 * MINUTE_MS);
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
        organization_timezone, source, created_by, created_at)
     VALUES ($1, $2, 1, $3, $4, 'Europe/Istanbul', 'CREATE', $5, $6)`,
    [input.organizationId, row.id, input.scheduledAt, input.scheduledEndsAt, input.createdBy, createdAt],
  );
  await pool.query(
    `INSERT INTO job_card_assignment_history
       (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
     VALUES ($1, $2, NULL, $3, $4, 'CREATE', $5)`,
    [input.organizationId, row.id, input.assignedTo, input.createdBy, createdAt],
  );
  return {
    id: row.id,
    version: Number(row.version),
    scheduledAt: input.scheduledAt,
    scheduledEndsAt: input.scheduledEndsAt,
  };
}

async function insertManualEvent(pool: Pool, input: {
  organizationId: string;
  assignedUserId: string;
  createdBy: string;
  title?: string;
  startsAt: string;
  endsAt: string;
  status?: 'ACTIVE' | 'CANCELLED';
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO calendar_events
       (id, organization_id, assigned_user_id, title, starts_at, ends_at, timezone,
        created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'Europe/Istanbul', $7, $7)`,
    [
      id, input.organizationId, input.assignedUserId, input.title ?? 'Manuel takvim kaydı',
      input.startsAt, input.endsAt, input.createdBy,
    ],
  );
  if (input.status === 'CANCELLED') {
    await pool.query(
      `UPDATE calendar_events
          SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = $2, cancel_reason = 'test'
        WHERE id = $1`,
      [id, input.createdBy],
    );
  }
  return id;
}

/**
 * Business footprint of one organization: row counts of every table a rejected
 * command could touch. A rejected command must leave it byte-identical.
 */
const FOOTPRINT_TABLES = [
  'job_cards',
  'job_card_activity_logs',
  'job_card_schedule_revisions',
  'job_card_assignment_history',
  'job_card_assignment_offers',
  'job_card_delivery_items',
  'calendar_events',
  'calendar_reminders',
  'processed_actions',
  'audit_events',
  'realtime_events',
  'in_app_notifications',
] as const;

async function readFootprint(pool: Pool, organizationId: string): Promise<Record<string, number>> {
  const footprint: Record<string, number> = {};
  for (const table of FOOTPRINT_TABLES) {
    footprint[table] = Number((await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ${table} WHERE organization_id = $1`,
      [organizationId],
    )).rows[0]!.n);
  }
  return footprint;
}

async function countStaffJobs(pool: Pool, organizationId: string, staffId: string): Promise<number> {
  return Number((await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM job_cards WHERE organization_id = $1 AND assigned_to = $2`,
    [organizationId, staffId],
  )).rows[0]!.n);
}

type JobRow = {
  status: string;
  version: number;
  assigned_to: string;
  scheduled_at: Date | null;
  scheduled_ends_at: Date | null;
};

async function readJob(pool: Pool, jobCardId: string): Promise<JobRow> {
  return (await pool.query<JobRow>(
    `SELECT status, version, assigned_to, scheduled_at, scheduled_ends_at
       FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

async function readOffers(pool: Pool, jobCardId: string) {
  return (await pool.query(
    `SELECT id, assignee_user_id, state, closed_at, closed_by, close_reason, close_text,
            proposed_scheduled_at, proposal_accepted_at, proposal_accepted_by
       FROM job_card_assignment_offers
      WHERE job_card_id = $1
      ORDER BY opened_at ASC, id ASC`,
    [jobCardId],
  )).rows;
}

async function readJobEvidence(pool: Pool, jobCardId: string) {
  return {
    job: await readJob(pool, jobCardId),
    offers: await readOffers(pool, jobCardId),
    activities: (await pool.query<{ event_type: string }>(
      `SELECT event_type FROM job_card_activity_logs
        WHERE job_card_id = $1 ORDER BY created_at ASC, id ASC`,
      [jobCardId],
    )).rows.map((row) => row.event_type),
    revisions: (await pool.query(
      `SELECT revision_no, scheduled_at, scheduled_ends_at, source
         FROM job_card_schedule_revisions WHERE job_card_id = $1 ORDER BY revision_no ASC`,
      [jobCardId],
    )).rows,
  };
}

function buildService(
  pool: Pool,
  clock: { now: Date },
  calendar: CalendarState,
  assignmentWindow: { enabled: boolean } = WINDOW_OFF,
): JobCardService {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    { publish: () => undefined },
    { enabled: false },
    { enabled: false },
    calendar,
    {},
    assignmentWindow,
  );
}

function iso(baseline: Date, offsetMs: number): string {
  return new Date(baseline.getTime() + offsetMs).toISOString();
}

function detailsOf(error: AppError): Record<string, unknown> {
  return (error.details ?? {}) as Record<string, unknown>;
}

async function rejectionOf(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (caught) {
    return caught as AppError;
  }
  throw new Error('Expected the command to be rejected, but it succeeded.');
}

function expectCalendarConflict(error: AppError) {
  expect(error).toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
}

function expectConflictRow(error: AppError, expected: { source: 'JOB' | 'MANUAL'; id: string }) {
  const conflicts = detailsOf(error).conflicts as Array<Record<string, unknown>>;
  expect(conflicts).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: expected.source, id: expected.id }),
  ]));
}

function meetingInput(
  staffId: string,
  customerId: string,
  startsAt: string,
): Extract<NormalizedJobCardCreateInput, { type: 'SALES_MEETING' }> {
  return {
    clientActionId: randomUUID(),
    type: 'SALES_MEETING',
    title: 'Klinik müşteri görüşmesi',
    description: null,
    customerId,
    contactId: null,
    assignedTo: staffId,
    priority: 'normal',
    dueDate: null,
    scheduledAt: startsAt,
    scheduledEndsAt: new Date(Date.parse(startsAt) + 60 * MINUTE_MS).toISOString(),
    engagementKind: 'SALES_MEETING',
  };
}

function deliveryInput(
  seed: Seed,
  customerId: string,
  startsAt: string,
): ProductDeliveryCreateInput {
  return {
    clientActionId: randomUUID(),
    type: 'PRODUCT_DELIVERY',
    title: 'Klinik ürün teslimi',
    description: null,
    customerId,
    contactId: null,
    assignedTo: seed.staff.id,
    priority: 'normal',
    dueDate: null,
    scheduledAt: startsAt,
    scheduledEndsAt: new Date(Date.parse(startsAt) + 30 * MINUTE_MS).toISOString(),
    overrideReason: null,
    deliveryPurpose: 'SALE',
    deliveryNote: null,
    items: [{ productId: seed.productId, quantity: 2 }],
  };
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

describe.skipIf(!databaseUrl)('core staff occupancy — acceptance scenarios', { timeout: 90_000 }, () => {
  it('A1: calendar OFF — creating a SALES_MEETING over another active on-site job of the same staff is 409 and writes nothing', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'A1');
      const existing = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'SALES_MEETING', assignedTo: seed.staff.id,
        createdBy: seed.manager.id, scheduledAt: iso(baseline, 48 * HOUR_MS),
        scheduledEndsAt: iso(baseline, 49 * HOUR_MS),
      });
      const customerId = await insertCustomer(pool, seed.organizationId);
      const service = buildService(pool, { now: baseline }, CALENDAR_OFF);

      const before = await readFootprint(pool, seed.organizationId);
      const error = await rejectionOf(() => service.create(
        seed.manager,
        meetingInput(seed.staff.id, customerId, iso(baseline, 48 * HOUR_MS + 30 * MINUTE_MS)),
      ));
      expectCalendarConflict(error);
      expectConflictRow(error, { source: 'JOB', id: existing.id });
      // No job, activity, audit, receipt or notification was written.
      expect(await readFootprint(pool, seed.organizationId)).toEqual(before);
      expect(await countStaffJobs(pool, seed.organizationId, seed.staff.id)).toBe(1);
    });
  });

  it('A1 control: calendar OFF — an interval that only touches the end of the other job (half-open) is allowed', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'A1 control');
      await insertJob(pool, {
        organizationId: seed.organizationId, type: 'SALES_MEETING', assignedTo: seed.staff.id,
        createdBy: seed.manager.id, scheduledAt: iso(baseline, 48 * HOUR_MS),
        scheduledEndsAt: iso(baseline, 49 * HOUR_MS),
      });
      const customerId = await insertCustomer(pool, seed.organizationId);
      const service = buildService(pool, { now: baseline }, CALENDAR_OFF);

      const created = await service.create(
        seed.manager,
        meetingInput(seed.staff.id, customerId, iso(baseline, 49 * HOUR_MS)),
      );
      expect(created).toMatchObject({ scheduledAt: iso(baseline, 49 * HOUR_MS) });
      expect(await countStaffJobs(pool, seed.organizationId, seed.staff.id)).toBe(2);
    });
  });

  it('A1 projection: calendar OFF — a Staff self-create gets the 409 without other plans in the details', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'A1 staff');
      await insertJob(pool, {
        organizationId: seed.organizationId, type: 'PRODUCT_DELIVERY', assignedTo: seed.staff.id,
        createdBy: seed.manager.id, scheduledAt: iso(baseline, 48 * HOUR_MS),
        scheduledEndsAt: iso(baseline, 48 * HOUR_MS + 30 * MINUTE_MS),
      });
      const customerId = await insertCustomer(pool, seed.organizationId);
      const service = buildService(pool, { now: baseline }, CALENDAR_OFF);

      const before = await readFootprint(pool, seed.organizationId);
      const error = await rejectionOf(() => service.create(
        seed.staff,
        meetingInput(seed.staff.id, customerId, iso(baseline, 48 * HOUR_MS + 10 * MINUTE_MS)),
      ));
      expectCalendarConflict(error);
      expect(detailsOf(error)).toEqual({ conflicts: [] });
      expect(await readFootprint(pool, seed.organizationId)).toEqual(before);
    });
  });

  it('A2: calendar OFF — creating over an ACTIVE manual calendar event only succeeds and leaves the event untouched', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'A2');
      const eventId = await insertManualEvent(pool, {
        organizationId: seed.organizationId, assignedUserId: seed.staff.id,
        createdBy: seed.manager.id, startsAt: iso(baseline, 48 * HOUR_MS),
        endsAt: iso(baseline, 50 * HOUR_MS),
      });
      const customerId = await insertCustomer(pool, seed.organizationId);
      const service = buildService(pool, { now: baseline }, CALENDAR_OFF);

      const created = await service.create(
        seed.manager,
        meetingInput(seed.staff.id, customerId, iso(baseline, 48 * HOUR_MS + 30 * MINUTE_MS)),
      );
      expect(created).toMatchObject({ scheduledAt: iso(baseline, 48 * HOUR_MS + 30 * MINUTE_MS) });
      expect(await countStaffJobs(pool, seed.organizationId, seed.staff.id)).toBe(1);

      // Events are never deleted or changed by the module being off.
      const events = (await pool.query<{ id: string; status: string; version: number }>(
        `SELECT id, status, version FROM calendar_events WHERE organization_id = $1`,
        [seed.organizationId],
      )).rows;
      expect(events).toEqual([{ id: eventId, status: 'ACTIVE', version: 1 }]);
    });
  });

  it('A3: calendar ON — the same create over an ACTIVE manual event is 409 and writes nothing (regression)', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'A3');
      const eventId = await insertManualEvent(pool, {
        organizationId: seed.organizationId, assignedUserId: seed.staff.id,
        createdBy: seed.manager.id, startsAt: iso(baseline, 48 * HOUR_MS),
        endsAt: iso(baseline, 50 * HOUR_MS),
      });
      const customerId = await insertCustomer(pool, seed.organizationId);
      const service = buildService(pool, { now: baseline }, CALENDAR_ON);

      const before = await readFootprint(pool, seed.organizationId);
      const error = await rejectionOf(() => service.create(
        seed.manager,
        meetingInput(seed.staff.id, customerId, iso(baseline, 48 * HOUR_MS + 30 * MINUTE_MS)),
      ));
      expectCalendarConflict(error);
      expectConflictRow(error, { source: 'MANUAL', id: eventId });
      expect(await readFootprint(pool, seed.organizationId)).toEqual(before);

      // A CANCELLED manual event never occupies, even with the module on.
      const cancelledOnly = await seedOrganization(pool, 'A3 cancelled');
      await insertManualEvent(pool, {
        organizationId: cancelledOnly.organizationId, assignedUserId: cancelledOnly.staff.id,
        createdBy: cancelledOnly.manager.id, startsAt: iso(baseline, 48 * HOUR_MS),
        endsAt: iso(baseline, 50 * HOUR_MS), status: 'CANCELLED',
      });
      const otherCustomerId = await insertCustomer(pool, cancelledOnly.organizationId);
      await expect(service.create(
        cancelledOnly.manager,
        meetingInput(cancelledOnly.staff.id, otherCustomerId, iso(baseline, 48 * HOUR_MS + 30 * MINUTE_MS)),
      )).resolves.toMatchObject({ scheduledAt: iso(baseline, 48 * HOUR_MS + 30 * MINUTE_MS) });
    });
  });

  it('A4: calendar OFF — a product delivery create over a job of the same staff is 409 and writes nothing', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'A4');
      const existing = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'SALES_MEETING', assignedTo: seed.staff.id,
        createdBy: seed.manager.id, scheduledAt: iso(baseline, 48 * HOUR_MS),
        scheduledEndsAt: iso(baseline, 49 * HOUR_MS),
      });
      const customerId = await insertCustomer(pool, seed.organizationId);
      const service = buildService(pool, { now: baseline }, CALENDAR_OFF);

      const before = await readFootprint(pool, seed.organizationId);
      const error = await rejectionOf(() => service.createProductDelivery(
        seed.manager,
        deliveryInput(seed, customerId, iso(baseline, 48 * HOUR_MS + 45 * MINUTE_MS)),
      ));
      expectCalendarConflict(error);
      expectConflictRow(error, { source: 'JOB', id: existing.id });
      expect(await readFootprint(pool, seed.organizationId)).toEqual(before);

      // Control: a free interval is created.
      const free = await service.createProductDelivery(
        seed.manager,
        deliveryInput(seed, customerId, iso(baseline, 72 * HOUR_MS)),
      );
      expect(typeof free.jobCardId).toBe('string');
    });
  });

  it('A5: calendar OFF — a follow-up create over a job of the same staff is 409 and creates no child', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'A5');
      const customerId = await insertCustomer(pool, seed.organizationId);
      const sourceId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, customer_id, assigned_to, created_by,
            started_at, staff_completed_at, staff_completed_by,
            manager_approved_at, manager_approved_by)
         VALUES ($1, 'GENERAL_TASK', 'COMPLETED', 'Tamamlanan görev', $2, $3, $4,
                 $5, $6, $3, $7, $4)
         RETURNING id`,
        [
          seed.organizationId, customerId, seed.staff.id, seed.manager.id,
          iso(baseline, -5 * HOUR_MS), iso(baseline, -4 * HOUR_MS), iso(baseline, -3 * HOUR_MS),
        ],
      )).rows[0]!.id;
      const existing = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'SALES_MEETING', assignedTo: seed.staff.id,
        createdBy: seed.manager.id, scheduledAt: iso(baseline, 48 * HOUR_MS),
        scheduledEndsAt: iso(baseline, 49 * HOUR_MS),
      });
      const service = buildService(pool, { now: baseline }, CALENDAR_OFF);
      const followUp = (startsAt: string): FollowUpCreateInput => ({
        clientActionId: randomUUID(),
        type: 'SALES_MEETING',
        title: 'Takip görüşmesi',
        followUpInstructions: 'Klinikle karar durumunu teyit edin.',
        scheduledAt: startsAt,
        assignedTo: seed.staff.id,
        priority: 'normal',
        dueDate: null,
        contactId: null,
        engagementKind: 'FOLLOW_UP',
      });

      const before = await readFootprint(pool, seed.organizationId);
      const error = await rejectionOf(() => service.createFollowUp(
        seed.manager, sourceId, followUp(iso(baseline, 48 * HOUR_MS + 15 * MINUTE_MS)),
      ));
      expectCalendarConflict(error);
      expectConflictRow(error, { source: 'JOB', id: existing.id });
      expect(await readFootprint(pool, seed.organizationId)).toEqual(before);
      const children = await pool.query(
        `SELECT 1 FROM job_cards WHERE source_job_card_id = $1`, [sourceId],
      );
      expect(children.rowCount).toBe(0);

      // Control: a free interval creates the child.
      await expect(service.createFollowUp(
        seed.manager, sourceId, followUp(iso(baseline, 72 * HOUR_MS)),
      )).resolves.toMatchObject({ type: 'SALES_MEETING', scheduledAt: iso(baseline, 72 * HOUR_MS) });
    });
  });

  it('A6: calendar OFF — a management reschedule into an overlapping job is 409 and the job version/schedule are unchanged', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'A6');
      const moving = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'SALES_MEETING', assignedTo: seed.staff.id,
        createdBy: seed.manager.id, scheduledAt: iso(baseline, 48 * HOUR_MS),
        scheduledEndsAt: iso(baseline, 49 * HOUR_MS),
      });
      const blocker = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'PRODUCT_DELIVERY', assignedTo: seed.staff.id,
        createdBy: seed.manager.id, scheduledAt: iso(baseline, 72 * HOUR_MS),
        scheduledEndsAt: iso(baseline, 72 * HOUR_MS + 30 * MINUTE_MS),
      });
      const service = buildService(pool, { now: baseline }, CALENDAR_OFF);

      const before = await readJobEvidence(pool, moving.id);
      const footprint = await readFootprint(pool, seed.organizationId);
      const error = await rejectionOf(() => service.patch(seed.manager, moving.id, {
        expectedVersion: moving.version,
        scheduledAt: iso(baseline, 72 * HOUR_MS + 10 * MINUTE_MS),
        scheduledEndsAt: iso(baseline, 73 * HOUR_MS + 10 * MINUTE_MS),
      }));
      expectCalendarConflict(error);
      expectConflictRow(error, { source: 'JOB', id: blocker.id });
      expect(await readJobEvidence(pool, moving.id)).toEqual(before);
      expect((await readJob(pool, moving.id)).version).toBe(moving.version);
      expect(await readFootprint(pool, seed.organizationId)).toEqual(footprint);

      // Control: a free target is accepted and bumps the version.
      const moved = await service.patch(seed.manager, moving.id, {
        expectedVersion: moving.version,
        scheduledAt: iso(baseline, 96 * HOUR_MS),
        scheduledEndsAt: iso(baseline, 97 * HOUR_MS),
      });
      expect(moved).toMatchObject({ scheduledAt: iso(baseline, 96 * HOUR_MS) });
    });
  });

  /** NEW SALES_MEETING with an open offer, as the JOB-012 suite seeds it. */
  async function seedOfferedJob(pool: Pool, seed: Seed, baseline: Date): Promise<FixtureJob> {
    const job = await insertJob(pool, {
      organizationId: seed.organizationId, type: 'SALES_MEETING', assignedTo: seed.staff.id,
      createdBy: seed.manager.id, scheduledAt: iso(baseline, 120 * MINUTE_MS),
      scheduledEndsAt: iso(baseline, 240 * MINUTE_MS),
    });
    await pool.query(
      `INSERT INTO job_card_assignment_offers
         (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason, opened_by,
          acceptance_due_at, state)
       VALUES ($1, $2, $3, $4, 'CREATE', $5, $6, 'OPEN')`,
      [
        seed.organizationId, job.id, seed.staff.id, new Date(baseline.getTime() - 60 * MINUTE_MS),
        seed.manager.id, new Date(baseline.getTime() + 60 * MINUTE_MS),
      ],
    );
    return job;
  }

  type ProposalDecision = Parameters<JobCardService['declineAssignment']>[2] & {
    proposedScheduledAt?: string | null;
  };
  function scheduleConflictDecline(
    job: FixtureJob,
    proposedScheduledAt: string,
  ): ProposalDecision {
    return {
      clientActionId: randomUUID(),
      expectedVersion: job.version,
      reasonCode: 'SCHEDULE_CONFLICT',
      reasonText: 'Aynı saatte başka bir klinik görüşmem var; öğleden sonra uygunum.',
      proposedScheduledAt,
    };
  }

  it('A7: calendar OFF, assignment window ON — a SCHEDULE_CONFLICT decline proposing a time over another job of the Staff is 409 and the offer is unchanged', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'A7');
      const job = await seedOfferedJob(pool, seed, baseline);
      // Another commitment of the same Staff: 330..390 min after baseline.
      const other = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'PRODUCT_DELIVERY', assignedTo: seed.staff.id,
        createdBy: seed.manager.id, scheduledAt: iso(baseline, 330 * MINUTE_MS),
        scheduledEndsAt: iso(baseline, 360 * MINUTE_MS),
      });
      const service = buildService(pool, { now: baseline }, CALENDAR_OFF, WINDOW_ON);

      const before = await readJobEvidence(pool, job.id);
      const footprint = await readFootprint(pool, seed.organizationId);
      // The 120-minute proposal interval (300..420) overlaps `other`.
      const error = await rejectionOf(() => service.declineAssignment(
        seed.staff, job.id, scheduleConflictDecline(job, iso(baseline, 300 * MINUTE_MS)),
      ));
      expectCalendarConflict(error);
      // The existing Staff projection never exposes other plans.
      expect(detailsOf(error)).toEqual({ conflicts: [] });
      expect(await readJobEvidence(pool, job.id)).toEqual(before);
      expect((await readOffers(pool, job.id))[0]).toMatchObject({
        state: 'OPEN', closed_by: null, close_reason: null, proposed_scheduled_at: null,
      });
      expect(await readFootprint(pool, seed.organizationId)).toEqual(footprint);
      void other;

      // Control: a free proposed time is stored.
      const declined = await service.declineAssignment(
        seed.staff, job.id, scheduleConflictDecline(job, iso(baseline, 500 * MINUTE_MS)),
      );
      expect(declined).toMatchObject({ status: 'NEW', version: job.version + 1 });
    });
  });

  it('A8: calendar OFF, assignment window ON — approving a proposal whose slot was taken afterwards is 409 and the job keeps its schedule and version', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'A8');
      const job = await seedOfferedJob(pool, seed, baseline);
      const service = buildService(pool, { now: baseline }, CALENDAR_OFF, WINDOW_ON);

      // Recorded for a free time.
      const proposal = iso(baseline, 300 * MINUTE_MS);
      await service.declineAssignment(seed.staff, job.id, scheduleConflictDecline(job, proposal));
      const declinedVersion = job.version + 1;
      const offer = (await readOffers(pool, job.id))[0] as { id: string };

      // Afterwards another job is created for the same Staff in that interval.
      const taken = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'SALES_MEETING', assignedTo: seed.staff.id,
        createdBy: seed.manager.id, scheduledAt: iso(baseline, 330 * MINUTE_MS),
        scheduledEndsAt: iso(baseline, 390 * MINUTE_MS),
      });

      const before = await readJobEvidence(pool, job.id);
      const footprint = await readFootprint(pool, seed.organizationId);
      const error = await rejectionOf(() => service.acceptAssignmentProposal(
        seed.manager, job.id,
        { clientActionId: randomUUID(), expectedVersion: declinedVersion, offerId: offer.id },
      ));
      expectCalendarConflict(error);
      expectConflictRow(error, { source: 'JOB', id: taken.id });
      expect(await readJobEvidence(pool, job.id)).toEqual(before);
      const persisted = await readJob(pool, job.id);
      expect(persisted.version).toBe(declinedVersion);
      expect(persisted.scheduled_at?.toISOString()).toBe(job.scheduledAt);
      expect(persisted.scheduled_ends_at?.toISOString()).toBe(job.scheduledEndsAt);
      expect(await readFootprint(pool, seed.organizationId)).toEqual(footprint);
    });
  });

  it('A9: calendar OFF — a SALE approval whose delivery overlaps a job of the delivery assignee is 409 and the whole approval is rolled back', async () => {
    await withSaleFixture(async (f) => {
      const service = new JobCardService(
        f.repository, () => saleTime, { publish: () => undefined },
        { enabled: false }, { enabled: false }, CALENDAR_OFF, {}, WINDOW_OFF,
      );
      const minute = 60_000;
      const deliveryAt = new Date(Math.floor((Date.now() + 2 * DAY_MS) / minute) * minute).toISOString();
      const deliveryBody = (scheduledAt: string) => ({
        assignedTo: f.otherStaff.id,
        scheduledAt,
        items: [{ productId: f.products[0]!, quantity: 2 }],
      });
      const waitingSale = async (key: string) => {
        const sale = await standaloneSale(f, { clientActionId: `${key}-standalone` });
        const submitted = await service.submitForApproval(f.staff, sale.jobCardId, {
          clientActionId: `${key}-submit`, expectedVersion: sale.version, note: 'Telefon siparişi.',
        });
        return { saleId: sale.jobCardId, version: submitted.version };
      };
      const blocker = await insertJob(f.pool, {
        organizationId: f.organizationId, type: 'SALES_MEETING', assignedTo: f.otherStaff.id,
        createdBy: f.manager.id,
        scheduledAt: new Date(Date.parse(deliveryAt) - 15 * MINUTE_MS).toISOString(),
        scheduledEndsAt: new Date(Date.parse(deliveryAt) + 45 * MINUTE_MS).toISOString(),
      });

      const { saleId, version } = await waitingSale('a9');
      const footprint = await readFootprint(f.pool, f.organizationId);
      const error = await rejectionOf(() => service.approve(f.manager, saleId, {
        clientActionId: 'a9-approve-conflict',
        expectedVersion: version,
        note: 'Satış onaylandı.',
        delivery: deliveryBody(deliveryAt),
      }));
      expectCalendarConflict(error);
      expectConflictRow(error, { source: 'JOB', id: blocker.id });

      // The whole approval rolled back.
      expect(await readJob(f.pool, saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version });
      expect(await readFootprint(f.pool, f.organizationId)).toEqual(footprint);
      const deliveries = await f.pool.query(`SELECT 1 FROM job_cards WHERE type = 'PRODUCT_DELIVERY'`);
      expect(deliveries.rowCount).toBe(0);
      const facts = await f.pool.query(
        `SELECT 1 FROM job_card_activity_logs WHERE event_type = 'SALE_DELIVERY_CREATED'`,
      );
      expect(facts.rowCount).toBe(0);

      // Control: the same approval with a free delivery interval completes.
      const freeAt = new Date(Date.parse(deliveryAt) + DAY_MS).toISOString();
      const approved = await service.approve(f.manager, saleId, {
        clientActionId: 'a9-approve-free',
        expectedVersion: version,
        note: 'Satış onaylandı.',
        delivery: deliveryBody(freeAt),
      });
      expect(approved).toMatchObject({ status: 'COMPLETED', id: saleId });
    });
  });

  describe('A10: available slots are core', () => {
    // Fixed clock/dates exactly like the NJ-S2 slot suite: America/New_York,
    // same time of day on successive working days, Sunday skipped.
    const CLOCK = new Date('2026-08-16T00:00:00.000Z');
    const requestedStartsAt = '2026-08-16T14:00:00.000Z';
    const requestedEndsAt = '2026-08-16T15:00:00.000Z';
    const JOB_BLOCKED = '2026-08-18T14:00:00.000Z';
    const EVENT_BLOCKED = '2026-08-19T14:00:00.000Z';

    async function seedSlotSearch(pool: Pool) {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('Doluluk A10', 'America/New_York') RETURNING id`,
      )).rows[0]!.id;
      const manager = await insertUser(pool, organizationId, 'MANAGER', 'A10 Müdür');
      const staff = await insertUser(pool, organizationId, 'STAFF', 'A10 Personel');
      const customerId = await insertCustomer(pool, organizationId);
      await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', assignedTo: staff.id, createdBy: manager.id,
        scheduledAt: JOB_BLOCKED, scheduledEndsAt: '2026-08-18T15:00:00.000Z',
      });
      await insertManualEvent(pool, {
        organizationId, assignedUserId: staff.id, createdBy: manager.id,
        startsAt: EVENT_BLOCKED, endsAt: '2026-08-19T15:00:00.000Z',
      });
      return { manager, staff, customerId };
    }

    const request = (staffId: string, customerId: string) => ({
      type: 'SALES_MEETING' as const,
      customerId,
      assignedTo: staffId,
      scheduledAt: requestedStartsAt,
      scheduledEndsAt: requestedEndsAt,
    });

    it('A10 OFF: the request is served (not NOT_FOUND); job-occupied slots are excluded, manual-event-only slots are not', async () => {
      await withSchema(async (pool) => {
        const { manager, staff, customerId } = await seedSlotSearch(pool);
        const service = buildService(pool, { now: CLOCK }, CALENDAR_OFF);

        const result = await service.availableSlots(manager, request(staff.id, customerId));
        const starts = result.slots.map((slot) => slot.startsAt);
        expect(starts).toContain('2026-08-17T14:00:00.000Z');
        expect(starts).not.toContain(JOB_BLOCKED);
        expect(starts).toContain(EVENT_BLOCKED);
      });
    });

    it('A10 ON: slots blocked only by an ACTIVE manual event are excluded as well (regression)', async () => {
      await withSchema(async (pool) => {
        const { manager, staff, customerId } = await seedSlotSearch(pool);
        const service = buildService(pool, { now: CLOCK }, CALENDAR_ON);

        const result = await service.availableSlots(manager, request(staff.id, customerId));
        const starts = result.slots.map((slot) => slot.startsAt);
        expect(starts).toContain('2026-08-17T14:00:00.000Z');
        expect(starts).not.toContain(JOB_BLOCKED);
        expect(starts).not.toContain(EVENT_BLOCKED);
      });
    });
  });

  describe('A11: follow-up auto-scheduler uses the same occupancy', () => {
    function systemSlotFor(baseline: Date, parentScheduledAtIso: string): string {
      const target = suggestedFollowUpInstant({
        evaluatedAt: baseline,
        sourceScheduledAt: new Date(parentScheduledAtIso),
        timezone: 'Europe/Istanbul',
        durationMs: canonicalScheduledDurationMs('SALES_MEETING'),
        intervalDays: 7,
      });
      const slot = findEarliestFollowUpSlot({
        earliestAllowedAt: target,
        horizonAnchorAt: target,
        type: 'SALES_MEETING',
        timezone: 'Europe/Istanbul',
        blockers: [],
      });
      if (!slot) throw new Error('Expected an automatic follow-up slot on a free calendar.');
      return slot.startsAt.toISOString();
    }

    /**
     * Staff completes a customer visit that requires a follow-up while a
     * manual event blocks the free-calendar target slot for one hour; returns
     * the auto-proposed follow-up start next to the free-calendar target.
     */
    async function proposeWithManualBlocker(pool: Pool, calendar: CalendarState) {
      const baseline = baselineAlignedToGrid(await readDbBaseline(pool));
      const seed = await seedOrganization(pool, `A11 ${calendar.enabled ? 'ON' : 'OFF'}`);
      const service = buildService(pool, { now: baseline }, calendar);
      const customerId = await insertCustomer(pool, seed.organizationId);

      const parentAt = new Date(baseline.getTime() - DAY_MS);
      parentAt.setUTCHours(10, 0, 0, 0);
      const targetAt = systemSlotFor(baseline, parentAt.toISOString());
      const blockerEnd = iso(new Date(targetAt), HOUR_MS);
      await insertManualEvent(pool, {
        organizationId: seed.organizationId, assignedUserId: seed.staff.id,
        createdBy: seed.manager.id, title: 'Takip saatini kapatan manuel kayıt',
        startsAt: targetAt, endsAt: blockerEnd,
      });

      const job = await service.create(seed.staff, {
        ...meetingInput(seed.staff.id, customerId, parentAt.toISOString()),
        engagementKind: 'CUSTOMER_VISIT',
      });
      const started = await service.start(seed.staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      await service.patchMeetingDetails(seed.staff, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: started.version,
        meetingAt: iso(baseline, -90 * MINUTE_MS),
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: 'REQUESTED_LATER',
        meetingSummary: 'Görüşme tamamlandı.',
      });
      const current = await service.detail(seed.staff, job.id);
      const submitted = await service.submitForApproval(seed.staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: current.version, note: 'Ziyaret tamamlandı.',
      });
      return { proposedAt: submitted.followUpProposal?.scheduledAt ?? null, targetAt, blockerEnd };
    }

    it('A11 OFF: a manual event is ignored — the proposal lands on the free-calendar target', async () => {
      await withSchema(async (pool) => {
        const { proposedAt, targetAt } = await proposeWithManualBlocker(pool, CALENDAR_OFF);
        expect(proposedAt).toBe(targetAt);
      });
    });

    it('A11 ON: a manual event is avoided — the proposal starts after the blocker', async () => {
      await withSchema(async (pool) => {
        const { proposedAt, targetAt, blockerEnd } = await proposeWithManualBlocker(pool, CALENDAR_ON);
        expect(proposedAt).not.toBeNull();
        expect(proposedAt).not.toBe(targetAt);
        expect(Date.parse(proposedAt!)).toBeGreaterThanOrEqual(Date.parse(blockerEnd));
      });
    });
  });

  describe('A12: offboarding transfer uses the same occupancy', () => {
    /**
     * The calendar module state is injected into the offboarding service
     * (contract: constructor option, default `{ enabled: false }`, appended
     * after the assignment-window option). The cast keeps this file compiling
     * before that option exists; the explicit state is the point of the test.
     */
    function buildOffboardingService(pool: Pool, calendar: { enabled: boolean }) {
      const Constructor = PostgresStaffOffboardingService as unknown as new (
        ...args: unknown[]
      ) => PostgresStaffOffboardingService;
      return new Constructor(pool, undefined, () => new Date(), { enabled: false }, calendar);
    }

    const TRANSFER_AT = '2026-09-10T10:30:00.000Z';
    const TRANSFER_ENDS_AT = '2026-09-10T11:30:00.000Z';

    async function setup(pool: Pool, label: string) {
      const seed = await seedOrganization(pool, label);
      const target = seed.staff;
      const replacement = seed.otherStaff;
      const transferred = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'ACCEPTED',
        assignedTo: target.id, createdBy: seed.admin.id,
        scheduledAt: TRANSFER_AT, scheduledEndsAt: TRANSFER_ENDS_AT,
      });
      return { seed, target, replacement, transferred };
    }

    async function offboard(
      pool: Pool,
      calendar: { enabled: boolean },
      ctx: Awaited<ReturnType<typeof setup>>,
    ) {
      const service = buildOffboardingService(pool, calendar);
      const admin = { id: ctx.seed.admin.id, organizationId: ctx.seed.organizationId, role: 'ADMIN' } as never;
      const plan = await service.preview(admin, ctx.target.id);
      return service.execute(admin, ctx.target.id, {
        clientActionId: randomUUID(),
        planHash: plan.planHash,
        reasonCode: 'OTHER_ADMINISTRATIVE',
        jobDecisions: [{ jobCardId: ctx.transferred.id, replacementUserId: ctx.replacement.id }],
        calendarDecisions: [],
        followUpDecisions: [],
        customerDecisions: [],
        reminderDecisions: [],
      } as never);
    }

    async function expectNothingTransferred(pool: Pool, ctx: Awaited<ReturnType<typeof setup>>) {
      expect((await readJob(pool, ctx.transferred.id)).assigned_to).toBe(ctx.target.id);
      const targetRow = await pool.query<{ is_active: boolean }>(
        `SELECT is_active FROM users WHERE id = $1`, [ctx.target.id],
      );
      expect(targetRow.rows[0]!.is_active).toBe(true);
    }

    it('A12 jobs, calendar OFF: a replacement with an overlapping job is 409 and nothing is transferred', async () => {
      await withSchema(async (pool) => {
        const ctx = await setup(pool, 'A12 job');
        await insertJob(pool, {
          organizationId: ctx.seed.organizationId, type: 'PRODUCT_DELIVERY',
          assignedTo: ctx.replacement.id, createdBy: ctx.seed.admin.id,
          scheduledAt: '2026-09-10T10:00:00.000Z', scheduledEndsAt: '2026-09-10T11:00:00.000Z',
        });
        const error = await rejectionOf(() => offboard(pool, CALENDAR_OFF, ctx));
        expectCalendarConflict(error);
        await expectNothingTransferred(pool, ctx);
      });
    });

    it('A12 manual event, calendar OFF: a replacement overlapping only a manual event is allowed and the event stays', async () => {
      await withSchema(async (pool) => {
        const ctx = await setup(pool, 'A12 manual OFF');
        const eventId = await insertManualEvent(pool, {
          organizationId: ctx.seed.organizationId, assignedUserId: ctx.replacement.id,
          createdBy: ctx.seed.admin.id, startsAt: '2026-09-10T10:00:00.000Z',
          endsAt: '2026-09-10T11:00:00.000Z',
        });
        const result = await offboard(pool, CALENDAR_OFF, ctx);
        expect(result.status).toBe('OFFBOARDED');
        expect((await readJob(pool, ctx.transferred.id)).assigned_to).toBe(ctx.replacement.id);
        const event = await pool.query<{ status: string }>(
          `SELECT status FROM calendar_events WHERE id = $1`, [eventId],
        );
        expect(event.rows).toEqual([{ status: 'ACTIVE' }]);
      });
    });

    it('A12 manual event, calendar ON: a replacement overlapping only a manual event is 409 and nothing is transferred', async () => {
      await withSchema(async (pool) => {
        const ctx = await setup(pool, 'A12 manual ON');
        await insertManualEvent(pool, {
          organizationId: ctx.seed.organizationId, assignedUserId: ctx.replacement.id,
          createdBy: ctx.seed.admin.id, startsAt: '2026-09-10T10:00:00.000Z',
          endsAt: '2026-09-10T11:00:00.000Z',
        });
        const error = await rejectionOf(() => offboard(pool, CALENDAR_ON, ctx));
        expectCalendarConflict(error);
        await expectNothingTransferred(pool, ctx);
      });
    });
  });

  describe('A13: the Calendar module creating a manual event', () => {
    function calendarService(pool: Pool, now: Date) {
      return new CalendarService(true, new PostgresCalendarRepository(pool, 30, false), () => now);
    }
    const eventInput = (assignedUserId: string, startsAt: string, endsAt: string) => ({
      clientActionId: randomUUID(),
      assignedUserId,
      title: 'Klinik hazırlığı',
      description: null,
      startsAt,
      endsAt,
      timezone: 'Europe/Istanbul',
    });

    it('A13: a manual event overlapping a job of the Staff is 409 CALENDAR_CONFLICT and writes no event (regression)', async () => {
      await withSchema(async (pool) => {
        const baseline = await readDbBaseline(pool);
        const seed = await seedOrganization(pool, 'A13');
        const job = await insertJob(pool, {
          organizationId: seed.organizationId, type: 'SALES_MEETING', assignedTo: seed.staff.id,
          createdBy: seed.manager.id, scheduledAt: iso(baseline, 48 * HOUR_MS),
          scheduledEndsAt: iso(baseline, 49 * HOUR_MS),
        });
        const calendar = calendarService(pool, baseline);
        const calendarManager: CalendarActor = {
          id: seed.manager.id, organizationId: seed.organizationId, role: 'MANAGER',
        };

        const before = await readFootprint(pool, seed.organizationId);
        const error = await rejectionOf(() => calendar.create(
          calendarManager,
          eventInput(seed.staff.id, iso(baseline, 48 * HOUR_MS + 30 * MINUTE_MS), iso(baseline, 50 * HOUR_MS)),
        ));
        expectCalendarConflict(error);
        expectConflictRow(error, { source: 'JOB', id: job.id });
        expect(await readFootprint(pool, seed.organizationId)).toEqual(before);

        // Control: touching the end of the job (half-open) is allowed.
        await expect(calendar.create(
          calendarManager,
          eventInput(seed.staff.id, iso(baseline, 49 * HOUR_MS), iso(baseline, 50 * HOUR_MS)),
        )).resolves.toMatchObject({ source: 'MANUAL' });
      });
    });

    it('A13: a manual event overlapping another ACTIVE manual event of the Staff is 409 (regression)', async () => {
      await withSchema(async (pool) => {
        const baseline = await readDbBaseline(pool);
        const seed = await seedOrganization(pool, 'A13 manual');
        const existingId = await insertManualEvent(pool, {
          organizationId: seed.organizationId, assignedUserId: seed.staff.id,
          createdBy: seed.manager.id, startsAt: iso(baseline, 48 * HOUR_MS),
          endsAt: iso(baseline, 49 * HOUR_MS),
        });
        const calendar = calendarService(pool, baseline);
        const calendarManager: CalendarActor = {
          id: seed.manager.id, organizationId: seed.organizationId, role: 'MANAGER',
        };

        const error = await rejectionOf(() => calendar.create(
          calendarManager,
          eventInput(seed.staff.id, iso(baseline, 48 * HOUR_MS + 30 * MINUTE_MS), iso(baseline, 50 * HOUR_MS)),
        ));
        expectCalendarConflict(error);
        expectConflictRow(error, { source: 'MANUAL', id: existingId });
      });
    });
  });

  describe('A14: concurrent creates serialize on the staff occupancy', () => {
    async function raceTwoCreates(pool: Pool, calendar: CalendarState, label: string) {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, label);
      const service = buildService(pool, { now: baseline }, calendar);
      const startsAt = iso(baseline, 48 * HOUR_MS);
      const firstCustomer = await insertCustomer(pool, seed.organizationId);
      const secondCustomer = await insertCustomer(pool, seed.organizationId);

      const outcomes = await Promise.allSettled([
        service.create(seed.manager, meetingInput(seed.staff.id, firstCustomer, startsAt)),
        service.create(seed.manager, meetingInput(seed.staff.id, secondCustomer, startsAt)),
      ]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      return { seed, fulfilled, rejected };
    }

    it('A14 OFF: exactly one of two concurrent creates for the same staff and interval succeeds', async () => {
      await withSchema(async (pool) => {
        const { seed, fulfilled, rejected } = await raceTwoCreates(pool, CALENDAR_OFF, 'A14 OFF');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expectCalendarConflict(rejected[0]!.reason as AppError);
        expect(await countStaffJobs(pool, seed.organizationId, seed.staff.id)).toBe(1);
      });
    });

    it('A14 ON: exactly one of two concurrent creates for the same staff and interval succeeds (regression)', async () => {
      await withSchema(async (pool) => {
        const { seed, fulfilled, rejected } = await raceTwoCreates(pool, CALENDAR_ON, 'A14 ON');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expectCalendarConflict(rejected[0]!.reason as AppError);
        expect(await countStaffJobs(pool, seed.organizationId, seed.staff.id)).toBe(1);
      });
    });
  });
});
