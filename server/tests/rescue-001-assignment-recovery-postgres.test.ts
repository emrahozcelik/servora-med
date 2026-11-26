import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { AppError } from '../src/errors/index.js';
import {
  PostgresAssignmentOfferExpiryRepository,
  createAssignmentOfferExpiryWorker,
} from '../src/modules/job-cards/assignment-offer-expiry-worker.js';
import { localDateKey } from '../src/modules/job-cards/local-calendar.js';
import { getAllowedLifecycleCommands } from '../src/modules/job-cards/policy.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { isSundayDateKey } from '../src/modules/job-cards/local-calendar.js';
import type {
  JobCardActor,
  JobCardStatus,
  JobCardType,
  NormalizedJobCardCreateInput,
} from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, readDbBaseline } from './support/db-clock-baseline.js';

/**
 * RESCUE-001 audit — PostgreSQL 17 characterization tests for R01, R03, R04,
 * R06, and R07 against the exact baseline (no production code changes).
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const WINDOW_ON = { enabled: true } as const;
const CALENDAR_OFF = { enabled: false, reminderLeadMinutes: 30 } as const;
const CALENDAR_ON = { enabled: true, reminderLeadMinutes: 30 } as const;

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `rescue001_${randomUUID().replaceAll('-', '')}`;
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

async function seedOrg(pool: Pool, label: string) {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [`RESCUE-001 ${label}`],
  )).rows[0]!.id;

  const insertUser = async (
    role: 'ADMIN' | 'MANAGER' | 'STAFF',
    name: string,
  ): Promise<JobCardActor> => {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
      [organizationId, name, `${randomUUID()}@rescue001.local`, role],
    )).rows[0]!.id;
    if (role === 'STAFF') {
      await pool.query(
        `INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, 'Saha Personeli')`,
        [organizationId, id],
      );
    }
    return { id, organizationId, role };
  };

  const manager = await insertUser('MANAGER', `${label} Müdür`);
  const admin = await insertUser('ADMIN', `${label} Admin`);
  const staff = await insertUser('STAFF', `${label} Personel A`);
  const otherStaff = await insertUser('STAFF', `${label} Personel B`);
  const customerId = (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, `Klinik ${label}`],
  )).rows[0]!.id;
  const secondCustomerId = (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, `Diğer Klinik ${label}`],
  )).rows[0]!.id;

  const thirdCustomerId = (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, `Üçüncü Klinik ${label}`],
  )).rows[0]!.id;
  const fourthCustomerId = (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, `Dördüncü Klinik ${label}`],
  )).rows[0]!.id;

  return { organizationId, manager, admin, staff, otherStaff, customerId, secondCustomerId, thirdCustomerId, fourthCustomerId };
}

function buildService(
  pool: Pool,
  clock: { now: Date },
  options: {
    calendar?: { enabled: boolean; reminderLeadMinutes: number };
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

async function rejectionOf(work: () => Promise<unknown>): Promise<AppError> {
  try {
    await work();
  } catch (caught) {
    return caught as AppError;
  }
  throw new Error('Expected promise to reject');
}

function iso(base: Date, deltaMs: number): string {
  return new Date(base.valueOf() + deltaMs).toISOString();
}

/**
 * Picks a future non-Sunday Istanbul local date and returns UTC instants for
 * 11:00–12:00 and 10:00–11:00 on that local day so `availableSlots` never
 * skips the day under WORKING-DAY V1.
 */
function nextWorkingDaySlots(baseline: Date) {
  let candidate = new Date(baseline.valueOf() + 2 * DAY_MS);
  while (isSundayDateKey(localDateKey(candidate, 'Europe/Istanbul'))) {
    candidate = new Date(candidate.valueOf() + DAY_MS);
  }
  const dayKey = localDateKey(candidate, 'Europe/Istanbul');
  // Europe/Istanbul is UTC+3 year-round.
  const tenAm = new Date(`${dayKey}T07:00:00.000Z`);
  const elevenAm = new Date(`${dayKey}T08:00:00.000Z`);
  const twelvePm = new Date(`${dayKey}T09:00:00.000Z`);
  const onePm = new Date(`${dayKey}T10:00:00.000Z`);
  return {
    searchFrom: tenAm.toISOString(),
    searchEnds: elevenAm.toISOString(),
    slotStart: elevenAm.toISOString(),
    slotEnd: twelvePm.toISOString(),
    laterFreeStart: onePm.toISOString(),
  };
}

function meetingInput(input: {
  customerId: string;
  assignedTo: string;
  scheduledAt: string;
  scheduledEndsAt: string;
  title?: string;
}): NormalizedJobCardCreateInput {
  return {
    clientActionId: randomUUID(),
    type: 'SALES_MEETING',
    title: input.title ?? 'Klinik ziyareti',
    description: undefined,
    customerId: input.customerId,
    contactId: null,
    assignedTo: input.assignedTo,
    priority: 'normal',
    dueDate: null,
    scheduledAt: input.scheduledAt,
    scheduledEndsAt: input.scheduledEndsAt,
    engagementKind: 'SALES_MEETING',
  };
}

