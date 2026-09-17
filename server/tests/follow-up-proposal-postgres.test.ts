import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import { canonicalScheduledEnd, canonicalScheduledDurationMs } from '../src/modules/job-cards/job-card-duration.js';
import { suggestedFollowUpInstant } from '../src/modules/job-cards/follow-up-policy.js';
import { advanceToWorkingDay } from '../src/modules/job-cards/working-day-policy.js';
import {
  baselineAlignedToGrid,
  baselineIso,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  readDbBaseline,
  readReservedAt,
} from './support/db-clock-baseline.js';
import type {
  JobCard,
  JobCardActor,
  JobCardEngagementKind,
  MeetingOutcome,
  UnsuccessfulVisitReasonCode,
  JobCardType,
} from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

// 049: lifecycle business time is the DB arbitration clock (reserved_at), so
// fixture instants derive from a DB-sampled baseline instead of fixed calendar
// dates that age past product validation (future-date, minimum-lead and
// working-day rules). withFixture re-establishes these values before every
// run; tests read the same variables.
let BASELINE = new Date('2026-08-01T10:00:00.000Z');
let CLOCK: Date = BASELINE;
let PARENT_SCHEDULED_AT = '2026-08-01T10:00:00.000Z';
let MEETING_AT = '2026-08-01T09:30:00.000Z';
let PROPOSAL_AT = '2026-08-08T10:00:00.000Z';
let PROPOSAL_ENDS_AT = '2026-08-08T11:00:00.000Z';
let EARLY_EXPLICIT_AT = '2026-08-03T10:00:00.000Z';
let EXPLICIT_LATER_AT = '2026-08-10T10:00:00.000Z';
let SUNDAY_AT = '2026-08-09T10:00:00.000Z';

/** UTC ISO instant at `deltaMs` from the current fixture baseline. */
const atBase = (deltaMs: number) => baselineIso(BASELINE, deltaMs);

/** UTC-midnight floor of an ISO instant (calendar-day window helper). */
const dayFloorIso = (iso: string) =>
  new Date(Math.floor(Date.parse(iso) / DAY_MS) * DAY_MS).toISOString();

/**
 * The +7-day policy target for a fixture parent slot, computed with the same
 * policy function and inputs (business instant, source slot, org timezone,
 * canonical duration) the production auto-scheduler uses.
 */
function targetFor(parentScheduledAtIso: string): string {
  return suggestedFollowUpInstant({
    evaluatedAt: BASELINE,
    sourceScheduledAt: new Date(parentScheduledAtIso),
    timezone: 'Europe/Istanbul',
    durationMs: canonicalScheduledDurationMs('SALES_MEETING'),
  }).toISOString();
}

/**
 * Same wall-clock slot on the first non-Sunday day after `iso`. Europe/Istanbul
 * is a fixed UTC+03 zone, so the UTC weekday equals the local weekday for
 * slots at 10:00 UTC (13:00 local).
 */
function nextNonSundaySlotIso(iso: string): string {
  for (let days = 1; days <= 8; days += 1) {
    const candidate = new Date(Date.parse(iso) + days * DAY_MS);
    if (candidate.getUTCDay() !== 0) return candidate.toISOString();
  }
  throw new Error('no non-Sunday day found within 8 days');
}

/**
 * A working-day-safe explicit schedule at `deltaMs` from the baseline: when
 * the candidate interval would touch an organization-local Sunday it advances
 * exactly like the production working-day rule, so weekday variance of the DB
 * baseline cannot invalidate the fixture.
 */
function workingSafeExplicitAt(deltaMs: number): string {
  const startsAt = new Date(atBase(deltaMs));
  const advanced = advanceToWorkingDay({
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR_MS),
    timezone: 'Europe/Istanbul',
  });
  return (advanced?.startsAt ?? startsAt).toISOString();
}

/** First Europe/Istanbul-local Sunday strictly after the baseline, at 10:00 UTC. */
function nextSundayIso(baseline: Date): string {
  for (let days = 1; days <= 8; days += 1) {
    const candidate = new Date(baseline.getTime() + days * DAY_MS);
    candidate.setUTCHours(10, 0, 0, 0);
    // Europe/Istanbul is a fixed UTC+03 zone: a 10:00 UTC instant maps to
    // 13:00 local on the same UTC calendar date, so the UTC weekday equals
    // the local weekday for this fixture slot.
    if (candidate.getUTCDay() === 0) return candidate.toISOString();
  }
  throw new Error('no Sunday found within 8 days of the baseline');
}

function withUserLockHold(pool: Pool): {
  waitForFirstLock: () => Promise<void>;
  waitForContenderLock: () => Promise<void>;
  release: () => void;
} {
  let firstLockArrived!: () => void;
  const firstLockReady = new Promise<void>((resolve) => { firstLockArrived = resolve; });
  let contenderLockArrived!: () => void;
  const contenderLockReady = new Promise<void>((resolve) => { contenderLockArrived = resolve; });
  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
  let userLockCount = 0;

  const originalConnect = pool.connect.bind(pool);
  pool.connect = (...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const callback = args.pop() as (
        error: Error | null,
        client?: unknown,
        release?: () => void,
      ) => void;
      originalConnect(...args, (error: Error | null, client?: unknown, release?: () => void) => {
        if (error) return callback(error);
        callback(null, client ? wrapClient(client) : client, release);
      });
      return;
    }
    return originalConnect(...args).then((client: unknown) => wrapClient(client));
  };

  function wrapClient(client: any): any {
    const originalQuery = client.query.bind(client);
    client.query = (...queryArgs: unknown[]) => {
      const text = typeof queryArgs[0] === 'string'
        ? queryArgs[0]
        : (queryArgs[0] as { text?: string } | undefined)?.text;
      if (text?.includes('FROM users') && text.includes('FOR UPDATE')) {
        userLockCount += 1;
        if (userLockCount === 1) {
          return Promise.resolve(originalQuery(...queryArgs)).then((result) => {
            firstLockArrived();
            return lockReleased.then(() => result);
          });
        }
        if (userLockCount === 2) contenderLockArrived();
      }
      return originalQuery(...queryArgs);
    };
    return client;
  }

  return {
    waitForFirstLock: () => firstLockReady,
    waitForContenderLock: () => contenderLockReady,
    release: () => releaseLock(),
  };
}

type Fixture = {
  pool: Pool;
  service: JobCardService;
  calendar: CalendarService;
  published: RealtimeEventRecord[];
  organizationId: string;
  otherOrganizationId: string;
  admin: JobCardActor;
  manager: JobCardActor;
  staffA: JobCardActor;
  staffB: JobCardActor;
  otherStaff: JobCardActor;
  customerId: string;
  productId: string;
  proposalFor(assignedTo: string, scheduledAt?: string, type?: JobCardType): {
    scheduledAt: string;
    type: JobCardType;
    assignedTo: string;
    followUpInstructions: string;
  };
  createInProgressJob(input: {
    type: JobCardType;
    title: string;
    customerId?: string | null;
    assignedTo: string;
    scheduledAt?: string | null;
    engagementKind?: JobCardEngagementKind;
    outcome?: MeetingOutcome;
    unsuccessfulReason?: UnsuccessfulVisitReasonCode | null;
  }): Promise<JobCard>;
};

