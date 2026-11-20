import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { DAY_MS, MINUTE_MS, readDbBaseline, readReservedAt } from './support/db-clock-baseline.js';

/**
 * JOB-010 release 2a — PostgreSQL acceptance for the truthful not-held visit
 * (acceptance A16): a Sales Meeting that did not take place is submitted with
 * an empty `meetingAt`, `FOLLOW_UP_REQUIRED` and a structured unsuccessful
 * reason, can be manager-approved, and stays visible in the Staff
 * meeting-outcome report of its `staff_completed_at` period.
 *
 * The contract is `docs/features/assignment-acceptance-sla.md`
 * ("Not-held Sales Meeting" and Decision D1 item 4).
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `job010nh_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, name = 'JOB-010 Görüşme Klinik'): Promise<string> {
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
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function insertCustomer(pool: Pool, organizationId: string, name = 'Anadolu Diş Kliniği'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, name],
  )).rows[0]!.id;
}

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
  );
  return { service, published };
}

type ServiceJob = { id: string; version: number; status: string };

type VisitFixture = {
  organizationId: string;
  staffId: string;
  managerId: string;
  staff: JobCardActor;
  manager: JobCardActor;
  job: ServiceJob;
};

/**
 * A started Customer Visit, which is the engagement kind that keeps the
 * mandatory follow-up proposal rule in force.
 */
async function createStartedVisit(
  pool: Pool,
  clock: { now: Date },
  label = 'Klinik ziyareti',
): Promise<VisitFixture> {
  const organizationId = await insertOrg(pool, `${label} Org`);
  const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
  const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
  const customerId = await insertCustomer(pool, organizationId);
  const { service } = buildService(pool, clock);
  const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };
  const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
  const scheduledAt = new Date(clock.now.getTime() - 10 * MINUTE_MS).toISOString();
  const created = await service.create(staff, {
    clientActionId: randomUUID(),
    type: 'SALES_MEETING',
    title: label,
    description: null,
    customerId,
    contactId: null,
    assignedTo: staffId,
    priority: 'normal',
    dueDate: null,
    scheduledAt,
    engagementKind: 'CUSTOMER_VISIT',
  } as never);
  const started = await service.start(staff, created.id, {
    clientActionId: randomUUID(), expectedVersion: created.version,
  });
  return { organizationId, staffId, managerId, staff, manager, job: started };
}

type PatchMeetingDetailsInput = Parameters<JobCardService['patchMeetingDetails']>[2];

function patchMeetingResult(
  service: JobCardService,
  fixture: VisitFixture,
  overrides: Partial<PatchMeetingDetailsInput> = {},
) {
  return service.patchMeetingDetails(fixture.staff, fixture.job.id, {
    clientActionId: randomUUID(),
    expectedVersion: fixture.job.version,
    meetingAt: null,
    outcome: 'FOLLOW_UP_REQUIRED',
    unsuccessfulReason: 'CONTACT_NOT_AVAILABLE',
    meetingSummary: 'Klinikte ilgili kişiye ulaşılamadı; görüşme yapılamadı.',
    nextFollowUpAt: null,
    ...overrides,
  });
}

type MeetingDetailsRow = {
  job_card_id: string;
  meeting_at: Date | null;
  outcome: string | null;
  unsuccessful_reason_code: string | null;
  meeting_summary: string | null;
  next_follow_up_at: Date | null;
};

async function readMeetingDetails(pool: Pool, jobCardId: string): Promise<MeetingDetailsRow> {
  return (await pool.query<MeetingDetailsRow>(
    `SELECT job_card_id, meeting_at, outcome, unsuccessful_reason_code,
            meeting_summary, next_follow_up_at
       FROM job_card_meeting_details
      WHERE job_card_id = $1`,
    [jobCardId],
  )).rows[0]!;
}

