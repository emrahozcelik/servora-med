import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { AppError } from '../src/errors/index.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import type { CalendarActor } from '../src/modules/calendar/types.js';
import { localDateKey, isSundayDateKey } from '../src/modules/job-cards/local-calendar.js';
import {
  findStaffOccupancyConflicts,
  listStaffOccupiedIntervals,
} from '../src/modules/job-cards/occupancy.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  JobCardActor,
  JobCardStatus,
  JobCardType,
  NormalizedJobCardCreateInput,
} from '../src/modules/job-cards/types.js';
import { PostgresStaffOffboardingService } from '../src/modules/people/offboarding.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, readDbBaseline } from './support/db-clock-baseline.js';

/**
 * RESCUE-004/A — released Staff reservation (SCH-001 addendum).
 *
 * Owner-approved policy: for a planned on-site job in `NEW`, the newest
 * assignment offer (`opened_at DESC, id DESC`, inspected before assignee/state
 * filtering) belonging to the current assignee with state `DECLINED` or
 * `RELEASED` releases the Staff occupancy. OPEN/ACCEPTED/EXPIRED/WITHDRAWN, no
 * offer, another assignee, older rows and every other status keep SCH-001.
 *
 * The suite is black-box where possible: JobCardService, CalendarService and
 * the shared occupancy reader against PostgreSQL 17.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const CALENDAR_OFF = { enabled: false, reminderLeadMinutes: 30 } as const;
const CALENDAR_ON = { enabled: true, reminderLeadMinutes: 30 } as const;
const WINDOW_ON = { enabled: true } as const;
const WINDOW_OFF = { enabled: false } as const;

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `rescue004a_${randomUUID().replaceAll('-', '')}`;
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

type Seed = {
  organizationId: string;
  manager: JobCardActor;
  admin: JobCardActor;
  staff: JobCardActor;
  otherStaff: JobCardActor;
  customerId: string;
  secondCustomerId: string;
  thirdCustomerId: string;
  fourthCustomerId: string;
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
    [organizationId, name, `${randomUUID()}@rescue004a.local`, role],
  )).rows[0]!.id;
  if (role === 'STAFF') {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'Saha Personeli')`,
      [organizationId, id],
    );
  }
  return { id, organizationId, role };
}

async function seedOrganization(pool: Pool, label: string): Promise<Seed> {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone)
     VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [`RESCUE-004/A ${label}`],
  )).rows[0]!.id;
  const manager = await insertUser(pool, organizationId, 'MANAGER', `${label} Müdür`);
  const admin = await insertUser(pool, organizationId, 'ADMIN', `${label} Yönetici`);
  const staff = await insertUser(pool, organizationId, 'STAFF', `${label} Personel A`);
  const otherStaff = await insertUser(pool, organizationId, 'STAFF', `${label} Personel B`);
  const customer = async (name: string) => (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, name],
  )).rows[0]!.id;
  return {
    organizationId,
    manager,
    admin,
    staff,
    otherStaff,
    customerId: await customer(`Klinik ${label} 1`),
    secondCustomerId: await customer(`Klinik ${label} 2`),
    thirdCustomerId: await customer(`Klinik ${label} 3`),
    fourthCustomerId: await customer(`Klinik ${label} 4`),
  };
}

function buildService(
  pool: Pool,
  clock: { now: Date },
  options: {
    calendar?: typeof CALENDAR_OFF | typeof CALENDAR_ON;
    assignmentWindow?: { enabled: boolean };
  } = {},
) {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  const service = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    publisher,
    { enabled: false },
    { enabled: false },
    options.calendar ?? CALENDAR_OFF,
    {},
    options.assignmentWindow ?? WINDOW_ON,
  );
  return { service, published };
}

function iso(base: Date, deltaMs: number): string {
  return new Date(base.valueOf() + deltaMs).toISOString();
}

function meetingInput(input: {
  customerId: string;
  assignedTo: string;
  scheduledAt: string;
  scheduledEndsAt?: string;
  title?: string;
}): NormalizedJobCardCreateInput {
  return {
    clientActionId: randomUUID(),
    type: 'SALES_MEETING',
    title: input.title ?? 'Klinik ziyareti',
    description: null,
    customerId: input.customerId,
    contactId: null,
    assignedTo: input.assignedTo,
    priority: 'normal',
    dueDate: null,
    scheduledAt: input.scheduledAt,
    scheduledEndsAt: input.scheduledEndsAt
      ?? new Date(Date.parse(input.scheduledAt) + HOUR_MS).toISOString(),
    engagementKind: 'SALES_MEETING',
  };
}

async function rejectionOf(work: () => Promise<unknown>): Promise<AppError> {
  try {
    await work();
  } catch (caught) {
    return caught as AppError;
  }
  throw new Error('Expected promise to reject');
}

function expectCalendarConflict(error: AppError) {
  expect(error).toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
}

/**
 * Picks a future non-Sunday Istanbul local date and returns 10:00/11:00/12:00/
 * 13:00 UTC instants (Europe/Istanbul is UTC+3) so working-day and slot rules
 * never move the fixture.
 */