async function insertRawJob(pool: Pool, input: {
  organizationId: string;
  type: JobCardType;
  status: JobCardStatus;
  assignedTo: string;
  createdBy: string;
  customerId?: string | null;
  title?: string;
  scheduledAt?: string | null;
  scheduledEndsAt?: string | null;
  dueDate?: string | null;
  startedAt?: string | null;
  acceptedAt?: string | null;
}) {
  const isAccepted = ['ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'].includes(input.status);
  const isStarted = ['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'].includes(input.status);
  const isSubmitted = ['WAITING_APPROVAL', 'REVISION_REQUESTED'].includes(input.status);
  const engagementKind = input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null;
  const acceptedAt = input.acceptedAt ?? (isAccepted ? '2026-01-01T08:00:00.000Z' : null);
  const startedAt = input.startedAt ?? (isStarted ? '2026-01-01T09:00:00.000Z' : null);
  const submittedAt = isSubmitted ? '2026-01-01T10:00:00.000Z' : null;

  const row = (await pool.query<{ id: string; version: number }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, assigned_to, created_by,
        accepted_at, accepted_by, started_at, staff_completed_at, staff_completed_by,
        revision_requested_at, revision_requested_by, revision_reason,
        scheduled_at, scheduled_ends_at, due_date, engagement_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8::timestamptz, $9::uuid, $10::timestamptz, $11::timestamptz, $12::uuid,
             $13::timestamptz, $14::uuid, $15,
             $16::timestamptz, $17::timestamptz, $18::date, $19)
     RETURNING id, version`,
    [
      input.organizationId,
      input.type,
      input.status,
      input.title ?? `Test ${input.type} ${input.status}`,
      input.customerId ?? null,
      input.assignedTo,
      input.createdBy,
      acceptedAt,
      acceptedAt ? input.assignedTo : null,
      startedAt,
      submittedAt,
      submittedAt ? input.assignedTo : null,
      input.status === 'REVISION_REQUESTED' ? '2026-01-01T10:30:00.000Z' : null,
      input.status === 'REVISION_REQUESTED' ? input.createdBy : null,
      input.status === 'REVISION_REQUESTED' ? 'Düzeltme gerekli' : null,
      input.scheduledAt ?? null,
      input.scheduledEndsAt ?? null,
      input.dueDate ?? null,
      engagementKind,
    ],
  )).rows[0]!;

  if (input.scheduledAt) {
    await pool.query(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
          organization_timezone, source, created_by, created_at)
       VALUES ($1, $2, 1, $3, $4, 'Europe/Istanbul', 'CREATE', $5, $6)`,
      [
        input.organizationId,
        row.id,
        input.scheduledAt,
        input.scheduledEndsAt ?? null,
        input.createdBy,
        new Date(Date.parse(input.scheduledAt) - HOUR_MS),
      ],
    );
  }
  return { id: row.id, version: Number(row.version) };
}

async function insertRawOffer(pool: Pool, input: {
  organizationId: string;
  jobCardId: string;
  assigneeUserId: string;
  openedBy: string;
  openedAt: Date;
  acceptanceDueAt: Date;
  urgentReason?: 'SHORT_NOTICE' | 'START_PASSED' | null;
  state: 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'RELEASED' | 'EXPIRED' | 'WITHDRAWN';
  closedAt?: Date | null;
  closedBy?: string | null;
  closeReason?: string | null;
  closeText?: string | null;
}) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_assignment_offers
       (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason, opened_by,
        acceptance_due_at, urgent_reason, state, closed_at, closed_by, close_reason, close_text)
     VALUES ($1, $2, $3, $4, 'CREATE', $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.organizationId,
      input.jobCardId,
      input.assigneeUserId,
      input.openedAt,
      input.openedBy,
      input.acceptanceDueAt,
      input.urgentReason ?? null,
      input.state,
      input.closedAt ?? null,
      input.closedBy ?? null,
      input.closeReason ?? null,
      input.closeText ?? null,
    ],
  )).rows[0]!.id;
}