async function insertUser(pool: Pool, organizationId: string, role: JobCardActor['role'], name: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `follow_up_proposal_${randomUUID().replaceAll('-', '')}`;
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

    // Re-derive every fixture instant from the authoritative DB clock. The
    // parent slot sits one hour in the past (an elapsed meeting), and the
    // +7-day SYSTEM target uses the same policy function the production
    // scheduler runs, anchored on the baseline.
    BASELINE = baselineAlignedToGrid(await readDbBaseline(pool));
    CLOCK = BASELINE;
    PARENT_SCHEDULED_AT = atBase(-HOUR_MS);
    MEETING_AT = atBase(-HOUR_MS - 30 * MINUTE_MS);
    PROPOSAL_AT = suggestedFollowUpInstant({
      evaluatedAt: BASELINE,
      sourceScheduledAt: new Date(PARENT_SCHEDULED_AT),
      timezone: 'Europe/Istanbul',
      durationMs: canonicalScheduledDurationMs('SALES_MEETING'),
    }).toISOString();
    const proposalEndsAt = canonicalScheduledEnd('SALES_MEETING', PROPOSAL_AT);
    if (proposalEndsAt === null) {
      throw new Error('SALES_MEETING canonical duration is required for follow-up fixtures');
    }
    PROPOSAL_ENDS_AT = proposalEndsAt;
    EARLY_EXPLICIT_AT = workingSafeExplicitAt(45 * MINUTE_MS);
    EXPLICIT_LATER_AT = workingSafeExplicitAt(2 * HOUR_MS);
    SUNDAY_AT = nextSundayIso(BASELINE);

    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone)
       VALUES ('Follow-up proposal', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const otherOrganizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Other org') RETURNING id`,
    )).rows[0]!.id;
    const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
    const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Admin');
    const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
    const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
    const otherStaffId = await insertUser(pool, otherOrganizationId, 'STAFF', 'Other Staff');

    const customerId = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, 'Dünya Klinik', 'clinic', 'active') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
    const productId = (await pool.query<{ id: string }>(
      `INSERT INTO products (organization_id, name, unit)
       VALUES ($1, 'İmplant Seti', 'adet') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;

    const published: RealtimeEventRecord[] = [];
    const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
    const repository = new PostgresJobCardRepository(pool);
    const service = new JobCardService(
      repository,
      () => CLOCK,
      publisher,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    );
    const calendar = new CalendarService(
      true,
      new PostgresCalendarRepository(pool),
      () => CLOCK,
    );
    const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
    const admin: JobCardActor = { id: adminId, organizationId, role: 'ADMIN' };
    const staffA: JobCardActor = { id: staffAId, organizationId, role: 'STAFF' };
    const staffB: JobCardActor = { id: staffBId, organizationId, role: 'STAFF' };
    const otherStaff: JobCardActor = { id: otherStaffId, organizationId: otherOrganizationId, role: 'STAFF' };

    const proposalFor: Fixture['proposalFor'] = (assignedTo, scheduledAt = PROPOSAL_AT, type = 'SALES_MEETING') => ({
      scheduledAt,
      type,
      assignedTo,
      followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
    });

    const createInProgressJob: Fixture['createInProgressJob'] = async (input) => {
      const type = input.type;
      const resolvedCustomerId = input.customerId === undefined ? customerId : input.customerId;
      const assignedTo = input.assignedTo;
      const engagementKind = type === 'SALES_MEETING'
        ? input.engagementKind ?? 'CUSTOMER_VISIT'
        : undefined;
      const scheduledAt = input.scheduledAt === undefined ? PARENT_SCHEDULED_AT : input.scheduledAt;
      const scheduledEndsAt = scheduledAt === null
        ? null
        : canonicalScheduledEnd(type, scheduledAt);
      const job = await service.create(staffA, {
        clientActionId: randomUUID(),
        type,
        title: input.title,
        description: null,
        customerId: type === 'GENERAL_TASK' ? null : resolvedCustomerId,
        contactId: null,
        assignedTo,
        priority: 'normal',
        dueDate: null,
        scheduledAt,
        scheduledEndsAt: type === 'GENERAL_TASK' ? undefined : scheduledEndsAt,
        engagementKind,
      } as never);
      const started = await service.start(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
      });
      if (type === 'PRODUCT_DELIVERY') {
        const planned = await service.addDeliveryItem(staffA, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: started.version,
          productId,
          deliveryPurpose: 'SALE',
          deliveredAt: null,
          quantity: 2,
        });
        await service.patchDeliveryItem(staffA, job.id, planned.item.id, {
          expectedVersion: planned.jobCardVersion,
          deliveredAt: MEETING_AT,
        });
        return service.detail(staffA, job.id) as unknown as Promise<JobCard>;
      }
      if (type === 'SALES_MEETING') {
        const outcome = input.outcome
          ?? (engagementKind === 'CUSTOMER_VISIT' ? 'FOLLOW_UP_REQUIRED' : 'POSITIVE');
        const unsuccessfulReason = outcome === 'FOLLOW_UP_REQUIRED'
          ? input.unsuccessfulReason ?? 'REQUESTED_LATER'
          : null;
        const details = await service.patchMeetingDetails(staffA, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: started.version,
          meetingAt: MEETING_AT,
          outcome,
          unsuccessfulReason,
          meetingSummary: 'Görüşme tamamlandı.',
        });
        void details;
        return service.detail(staffA, job.id) as unknown as Promise<JobCard>;
      }
      return started;
    };

    await run({
      pool,
      service,
      calendar,
      published,
      organizationId,
      otherOrganizationId,
      admin,
      manager,
      staffA,
      staffB,
      otherStaff,
      customerId,
      productId,
      proposalFor,
      createInProgressJob,
    });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

const appError = (code: string, statusCode: number) => expect.objectContaining({ code, statusCode });

describe.skipIf(!databaseUrl)('mandatory follow-up proposal PostgreSQL contract', () => {
  it('AUTO-1: creates the target-date proposal when Staff omits the schedule', async () => {
    await withFixture(async ({ service, pool, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Klinik ziyareti',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Ziyaret tamamlandı.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      expect(submitted.followUpProposal).toMatchObject({
        scheduledAt: PROPOSAL_AT,
        type: 'SALES_MEETING',
        assignedTo: staffA.id,
        origin: 'SYSTEM',
      });
      expect((await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM job_cards WHERE source_job_card_id = $1',
        [job.id],
      )).rows[0]!.count).toBe('0');
      expect((await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM calendar_events
          WHERE organization_id = $1 AND assigned_user_id = $2`,
        [staffA.organizationId, staffA.id],
      )).rows[0]!.count).toBe('0');
    });
  });

  it('AUTO-1B: fails safely with manual-planning guidance when the bounded horizon has no slot', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, organizationId, createInProgressJob,
    }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Dolu takvim', assignedTo: staffA.id,
      });
      await pool.query(
        `INSERT INTO calendar_events (
           organization_id, assigned_user_id, title, starts_at, ends_at, timezone,
           created_by, updated_by
         ) VALUES ($1, $2, 'Tüm aralığı kapatan test kaydı', $3, $4, 'Europe/Istanbul', $5, $5)`,
        [
          organizationId,
          staffA.id,
          atBase(0),
          atBase(32 * DAY_MS),
          manager.id,
        ],
      );

      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version, note: 'Tamamlandı.',
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_INVALID', 409));
      await expect(service.detail(staffA, job.id)).resolves.toMatchObject({
        status: 'IN_PROGRESS', version: job.version,
      });
    });
  });

  it('AUTO-1D: auto target scheduling still succeeds on a recent-visit WARNING', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, staffB, organizationId, customerId, createInProgressJob,
    }) => {
      const visit = await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by,
           engagement_kind)
         VALUES ($1, 'SALES_MEETING', 'COMPLETED', 'Geçen haftaki ziyaret', $2, $3, $4, NOW(), NOW(), $3, NOW(), $4, 'SALES_MEETING')
         RETURNING id`,
        [organizationId, customerId, staffB.id, manager.id],
      );
      await pool.query(
        `INSERT INTO job_card_meeting_details (organization_id, job_card_id, meeting_at, outcome, meeting_summary)
         VALUES ($1, $2, $3, 'POSITIVE', 'Geçmiş ziyaret')`,
        [organizationId, visit.rows[0]!.id, atBase(-2 * DAY_MS)],
      );
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Uyarılı takip', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
      });
      expect(submitted.followUpProposal).toMatchObject({
        scheduledAt: PROPOSAL_AT,
        origin: 'SYSTEM',
      });
    });
  });

  it('AUTO-1E: explicit Staff schedule before the target stays valid under floor-only manual policy', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Erken manuel takip', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
        followUpProposal: {
          // A working-day-safe near-term date derived from the DB baseline;
          // the intent (a date before the +7 target) holds.
          scheduledAt: EARLY_EXPLICIT_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Erken kontrol araması.',
        },
      });
      // The +7-day target is a SYSTEM preference, not a universal minimum.
      expect(submitted.followUpProposal).toMatchObject({
        scheduledAt: EARLY_EXPLICIT_AT,
        origin: 'STAFF_ADJUSTED',
      });
    });
  });

  it('AUTO-1C: accepts an additive proposal payload with scheduledAt omitted', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kısmi teklif', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
        followUpProposal: {
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Klinik kararını teyit edin.',
        },
      });

      expect(submitted.followUpProposal).toMatchObject({
        scheduledAt: PROPOSAL_AT,
        followUpInstructions: 'Klinik kararını teyit edin.',
        origin: 'SYSTEM',
      });
    });
  });

  it('D1-2: Product Delivery submits and approves without a follow-up proposal', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'PRODUCT_DELIVERY', title: 'Teslim', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Teslim tamamlandı.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      expect(submitted.followUpProposal).toBeNull();

      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      });
      expect(approved.status).toBe('COMPLETED');
      expect(approved.followUpProposal).toBeNull();
    });
  });

  it('FUP-POSTHOC: authorized managers get the Product Delivery target without making +7 a floor', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'PRODUCT_DELIVERY', title: 'Tamamlanan teslim', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version, note: 'Teslim tamamlandı.',
      });
      const completed = await service.approve(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: submitted.version,
      });
      expect(completed.status).toBe('COMPLETED');

      const suggestion = await service.getFollowUpSuggestion(manager, job.id);
      expect(suggestion).toMatchObject({
        scheduledAt: PROPOSAL_AT,
        type: 'SALES_MEETING',
        assignedTo: staffA.id,
      });

      await expect(service.getFollowUpSuggestion(staffA, job.id))
        .rejects.toMatchObject(appError('FORBIDDEN', 403));

      const early = await service.createFollowUp(manager, job.id, {
        clientActionId: randomUUID(),
        type: 'SALES_MEETING',
        title: 'Erken manuel takip',
        followUpInstructions: 'Müşteriyi erken arayın.',
        scheduledAt: EARLY_EXPLICIT_AT,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: null,
        contactId: null,
        engagementKind: 'FOLLOW_UP',
      });
      expect(early).toMatchObject({ scheduledAt: EARLY_EXPLICIT_AT });
    });
  });

  it('FUP-POSTHOC: cancelled and invalidated sources remain ineligible for suggestions', async () => {
    await withFixture(async ({ service, manager, admin, staffA, createInProgressJob }) => {
      const cancelledJob = await createInProgressJob({
        type: 'PRODUCT_DELIVERY', title: 'İptal teslim', assignedTo: staffA.id,
      });
      const cancelled = await service.cancel(staffA, cancelledJob.id, {
        clientActionId: randomUUID(), expectedVersion: cancelledJob.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(cancelled.status).toBe('CANCELLED');
      await expect(service.getFollowUpSuggestion(manager, cancelledJob.id))
        .rejects.toMatchObject(appError('INVALID_TRANSITION', 409));

      const invalidatedJob = await createInProgressJob({
        type: 'PRODUCT_DELIVERY', title: 'Geçersiz teslim', assignedTo: staffA.id,
      });
      const invalidated = await service.invalidate(admin, invalidatedJob.id, {
        clientActionId: randomUUID(), expectedVersion: invalidatedJob.version,
        reasonCode: 'DUPLICATE', note: null,
      });
      expect(invalidated.status).toBe('INVALIDATED');
      await expect(service.getFollowUpSuggestion(manager, invalidatedJob.id))
        .rejects.toMatchObject(appError('INVALID_TRANSITION', 409));
    });
  });

  it('D1-3/D1-8: non-visit Sales Meeting kinds submit without recursive proposal requirements', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      for (const [index, engagementKind] of [
        'TRAINING', 'PRODUCT_DEMO', 'SALES_MEETING', 'FOLLOW_UP', 'OTHER',
      ].entries() as IterableIterator<[number, JobCardEngagementKind]>) {
        const scheduledAt = new Date('2026-07-31T10:00:00.000Z');
        scheduledAt.setUTCDate(scheduledAt.getUTCDate() - index);
        const job = await createInProgressJob({
          type: 'SALES_MEETING',
          engagementKind,
          title: `${engagementKind} işi`,
          assignedTo: staffA.id,
          scheduledAt: scheduledAt.toISOString(),
        });
        const submitted = await service.submitForApproval(staffA, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: job.version,
          note: `${engagementKind} tamamlandı.`,
        });
        expect(submitted.status).toBe('WAITING_APPROVAL');
        expect(submitted.followUpProposal).toBeNull();

        const approved = await service.approve(manager, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: submitted.version,
        });
        expect(approved.status).toBe('COMPLETED');
        expect(approved.followUpProposal).toBeNull();
      }
    });
  });

  it('FUP-M2/M3: preserves explicit Staff scheduling as a manually adjusted proposal', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      const suggestion = await service.getFollowUpSuggestion(staffA, job.id);
      expect(suggestion).toMatchObject({
        scheduledAt: PROPOSAL_AT,
        type: 'SALES_MEETING',
        assignedTo: staffA.id,
        followUpInstructions: 'Takip: Kontrol görüşmesi',
      });
      expect(suggestion.evaluation.level).toBe('CLEAR');

      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: suggestion.scheduledAt!,
          type: suggestion.type,
          assignedTo: suggestion.assignedTo,
          followUpInstructions: suggestion.followUpInstructions,
        },
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      expect(submitted.followUpProposal).toMatchObject({
        scheduledAt: PROPOSAL_AT,
        type: 'SALES_MEETING',
        assignedTo: staffA.id,
        origin: 'STAFF_ADJUSTED',
      });
    });
  });

  it('FUP-M4/M5: marks edited proposals STAFF_ADJUSTED and rejects past dates', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: atBase(-3 * HOUR_MS),
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_INVALID', 400));

      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          // A working-day-safe explicit schedule derived from the DB baseline.
          scheduledAt: EXPLICIT_LATER_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      });
      expect(submitted.followUpProposal).toMatchObject({
        scheduledAt: EXPLICIT_LATER_AT,
        origin: 'STAFF_ADJUSTED',
      });
    });
  });

  it('§14/§15: rejects a Staff proposal whose explicit schedule lands on a Sunday', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Pazar denemesi', assignedTo: staffA.id,
      });
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          // The first Istanbul-local Sunday after the DB baseline: a valid
          // future target that only the working-day rule rejects.
          scheduledAt: SUNDAY_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Pazar denemesi',
        },
      })).rejects.toMatchObject({
        code: 'NON_WORKING_DAY',
        statusCode: 400,
        message: 'Pazar günleri planlama yapılamaz. Lütfen Cumartesi veya Pazartesi seçin.',
      });
    });
  });

  it('D1-16: rejects a new non-visit workflow proposal write before assignee validation', async () => {
    await withFixture(async ({ service, staffA, staffB, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'GENERAL_TASK', title: 'Görev', assignedTo: staffA.id, customerId: null,
      });
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görev tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'GENERAL_TASK',
          assignedTo: staffB.id,
          followUpInstructions: 'Takip: Görev',
        },
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_INVALID', 400));
    });
  });

  it('D1-16: rejects a non-visit Sales Meeting workflow proposal write', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'TRAINING',
        title: 'Eğitim görüşmesi',
        assignedTo: staffA.id,
      });
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'PRODUCT_DELIVERY',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_INVALID', 400));
      const after = await service.detail(staffA, job.id);
      expect(after.status).toBe('IN_PROGRESS');
      expect(after.followUpProposal).toBeNull();
    });
  });

  it('D1-16: rejects a Product Delivery workflow proposal write', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'PRODUCT_DELIVERY', title: 'Teslim', assignedTo: staffA.id,
      });
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Teslim tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'PRODUCT_DELIVERY',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Teslim',
        },
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_INVALID', 400));
    });
  });

  it('R1-6: Staff receives the frequency warning with Manager-review wording and no override surface', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, staffB, organizationId, customerId, createInProgressJob,
    }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      for (const [index, at] of [1, 2, 3].map((days) => new Date(Date.parse(PROPOSAL_AT) - days * DAY_MS).toISOString()).entries()) {
        const visit = await pool.query<{ id: string }>(
          `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
             started_at, staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by,
             engagement_kind)
           VALUES ($1, 'SALES_MEETING', 'COMPLETED', $2, $3, $4, $5, NOW(), NOW(), $6, NOW(), $5, 'SALES_MEETING')
           RETURNING id`,
          [organizationId, `Ziyaret ${index}`, customerId, staffB.id, manager.id, staffB.id],
        );
        await pool.query(
          `INSERT INTO job_card_meeting_details (organization_id, job_card_id, meeting_at, outcome, meeting_summary)
           VALUES ($1, $2, $3, 'POSITIVE', 'Geçmiş ziyaret')`,
          [organizationId, visit.rows[0]!.id, at],
        );
      }
      const staffSuggestion = await service.getFollowUpSuggestion(staffA, job.id);
      expect(staffSuggestion.evaluation.level).toBe('FREQUENCY_EXCEEDED');
      expect(staffSuggestion.evaluation.safeMessage).toContain('yönetici onayında ayrıca değerlendirilecek');
      expect(staffSuggestion.evaluation.safeMessage).not.toContain('nedeni belirtin');
      const managerSuggestion = await service.getFollowUpSuggestion(manager, job.id);
      expect(managerSuggestion.evaluation.safeMessage).toContain('14 günlük bir dönemde ziyaret sıklığı sınırını aşıyor');
    });
  });

  it('FUP-M17: cross-organization access fails closed', async () => {
    await withFixture(async ({ service, otherStaff, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'GENERAL_TASK', title: 'Görev', assignedTo: staffA.id, customerId: null,
      });
      await expect(service.submitForApproval(otherStaff, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Yetkisiz.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'GENERAL_TASK',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Görev',
        },
      })).rejects.toMatchObject(appError('JOB_CARD_NOT_FOUND', 404));
    });
  });

  it('FUP-M9/M11/M13 + CSI-17: unified approval creates exactly one linked child and Calendar shows it', async () => {
    await withFixture(async ({
      service, calendar, manager, staffA, createInProgressJob, customerId, pool, published,
    }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Teslim tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
        },
      });
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      expect(approved.status).toBe('COMPLETED');
      expect(approved.followUpJobCardId).toBeTypeOf('string');

      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        status: 'ACCEPTED',
        type: 'SALES_MEETING',
        customerId,
        scheduledAt: PROPOSAL_AT,
        scheduledEndsAt: PROPOSAL_ENDS_AT,
        engagementKind: 'FOLLOW_UP',
      });
      // Child acceptance is part of the parent's APPROVE transaction.
      expect(child.workflowContext.lifecycle).toMatchObject({
        acceptedAt: (await readReservedAt(pool, job.id, 'APPROVE')).toISOString(),
        acceptedBy: { id: staffA.id, name: 'Staff A' },
      });
      expect(child.followUpContext).toMatchObject({
        sourceJobCardId: job.id,
        followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
      });
      expect(published.find((event) => event.entityId === child.id)).toMatchObject({
        type: 'job.created',
        entityType: 'job-card',
      });
      expect((await pool.query(
        `SELECT kind, recipient_user_id FROM in_app_notifications WHERE entity_id = $1`,
        [child.id],
      )).rows).toEqual([
        expect.objectContaining({ kind: 'job.assigned', recipient_user_id: staffA.id }),
      ]);

      const calendarItems = await calendar.list(manager, {
        from: dayFloorIso(PROPOSAL_AT),
        to: dayFloorIso(baselineIso(new Date(PROPOSAL_AT), DAY_MS)),
        assignedTo: null,
      });
      expect(calendarItems.items.map((item) => item.id)).toContain(child.id);

      const activity = await service.listActivity(manager, job.id, { limit: 50, offset: 0 });
      const approveActivity = activity.items.find((item) => item.eventType === 'JOB_APPROVED');
      expect(approveActivity).toMatchObject({ actor: { id: manager.id, name: 'Manager' } });
    });
  });

  it('FUP-M14/M10: replays return the original child and never create a second one', async () => {
    await withFixture(async ({ service, pool, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görev tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Görev',
        },
      });
      const approveId = randomUUID();
      const first = await service.approve(manager, job.id, {
        clientActionId: approveId,
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      const m14Debug = await pool.query(
        'SELECT id, status, assigned_to, source_job_card_id FROM job_cards WHERE source_job_card_id = $1',
        [job.id],
      );
      console.log('M14-DEBUG', JSON.stringify({
        firstStatus: first.status,
        followUpJobCardId: first.followUpJobCardId,
        childRows: m14Debug.rows,
      }));
      const m14DetailDebug = await pool.query(
        'SELECT j.id, j.organization_id, j.status FROM job_cards j WHERE j.organization_id = $1 AND j.id = $2',
        [manager.organizationId, first.followUpJobCardId],
      );
      console.log('M14-DETAIL-DEBUG', JSON.stringify({
        managerOrg: manager.organizationId,
        detailRows: m14DetailDebug.rows,
      }));
      const m14JoinDebug = await pool.query(
        `SELECT j.id FROM job_cards j
           JOIN users assignee
             ON assignee.organization_id = j.organization_id AND assignee.id = j.assigned_to
          WHERE j.organization_id = $1 AND j.id = $2`,
        [manager.organizationId, first.followUpJobCardId],
      );
      const m14AssigneeDebug = await pool.query(
        'SELECT id, organization_id FROM users WHERE id = $1',
        [String(m14Debug.rows[0]?.assigned_to ?? '')],
      );
      console.log('M14-JOIN-DEBUG', JSON.stringify({
        joinRows: m14JoinDebug.rows,
        assigneeRows: m14AssigneeDebug.rows,
      }));
      const m14ReceiptDebug = await pool.query(
        'SELECT status, response_body FROM processed_actions WHERE client_action_id = $1',
        [approveId],
      );
      console.log('M14-RECEIPT-DEBUG', JSON.stringify(m14ReceiptDebug.rows[0]?.response_body ?? null));
      const childBeforeReplay = await service.detail(manager, first.followUpJobCardId);
      const second = await service.approve(manager, job.id, {
        clientActionId: approveId,
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      const childAfterReplay = await service.detail(manager, second.followUpJobCardId);
      expect(second).toEqual(first);
      expect(childAfterReplay.workflowContext.lifecycle).toEqual(
        childBeforeReplay.workflowContext.lifecycle,
      );
      expect(childAfterReplay).toMatchObject({ status: 'ACCEPTED' });
      const children = await service.listFollowUps(manager, job.id, { limit: 10, offset: 0 });
      expect(children.total).toBe(1);
    });
  });

  it('D4-FUP-AVAILABILITY: approval rejects an assignee overlap and rolls back the child', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, organizationId, customerId, createInProgressJob,
    }) => {
      const otherCustomerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Başka Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at, scheduled_ends_at, engagement_kind
         ) VALUES ($1, 'SALES_MEETING', 'NEW', 'Çakışan iş', $2, $3, $4, $5, $6, 'SALES_MEETING')`,
        [
          organizationId,
          otherCustomerId,
          staffA.id,
          manager.id,
          PROPOSAL_AT,
          PROPOSAL_ENDS_AT,
        ],
      );
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Çakışma kontrolü.',
        },
      });

      await expect(service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      })).rejects.toMatchObject(appError('CALENDAR_CONFLICT', 409));

      await expect(service.detail(manager, job.id)).resolves.toMatchObject({
        status: 'WAITING_APPROVAL',
        version: submitted.version,
        customerId,
      });
      const children = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_cards WHERE source_job_card_id = $1`,
        [job.id],
      );
      expect(children.rows[0]!.count).toBe('0');
    });
  });

  it('D4-C1: approval serializes against a normal interval create for the same assignee', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, organizationId, customerId, createInProgressJob,
    }) => {
      const otherCustomerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Başka Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Seri hale getirme.',
        },
      });
      const barrier = withUserLockHold(pool);
      try {
        const approval = service.approve(manager, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: submitted.version,
        });
        await barrier.waitForFirstLock();
        const create = service.create(manager, {
          clientActionId: randomUUID(),
          type: 'SALES_MEETING',
          title: 'Rakip görüşme',
          description: null,
          customerId: otherCustomerId,
          contactId: null,
          assignedTo: staffA.id,
          priority: 'normal',
          dueDate: null,
          scheduledAt: PROPOSAL_AT,
          scheduledEndsAt: PROPOSAL_ENDS_AT,
          engagementKind: 'SALES_MEETING',
        });
        await barrier.waitForContenderLock();
        barrier.release();

        const results = await Promise.allSettled([approval, create]);
        expect(results[0]).toMatchObject({ status: 'fulfilled' });
        expect(results[1]).toMatchObject({
          status: 'rejected',
          reason: { code: 'CALENDAR_CONFLICT', statusCode: 409 },
        });
        const commitments = await pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM job_cards
           WHERE organization_id = $1 AND assigned_to = $2
             AND scheduled_at < $3 AND $4 < scheduled_ends_at
             AND status NOT IN ('COMPLETED', 'CANCELLED')`,
          [organizationId, staffA.id, PROPOSAL_ENDS_AT, PROPOSAL_AT],
        );
        expect(commitments.rows[0]!.total).toBe('1');
        await expect(service.detail(manager, job.id)).resolves.toMatchObject({
          status: 'COMPLETED',
          customerId,
        });
      } finally {
        barrier.release();
      }
    });
  });

  it('D4-C2: approval serializes against a MANUAL interval create for the same assignee', async () => {
    await withFixture(async ({ service, pool, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Manuel seri hale getirme.',
        },
      });
      const calendar = new CalendarService(
        true,
        new PostgresCalendarRepository(pool),
        () => CLOCK,
      );
      const barrier = withUserLockHold(pool);
      try {
        const approval = service.approve(manager, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: submitted.version,
        });
        await barrier.waitForFirstLock();
        const manual = calendar.create(manager, {
          clientActionId: randomUUID(),
          assignedUserId: staffA.id,
          title: 'Rakip manuel plan',
          description: null,
          startsAt: PROPOSAL_AT,
          endsAt: PROPOSAL_ENDS_AT,
          timezone: 'Europe/Istanbul',
        });
        await barrier.waitForContenderLock();
        barrier.release();

        const results = await Promise.allSettled([approval, manual]);
        expect(results[0]).toMatchObject({ status: 'fulfilled' });
        expect(results[1]).toMatchObject({
          status: 'rejected',
          reason: { code: 'CALENDAR_CONFLICT', statusCode: 409 },
        });
        const commitments = await pool.query<{ total: string }>(
          `SELECT (
             SELECT COUNT(*) FROM job_cards
              WHERE organization_id = $1 AND assigned_to = $2
                AND scheduled_at < $3 AND $4 < scheduled_ends_at
                AND status NOT IN ('COMPLETED', 'CANCELLED')
           ) + (
             SELECT COUNT(*) FROM calendar_events
              WHERE organization_id = $1 AND assigned_user_id = $2
                AND starts_at < $3 AND $4 < ends_at AND status = 'ACTIVE'
           ) AS total`,
          [manager.organizationId, staffA.id, PROPOSAL_ENDS_AT, PROPOSAL_AT],
        );
        expect(commitments.rows[0]!.total).toBe('1');
      } finally {
        barrier.release();
      }
    });
  });

  it('D2-9/10: auto-accepted future children cannot start early but start at exact scheduledAt', async () => {
    await withFixture(async ({ service, pool, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
        },
      });
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(staffA, approved.followUpJobCardId);

      await expect(service.start(staffA, child.id, {
        clientActionId: randomUUID(),
        expectedVersion: child.version,
      })).rejects.toMatchObject({ code: 'INVALID_TRANSITION', statusCode: 409 });
      await expect(service.detail(staffA, child.id)).resolves.toMatchObject({
        status: 'ACCEPTED',
        version: child.version,
        workflowContext: { allowedCommands: ['CANCEL'] },
      });

      const atScheduledTime = new JobCardService(
        new PostgresJobCardRepository(pool),
      );
      // 049: business time is the authoritative DB clock, so the test cannot
      // fast-forward time. Simulate the scheduled instant arriving by moving
      // the child's planned interval onto the DB business clock; the START
      // gate (requestTime >= scheduledAt) then admits the start exactly as
      // the "at scheduledAt" semantics require.
      await pool.query(
        'UPDATE job_cards SET scheduled_at = $2, scheduled_ends_at = $3 WHERE id = $1',
        [child.id, atBase(0), atBase(HOUR_MS)],
      );
      await expect(atScheduledTime.start(staffA, child.id, {
        clientActionId: randomUUID(),
        expectedVersion: child.version,
      })).resolves.toMatchObject({ status: 'IN_PROGRESS', version: child.version + 1 });
    });
  });

  it('FUP-M15: revision preserves the proposal and resubmission updates it', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      });
      const revised = await service.requestRevision(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        revisionReason: 'Özeti düzeltin.',
      });
      const detail = await service.detail(manager, job.id);
      expect(detail.followUpProposal).toMatchObject({
        scheduledAt: PROPOSAL_AT,
        proposedBy: { id: staffA.id, name: 'Staff A' },
      });

      const resumed = await service.resume(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: revised.version,
      });
      const resubmitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: resumed.version,
        note: 'Görüşme düzeltildi.',
        followUpProposal: {
          // A working-day-safe explicit schedule derived from the DB baseline.
          scheduledAt: EXPLICIT_LATER_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      });
      expect(resubmitted.followUpProposal).toMatchObject({ scheduledAt: EXPLICIT_LATER_AT });

      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: resubmitted.version,
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child.scheduledAt).toBe(EXPLICIT_LATER_AT);
    });
  });

  it('FUP-M8: Manager may change the assignee at approval', async () => {
    await withFixture(async ({ service, manager, staffA, staffB, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görev tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Görev',
        },
      });
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: 'Takip: Görev',
        },
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({ assignedTo: staffB.id, status: 'NEW' });
      expect(child.workflowContext.lifecycle).toMatchObject({
        acceptedAt: null,
        acceptedBy: null,
      });
    });
  });

  it('CSI-1/2/3/4 + CSI-8/9: suggestions skip same-Customer ON_SITE days regardless of assignee', async () => {
    await withFixture(async ({ service, pool, manager, staffA, staffB, organizationId, customerId, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      // A cancelled ON_SITE job on the base day does not block (CSI-3).
      await pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at, started_at, cancelled_at, cancelled_by, cancel_reason)
         VALUES ($1, 'PRODUCT_DELIVERY', 'CANCELLED', 'İptal teslim', $2, $3, $4, $5, NOW(), NOW(), $4, 'İptal')`,
        [organizationId, customerId, staffB.id, manager.id, PROPOSAL_AT],
      );
      // A GENERAL_TASK for the same Customer on the base day does not block (CSI-4).
      await pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at)
         VALUES ($1, 'GENERAL_TASK', 'NEW', 'Uzaktan görev', $2, $3, $4, $5)`,
        [organizationId, customerId, staffB.id, manager.id, PROPOSAL_AT],
      );
      let suggestion = await service.getFollowUpSuggestion(staffA, job.id);
      expect(suggestion.scheduledAt).toBe(PROPOSAL_AT);

      // Another Staff member's ON_SITE job on the base day forces a skip (CSI-1/2/8/9).
      await pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at)
         VALUES ($1, 'PRODUCT_DELIVERY', 'NEW', 'Başka personelin teslimi', $2, $3, $4, $5)`,
        [organizationId, customerId, staffB.id, manager.id, baselineIso(new Date(PROPOSAL_AT), -HOUR_MS)],
      );
      suggestion = await service.getFollowUpSuggestion(staffA, job.id);
      // The base day is occupied by another Staff's ON_SITE job: the
      // suggestion advances one calendar day at a time, skipping the
      // organization-local Sunday, preserving the wall-clock slot.
      expect(suggestion.scheduledAt).toBe(nextNonSundaySlotIso(PROPOSAL_AT));
      expect(suggestion.evaluation.safeMessage).toContain('sonraki uygun tarih önerildi');
      // Staff projection leaks no conflict details (CSI-7).
      expect(suggestion.evaluation.conflicts).toEqual([]);
      expect(suggestion.evaluation.recentVisit).toBeNull();

      // Manager receives rich conflict details (CSI-6).
      const evaluation = await service.getFollowUpSuggestion(manager, job.id, PROPOSAL_AT);
      expect(evaluation.evaluation.level).toBe('CONFLICT');
      expect(evaluation.evaluation.conflicts).toEqual([
        expect.objectContaining({ title: 'Başka personelin teslimi' }),
      ]);
      expect(evaluation.evaluation.suggestedAlternativeAt).toBe(nextNonSundaySlotIso(PROPOSAL_AT));
    });
  });

  it('CSI-10: approval revalidates authoritatively when a conflict appears after submission', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, staffB, organizationId, customerId, createInProgressJob,
    }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      });
      // Another Manager schedules a conflicting ON_SITE job after submission.
      await pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at)
         VALUES ($1, 'PRODUCT_DELIVERY', 'NEW', 'Sonradan planlanan teslim', $2, $3, $4, $5)`,
        [organizationId, customerId, staffB.id, manager.id, baselineIso(new Date(PROPOSAL_AT), -HOUR_MS)],
      );

      await expect(service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      })).rejects.toMatchObject(appError('FOLLOW_UP_CUSTOMER_CONFLICT', 409));

      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          // A working-day-safe explicit override derived from the DB baseline.
          scheduledAt: EXPLICIT_LATER_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child.scheduledAt).toBe(EXPLICIT_LATER_AT);
    });
  });

  it('AUTO-2: approval reselects forward from the persisted target when it becomes stale', async () => {
    await withFixture(async ({
      service, calendar, manager, staffA, createInProgressJob,
    }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Otomatik takip', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
      });
      expect(submitted.followUpProposal?.scheduledAt).toBe(PROPOSAL_AT);

      await calendar.create(manager, {
        clientActionId: randomUUID(),
        assignedUserId: staffA.id,
        title: 'Sonradan oluşan engel',
        description: null,
        startsAt: PROPOSAL_AT,
        endsAt: PROPOSAL_ENDS_AT,
        timezone: 'Europe/Istanbul',
      });

      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      // Approval re-runs from the persisted target (not approvalTime + 7d):
      // the blocked target moves forward one grid slot, never backward,
      // and never a second +7 days out.
      expect(child.scheduledAt).toBe(baselineIso(new Date(PROPOSAL_AT), HOUR_MS));
      expect(child.scheduledEndsAt).toBe(baselineIso(new Date(PROPOSAL_AT), 2 * HOUR_MS));
    });
  });

  it('AUTO-3: concurrent approvals for one Staff serialize into non-overlapping slots', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, organizationId, createInProgressJob,
    }) => {
      const secondCustomerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'İkinci Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      // Distinct parent slots one grid hour apart, derived from the DB
      // baseline: the +7-day targets inherit the parent wall-clock times and
      // serialize into non-overlapping child slots.
      const firstParentAt = atBase(-2 * HOUR_MS);
      const secondParentAt = atBase(-HOUR_MS);
      const firstJob = await createInProgressJob({
        type: 'SALES_MEETING', title: 'İlk otomatik takip', assignedTo: staffA.id,
        scheduledAt: firstParentAt,
      });
      const secondJob = await createInProgressJob({
        type: 'SALES_MEETING', title: 'İkinci otomatik takip', assignedTo: staffA.id,
        customerId: secondCustomerId,
        scheduledAt: secondParentAt,
      });
      const firstSubmitted = await service.submitForApproval(staffA, firstJob.id, {
        clientActionId: randomUUID(), expectedVersion: firstJob.version, note: 'Tamamlandı.',
      });
      const secondSubmitted = await service.submitForApproval(staffA, secondJob.id, {
        clientActionId: randomUUID(), expectedVersion: secondJob.version, note: 'Tamamlandı.',
      });
      expect(firstSubmitted.followUpProposal?.scheduledAt).toBe(targetFor(firstParentAt));
      expect(secondSubmitted.followUpProposal?.scheduledAt).toBe(targetFor(secondParentAt));

      const [firstApproved, secondApproved] = await Promise.all([
        service.approve(manager, firstJob.id, {
          clientActionId: randomUUID(), expectedVersion: firstSubmitted.version,
        }),
        service.approve(manager, secondJob.id, {
          clientActionId: randomUUID(), expectedVersion: secondSubmitted.version,
        }),
      ]) as Array<JobCard & { followUpJobCardId: string }>;
      const children = await Promise.all([
        service.detail(manager, firstApproved.followUpJobCardId),
        service.detail(manager, secondApproved.followUpJobCardId),
      ]);
      expect(children.map((child) => child.scheduledAt).sort()).toEqual([
        targetFor(firstParentAt),
        targetFor(secondParentAt),
      ]);
    });
  });

  it('CSI-12/13/14: the 4th visit in 14 days requires a Manager override reason that is audited', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, staffB, organizationId, customerId, createInProgressJob,
    }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      for (const [index, at] of [1, 2, 3].map((days) => new Date(Date.parse(PROPOSAL_AT) - days * DAY_MS).toISOString()).entries()) {
        const visit = await pool.query<{ id: string }>(
          `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
             started_at, staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by,
             engagement_kind)
           VALUES ($1, 'SALES_MEETING', 'COMPLETED', $2, $3, $4, $5, NOW(), NOW(), $6, NOW(), $5, 'SALES_MEETING')
           RETURNING id`,
          [organizationId, `Ziyaret ${index}`, customerId, staffB.id, manager.id, staffB.id],
        );
        await pool.query(
          `INSERT INTO job_card_meeting_details (organization_id, job_card_id, meeting_at, outcome, meeting_summary)
           VALUES ($1, $2, $3, 'POSITIVE', 'Geçmiş ziyaret')`,
          [organizationId, visit.rows[0]!.id, at],
        );
      }
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      });

      const evaluation = await service.getFollowUpSuggestion(manager, job.id, PROPOSAL_AT);
      expect(evaluation.evaluation.level).toBe('FREQUENCY_EXCEEDED');
      expect(evaluation.evaluation.recentVisit).toMatchObject({ jobType: 'SALES_MEETING' });

      await expect(service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      })).rejects.toMatchObject(appError('FOLLOW_UP_OVERRIDE_REASON_REQUIRED', 400));

      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
          overrideReason: 'Klinik acil takip istedi.',
        },
      }) as JobCard & { followUpJobCardId: string };

      const approveActivity = await pool.query(
        `SELECT metadata FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_APPROVED'`,
        [job.id],
      );
      expect(approveActivity.rows[0]!.metadata).toMatchObject({
        customerVisitOverrideReason: 'Klinik acil takip istedi.',
      });
      const childActivity = await pool.query(
        `SELECT metadata FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_CREATED'`,
        [approved.followUpJobCardId],
      );
      expect(childActivity.rows[0]!.metadata).toMatchObject({
        sourceJobCardId: job.id,
        customerVisitOverrideReason: 'Klinik acil takip istedi.',
      });
    });
  });

  it('D1-4/CSI-16: customerless General Tasks submit and approve without a proposal', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'GENERAL_TASK', title: 'Uzaktan görev', assignedTo: staffA.id, customerId: null,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görev tamamlandı.',
      });
      expect(submitted.followUpProposal).toBeNull();
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      });
      expect(approved.status).toBe('COMPLETED');
      expect(approved.followUpProposal).toBeNull();
    });
  });

  it('D1-15: legacy non-visit approval rows remain resolvable with and without persisted proposals', async () => {
    await withFixture(async ({ service, pool, manager, staffA, organizationId }) => {
      const noProposal = await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, version, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by)
         VALUES ($1, 'GENERAL_TASK', 'WAITING_APPROVAL', 2, 'Eski iş', $2, $3, NOW(), NOW(), $2) RETURNING id`,
        [organizationId, staffA.id, manager.id],
      );
      const approvedWithoutProposal = await service.approve(manager, noProposal.rows[0]!.id, {
        clientActionId: randomUUID(),
        expectedVersion: 2,
      });
      expect(approvedWithoutProposal.status).toBe('COMPLETED');
      expect(approvedWithoutProposal.followUpProposal).toBeNull();
      expect((approvedWithoutProposal as JobCard & { followUpJobCardId?: string }).followUpJobCardId)
        .toBeUndefined();

      const persistedProposal = await pool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, version, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by,
           follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
           follow_up_proposal_instructions, follow_up_proposal_origin, follow_up_proposed_by
         )
         VALUES ($1, 'GENERAL_TASK', 'WAITING_APPROVAL', 2, 'Eski teklifli iş', $2, $3,
           NOW(), NOW(), $2, $4, 'GENERAL_TASK', $2, 'Takip: Eski iş takibi', 'SYSTEM', $3)
         RETURNING id`,
        [organizationId, staffA.id, manager.id, PROPOSAL_AT],
      );
      const approvedWithProposal = await service.approve(manager, persistedProposal.rows[0]!.id, {
        clientActionId: randomUUID(),
        expectedVersion: 2,
      }) as JobCard & { followUpJobCardId: string };
      expect(approvedWithProposal.followUpJobCardId).toBeTypeOf('string');
      const child = await service.detail(manager, approvedWithProposal.followUpJobCardId);
      expect(child).toMatchObject({
        type: 'GENERAL_TASK',
        scheduledAt: PROPOSAL_AT,
      });
      expect(child.followUpContext).toMatchObject({
        sourceJobCardId: persistedProposal.rows[0]!.id,
      });
    });
  });

  it('keeps a legacy near-term persisted proposal valid under the new lead policy', async () => {
    await withFixture(async ({ service, pool, manager, staffA, organizationId }) => {
      // Legacy near-term target: a fresh DB-clock sample +5 minutes. The
      // 15-minute lead floor is deliberately NOT enforced for legacy persisted
      // proposals, so this near-term target (above the business instant but
      // below requestTime+15m) must survive approval unchanged.
      const legacyScheduledAt = baselineIso(await readDbBaseline(pool), 5 * MINUTE_MS);
      const persisted = await pool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, version, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by,
           follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
           follow_up_proposal_instructions, follow_up_proposal_origin, follow_up_proposed_by
         )
         VALUES ($1, 'GENERAL_TASK', 'WAITING_APPROVAL', 2, 'Eski yakın tarihli teklif', $2, $3,
           NOW(), NOW(), $2, $4, 'GENERAL_TASK', $2, 'Takip: Eski iş', 'SYSTEM', $3)
         RETURNING id`,
        [organizationId, staffA.id, manager.id, legacyScheduledAt],
      );

      const approved = await service.approve(manager, persisted.rows[0]!.id, {
        clientActionId: randomUUID(), expectedVersion: 2,
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child.scheduledAt).toBe(legacyScheduledAt);
    });
  });

  it('R2-AP-1: approval without priority/dueDate defaults the child to normal/null (backward compat)', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', engagementKind: 'CUSTOMER_VISIT', title: 'Ziyaret', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
        },
      });
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({ priority: 'normal', dueDate: null });
    });
  });

  it('R2-AP-2: approval priority override lands on the child and same-assignee stays ACCEPTED', async () => {
    await withFixture(async ({ pool, service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', engagementKind: 'CUSTOMER_VISIT', title: 'Ziyaret', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
        },
      });
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
          priority: 'urgent',
        },
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({ priority: 'urgent', dueDate: null, status: 'ACCEPTED' });
      expect(child.workflowContext.lifecycle).toMatchObject({
        acceptedAt: (await readReservedAt(pool, job.id, 'APPROVE')).toISOString(),
        acceptedBy: { id: staffA.id, name: 'Staff A' },
      });
    });
  });

  it('R2-AP-3: approval priority/dueDate override lands on a GENERAL_TASK child (legacy persisted proposal)', async () => {
    await withFixture(async ({ service, pool, manager, staffA, organizationId }) => {
      const job = await pool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, version, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by,
           follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
           follow_up_proposal_instructions, follow_up_proposal_origin, follow_up_proposed_by
         )
         VALUES ($1, 'GENERAL_TASK', 'WAITING_APPROVAL', 2, 'Eski teklifli iş', $2, $3,
           NOW(), NOW(), $2, $4, 'GENERAL_TASK', $2, 'Takip: Eski iş takibi', 'SYSTEM', $3)
         RETURNING id`,
        [organizationId, staffA.id, manager.id, PROPOSAL_AT],
      );
      const approved = await service.approve(manager, job.rows[0]!.id, {
        clientActionId: randomUUID(),
        expectedVersion: 2,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'GENERAL_TASK',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Eski iş takibi',
          priority: 'urgent',
          dueDate: '2026-09-15',
        },
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        type: 'GENERAL_TASK',
        priority: 'urgent',
        dueDate: '2026-09-15',
      });
    });
  });

  it('R2-AP-4: approval rejects a non-null dueDate for a SALES_MEETING child', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', engagementKind: 'CUSTOMER_VISIT', title: 'Ziyaret', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
        },
      });
      await expect(service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
          dueDate: '2026-09-15',
        },
      })).rejects.toMatchObject(appError('VALIDATION_ERROR', 400));
    });
  });

  it('R2-AP-5: approval rejects an invalid priority value', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', engagementKind: 'CUSTOMER_VISIT', title: 'Ziyaret', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
        },
      });
      await expect(service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
          priority: 'bogus' as never,
        },
      })).rejects.toMatchObject(appError('VALIDATION_ERROR', 400));
    });
  });

  it('R2-AP-6: different-assignee approval stays NEW with priority override applied', async () => {
    await withFixture(async ({ service, manager, staffA, staffB, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', engagementKind: 'CUSTOMER_VISIT', title: 'Ziyaret', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
        },
      });
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
          priority: 'high',
        },
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({ priority: 'high', dueDate: null, status: 'NEW' });
      expect(child.workflowContext.lifecycle).toMatchObject({ acceptedAt: null, acceptedBy: null });
    });
  });
});