function nextWorkingDaySlots(baseline: Date) {
  let candidate = new Date(baseline.valueOf() + 2 * DAY_MS);
  while (isSundayDateKey(localDateKey(candidate, 'Europe/Istanbul'))) {
    candidate = new Date(candidate.valueOf() + DAY_MS);
  }
  const dayKey = localDateKey(candidate, 'Europe/Istanbul');
  return {
    searchFrom: new Date(`${dayKey}T07:00:00.000Z`).toISOString(),
    searchEnds: new Date(`${dayKey}T08:00:00.000Z`).toISOString(),
    slotStart: new Date(`${dayKey}T08:00:00.000Z`).toISOString(),
    slotEnd: new Date(`${dayKey}T09:00:00.000Z`).toISOString(),
    laterFreeStart: new Date(`${dayKey}T10:00:00.000Z`).toISOString(),
  };
}

async function insertJob(pool: Pool, input: {
  organizationId: string;
  type: JobCardType;
  status: JobCardStatus;
  assignedTo: string;
  createdBy: string;
  title?: string;
  scheduledAt: string;
  scheduledEndsAt: string;
}) {
  const accepted = ['ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED']
    .includes(input.status);
  const started = ['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED']
    .includes(input.status);
  return (await pool.query<{ id: string; version: number }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        accepted_at, accepted_by, started_at, scheduled_at, scheduled_ends_at,
        engagement_kind)
     VALUES ($1, $2, $3, $4, $5, $6,
             $7::timestamptz, $8::uuid, $9::timestamptz, $10::timestamptz,
             $11::timestamptz, $12)
     RETURNING id, version`,
    [
      input.organizationId, input.type, input.status,
      input.title ?? `Fixture ${input.type} ${input.status}`,
      input.assignedTo, input.createdBy,
      accepted ? '2026-01-01T08:00:00.000Z' : null,
      accepted ? input.assignedTo : null,
      started ? '2026-01-01T09:00:00.000Z' : null,
      input.scheduledAt, input.scheduledEndsAt,
      input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null,
    ],
  )).rows[0]!;
}

async function insertOffer(pool: Pool, input: {
  organizationId: string;
  jobCardId: string;
  assigneeUserId: string;
  openedBy: string;
  openedAt: Date;
  state: 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'RELEASED' | 'EXPIRED' | 'WITHDRAWN';
}) {
  const closed = input.state !== 'OPEN';
  const closeReason = input.state === 'DECLINED' || input.state === 'RELEASED'
    ? 'OTHER'
    : input.state === 'WITHDRAWN'
      ? 'CANCELLED'
      : null;
  const closeText = closeReason === 'OTHER' ? 'Neden açıklaması' : null;
  const closedBy = input.state === 'OPEN' || input.state === 'EXPIRED'
    ? null
    : input.assigneeUserId;
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_assignment_offers
       (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason,
        opened_by, acceptance_due_at, state, closed_at, closed_by, close_reason, close_text)
     VALUES ($1, $2, $3, $4, 'CREATE', $5, $6, $7, $8::timestamptz, $9::uuid, $10, $11)
     RETURNING id`,
    [
      input.organizationId, input.jobCardId, input.assigneeUserId,
      input.openedAt, input.openedBy,
      new Date(input.openedAt.valueOf() + 10 * MINUTE_MS),
      input.state, closed ? input.openedAt : null, closedBy, closeReason, closeText,
    ],
  )).rows[0]!.id;
}