describe.skipIf(!databaseUrl)('RESCUE-001 PostgreSQL characterization (R01, R03, R04, R06, R07)', () => {
  it('R01: rejects proposedScheduledAt on ON_LEAVE / TOO_FAR / OTHER and requires it on SCHEDULE_CONFLICT (decline & release)', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrg(pool, 'R01');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);

      const created = await service.create(seed.manager, meetingInput({
        customerId: seed.customerId,
        assignedTo: seed.staff.id,
        scheduledAt: iso(baseline, 4 * HOUR_MS),
        scheduledEndsAt: iso(baseline, 5 * HOUR_MS),
      }));
      const proposedTime = iso(baseline, 8 * HOUR_MS);

      for (const reasonCode of ['ON_LEAVE', 'TOO_FAR', 'OTHER'] as const) {
        const err = await rejectionOf(() => service.declineAssignment(seed.staff, created.id, {
          clientActionId: randomUUID(),
          expectedVersion: created.version,
          reasonCode,
          reasonText: `${reasonCode} açıklaması`,
          proposedScheduledAt: proposedTime,
        }));
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err.statusCode).toBe(400);
        expect((err.details as { fieldErrors?: Record<string, string> })?.fieldErrors?.proposedScheduledAt)
          .toBe('Önerilen zaman yalnızca plan çakışması nedeniyle verilebilir.');
      }

      const missingProposalOnDecline = await rejectionOf(() => service.declineAssignment(
        seed.staff,
        created.id,
        {
          clientActionId: randomUUID(),
          expectedVersion: created.version,
          reasonCode: 'SCHEDULE_CONFLICT',
          reasonText: 'Aynı saatte başka müşteri randevusu var.',
        },
      ));
      expect(missingProposalOnDecline.code).toBe('VALIDATION_ERROR');
      expect(missingProposalOnDecline.statusCode).toBe(400);
      expect((missingProposalOnDecline.details as { fieldErrors?: Record<string, string> })
        ?.fieldErrors?.proposedScheduledAt).toBe('Önerilen zaman zorunludur.');

      // Accept first so we can characterize RELEASE_ASSIGNMENT with the same rules.
      const accepted = await service.acceptAssignment(seed.staff, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: created.version,
      });

      for (const reasonCode of ['ON_LEAVE', 'TOO_FAR', 'OTHER'] as const) {
        const err = await rejectionOf(() => service.releaseAssignment(seed.staff, created.id, {
          clientActionId: randomUUID(),
          expectedVersion: accepted.version,
          reasonCode,
          reasonText: `${reasonCode} bırakma açıklaması`,
          proposedScheduledAt: proposedTime,
        }));
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err.statusCode).toBe(400);
        expect((err.details as { fieldErrors?: Record<string, string> })?.fieldErrors?.proposedScheduledAt)
          .toBe('Önerilen zaman yalnızca plan çakışması nedeniyle verilebilir.');
      }

      const missingProposalOnRelease = await rejectionOf(() => service.releaseAssignment(
        seed.staff,
        created.id,
        {
          clientActionId: randomUUID(),
          expectedVersion: accepted.version,
          reasonCode: 'SCHEDULE_CONFLICT',
          reasonText: 'Saat çakışması oluştu.',
          proposedScheduledAt: null,
        },
      ));
      expect(missingProposalOnRelease.code).toBe('VALIDATION_ERROR');
      expect(missingProposalOnRelease.statusCode).toBe(400);
      expect((missingProposalOnRelease.details as { fieldErrors?: Record<string, string> })
        ?.fieldErrors?.proposedScheduledAt).toBe('Önerilen zaman zorunludur.');

      // Control: SCHEDULE_CONFLICT with a free future proposal succeeds and persists.
      const released = await service.releaseAssignment(seed.staff, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: accepted.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Saat çakışması oluştu; sonraki uygun saati öneriyorum.',
        proposedScheduledAt: proposedTime,
      });
      expect(released.status).toBe('NEW');
      const offerRow = (await pool.query<{ state: string; proposed_scheduled_at: Date | null }>(
        `SELECT state, proposed_scheduled_at FROM job_card_assignment_offers WHERE job_card_id = $1`,
        [created.id],
      )).rows[0]!;
      expect(offerRow.state).toBe('RELEASED');
      expect(offerRow.proposed_scheduled_at?.toISOString()).toBe(proposedTime);
    });
  });

  it('R03: declined and released jobs stay NEW and still occupy original staff interval for create and available-slots', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrg(pool, 'R03');
      const slots = nextWorkingDaySlots(baseline);
      const clock = { now: baseline };

      // Verify both calendar OFF and calendar ON (core SCH-001 occupancy).
      const serviceCalOff = buildService(pool, clock, { calendar: CALENDAR_OFF, assignmentWindow: WINDOW_ON }).service;
      const serviceCalOn = buildService(pool, clock, { calendar: CALENDAR_ON, assignmentWindow: WINDOW_ON }).service;

      const releaseSlotEnd = new Date(Date.parse(slots.laterFreeStart) + HOUR_MS).toISOString();

      // Positive baseline: before creating the jobs, both intervals are returned for seed.staff.
      const availableBefore = await serviceCalOff.availableSlots(seed.manager, {
        type: 'SALES_MEETING',
        customerId: seed.secondCustomerId,
        assignedTo: seed.staff.id,
        scheduledAt: slots.searchFrom,
        scheduledEndsAt: slots.searchEnds,
        jobCardId: null,
      });
      expect(availableBefore.slots).toContainEqual({
        startsAt: slots.slotStart,
        endsAt: slots.slotEnd,
      });
      expect(availableBefore.slots).toContainEqual({
        startsAt: slots.laterFreeStart,
        endsAt: releaseSlotEnd,
      });

      // 1) DECLINED job still occupies staff interval.
      const declinedJob = await serviceCalOff.create(seed.manager, meetingInput({
        customerId: seed.customerId,
        assignedTo: seed.staff.id,
        scheduledAt: slots.slotStart,
        scheduledEndsAt: slots.slotEnd,
        title: 'Reddedilecek ziyaret',
      }));
      const declineRes = await serviceCalOff.declineAssignment(seed.staff, declinedJob.id, {
        clientActionId: randomUUID(),
        expectedVersion: declinedJob.version,
        reasonCode: 'ON_LEAVE',
        reasonText: 'İzinliyim.',
      });
      expect(declineRes.status).toBe('NEW');

      const overlapDeclinedOff = await rejectionOf(() => serviceCalOff.create(
        seed.manager,
        meetingInput({
          customerId: seed.secondCustomerId,
          assignedTo: seed.staff.id,
          scheduledAt: slots.slotStart,
          scheduledEndsAt: slots.slotEnd,
          title: 'Çakışan yeni iş (cal off)',
        }),
      ));
      expect(overlapDeclinedOff.code).toBe('CALENDAR_CONFLICT');
      expect(overlapDeclinedOff.statusCode).toBe(409);
      expect((overlapDeclinedOff.details as { conflicts: Array<{ id: string }> }).conflicts[0]?.id)
        .toBe(declinedJob.id);

      const overlapDeclinedOn = await rejectionOf(() => serviceCalOn.create(
        seed.manager,
        meetingInput({
          customerId: seed.secondCustomerId,
          assignedTo: seed.staff.id,
          scheduledAt: slots.slotStart,
          scheduledEndsAt: slots.slotEnd,
          title: 'Çakışan yeni iş (cal on)',
        }),
      ));
      expect(overlapDeclinedOn.code).toBe('CALENDAR_CONFLICT');
      expect(overlapDeclinedOn.statusCode).toBe(409);

      const availableAfterDecline = await serviceCalOff.availableSlots(seed.manager, {
        type: 'SALES_MEETING',
        customerId: seed.secondCustomerId,
        assignedTo: seed.staff.id,
        scheduledAt: slots.searchFrom,
        scheduledEndsAt: slots.searchEnds,
        jobCardId: null,
      });
      expect(availableAfterDecline.slots).not.toContainEqual({
        startsAt: slots.slotStart,
        endsAt: slots.slotEnd,
      });
      expect(availableAfterDecline.slots).toContainEqual({
        startsAt: slots.laterFreeStart,
        endsAt: releaseSlotEnd,
      });

      // Control: another staff member is free on that interval.
      const otherStaffJob = await serviceCalOff.create(seed.manager, meetingInput({
        customerId: seed.thirdCustomerId,
        assignedTo: seed.otherStaff.id,
        scheduledAt: slots.slotStart,
        scheduledEndsAt: slots.slotEnd,
        title: 'Diğer personel işi',
      }));
      expect(otherStaffJob.status).toBe('NEW');

      // 2) RELEASED job returns to NEW and still occupies staff interval.
      const toRelease = await serviceCalOff.create(seed.manager, meetingInput({
        customerId: seed.thirdCustomerId,
        assignedTo: seed.staff.id,
        scheduledAt: slots.laterFreeStart,
        scheduledEndsAt: releaseSlotEnd,
        title: 'Geri bırakılacak ziyaret',
      }));
      const accepted = await serviceCalOff.acceptAssignment(seed.staff, toRelease.id, {
        clientActionId: randomUUID(),
        expectedVersion: toRelease.version,
      });
      const released = await serviceCalOff.releaseAssignment(seed.staff, toRelease.id, {
        clientActionId: randomUUID(),
        expectedVersion: accepted.version,
        reasonCode: 'TOO_FAR',
        reasonText: 'Bölge dışı.',
      });
      expect(released.status).toBe('NEW');

      const overlapReleased = await rejectionOf(() => serviceCalOff.create(
        seed.manager,
        meetingInput({
          customerId: seed.fourthCustomerId,
          assignedTo: seed.staff.id,
          scheduledAt: slots.laterFreeStart,
          scheduledEndsAt: releaseSlotEnd,
          title: 'Çakışan iş (released)',
        }),
      ));
      expect(overlapReleased.code).toBe('CALENDAR_CONFLICT');
      expect(overlapReleased.statusCode).toBe(409);
      expect((overlapReleased.details as { conflicts: Array<{ id: string }> }).conflicts[0]?.id)
        .toBe(toRelease.id);

      const availableAfterRelease = await serviceCalOff.availableSlots(seed.manager, {
        type: 'SALES_MEETING',
        customerId: seed.secondCustomerId,
        assignedTo: seed.staff.id,
        scheduledAt: slots.searchFrom,
        scheduledEndsAt: slots.searchEnds,
        jobCardId: null,
      });
      expect(availableAfterRelease.slots).not.toContainEqual({
        startsAt: slots.laterFreeStart,
        endsAt: releaseSlotEnd,
      });
      expect(availableAfterRelease.slots.length).toBeGreaterThan(0);
    });
  });

  it('R04: record-only change-request resolution leaves job unchanged; real reschedule resolves atomically', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrg(pool, 'R04');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);

      const initialStart = iso(baseline, 3 * HOUR_MS);
      const initialEnd = iso(baseline, 4 * HOUR_MS);
      const jobA = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'SALES_MEETING',
        status: 'IN_PROGRESS',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        customerId: seed.customerId,
        scheduledAt: initialStart,
        scheduledEndsAt: initialEnd,
      });

      // Case 1: record-only closure does NOT change job_cards or schedule revisions.
      const reqA = await service.createChangeRequest(seed.staff, jobA.id, {
        clientActionId: randomUUID(),
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Müşteri erteledi.',
      });
      const resolvedA = await service.resolveChangeRequest(seed.manager, jobA.id, reqA.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'RESCHEDULED',
      });
      expect(resolvedA.resolution).toBe('RESCHEDULED');

      const jobAAfter = (await pool.query<{
        status: string; version: number; scheduled_at: Date; scheduled_ends_at: Date;
      }>(
        `SELECT status, version, scheduled_at, scheduled_ends_at FROM job_cards WHERE id = $1`,
        [jobA.id],
      )).rows[0]!;
      expect(jobAAfter.status).toBe('IN_PROGRESS');
      expect(jobAAfter.version).toBe(jobA.version);
      expect(jobAAfter.scheduled_at.toISOString()).toBe(initialStart);
      expect(jobAAfter.scheduled_ends_at.toISOString()).toBe(initialEnd);

      const revCountA = (await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM job_card_schedule_revisions WHERE job_card_id = $1`,
        [jobA.id],
      )).rows[0]!.count;
      expect(Number(revCountA)).toBe(1);

      // Persisted closure and activity evidence for record-only resolution.
      const reqARow = (await pool.query<{
        state: string; resolution: string | null; resolved_by: string | null; resolved_at: Date | null;
      }>(
        `SELECT state, resolution, resolved_by, resolved_at FROM job_card_change_requests WHERE id = $1`,
        [reqA.changeRequestId],
      )).rows[0]!;
      expect(reqARow.state).toBe('CLOSED');
      expect(reqARow.resolution).toBe('RESCHEDULED');
      expect(reqARow.resolved_by).toBe(seed.manager.id);
      expect(reqARow.resolved_at).not.toBeNull();

      const activityA = (await pool.query<{ event_type: string; metadata: Record<string, unknown> }>(
        `SELECT event_type, metadata FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_CHANGE_REQUEST_RESOLVED'`,
        [jobA.id],
      )).rows;
      expect(activityA).toHaveLength(1);
      expect(activityA[0]?.metadata).toMatchObject({
        requestId: reqA.changeRequestId,
        resolution: 'RESCHEDULED',
      });

      // Case 2: real reschedule with changeRequestResolution updates schedule & closes request atomically.
      const initialStartB = iso(baseline, 6 * HOUR_MS);
      const initialEndB = iso(baseline, 7 * HOUR_MS);
      const jobB = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'SALES_MEETING',
        status: 'ACCEPTED',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        customerId: seed.customerId,
        scheduledAt: initialStartB,
        scheduledEndsAt: initialEndB,
      });
      const reqB = await service.createChangeRequest(seed.staff, jobB.id, {
        clientActionId: randomUUID(),
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Saat değişmeli.',
      });

      // Control 2a: patch without actual schedule revision rejects atomic closure.
      const rejectedPatch = await rejectionOf(() => service.patch(seed.manager, jobB.id, {
        expectedVersion: jobB.version,
        title: 'Sadece başlık',
        changeRequestResolution: {
          changeRequestId: reqB.changeRequestId,
          resolution: 'RESCHEDULED',
        },
      }));
      expect(rejectedPatch.statusCode).toBe(400);

      // Control 2b: atomicity check — real schedule change paired with nonexistent changeRequestId
      // rejects with 404 CHANGE_REQUEST_NOT_FOUND and rolls back the schedule mutation.
      const movedStart = iso(baseline, 9 * HOUR_MS);
      const movedEnd = iso(baseline, 10 * HOUR_MS);
      const badReqPatch = await rejectionOf(() => service.patch(seed.manager, jobB.id, {
        expectedVersion: jobB.version,
        scheduledAt: movedStart,
        scheduledEndsAt: movedEnd,
        changeRequestResolution: {
          changeRequestId: randomUUID(),
          resolution: 'RESCHEDULED',
        },
      }));
      expect(badReqPatch.code).toBe('CHANGE_REQUEST_NOT_FOUND');
      expect(badReqPatch.statusCode).toBe(404);

      const jobBAfterRollback = (await pool.query<{
        version: number; scheduled_at: Date; scheduled_ends_at: Date;
      }>(
        `SELECT version, scheduled_at, scheduled_ends_at FROM job_cards WHERE id = $1`,
        [jobB.id],
      )).rows[0]!;
      expect(jobBAfterRollback.version).toBe(jobB.version);
      expect(jobBAfterRollback.scheduled_at.toISOString()).toBe(initialStartB);
      expect(jobBAfterRollback.scheduled_ends_at.toISOString()).toBe(initialEndB);
      const revCountBBefore = (await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM job_card_schedule_revisions WHERE job_card_id = $1`,
        [jobB.id],
      )).rows[0]!.count;
      expect(Number(revCountBBefore)).toBe(1);
      const reqBStillOpen = (await pool.query<{ state: string }>(
        `SELECT state FROM job_card_change_requests WHERE id = $1`,
        [reqB.changeRequestId],
      )).rows[0]!;
      expect(reqBStillOpen.state).toBe('OPEN');

      const patchedB = await service.patch(seed.manager, jobB.id, {
        expectedVersion: jobB.version,
        scheduledAt: movedStart,
        scheduledEndsAt: movedEnd,
        changeRequestResolution: {
          changeRequestId: reqB.changeRequestId,
          resolution: 'RESCHEDULED',
        },
      });
      expect(patchedB.version).toBe(jobB.version + 1);
      expect(patchedB.scheduledAt).toBe(movedStart);
      expect(patchedB.scheduledEndsAt).toBe(movedEnd);

      const reqBRow = (await pool.query<{ state: string; resolution: string | null }>(
        `SELECT state, resolution FROM job_card_change_requests WHERE id = $1`,
        [reqB.changeRequestId],
      )).rows[0]!;
      expect(reqBRow.state).toBe('CLOSED');
      expect(reqBRow.resolution).toBe('RESCHEDULED');

      const revCountB = (await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM job_card_schedule_revisions WHERE job_card_id = $1`,
        [jobB.id],
      )).rows[0]!.count;
      expect(Number(revCountB)).toBe(2);
    });
  });

  it('R06: needs-action and OVR-6 unaccepted-past-start are disjoint, and urgent/overdue OPEN offers appear in needs-action before expiry worker runs', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrg(pool, 'R06');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);
      const pastStart = new Date(baseline.valueOf() - 2 * HOUR_MS);
      const pastEnd = new Date(baseline.valueOf() - HOUR_MS);
      const futureStart = new Date(baseline.valueOf() + 5 * HOUR_MS);
      const futureEnd = new Date(baseline.valueOf() + 6 * HOUR_MS);

      // 1) DECLINED offer, past start -> needs-action only
      const declinedPast = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'PRODUCT_DELIVERY',
        status: 'NEW',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        scheduledAt: pastStart.toISOString(),
        scheduledEndsAt: pastEnd.toISOString(),
        title: 'Declined Past',
      });
      await insertRawOffer(pool, {
        organizationId: seed.organizationId,
        jobCardId: declinedPast.id,
        assigneeUserId: seed.staff.id,
        openedBy: seed.manager.id,
        openedAt: new Date(baseline.valueOf() - 4 * HOUR_MS),
        acceptanceDueAt: new Date(baseline.valueOf() - 3 * HOUR_MS),
        state: 'DECLINED',
        closedAt: new Date(baseline.valueOf() - 3.5 * HOUR_MS),
        closedBy: seed.staff.id,
        closeReason: 'ON_LEAVE',
        closeText: 'İzin',
      });

      // 2) Urgent SHORT_NOTICE OPEN offer (still before deadline, expiry worker NOT run) -> needs-action only
      const urgentShortNotice = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'PRODUCT_DELIVERY',
        status: 'NEW',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        scheduledAt: new Date(baseline.valueOf() + 30 * MINUTE_MS).toISOString(),
        scheduledEndsAt: new Date(baseline.valueOf() + 90 * MINUTE_MS).toISOString(),
        title: 'Urgent Short Notice',
      });
      await insertRawOffer(pool, {
        organizationId: seed.organizationId,
        jobCardId: urgentShortNotice.id,
        assigneeUserId: seed.staff.id,
        openedBy: seed.manager.id,
        openedAt: baseline,
        acceptanceDueAt: new Date(baseline.valueOf() + 10 * MINUTE_MS),
        urgentReason: 'SHORT_NOTICE',
        state: 'OPEN',
      });

      // 3) Urgent START_PASSED OPEN offer (expiry worker NOT run) -> needs-action only (NOT OVR-6!)
      const urgentStartPassed = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'SALES_MEETING',
        status: 'NEW',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        scheduledAt: new Date(baseline.valueOf() - 10 * MINUTE_MS).toISOString(),
        scheduledEndsAt: new Date(baseline.valueOf() + 50 * MINUTE_MS).toISOString(),
        title: 'Urgent Start Passed',
      });
      await insertRawOffer(pool, {
        organizationId: seed.organizationId,
        jobCardId: urgentStartPassed.id,
        assigneeUserId: seed.staff.id,
        openedBy: seed.manager.id,
        openedAt: baseline,
        acceptanceDueAt: new Date(baseline.valueOf() + 10 * MINUTE_MS),
        urgentReason: 'START_PASSED',
        state: 'OPEN',
      });

      // 4) OPEN offer whose acceptanceDueAt <= now, worker NOT run -> needs-action only
      const overdueOpen = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'PRODUCT_DELIVERY',
        status: 'NEW',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        scheduledAt: futureStart.toISOString(),
        scheduledEndsAt: futureEnd.toISOString(),
        title: 'Overdue Open Worker Not Run',
      });
      await insertRawOffer(pool, {
        organizationId: seed.organizationId,
        jobCardId: overdueOpen.id,
        assigneeUserId: seed.staff.id,
        openedBy: seed.manager.id,
        openedAt: new Date(baseline.valueOf() - HOUR_MS),
        acceptanceDueAt: new Date(baseline.valueOf() - MINUTE_MS),
        state: 'OPEN',
      });

      // 5) Calm future OPEN offer -> in NEITHER list
      const calmOpen = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'PRODUCT_DELIVERY',
        status: 'NEW',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        scheduledAt: futureStart.toISOString(),
        scheduledEndsAt: futureEnd.toISOString(),
        title: 'Calm Open',
      });
      await insertRawOffer(pool, {
        organizationId: seed.organizationId,
        jobCardId: calmOpen.id,
        assigneeUserId: seed.staff.id,
        openedBy: seed.manager.id,
        openedAt: baseline,
        acceptanceDueAt: new Date(baseline.valueOf() + 4 * HOUR_MS),
        state: 'OPEN',
      });

      // 6) Legacy / no-offer NEW job past start -> OVR-6 unaccepted-past-start only
      const noOfferPast = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'SALES_MEETING',
        status: 'NEW',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        scheduledAt: pastStart.toISOString(),
        scheduledEndsAt: pastEnd.toISOString(),
        title: 'No Offer Past',
      });

      // 7) GENERAL_TASK past start (no offer possible) -> OVR-6 unaccepted-past-start only
      const generalTaskPast = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'GENERAL_TASK',
        status: 'NEW',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        scheduledAt: pastStart.toISOString(),
        title: 'General Task Past',
      });

      // 8) RELEASED, EXPIRED, and WITHDRAWN (PLANNED_WINDOW_PASSED) past start -> needs-action only
      const releasedPast = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'PRODUCT_DELIVERY',
        status: 'NEW',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        scheduledAt: pastStart.toISOString(),
        scheduledEndsAt: pastEnd.toISOString(),
        title: 'Released Past',
      });
      await insertRawOffer(pool, {
        organizationId: seed.organizationId,
        jobCardId: releasedPast.id,
        assigneeUserId: seed.staff.id,
        openedBy: seed.manager.id,
        openedAt: new Date(baseline.valueOf() - 4 * HOUR_MS),
        acceptanceDueAt: new Date(baseline.valueOf() - 3 * HOUR_MS),
        state: 'RELEASED',
        closedAt: new Date(baseline.valueOf() - 2.5 * HOUR_MS),
        closedBy: seed.staff.id,
        closeReason: 'TOO_FAR',
        closeText: 'Uzak bölge.',
      });

      const expiredPast = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'SALES_MEETING',
        status: 'NEW',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        scheduledAt: pastStart.toISOString(),
        scheduledEndsAt: pastEnd.toISOString(),
        title: 'Expired Past',
      });
      await insertRawOffer(pool, {
        organizationId: seed.organizationId,
        jobCardId: expiredPast.id,
        assigneeUserId: seed.staff.id,
        openedBy: seed.manager.id,
        openedAt: new Date(baseline.valueOf() - 4 * HOUR_MS),
        acceptanceDueAt: new Date(baseline.valueOf() - 3 * HOUR_MS),
        state: 'EXPIRED',
        closedAt: new Date(baseline.valueOf() - 3 * HOUR_MS),
        closedBy: null,
      });

      const withdrawnWindowPast = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'SALES_MEETING',
        status: 'NEW',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
        scheduledAt: pastStart.toISOString(),
        scheduledEndsAt: pastEnd.toISOString(),
        title: 'Withdrawn Window Passed Past',
      });
      await insertRawOffer(pool, {
        organizationId: seed.organizationId,
        jobCardId: withdrawnWindowPast.id,
        assigneeUserId: seed.staff.id,
        openedBy: seed.manager.id,
        openedAt: new Date(baseline.valueOf() - 4 * HOUR_MS),
        acceptanceDueAt: new Date(baseline.valueOf() - 3 * HOUR_MS),
        state: 'WITHDRAWN',
        closedAt: new Date(baseline.valueOf() - 4 * HOUR_MS),
        closedBy: seed.manager.id,
        closeReason: 'PLANNED_WINDOW_PASSED',
      });

      const needsAction = await service.listAssignmentOffersNeedingAction(seed.manager, {
        limit: 50,
        offset: 0,
      });
      const unacceptedPastStart = await service.listUnacceptedPastStart(seed.manager, {
        limit: 50,
        offset: 0,
      });

      const needsIds = needsAction.items.map((item) => item.jobCardId);
      const unacceptedIds = unacceptedPastStart.items.map((item) => item.jobCardId);
      const overlap = needsIds.filter((id) => unacceptedIds.includes(id));

      expect(overlap).toEqual([]);
      expect(new Set(needsIds)).toEqual(new Set([
        declinedPast.id,
        releasedPast.id,
        expiredPast.id,
        withdrawnWindowPast.id,
        urgentShortNotice.id,
        urgentStartPassed.id,
        overdueOpen.id,
      ]));
      expect(new Set(unacceptedIds)).toEqual(new Set([
        noOfferPast.id,
        generalTaskPast.id,
      ]));
      expect(needsIds).not.toContain(calmOpen.id);
      expect(unacceptedIds).not.toContain(calmOpen.id);
    });
  });

  it('R07: STAFF cannot CANCEL across types/statuses when window is enabled, and offer expiry never auto-cancels the JobCard', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrg(pool, 'R07');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);
      const futureStart = iso(baseline, 4 * HOUR_MS);
      const futureEnd = iso(baseline, 5 * HOUR_MS);

      // 1) STAFF cannot CANCEL any active status / type (in-window or outside-window).
      const statuses: Array<'NEW' | 'ACCEPTED' | 'IN_PROGRESS' | 'WAITING_APPROVAL' | 'REVISION_REQUESTED'> = [
        'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
      ];
      for (const status of statuses) {
        const delivery = await insertRawJob(pool, {
          organizationId: seed.organizationId,
          type: 'PRODUCT_DELIVERY',
          status,
          assignedTo: seed.staff.id,
          createdBy: seed.manager.id,
          customerId: seed.customerId,
          scheduledAt: futureStart,
          scheduledEndsAt: futureEnd,
        });
        const allowed = getAllowedLifecycleCommands(
          seed.staff,
          {
            id: delivery.id,
            organizationId: seed.organizationId,
            type: 'PRODUCT_DELIVERY',
            status,
            assignedTo: seed.staff.id,
            scheduledAt: futureStart,
          },
          baseline,
          { assignmentWindowEnabled: true },
        );
        expect(allowed).not.toContain('CANCEL');

        const cancelErr = await rejectionOf(() => service.cancel(seed.staff, delivery.id, {
          clientActionId: randomUUID(),
          expectedVersion: delivery.version,
          cancelReason: 'Personel iptal denemesi',
        }));
        expect(cancelErr.code).toBe('INVALID_TRANSITION');
        expect(cancelErr.statusCode).toBe(409);
      }

      const generalTask = await insertRawJob(pool, {
        organizationId: seed.organizationId,
        type: 'GENERAL_TASK',
        status: 'NEW',
        assignedTo: seed.staff.id,
        createdBy: seed.manager.id,
      });
      const generalCancelErr = await rejectionOf(() => service.cancel(seed.staff, generalTask.id, {
        clientActionId: randomUUID(),
        expectedVersion: generalTask.version,
        cancelReason: 'Genel görev personel iptal denemesi',
      }));
      expect(generalCancelErr.code).toBe('INVALID_TRANSITION');
      expect(generalCancelErr.statusCode).toBe(409);

      // 2) Offer expiry closes offer as EXPIRED and leaves JobCard NEW (never auto-cancels).
      const offeredStart = iso(baseline, 10 * HOUR_MS);
      const offered = await service.create(seed.manager, meetingInput({
        customerId: seed.customerId,
        assignedTo: seed.staff.id,
        scheduledAt: offeredStart,
        scheduledEndsAt: iso(baseline, 11 * HOUR_MS),
        title: 'Süresi dolacak teklif',
      }));
      const offerBefore = (await pool.query<{
        id: string; assignee_user_id: string; state: string; acceptance_due_at: Date;
      }>(
        `SELECT id, assignee_user_id, state, acceptance_due_at
           FROM job_card_assignment_offers WHERE job_card_id = $1`,
        [offered.id],
      )).rows[0]!;
      expect(offerBefore.state).toBe('OPEN');

      // STAFF cannot CANCEL a real in-window NEW job with an OPEN offer before expiry.
      const allowedOnOffered = getAllowedLifecycleCommands(
        seed.staff,
        {
          id: offered.id,
          organizationId: seed.organizationId,
          type: 'SALES_MEETING',
          status: 'NEW',
          assignedTo: seed.staff.id,
          scheduledAt: offeredStart,
          assignmentOffer: {
            state: 'OPEN',
            assigneeUserId: offerBefore.assignee_user_id,
            acceptanceDueAt: offerBefore.acceptance_due_at.toISOString(),
          },
        },
        baseline,
        { assignmentWindowEnabled: true },
      );
      expect(allowedOnOffered).not.toContain('CANCEL');

      const offeredCancelErr = await rejectionOf(() => service.cancel(seed.staff, offered.id, {
        clientActionId: randomUUID(),
        expectedVersion: offered.version,
        cancelReason: 'Teklif varken personel iptal denemesi',
      }));
      expect(offeredCancelErr.code).toBe('INVALID_TRANSITION');
      expect(offeredCancelErr.statusCode).toBe(409);

      const offerStillOpen = (await pool.query<{ state: string }>(
        `SELECT state FROM job_card_assignment_offers WHERE id = $1`,
        [offerBefore.id],
      )).rows[0]!;
      expect(offerStillOpen.state).toBe('OPEN');

      const worker = createAssignmentOfferExpiryWorker(
        new PostgresAssignmentOfferExpiryRepository(new PostgresJobCardRepository(pool)),
        { now: () => new Date(offerBefore.acceptance_due_at.valueOf() + MINUTE_MS) },
      );
      const report = await worker.runOnce(new Date(offerBefore.acceptance_due_at.valueOf() + MINUTE_MS));
      expect(report.expired).toBe(1);

      const jobAfterExpiry = (await pool.query<{
        status: string; cancelled_at: Date | null; assigned_to: string;
      }>(
        `SELECT status, cancelled_at, assigned_to FROM job_cards WHERE id = $1`,
        [offered.id],
      )).rows[0]!;
      expect(jobAfterExpiry.status).toBe('NEW');
      expect(jobAfterExpiry.cancelled_at).toBeNull();
      expect(jobAfterExpiry.assigned_to).toBe(seed.staff.id);

      const offerAfter = (await pool.query<{ state: string }>(
        `SELECT state FROM job_card_assignment_offers WHERE id = $1`,
        [offerBefore.id],
      )).rows[0]!;
      expect(offerAfter.state).toBe('EXPIRED');

      // Manager retains CANCEL power after expiry.
      const cancelledByManager = await service.cancel(seed.manager, offered.id, {
        clientActionId: randomUUID(),
        expectedVersion: offered.version,
        cancelReason: 'Müşteri iptal etti.',
      });
      expect(cancelledByManager.status).toBe('CANCELLED');
    });
  });
});