async function readJobRow(pool: Pool, jobCardId: string) {
  return (await pool.query<{
    status: string;
    version: number;
    started_at: Date | null;
    staff_completed_at: Date | null;
    manager_approved_at: Date | null;
    follow_up_proposed_at: Date | null;
    follow_up_proposal_origin: string | null;
  }>(
    `SELECT status, version, started_at, staff_completed_at, manager_approved_at,
            follow_up_proposed_at, follow_up_proposal_origin
       FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

function istanbulDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

/** Submits and manager-approves the not-held visit; returns the final job. */
async function approveNotHeldVisit(
  service: JobCardService,
  fixture: VisitFixture,
  clock: { now: Date },
): Promise<{ job: ServiceJob }> {
  const patched = await patchMeetingResult(service, fixture);
  clock.now = new Date(clock.now.getTime() + 10 * MINUTE_MS);
  const submitted = await service.submitForApproval(fixture.staff, fixture.job.id, {
    clientActionId: randomUUID(),
    expectedVersion: patched.jobCardVersion,
    note: 'Görüşme yapılamadı; takip planı önerildi.',
  });
  clock.now = new Date(clock.now.getTime() + 10 * MINUTE_MS);
  const approved = await service.approve(fixture.manager, fixture.job.id, {
    clientActionId: randomUUID(), expectedVersion: submitted.version,
  });
  return { job: approved };
}

describe.skipIf(!databaseUrl)('JOB-010 release 2a — not-held Sales Meeting', () => {
  it('A16: an empty meetingAt with FOLLOW_UP_REQUIRED is submittable and approvable', async () => {
    await withSchema(async (pool) => {
      const clock = { now: await readDbBaseline(pool) };
      const fixture = await createStartedVisit(pool, clock);
      const { service } = buildService(pool, clock);

      const patched = await patchMeetingResult(service, fixture);
      expect(patched.meetingAt).toBeNull();
      expect(patched.outcome).toBe('FOLLOW_UP_REQUIRED');

      // MEETING_TIME_VALID becomes met for this exact combination, so the
      // visit is genuinely submittable without fabricating a time.
      const detail = await service.detail(fixture.staff, fixture.job.id);
      const readiness = detail.workflowContext.submissionReadiness;
      expect(readiness).not.toBeNull();
      expect(readiness!.ready).toBe(true);
      expect(readiness!.items.find((item) => item.code === 'MEETING_TIME_VALID'))
        .toMatchObject({ state: 'met' });
      expect(readiness!.items.find((item) => item.code === 'UNSUCCESSFUL_REASON_PRESENT'))
        .toMatchObject({ state: 'met' });

      clock.now = new Date(clock.now.getTime() + 10 * MINUTE_MS);
      const submitted = await service.submitForApproval(fixture.staff, fixture.job.id, {
        clientActionId: randomUUID(),
        expectedVersion: patched.jobCardVersion,
        note: 'Görüşme yapılamadı; takip planı önerildi.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');

      // The mandatory follow-up proposal rule still applies to the not-held
      // visit: the submission carries a persisted proposal.
      const submittedDetail = await service.detail(fixture.staff, fixture.job.id);
      expect(submittedDetail.followUpProposal).not.toBeNull();
      expect(submittedDetail.followUpProposal!.type).toBe('SALES_MEETING');
      expect((await readJobRow(pool, fixture.job.id)).follow_up_proposed_at).not.toBeNull();

      clock.now = new Date(clock.now.getTime() + 10 * MINUTE_MS);
      const approved = await service.approve(fixture.manager, fixture.job.id, {
        clientActionId: randomUUID(), expectedVersion: submitted.version,
      });
      expect(approved.status).toBe('COMPLETED');

      const details = await readMeetingDetails(pool, fixture.job.id);
      expect(details).toMatchObject({
        meeting_at: null,
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessful_reason_code: 'CONTACT_NOT_AVAILABLE',
        next_follow_up_at: null,
      });
      expect(details.meeting_summary).toBe('Klinikte ilgili kişiye ulaşılamadı; görüşme yapılamadı.');

      const row = await readJobRow(pool, fixture.job.id);
      expect(row.status).toBe('COMPLETED');
      expect(row.staff_completed_at).not.toBeNull();
      expect(row.manager_approved_at).not.toBeNull();
    });
  });

  it('keeps nextFollowUpAt empty when meetingAt is empty', async () => {
    await withSchema(async (pool) => {
      const clock = { now: await readDbBaseline(pool) };
      const fixture = await createStartedVisit(pool, clock);
      const { service } = buildService(pool, clock);
      const nextFollowUpAt = new Date(clock.now.getTime() + 2 * DAY_MS).toISOString();

      await expect(patchMeetingResult(service, fixture, { nextFollowUpAt }))
        .rejects.toMatchObject({ statusCode: 400 });

      // Nothing partial was persisted: the visit still has no time, no
      // follow-up time and no outcome, so it cannot be submitted.
      const details = await readMeetingDetails(pool, fixture.job.id);
      expect(details).toMatchObject({
        meeting_at: null, outcome: null, next_follow_up_at: null,
      });
      const detail = await service.detail(fixture.staff, fixture.job.id);
      expect(detail.workflowContext.submissionReadiness!.ready).toBe(false);
      await expect(service.submitForApproval(fixture.staff, fixture.job.id, {
        clientActionId: randomUUID(),
        expectedVersion: (await readJobRow(pool, fixture.job.id)).version,
        note: 'Görüşme yapılamadı.',
      })).rejects.toMatchObject({ code: 'MEETING_NOT_READY', statusCode: 400 });
      expect((await readJobRow(pool, fixture.job.id)).status).toBe('IN_PROGRESS');
    });
  });

  it('still rejects an empty meetingAt for every other outcome', async () => {
    await withSchema(async (pool) => {
      const clock = { now: await readDbBaseline(pool) };
      const fixture = await createStartedVisit(pool, clock);
      const { service } = buildService(pool, clock);

      const patched = await patchMeetingResult(service, fixture, {
        outcome: 'POSITIVE',
        unsuccessfulReason: null,
      });
      expect(patched.outcome).toBe('POSITIVE');
      expect(patched.meetingAt).toBeNull();

      const detail = await service.detail(fixture.staff, fixture.job.id);
      const readiness = detail.workflowContext.submissionReadiness;
      expect(readiness!.ready).toBe(false);
      expect(readiness!.items.find((item) => item.code === 'MEETING_TIME_VALID'))
        .toMatchObject({ state: 'missing' });

      await expect(service.submitForApproval(fixture.staff, fixture.job.id, {
        clientActionId: randomUUID(),
        expectedVersion: patched.jobCardVersion,
        note: 'Görüşme olumlu geçti.',
      })).rejects.toMatchObject({ code: 'MEETING_NOT_READY', statusCode: 400 });
      expect((await readJobRow(pool, fixture.job.id)).status).toBe('IN_PROGRESS');
      expect((await readMeetingDetails(pool, fixture.job.id)).meeting_at).toBeNull();
    });
  });

  it('keeps the completed not-held visit in the staff meeting-outcome report period', async () => {
    await withSchema(async (pool) => {
      const clock = { now: await readDbBaseline(pool) };
      const fixture = await createStartedVisit(pool, clock);
      const { service } = buildService(pool, clock);

      const { job } = await approveNotHeldVisit(service, fixture, clock);
      expect(job.status).toBe('COMPLETED');

      // The occurred-at instant is the staff completion instant because no
      // meeting happened.
      const staffCompletedAt = await readReservedAt(
        pool, fixture.job.id, 'JOB_SUBMIT_FOR_APPROVAL',
      );
      const row = await readJobRow(pool, fixture.job.id);
      expect(row.staff_completed_at).toEqual(staffCompletedAt);
      expect(row.started_at).not.toBeNull();

      const reports = new PostgresReportsRepository(pool);
      const day = istanbulDate(staffCompletedAt);
      const distribution = await reports.getStaffMeetingsByOutcome({
        organizationId: fixture.organizationId,
        staffUserId: fixture.staffId,
        requestedRange: { from: day, to: day },
        requestTime: clock.now,
      });
      expect(distribution).toEqual([
        { outcome: 'POSITIVE', count: 0 },
        { outcome: 'FOLLOW_UP_REQUIRED', count: 1 },
        { outcome: 'NO_DECISION', count: 0 },
        { outcome: 'NOT_INTERESTED', count: 0 },
      ]);

      // The neighbouring day is untouched: the period is anchored on
      // staff_completed_at, never on a fabricated meeting instant.
      const previousDay = istanbulDate(new Date(staffCompletedAt.getTime() - DAY_MS));
      const previous = await reports.getStaffMeetingsByOutcome({
        organizationId: fixture.organizationId,
        staffUserId: fixture.staffId,
        requestedRange: { from: previousDay, to: previousDay },
        requestTime: clock.now,
      });
      expect(previous.every((item) => item.count === 0)).toBe(true);
    });
  });
});