async function insertManualEvent(pool: Pool, input: {
  organizationId: string;
  assignedUserId: string;
  createdBy: string;
  startsAt: string;
  endsAt: string;
}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO calendar_events
       (id, organization_id, assigned_user_id, title, starts_at, ends_at, timezone,
        created_by, updated_by)
     VALUES ($1, $2, $3, 'Manuel takvim kaydı', $4, $5, 'Europe/Istanbul', $6, $6)`,
    [id, input.organizationId, input.assignedUserId, input.startsAt, input.endsAt, input.createdBy],
  );
  return id;
}

async function readJob(pool: Pool, jobCardId: string) {
  return (await pool.query<{
    status: string; version: number; assigned_to: string;
    scheduled_at: Date; scheduled_ends_at: Date; started_at: Date | null;
  }>(
    `SELECT status, version, assigned_to, scheduled_at, scheduled_ends_at, started_at
       FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

async function readOffers(pool: Pool, jobCardId: string) {
  return (await pool.query<{ id: string; state: string }>(
    `SELECT id, state FROM job_card_assignment_offers
      WHERE job_card_id = $1 ORDER BY opened_at ASC, id ASC`,
    [jobCardId],
  )).rows;
}

describe.skipIf(!databaseUrl)('RESCUE-004/A released Staff reservation', () => {
  it('matrix: newest offer decides; older rows, other assignees, statuses and module toggles keep SCH-001', async () => {
    await withSchema(async (pool) => {
      const seed = await seedOrganization(pool, 'matrix');
      const baseline = await readDbBaseline(pool);
      const startsAt = iso(baseline, 2 * DAY_MS + 2 * HOUR_MS);
      const endsAt = iso(baseline, 2 * DAY_MS + 3 * HOUR_MS);
      const client: PoolClient = await pool.connect();
      const at = (offsetMs: number) => new Date(Date.parse(startsAt) + offsetMs);
      const conflicts = (includeCalendarEvents: boolean, userId = seed.staff.id) =>
        findStaffOccupancyConflicts(client, {
          organizationId: seed.organizationId,
          assignedUserId: userId,
          startsAt,
          endsAt,
          includeCalendarEvents,
        });
      try {
        // No offer still occupies.
        const noOffer = await insertJob(pool, {
          organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'NEW',
          assignedTo: seed.staff.id, createdBy: seed.manager.id,
          scheduledAt: startsAt, scheduledEndsAt: endsAt,
        });
        expect((await conflicts(false)).some((row) => row.id === noOffer.id)).toBe(true);

        // OPEN (including urgent) still occupies.
        const open = await insertJob(pool, {
          organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'NEW',
          assignedTo: seed.staff.id, createdBy: seed.manager.id,
          scheduledAt: startsAt, scheduledEndsAt: endsAt,
        });
        await insertOffer(pool, {
          organizationId: seed.organizationId, jobCardId: open.id,
          assigneeUserId: seed.staff.id, openedBy: seed.manager.id,
          openedAt: at(-2 * HOUR_MS), state: 'OPEN',
        });
        expect((await conflicts(false)).some((row) => row.id === open.id)).toBe(true);

        // DECLINED and RELEASED release the reservation.
        for (const state of ['DECLINED', 'RELEASED'] as const) {
          const released = await insertJob(pool, {
            organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'NEW',
            assignedTo: seed.staff.id, createdBy: seed.manager.id,
            scheduledAt: startsAt, scheduledEndsAt: endsAt,
          });
          await insertOffer(pool, {
            organizationId: seed.organizationId, jobCardId: released.id,
            assigneeUserId: seed.staff.id, openedBy: seed.manager.id,
            openedAt: at(-3 * HOUR_MS), state,
          });
          expect((await conflicts(false)).some((row) => row.id === released.id)).toBe(false);
        }

        // EXPIRED and WITHDRAWN still occupy.
        for (const state of ['EXPIRED', 'WITHDRAWN'] as const) {
          const occupied = await insertJob(pool, {
            organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'NEW',
            assignedTo: seed.staff.id, createdBy: seed.manager.id,
            scheduledAt: startsAt, scheduledEndsAt: endsAt,
          });
          await insertOffer(pool, {
            organizationId: seed.organizationId, jobCardId: occupied.id,
            assigneeUserId: seed.staff.id, openedBy: seed.manager.id,
            openedAt: at(-3 * HOUR_MS), state,
          });
          expect((await conflicts(false)).some((row) => row.id === occupied.id)).toBe(true);
        }

        // A newer OPEN offer supersedes an older DECLINED one.
        const superseded = await insertJob(pool, {
          organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'NEW',
          assignedTo: seed.staff.id, createdBy: seed.manager.id,
          scheduledAt: startsAt, scheduledEndsAt: endsAt,
        });
        await insertOffer(pool, {
          organizationId: seed.organizationId, jobCardId: superseded.id,
          assigneeUserId: seed.staff.id, openedBy: seed.manager.id,
          openedAt: at(-4 * HOUR_MS), state: 'DECLINED',
        });
        await insertOffer(pool, {
          organizationId: seed.organizationId, jobCardId: superseded.id,
          assigneeUserId: seed.staff.id, openedBy: seed.manager.id,
          openedAt: at(-3 * HOUR_MS), state: 'OPEN',
        });
        expect((await conflicts(false)).some((row) => row.id === superseded.id)).toBe(true);

        // Another assignee's newer answer never colors the current assignee;
        // an older RELEASED row for the current assignee cannot release it.
        const otherAssigneeNewest = await insertJob(pool, {
          organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'NEW',
          assignedTo: seed.staff.id, createdBy: seed.manager.id,
          scheduledAt: startsAt, scheduledEndsAt: endsAt,
        });
        await insertOffer(pool, {
          organizationId: seed.organizationId, jobCardId: otherAssigneeNewest.id,
          assigneeUserId: seed.staff.id, openedBy: seed.manager.id,
          openedAt: at(-4 * HOUR_MS), state: 'RELEASED',
        });
        await insertOffer(pool, {
          organizationId: seed.organizationId, jobCardId: otherAssigneeNewest.id,
          assigneeUserId: seed.otherStaff.id, openedBy: seed.manager.id,
          openedAt: at(-3 * HOUR_MS), state: 'DECLINED',
        });
        expect((await conflicts(false)).some((row) => row.id === otherAssigneeNewest.id))
          .toBe(true);

        // Started / other occupied statuses are never released by an old answer.
        for (const status of ['ACCEPTED', 'IN_PROGRESS'] as const) {
          const occupied = await insertJob(pool, {
            organizationId: seed.organizationId, type: 'SALES_MEETING', status,
            assignedTo: seed.staff.id, createdBy: seed.manager.id,
            scheduledAt: startsAt, scheduledEndsAt: endsAt,
          });
          await insertOffer(pool, {
            organizationId: seed.organizationId, jobCardId: occupied.id,
            assigneeUserId: seed.staff.id, openedBy: seed.manager.id,
            openedAt: at(-3 * HOUR_MS), state: 'RELEASED',
          });
          expect((await conflicts(false)).some((row) => row.id === occupied.id)).toBe(true);
        }

        // Calendar module toggle: released job stays free either way, while an
        // ACTIVE manual event contributes only with the module on.
        const released = await insertJob(pool, {
          organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'NEW',
          assignedTo: seed.staff.id, createdBy: seed.manager.id,
          scheduledAt: startsAt, scheduledEndsAt: endsAt,
        });
        await insertOffer(pool, {
          organizationId: seed.organizationId, jobCardId: released.id,
          assigneeUserId: seed.staff.id, openedBy: seed.manager.id,
          openedAt: at(-3 * HOUR_MS), state: 'DECLINED',
        });
        const manualId = await insertManualEvent(pool, {
          organizationId: seed.organizationId, assignedUserId: seed.staff.id,
          createdBy: seed.manager.id, startsAt, endsAt,
        });
        expect((await conflicts(false)).some((row) => row.id === released.id)).toBe(false);
        expect((await conflicts(false)).some((row) => row.id === manualId)).toBe(false);
        expect((await conflicts(true)).some((row) => row.id === manualId)).toBe(true);

        // Current active use: a released job stays free while another job now
        // occupies the same interval; busy intervals list only the new job.
        await client.query(
          `DELETE FROM calendar_events WHERE id = $1`, [manualId],
        );
        const booked = await insertJob(pool, {
          organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'NEW',
          assignedTo: seed.staff.id, createdBy: seed.manager.id,
          scheduledAt: startsAt, scheduledEndsAt: endsAt,
        });
        const current = await conflicts(false);
        expect(current.some((row) => row.id === released.id)).toBe(false);
        expect(current.some((row) => row.id === booked.id)).toBe(true);
        const intervals = await listStaffOccupiedIntervals(client, {
          organizationId: seed.organizationId, assignedUserId: seed.staff.id,
          startsAt, endsAt, includeCalendarEvents: false,
        });
        expect(intervals).toContainEqual({ startsAt, endsAt });
      } finally {
        client.release();
      }
    });
  }, 30_000);

  it('Calendar projection keeps the job at its interval and marks only the released reservation', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'calendar');
      const slots = nextWorkingDaySlots(baseline);
      const clock = { now: baseline };
      const { service, published } = buildService(pool, clock, {
        calendar: CALENDAR_ON, assignmentWindow: WINDOW_ON,
      });
      const declined = await service.create(seed.manager, meetingInput({
        customerId: seed.customerId, assignedTo: seed.staff.id,
        scheduledAt: slots.slotStart,
      }));
      published.length = 0;
      await service.declineAssignment(seed.staff, declined.id, {
        clientActionId: randomUUID(), expectedVersion: declined.version,
        reasonCode: 'ON_LEAVE', reasonText: 'İzinliyim.',
      });
      const normal = await service.create(seed.manager, meetingInput({
        customerId: seed.secondCustomerId, assignedTo: seed.otherStaff.id,
        scheduledAt: slots.laterFreeStart,
      }));
      const manualId = await insertManualEvent(pool, {
        organizationId: seed.organizationId, assignedUserId: seed.otherStaff.id,
        createdBy: seed.manager.id,
        startsAt: iso(baseline, 2 * DAY_MS + 15 * HOUR_MS),
        endsAt: iso(baseline, 2 * DAY_MS + 16 * HOUR_MS),
      });
      const repository = new PostgresCalendarRepository(pool, 30, false);
      const calendar = new CalendarService(true, repository, () => clock.now);
      const query = { from: slots.searchFrom, to: iso(baseline, 2 * DAY_MS + 20 * HOUR_MS), assignedTo: null };
      const managerItems = (await calendar.list(seed.manager, query)).items;

      const releasedEvent = managerItems.find((item) => item.id === declined.id)!;
      expect(releasedEvent).toMatchObject({
        source: 'JOB',
        jobCardId: declined.id,
        startsAt: slots.slotStart,
        assignedUser: { id: seed.staff.id },
        jobStatus: 'NEW',
        staffReservationReleased: true,
      });
      const normalEvent = managerItems.find((item) => item.id === normal.id)!;
      expect(normalEvent).toMatchObject({ source: 'JOB', staffReservationReleased: false });
      const manualEvent = managerItems.find((item) => item.id === manualId)!;
      expect(manualEvent).toMatchObject({ source: 'MANUAL' });
      expect('staffReservationReleased' in manualEvent).toBe(false);

      // The manual Calendar write check uses the same shared reader: a released
      // job no longer blocks a manual event at the freed interval.
      const manualCreated = await calendar.create(seed.staff, {
        clientActionId: randomUUID(),
        assignedUserId: seed.staff.id,
        title: 'Serbest aralıkta manuel kayıt',
        description: null,
        startsAt: slots.slotStart,
        endsAt: slots.slotEnd,
        timezone: 'Europe/Istanbul',
      });
      expect(manualCreated.source).toBe('MANUAL');

      // Staff-scoped authorization: the owner sees the event, another Staff does not.
      const ownerItems = (await calendar.list(seed.staff, { ...query, assignedTo: null })).items;
      expect(ownerItems.some((item) => item.id === declined.id)).toBe(true);
      const otherItems = (await calendar.list(seed.otherStaff, { ...query, assignedTo: null })).items;
      expect(otherItems.some((item) => item.id === declined.id)).toBe(false);

      // Optional Calendar module stays optional.
      const disabled = new CalendarService(false, repository, () => clock.now);
      const disabledError = await rejectionOf(() => disabled.list(seed.manager, query));
      expect(disabledError.statusCode).toBe(404);

      // Job, assignee and history are untouched by the free Staff interval.
      const row = await readJob(pool, declined.id);
      expect(row.status).toBe('NEW');
      expect(row.assigned_to).toBe(seed.staff.id);
      expect((await readOffers(pool, declined.id)).map((offer) => offer.state)).toEqual(['DECLINED']);

      // Existing realtime transport refreshes the calendar without a new
      // notification kind: the decline event carries the shared `calendar` key
      // and includes the assignee in its audience.
      const declineEvent = published.find((event) => event.type === 'job.updated');
      expect(declineEvent).toBeDefined();
      expect(declineEvent!.resourceKeys).toContain('calendar');
      expect(declineEvent!.audience.userIds).toContain(seed.staff.id);
      expect(declineEvent!.audience.roles).toEqual(expect.arrayContaining(['ADMIN', 'MANAGER']));
      const calendarKinds = (await pool.query<{ kind: string }>(
        `SELECT kind FROM in_app_notifications
          WHERE organization_id = $1 AND entity_id = $2 AND kind LIKE 'calendar.%'`,
        [seed.organizationId, declined.id],
      )).rows;
      expect(calendarKinds).toEqual([]);
    });
  }, 30_000);

  it('re-offer: conflict rolls back everything; success re-acquires the slot; concurrent create/offer serialize', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'reoffer');
      const slots = nextWorkingDaySlots(baseline);
      const clock = { now: baseline };
      const { service, published } = buildService(pool, clock, {
        calendar: CALENDAR_OFF, assignmentWindow: WINDOW_ON,
      });

      const released = await service.create(seed.manager, meetingInput({
        customerId: seed.customerId, assignedTo: seed.staff.id,
        scheduledAt: slots.slotStart,
      }));
      const accepted = await service.acceptAssignment(seed.staff, released.id, {
        clientActionId: randomUUID(), expectedVersion: released.version,
      });
      const releasedReceipt = await service.releaseAssignment(seed.staff, released.id, {
        clientActionId: randomUUID(), expectedVersion: accepted.version,
        reasonCode: 'TOO_FAR', reasonText: 'Bölge dışı.',
      });
      expect(releasedReceipt.status).toBe('NEW');

      // The freed interval is usable by another job. Move the injected request
      // clock forward so the later re-offer's `opened_at` is canonically newer
      // than the declined answer (production time never stands still).
      clock.now = new Date(baseline.valueOf() + 5 * MINUTE_MS);
      const overlap = await service.create(seed.manager, meetingInput({
        customerId: seed.secondCustomerId, assignedTo: seed.staff.id,
        scheduledAt: slots.slotStart,
      }));
      const before = await readJob(pool, released.id);
      const offersBefore = await readOffers(pool, released.id);
      const activitiesBefore = Number((await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM job_card_activity_logs WHERE job_card_id = $1`,
        [released.id],
      )).rows[0]!.n);
      published.length = 0;

      const conflict = await rejectionOf(() => service.reofferAssignment(
        seed.manager, released.id, { clientActionId: randomUUID(), expectedVersion: releasedReceipt.version },
      ));
      expectCalendarConflict(conflict);
      expect(await readJob(pool, released.id)).toMatchObject({
        status: before.status, version: before.version, assigned_to: before.assigned_to,
      });
      expect(await readOffers(pool, released.id)).toEqual(offersBefore);
      expect(Number((await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM job_card_activity_logs WHERE job_card_id = $1`,
        [released.id],
      )).rows[0]!.n)).toBe(activitiesBefore);
      expect(published).toEqual([]);

      // Freeing the other job lets the re-offer acquire the slot again.
      await service.cancel(seed.manager, overlap.id, {
        clientActionId: randomUUID(), expectedVersion: overlap.version,
        cancelReason: 'Plan değişikliği.',
      });
      clock.now = new Date(baseline.valueOf() + 10 * MINUTE_MS);
      const reoffer = await service.reofferAssignment(seed.manager, released.id, {
        clientActionId: randomUUID(), expectedVersion: releasedReceipt.version,
      });
      expect(reoffer.jobCardId).toBe(released.id);
      expect(await readOffers(pool, released.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: reoffer.offerId, state: 'OPEN' }),
      ]));
      const occupyAgain = await rejectionOf(() => service.create(seed.manager, meetingInput({
        customerId: seed.fourthCustomerId, assignedTo: seed.staff.id,
        scheduledAt: slots.slotStart,
      })));
      expectCalendarConflict(occupyAgain);

      // Concurrency: re-offer and the competing create take the same user
      // lock; exactly one wins and the loser writes nothing.
      clock.now = new Date(baseline.valueOf() + 20 * MINUTE_MS);
      const concurrentJob = await service.create(seed.manager, meetingInput({
        customerId: seed.thirdCustomerId, assignedTo: seed.staff.id,
        scheduledAt: slots.laterFreeStart,
      }));
      const concurrentAccepted = await service.acceptAssignment(seed.staff, concurrentJob.id, {
        clientActionId: randomUUID(), expectedVersion: concurrentJob.version,
      });
      const concurrentReleased = await service.releaseAssignment(seed.staff, concurrentJob.id, {
        clientActionId: randomUUID(), expectedVersion: concurrentAccepted.version,
        reasonCode: 'ON_LEAVE', reasonText: 'İzinliyim.',
      });
      const concurrentVersion = concurrentReleased.version;
      // Later request time keeps the re-offer's new OPEN offer canonically
      // newer than the RELEASED answer even with an injected clock.
      clock.now = new Date(baseline.valueOf() + 25 * MINUTE_MS);
      const results = await Promise.allSettled([
        service.reofferAssignment(seed.manager, concurrentJob.id, {
          clientActionId: randomUUID(), expectedVersion: concurrentVersion,
        }),
        service.create(seed.manager, meetingInput({
          customerId: seed.fourthCustomerId, assignedTo: seed.staff.id,
          scheduledAt: slots.laterFreeStart,
        })),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expectCalendarConflict((rejected[0] as PromiseRejectedResult).reason as AppError);

      const concurrentOffers = await readOffers(pool, concurrentJob.id);
      const concurrentRow = await readJob(pool, concurrentJob.id);
      if (fulfilled[0] === results[0]) {
        expect(concurrentOffers.some((offer) => offer.state === 'OPEN')).toBe(true);
        expect(concurrentRow.version).toBe(concurrentVersion + 1);
      } else {
        expect(concurrentOffers.map((offer) => offer.state)).toEqual(['RELEASED']);
        expect(concurrentRow.version).toBe(concurrentVersion);
      }
    });
  }, 30_000);

  it('offboarding job and manual-calendar transfer checks ignore a released job of the replacement', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'offboarding');
      const jobStart = iso(baseline, 3 * DAY_MS + 2 * HOUR_MS);
      const jobEnd = iso(baseline, 3 * DAY_MS + 3 * HOUR_MS);
      const calendarStart = iso(baseline, 3 * DAY_MS + 5 * HOUR_MS);
      const calendarEnd = iso(baseline, 3 * DAY_MS + 6 * HOUR_MS);

      const transferred = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'ACCEPTED',
        assignedTo: seed.staff.id, createdBy: seed.admin.id,
        scheduledAt: jobStart, scheduledEndsAt: jobEnd,
      });
      const replacementJob = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: seed.otherStaff.id, createdBy: seed.admin.id,
        scheduledAt: jobStart, scheduledEndsAt: jobEnd,
      });
      await insertOffer(pool, {
        organizationId: seed.organizationId, jobCardId: replacementJob.id,
        assigneeUserId: seed.otherStaff.id, openedBy: seed.admin.id,
        openedAt: new Date(baseline.valueOf() - HOUR_MS), state: 'DECLINED',
      });
      const replacementCalendarJob = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: seed.otherStaff.id, createdBy: seed.admin.id,
        scheduledAt: calendarStart, scheduledEndsAt: calendarEnd,
      });
      await insertOffer(pool, {
        organizationId: seed.organizationId, jobCardId: replacementCalendarJob.id,
        assigneeUserId: seed.otherStaff.id, openedBy: seed.admin.id,
        openedAt: new Date(baseline.valueOf() - HOUR_MS), state: 'RELEASED',
      });
      const eventId = await insertManualEvent(pool, {
        organizationId: seed.organizationId, assignedUserId: seed.staff.id,
        createdBy: seed.admin.id, startsAt: calendarStart, endsAt: calendarEnd,
      });

      const service = new PostgresStaffOffboardingService(
        pool, undefined, () => baseline, { enabled: false }, { enabled: true },
      );
      const admin = {
        id: seed.admin.id, organizationId: seed.organizationId, role: 'ADMIN',
      } as never;
      const plan = await service.preview(admin, seed.staff.id);
      const result = await service.execute(admin, seed.staff.id, {
        clientActionId: randomUUID(),
        planHash: plan.planHash,
        reasonCode: 'OTHER_ADMINISTRATIVE',
        jobDecisions: [{
          jobCardId: transferred.id, replacementUserId: seed.otherStaff.id,
        }],
        calendarDecisions: [{
          calendarEventId: eventId, replacementUserId: seed.otherStaff.id,
        }],
        followUpDecisions: [],
        customerDecisions: [],
        reminderDecisions: [],
      } as never);
      expect(result.status).toBe('OFFBOARDED');
      expect((await readJob(pool, transferred.id)).assigned_to).toBe(seed.otherStaff.id);
      expect((await pool.query<{ assigned_user_id: string }>(
        `SELECT assigned_user_id FROM calendar_events WHERE id = $1`, [eventId],
      )).rows[0]!.assigned_user_id).toBe(seed.otherStaff.id);
    });
  }, 30_000);

  it('legacy window-off ACCEPT/START re-check a released slot; ordinary legacy jobs stay unchanged', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'legacy');
      const slots = nextWorkingDaySlots(baseline);
      const secondDay = nextWorkingDaySlots(new Date(baseline.valueOf() + DAY_MS));
      const clock = { now: baseline };
      const windowOn = buildService(pool, clock, {
        calendar: CALENDAR_OFF, assignmentWindow: WINDOW_ON,
      }).service;
      const windowOff = buildService(pool, clock, {
        calendar: CALENDAR_OFF, assignmentWindow: WINDOW_OFF,
      }).service;

      // Released job, then the freed interval is booked by another job.
      const released = await windowOn.create(seed.manager, meetingInput({
        customerId: seed.customerId, assignedTo: seed.staff.id,
        scheduledAt: slots.slotStart,
      }));
      const declined = await windowOn.declineAssignment(seed.staff, released.id, {
        clientActionId: randomUUID(), expectedVersion: released.version,
        reasonCode: 'ON_LEAVE', reasonText: 'İzinliyim.',
      });
      await windowOff.create(seed.manager, meetingInput({
        customerId: seed.secondCustomerId, assignedTo: seed.staff.id,
        scheduledAt: slots.slotStart,
      }));
      const acceptConflict = await rejectionOf(() => windowOff.acceptAssignment(
        seed.staff, released.id,
        { clientActionId: randomUUID(), expectedVersion: declined.version },
      ));
      expectCalendarConflict(acceptConflict);
      expect(await readJob(pool, released.id)).toMatchObject({
        status: 'NEW', version: declined.version, assigned_to: seed.staff.id,
      });
      expect((await readOffers(pool, released.id)).map((offer) => offer.state))
        .toEqual(['DECLINED']);

      // A free released slot can still be accepted in the legacy window-off
      // flow; a stale overlapping row then blocks START instead of silently
      // double-booking.
      const nearStart = iso(baseline, 20 * MINUTE_MS);
      const acceptedJob = await windowOn.create(seed.manager, meetingInput({
        customerId: seed.thirdCustomerId, assignedTo: seed.staff.id,
        scheduledAt: nearStart,
      }));
      const acceptedDecline = await windowOn.declineAssignment(seed.staff, acceptedJob.id, {
        clientActionId: randomUUID(), expectedVersion: acceptedJob.version,
        reasonCode: 'TOO_FAR', reasonText: 'Bölge dışı.',
      });
      const legacyAccept = await windowOff.acceptAssignment(seed.staff, acceptedJob.id, {
        clientActionId: randomUUID(), expectedVersion: acceptedDecline.version,
      });
      expect(legacyAccept.status).toBe('ACCEPTED');
      const staleOverlap = await insertJob(pool, {
        organizationId: seed.organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: seed.staff.id, createdBy: seed.manager.id,
        scheduledAt: nearStart,
        scheduledEndsAt: iso(baseline, 80 * MINUTE_MS),
      });
      const startConflict = await rejectionOf(() => windowOff.start(
        seed.staff, acceptedJob.id,
        { clientActionId: randomUUID(), expectedVersion: legacyAccept.version },
      ));
      expectCalendarConflict(startConflict);
      const afterStart = await readJob(pool, acceptedJob.id);
      expect(afterStart.status).toBe('ACCEPTED');
      expect(afterStart.started_at).toBeNull();
      expect(staleOverlap.id).toBeTruthy();

      // Control: an ordinary legacy job (no offer history) still accepts with
      // the window off; the released-only guard does not change SCH-001 writes.
      const plain = await windowOff.create(seed.manager, meetingInput({
        customerId: seed.fourthCustomerId, assignedTo: seed.staff.id,
        scheduledAt: secondDay.slotStart,
      }));
      const plainAccept = await windowOff.acceptAssignment(seed.staff, plain.id, {
        clientActionId: randomUUID(), expectedVersion: plain.version,
      });
      expect(plainAccept.status).toBe('ACCEPTED');
    });
  }, 30_000);
});
