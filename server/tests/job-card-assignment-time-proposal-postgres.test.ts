import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { AppError } from '../src/errors/index.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  AssignmentOfferDecisionInput,
  JobAssignmentOfferView,
  JobCardActor,
  JobCardDetail,
  JobCardType,
  NeedsActionAssignmentOfferItem,
} from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { MINUTE_MS, readDbBaseline } from './support/db-clock-baseline.js';

/**
 * JOB-012 — Staff time proposal on a declined or released assignment.
 *
 * Contract: `docs/features/assignment-time-proposal.md` (accepted 2026-11-24),
 * "Acceptance scenarios" 1–13 and the Data/API sections they cite. This suite is
 * written from the contract alone, independently of the implementation that
 * lands in parallel, so it targets the public service behaviour: the Staff
 * answer commands (`declineAssignment` / `releaseAssignment` with
 * `proposedScheduledAt`), the management confirmation
 * (`acceptAssignmentProposal`), and the documented reads.
 *
 * Scenario → test:
 *   1  → "1. a SCHEDULE_CONFLICT decline stores a free future proposal …"
 *   2  → "2. a SCHEDULE_CONFLICT decline without a time, with a past time, …"
 *   3  → "3. any reason other than SCHEDULE_CONFLICT cannot carry a …"
 *   4  → "4. a SCHEDULE_CONFLICT release stores the proposal and keeps the …"
 *   5  → "5. a management confirmation moves the interval, accepts for the …"
 *   6  → "6. the confirmation replays idempotently and refuses a different …"
 *   7  → "7. confirming twice with a new key is ASSIGNMENT_PROPOSAL_NOT_AVAILABLE"
 *   8  → "8. reassignment, management reschedule and re-offer supersede …"
 *   9  → "9. a proposal whose start has passed cannot be confirmed"
 *   10 → "10. a confirmation that now conflicts with the Staff calendar …"
 *   11 → "11. STAFF cannot confirm and the disabled flag gates the command"
 *   12 → "12. a later Staff assignee reads the decision without the reason …"
 *   13 → "13. management may ignore the proposal and reschedule with the …"
 *
 * This file does not pass until migration `073_assignment_offer_time_proposal`
 * and `JobCardService.acceptAssignmentProposal` are merged: the reads below
 * select the new offer columns and call the new command by its contract name.
 * Fixtures never fabricate a proposal; every `proposed_scheduled_at` row is
 * produced by the command under test.
 *
 * Time convention: fixtures are placed relative to the DB arbitration clock
 * (`readDbBaseline`) and the service clock is pinned to the same instant, so
 * the suite never ages and `proposed <= requestTime` boundaries are explicit.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const WINDOW_ON = { enabled: true } as const;
const WINDOW_OFF = { enabled: false } as const;
/** Calendar on, so the "rescheduled" notification and calendar realtime exist. */
const CALENDAR_ON = { enabled: true, reminderLeadMinutes: 30 } as const;

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `job012prop_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, name = 'JOB-012 Klinik'): Promise<string> {
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
  return id;
}

type FixtureJob = {
  id: string;
  version: number;
  status: string;
  scheduledAt: string;
  scheduledEndsAt: string;
};

/**
 * Direct fixture insert. The commands under test are the unit here; the job
 * only has to satisfy the persisted lifecycle constraints, and every mutation
 * below still runs through the real service.
 */
async function insertJob(pool: Pool, input: {
  organizationId: string;
  type: JobCardType;
  status: 'NEW' | 'ACCEPTED';
  assignedTo: string;
  createdBy: string;
  title?: string;
  scheduledAt: string;
  scheduledEndsAt: string;
  acceptedAt?: string;
}): Promise<FixtureJob> {
  const acceptedAt = input.status === 'ACCEPTED'
    ? input.acceptedAt ?? '2026-01-01T08:00:00.000Z'
    : null;
  const row = (await pool.query<{ id: string; version: number; status: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, assigned_to, created_by,
        accepted_at, accepted_by, scheduled_at, scheduled_ends_at, engagement_kind)
     VALUES ($1, $2, $3, $4, NULL, $5, $6,
             $7::timestamptz, $8::uuid, $9::timestamptz, $10::timestamptz, $11)
     RETURNING id, version, status`,
    [
      input.organizationId, input.type, input.status,
      input.title ?? 'JOB-012 zaman önerisi işi',
      input.assignedTo, input.createdBy,
      acceptedAt, acceptedAt === null ? null : input.assignedTo,
      input.scheduledAt, input.scheduledEndsAt,
      input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null,
    ],
  )).rows[0]!;
  const createdOffsetMs = -60 * MINUTE_MS;
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
        organization_timezone, source, created_by, created_at)
     VALUES ($1, $2, 1, $3, $4, 'Europe/Istanbul', 'CREATE', $5, $6)`,
    [
      input.organizationId, row.id, input.scheduledAt, input.scheduledEndsAt,
      input.createdBy, new Date(Date.parse(input.scheduledAt) + createdOffsetMs),
    ],
  );
  await pool.query(
    `INSERT INTO job_card_assignment_history
       (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
     VALUES ($1, $2, NULL, $3, $4, 'CREATE', $5)`,
    [
      input.organizationId, row.id, input.assignedTo, input.createdBy,
      new Date(Date.parse(input.scheduledAt) + createdOffsetMs),
    ],
  );
  return {
    id: row.id,
    version: Number(row.version),
    status: String(row.status),
    scheduledAt: input.scheduledAt,
    scheduledEndsAt: input.scheduledEndsAt,
  };
}

async function insertOffer(pool: Pool, input: {
  organizationId: string;
  jobCardId: string;
  assigneeUserId: string;
  openedBy: string;
  openedAt: Date;
  acceptanceDueAt: Date;
  state?: 'OPEN' | 'ACCEPTED';
  closedAt?: Date | null;
  closedBy?: string | null;
}): Promise<string> {
  const state = input.state ?? 'OPEN';
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_assignment_offers
       (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason, opened_by,
        acceptance_due_at, state, closed_at, closed_by, close_reason, close_text)
     VALUES ($1, $2, $3, $4, 'CREATE', $5, $6, $7, $8, $9, NULL, NULL)
     RETURNING id`,
    [
      input.organizationId, input.jobCardId, input.assigneeUserId, input.openedAt,
      input.openedBy, input.acceptanceDueAt, state,
      state === 'ACCEPTED' ? input.closedAt ?? null : null,
      state === 'ACCEPTED' ? input.closedBy ?? null : null,
    ],
  )).rows[0]!.id;
}

async function insertCalendarEvent(pool: Pool, input: {
  organizationId: string;
  assignedUserId: string;
  createdBy: string;
  title: string;
  startsAt: string;
  endsAt: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO calendar_events
       (id, organization_id, assigned_user_id, title, starts_at, ends_at, timezone,
        created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'Europe/Istanbul', $7, $7)`,
    [
      randomUUID(), input.organizationId, input.assignedUserId, input.title,
      input.startsAt, input.endsAt, input.createdBy,
    ],
  );
}

async function insertEarlyStartAuthorization(pool: Pool, input: {
  organizationId: string;
  jobCardId: string;
  assigneeUserId: string;
  grantedBy: string;
  scheduledAt: string;
  scheduledEndsAt: string;
  grantedAt: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO job_card_early_start_authorizations
       (organization_id, job_card_id, assignee_user_id, schedule_revision_no,
        scheduled_at, scheduled_ends_at, granted_by, granted_at, client_action_id)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
    [
      input.organizationId, input.jobCardId, input.assigneeUserId,
      input.scheduledAt, input.scheduledEndsAt, input.grantedBy, input.grantedAt,
      randomUUID(),
    ],
  );
}

/**
 * Persisted offer row. `proposed_scheduled_at`, `proposal_accepted_at` and
 * `proposal_accepted_by` are the migration 073 columns; selecting them here is
 * deliberate, so a missing schema artifact fails loudly.
 */
type OfferRow = {
  id: string;
  assignee_user_id: string;
  opened_at: Date;
  opened_reason: string;
  opened_by: string;
  acceptance_due_at: Date;
  urgent_reason: string | null;
  state: string;
  closed_at: Date | null;
  closed_by: string | null;
  close_reason: string | null;
  close_text: string | null;
  proposed_scheduled_at: Date | null;
  proposal_accepted_at: Date | null;
  proposal_accepted_by: string | null;
};

async function readOffers(pool: Pool, jobCardId: string): Promise<OfferRow[]> {
  return (await pool.query<OfferRow>(
    `SELECT id, assignee_user_id, opened_at, opened_reason, opened_by, acceptance_due_at,
            urgent_reason, state, closed_at, closed_by, close_reason, close_text,
            proposed_scheduled_at, proposal_accepted_at, proposal_accepted_by
       FROM job_card_assignment_offers
      WHERE job_card_id = $1
      ORDER BY opened_at ASC, id ASC`,
    [jobCardId],
  )).rows;
}

type JobRow = {
  status: string;
  version: number;
  assigned_to: string;
  accepted_at: Date | null;
  accepted_by: string | null;
  scheduled_at: Date | null;
  scheduled_ends_at: Date | null;
  due_date: Date | null;
};

async function readJob(pool: Pool, jobCardId: string): Promise<JobRow> {
  return (await pool.query<JobRow>(
    `SELECT status, version, assigned_to, accepted_at, accepted_by,
            scheduled_at, scheduled_ends_at, due_date
       FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

type ScheduleRevisionRow = {
  revision_no: number;
  scheduled_at: Date | null;
  scheduled_ends_at: Date | null;
  source: string;
};

async function readScheduleRevisions(
  pool: Pool,
  jobCardId: string,
): Promise<ScheduleRevisionRow[]> {
  return (await pool.query<ScheduleRevisionRow>(
    `SELECT revision_no, scheduled_at, scheduled_ends_at, source
       FROM job_card_schedule_revisions
      WHERE job_card_id = $1
      ORDER BY revision_no ASC`,
    [jobCardId],
  )).rows;
}

type ActivityRow = {
  id: string;
  actor_id: string | null;
  event_type: string;
  metadata: Record<string, unknown> | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  created_at: Date;
};

async function readActivities(pool: Pool, jobCardId: string): Promise<ActivityRow[]> {
  return (await pool.query<ActivityRow>(
    `SELECT id, actor_id, event_type, metadata, old_value, new_value, created_at
       FROM job_card_activity_logs
      WHERE job_card_id = $1
      ORDER BY created_at ASC, id ASC`,
    [jobCardId],
  )).rows;
}

async function selectActivities(pool: Pool, jobCardId: string): Promise<string[]> {
  return (await readActivities(pool, jobCardId)).map((row) => row.event_type);
}

async function selectActivity(
  pool: Pool,
  jobCardId: string,
  eventType: string,
): Promise<ActivityRow[]> {
  return (await readActivities(pool, jobCardId))
    .filter((row) => row.event_type === eventType);
}

async function selectNotifications(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
): Promise<Array<{ recipient_user_id: string; kind: string }>> {
  return (await pool.query<{ recipient_user_id: string; kind: string }>(
    `SELECT recipient_user_id, kind FROM in_app_notifications
      WHERE organization_id = $1 AND entity_type = 'job-card' AND entity_id = $2
      ORDER BY created_at ASC, id ASC`,
    [organizationId, jobCardId],
  )).rows;
}

async function readOverdueIncidents(pool: Pool, jobCardId: string) {
  return (await pool.query<{
    delay_type: string;
    deadline_at: Date;
    accountable_user_id: string | null;
    recovered_at: Date | null;
  }>(
    `SELECT delay_type, deadline_at, accountable_user_id, recovered_at
       FROM job_card_overdue_incidents WHERE job_card_id = $1 ORDER BY recorded_at`,
    [jobCardId],
  )).rows;
}

async function readEarlyStartAuthorizations(pool: Pool, jobCardId: string) {
  return (await pool.query<{ voided_at: Date | null; void_reason: string | null }>(
    `SELECT voided_at, void_reason FROM job_card_early_start_authorizations
      WHERE job_card_id = $1 ORDER BY granted_at ASC`,
    [jobCardId],
  )).rows;
}

/**
 * Business evidence for "nothing written": the persisted job row, the complete
 * offer history, the activity vocabulary and the schedule history. A rejected
 * command must leave all four byte-identical.
 */
async function readJobEvidence(pool: Pool, jobCardId: string) {
  return {
    job: await readJob(pool, jobCardId),
    offers: await readOffers(pool, jobCardId),
    activities: await selectActivities(pool, jobCardId),
    revisions: await readScheduleRevisions(pool, jobCardId),
  };
}

function buildService(
  pool: Pool,
  clock: { now: Date },
  assignmentWindow: { enabled: boolean },
) {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  const service = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    publisher,
    { enabled: false },
    { enabled: false },
    CALENDAR_ON,
    {},
    assignmentWindow,
  );
  return { service, published };
}

function actor(id: string, organizationId: string, role: 'ADMIN' | 'MANAGER' | 'STAFF'): JobCardActor {
  return { id, organizationId, role };
}

function isoOffset(baseline: Date, offsetMs: number): string {
  return new Date(baseline.getTime() + offsetMs).toISOString();
}

function detailsOf(error: AppError): Record<string, unknown> {
  return (error.details ?? {}) as Record<string, unknown>;
}

/** Capture a rejection so the `details` payload can be asserted. */
async function rejectionOf(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (caught) {
    return caught as AppError;
  }
  throw new Error('Expected the command to be rejected, but it succeeded.');
}

/*
 * JOB-012 contract (`docs/features/assignment-time-proposal.md`).
 *
 * The implementation lands in parallel with this suite, so the accepted public
 * surface is declared narrowly here instead of editing `src/`: the new answer
 * field, the two new offer-view fields, and the confirmation command.
 */

/** Staff answer body: `proposedScheduledAt?: string | null`. */
type ProposalDecisionInput = AssignmentOfferDecisionInput & {
  proposedScheduledAt?: string | null;
};

/**
 * Builds an answer body typed by the contract. Returning the value instead of
 * passing a literal keeps the widened field out of the current
 * `AssignmentOfferDecisionInput` excess-property check.
 */
function proposalDecisionInput(input: ProposalDecisionInput): ProposalDecisionInput {
  return input;
}

/** Job-detail offer view gains the pending proposal and its accepted instant. */
type ProposalOfferView = JobAssignmentOfferView & {
  proposedScheduledAt: string | null;
  proposedScheduledEndsAt: string | null;
  proposalAcceptedAt: string | null;
};

/** Needs-action row gains the pending proposal. */
type ProposalNeedsActionItem = NeedsActionAssignmentOfferItem & {
  proposedScheduledAt: string | null;
};

/** `ASSIGNMENT_DECISION` details gain the proposal under the reader scope. */
type ProposalAssignmentDecisionDetails = {
  kind: 'ASSIGNMENT_DECISION';
  decision: 'DECLINED' | 'RELEASED';
  reasonCode: string | null;
  reasonText: string | null;
  proposedScheduledAt: string | null;
};

type AcceptProposalInput = {
  clientActionId: string;
  expectedVersion: number;
  offerId: string;
};

type AcceptProposalReceipt = {
  jobCardId: string;
  offerId: string;
  scheduledAt: string;
  scheduledEndsAt: string;
};

type AssignmentProposalCommands = {
  acceptAssignmentProposal(
    actor: JobCardActor,
    jobCardId: string,
    input: AcceptProposalInput,
  ): Promise<AcceptProposalReceipt>;
};

/**
 * JOB-012 contract: the management confirmation command. It is added to
 * `JobCardService` by the parallel implementation; this narrow assertion keeps
 * the suite compiling and fails at call time until the method exists.
 */
function withProposalCommands(
  service: JobCardService,
): JobCardService & AssignmentProposalCommands {
  return service as JobCardService & AssignmentProposalCommands;
}

function offerViewOf(detail: JobCardDetail): ProposalOfferView | null {
  return detail.assignmentOffer as ProposalOfferView | null;
}

async function assignmentDecisionDetails(
  service: JobCardService,
  viewer: JobCardActor,
  jobCardId: string,
): Promise<ProposalAssignmentDecisionDetails> {
  const page = await service.listActivity(viewer, jobCardId, { limit: 50, offset: 0 });
  const entry = page.items.find(
    (item) => item.eventType === 'JOB_ASSIGNMENT_DECLINED'
      || item.eventType === 'JOB_ASSIGNMENT_RELEASED',
  );
  if (entry === undefined) throw new Error('ASSIGNMENT_DECISION activity not found');
  return entry.details as unknown as ProposalAssignmentDecisionDetails;
}

type SeedOrganization = {
  organizationId: string;
  managerId: string;
  staffId: string;
  otherStaffId: string;
  manager: JobCardActor;
  staff: JobCardActor;
  otherStaff: JobCardActor;
};

async function seedOrganization(pool: Pool, label: string): Promise<SeedOrganization> {
  const organizationId = await insertOrg(pool, `JOB-012 ${label}`);
  const managerId = await insertUser(pool, organizationId, 'MANAGER', `${label} Müdür`);
  const staffId = await insertUser(pool, organizationId, 'STAFF', `${label} Saha Personeli`);
  const otherStaffId = await insertUser(pool, organizationId, 'STAFF', `${label} Diğer Personel`);
  return {
    organizationId,
    managerId,
    staffId,
    otherStaffId,
    manager: actor(managerId, organizationId, 'MANAGER'),
    staff: actor(staffId, organizationId, 'STAFF'),
    otherStaff: actor(otherStaffId, organizationId, 'STAFF'),
  };
}

type SeedOfferedJob = { job: FixtureJob; offerId: string };

/**
 * One planned job with its (single) latest offer: NEW + on-time OPEN offer by
 * default, or ACCEPTED + ACCEPTED offer for the release scenario.
 */
async function seedOfferedJob(
  pool: Pool,
  seed: SeedOrganization,
  baseline: Date,
  overrides: {
    status?: 'NEW' | 'ACCEPTED';
    type?: JobCardType;
    startOffsetMs?: number;
    durationMs?: number;
    acceptedOffsetMs?: number;
    offerOpenedOffsetMs?: number;
    offerDueOffsetMs?: number;
  } = {},
): Promise<SeedOfferedJob> {
  const status = overrides.status ?? 'NEW';
  const type = overrides.type ?? 'SALES_MEETING';
  const startOffsetMs = overrides.startOffsetMs ?? 120 * MINUTE_MS;
  const durationMs = overrides.durationMs ?? 120 * MINUTE_MS;
  const acceptedOffsetMs = overrides.acceptedOffsetMs ?? -180 * MINUTE_MS;
  const job = await insertJob(pool, {
    organizationId: seed.organizationId,
    type,
    status,
    assignedTo: seed.staffId,
    createdBy: seed.managerId,
    scheduledAt: isoOffset(baseline, startOffsetMs),
    scheduledEndsAt: isoOffset(baseline, startOffsetMs + durationMs),
    ...(status === 'ACCEPTED'
      ? { acceptedAt: isoOffset(baseline, acceptedOffsetMs) }
      : {}),
  });
  const offerId = await insertOffer(pool, {
    organizationId: seed.organizationId,
    jobCardId: job.id,
    assigneeUserId: seed.staffId,
    openedBy: seed.managerId,
    openedAt: new Date(baseline.getTime() + (overrides.offerOpenedOffsetMs ?? -60 * MINUTE_MS)),
    acceptanceDueAt: new Date(baseline.getTime() + (overrides.offerDueOffsetMs ?? 60 * MINUTE_MS)),
    ...(status === 'ACCEPTED'
      ? {
        state: 'ACCEPTED' as const,
        closedAt: new Date(baseline.getTime() + acceptedOffsetMs),
        closedBy: seed.staffId,
      }
      : {}),
  });
  return { job, offerId };
}

describe.skipIf(!databaseUrl)('JOB-012 — assignment time proposal', () => {
  it('1. a SCHEDULE_CONFLICT decline stores a free future proposal and leaves the job time unchanged', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 1');
      const { job, offerId } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      // 120-minute planned interval: the derived proposal interval must keep it.
      const proposal = isoOffset(baseline, 300 * MINUTE_MS);
      const proposalEndsAt = isoOffset(baseline, 420 * MINUTE_MS);
      const reasonText = 'Aynı saatte başka bir klinik teslimatı var; öğleden sonra uygunum.';

      const input: ProposalDecisionInput = {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText,
        proposedScheduledAt: proposal,
      };
      const declined = await service.declineAssignment(seed.staff, job.id, input);
      expect(declined).toMatchObject({ status: 'NEW', version: job.version + 1 });

      const persisted = await readJob(pool, job.id);
      expect(persisted).toMatchObject({
        status: 'NEW',
        version: job.version + 1,
        assigned_to: seed.staffId,
        accepted_at: null,
        accepted_by: null,
      });
      // Only management confirmation may move the customer time.
      expect(persisted.scheduled_at?.toISOString()).toBe(job.scheduledAt);
      expect(persisted.scheduled_ends_at?.toISOString()).toBe(job.scheduledEndsAt);

      const offers = await readOffers(pool, job.id);
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        id: offerId,
        state: 'DECLINED',
        closed_by: seed.staffId,
        close_reason: 'SCHEDULE_CONFLICT',
        close_text: reasonText,
        proposal_accepted_at: null,
        proposal_accepted_by: null,
      });
      expect(offers[0]!.proposed_scheduled_at?.toISOString()).toBe(proposal);

      // Management reads the pending proposal with its derived interval.
      expect(offerViewOf(await service.detail(seed.manager, job.id))).toMatchObject({
        id: offerId,
        state: 'DECLINED',
        closeReason: 'SCHEDULE_CONFLICT',
        closeText: reasonText,
        proposedScheduledAt: proposal,
        proposedScheduledEndsAt: proposalEndsAt,
        proposalAcceptedAt: null,
      });
      // The answering Staff member sees the same offer fact.
      expect(offerViewOf(await service.detail(seed.staff, job.id))).toMatchObject({
        id: offerId,
        state: 'DECLINED',
        proposedScheduledAt: proposal,
        proposedScheduledEndsAt: proposalEndsAt,
      });

      // The management recovery list carries the proposal too.
      const needsAction = await service.listAssignmentOffersNeedingAction(
        seed.manager, { limit: 10, offset: 0 },
      );
      const item = needsAction.items.find((entry) => entry.jobCardId === job.id);
      expect(item).toBeDefined();
      expect((item as ProposalNeedsActionItem).proposedScheduledAt).toBe(proposal);

      // The timeline carries code, text and the proposal for management.
      expect(await assignmentDecisionDetails(service, seed.manager, job.id)).toMatchObject({
        kind: 'ASSIGNMENT_DECISION',
        decision: 'DECLINED',
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText,
        proposedScheduledAt: proposal,
      });
    });
  });

  it('2. a SCHEDULE_CONFLICT decline without a time, with a past time, or into the Staff calendar is rejected and writes nothing', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 2');
      const { job } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);

      // Missing and explicit null are both "no proposal supplied".
      const invalidInputs: ProposalDecisionInput[] = [
        {
          clientActionId: randomUUID(),
          expectedVersion: job.version,
          reasonCode: 'SCHEDULE_CONFLICT',
          reasonText: 'Planım dolu.',
        },
        {
          clientActionId: randomUUID(),
          expectedVersion: job.version,
          reasonCode: 'SCHEDULE_CONFLICT',
          reasonText: 'Planım dolu.',
          proposedScheduledAt: null,
        },
        {
          clientActionId: randomUUID(),
          expectedVersion: job.version,
          reasonCode: 'SCHEDULE_CONFLICT',
          reasonText: 'Planım dolu.',
          proposedScheduledAt: isoOffset(baseline, -30 * MINUTE_MS),
        },
      ];
      for (const input of invalidInputs) {
        const before = await readJobEvidence(pool, job.id);
        const error = await rejectionOf(() => service.declineAssignment(seed.staff, job.id, input));
        expect(error).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
        expect(detailsOf(error)).toMatchObject({
          fieldErrors: { proposedScheduledAt: expect.any(String) },
        });
        expect(await readJobEvidence(pool, job.id)).toEqual(before);
      }

      // The same occupancy reader as reschedule, excluding this job.
      await insertCalendarEvent(pool, {
        organizationId: seed.organizationId,
        assignedUserId: seed.staffId,
        createdBy: seed.managerId,
        title: 'Klinik blok',
        startsAt: isoOffset(baseline, 330 * MINUTE_MS),
        endsAt: isoOffset(baseline, 390 * MINUTE_MS),
      });
      const beforeConflict = await readJobEvidence(pool, job.id);
      const conflicting: ProposalDecisionInput = {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Sabah dış saha programım dolu.',
        proposedScheduledAt: isoOffset(baseline, 300 * MINUTE_MS),
      };
      const conflict = await rejectionOf(
        () => service.declineAssignment(seed.staff, job.id, conflicting),
      );
      expect(conflict).toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
      // The existing Staff projection never exposes other assignees' plans.
      expect(detailsOf(conflict)).toEqual({ conflicts: [] });
      expect(await readJobEvidence(pool, job.id)).toEqual(beforeConflict);
    });
  });

  it('3. any reason other than SCHEDULE_CONFLICT cannot carry a proposed time', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 3');
      const { job } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);

      const before = await readJobEvidence(pool, job.id);
      const withTime: ProposalDecisionInput = {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'ON_LEAVE',
        reasonText: 'Yıllık iznimdeyim.',
        proposedScheduledAt: isoOffset(baseline, 300 * MINUTE_MS),
      };
      const error = await rejectionOf(() => service.declineAssignment(seed.staff, job.id, withTime));
      expect(error).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
      expect(detailsOf(error)).toMatchObject({
        fieldErrors: { proposedScheduledAt: expect.any(String) },
      });
      expect(await readJobEvidence(pool, job.id)).toEqual(before);

      // Control: the same reason without a proposal stays the unchanged decline.
      const declined = await service.declineAssignment(seed.staff, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'ON_LEAVE',
        reasonText: 'Yıllık iznimdeyim.',
      });
      expect(declined).toMatchObject({ status: 'NEW', version: job.version + 1 });
      expect((await readOffers(pool, job.id))[0]).toMatchObject({
        state: 'DECLINED',
        close_reason: 'ON_LEAVE',
        proposed_scheduled_at: null,
      });
    });
  });

  it('4. a SCHEDULE_CONFLICT release stores the proposal and keeps the OVR-2 release order', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 4');
      // Accepted commitment whose planned interval already ended.
      const { job, offerId } = await seedOfferedJob(pool, seed, baseline, {
        status: 'ACCEPTED',
        type: 'PRODUCT_DELIVERY',
        startOffsetMs: -60 * MINUTE_MS,
        durationMs: 30 * MINUTE_MS,
        acceptedOffsetMs: -180 * MINUTE_MS,
        offerOpenedOffsetMs: -240 * MINUTE_MS,
        offerDueOffsetMs: -120 * MINUTE_MS,
      });
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const proposal = isoOffset(baseline, 180 * MINUTE_MS);
      const reasonText = 'Sabah teslim edilecek seti yetiştiremiyorum.';

      const input: ProposalDecisionInput = {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText,
        proposedScheduledAt: proposal,
      };
      const released = await service.releaseAssignment(seed.staff, job.id, input);
      expect(released).toMatchObject({ status: 'NEW', version: job.version + 1 });

      const persisted = await readJob(pool, job.id);
      expect(persisted).toMatchObject({
        status: 'NEW',
        version: job.version + 1,
        assigned_to: seed.staffId,
        accepted_at: null,
        accepted_by: null,
      });
      // A release never rewrites the planned interval.
      expect(persisted.scheduled_at?.toISOString()).toBe(job.scheduledAt);
      expect(persisted.scheduled_ends_at?.toISOString()).toBe(job.scheduledEndsAt);

      const offer = (await readOffers(pool, job.id))[0]!;
      expect(offer).toMatchObject({
        id: offerId,
        state: 'RELEASED',
        closed_by: seed.staffId,
        close_reason: 'SCHEDULE_CONFLICT',
        close_text: reasonText,
        proposal_accepted_at: null,
      });
      expect(offer.proposed_scheduled_at?.toISOString()).toBe(proposal);

      // OVR-2 order unchanged: the pre-release acceptance is materialized first.
      const incidents = await readOverdueIncidents(pool, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        accountable_user_id: seed.staffId,
        recovered_at: null,
      });
      expect(incidents[0]!.deadline_at.toISOString()).toBe(job.scheduledEndsAt);

      expect(await selectActivities(pool, job.id)).toContain('JOB_ASSIGNMENT_RELEASED');
      expect(await assignmentDecisionDetails(service, seed.manager, job.id)).toMatchObject({
        kind: 'ASSIGNMENT_DECISION',
        decision: 'RELEASED',
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText,
        proposedScheduledAt: proposal,
      });

      // Q4: a released answer's proposal is confirmable exactly like a decline.
      const receipt = await withProposalCommands(service).acceptAssignmentProposal(
        seed.manager, job.id,
        { clientActionId: randomUUID(), expectedVersion: job.version + 1, offerId },
      );
      expect(receipt).toMatchObject({ jobCardId: job.id, scheduledAt: proposal });
      expect(await readJob(pool, job.id)).toMatchObject({
        status: 'ACCEPTED',
        accepted_by: seed.staffId,
      });
      expect((await readOffers(pool, job.id)).map((row) => row.opened_reason))
        .toContain('PROPOSAL_ACCEPTED');
    });
  });

  it('5. a management confirmation moves the interval, accepts for the proposer and records one transaction', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 5');
      const { job, offerId } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service, published } = buildService(pool, clock, WINDOW_ON);
      const commands = withProposalCommands(service);
      // A live early-start authorization for the old interval must be voided.
      await insertEarlyStartAuthorization(pool, {
        organizationId: seed.organizationId,
        jobCardId: job.id,
        assigneeUserId: seed.staffId,
        grantedBy: seed.managerId,
        scheduledAt: job.scheduledAt,
        scheduledEndsAt: job.scheduledEndsAt,
        grantedAt: isoOffset(baseline, -30 * MINUTE_MS),
      });

      const proposal = isoOffset(baseline, 300 * MINUTE_MS);
      const proposalEndsAt = isoOffset(baseline, 420 * MINUTE_MS);
      await service.declineAssignment(seed.staff, job.id, proposalDecisionInput({
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Öğleden sonra kliniğe ancak yetişebilirim.',
        proposedScheduledAt: proposal,
      }));
      const declinedVersion = job.version + 1;

      const receipt = await commands.acceptAssignmentProposal(seed.manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: declinedVersion,
        offerId,
      });

      // The response names the new ACCEPTED offer and the moved interval.
      expect(receipt).toEqual({
        jobCardId: job.id,
        offerId: expect.any(String),
        scheduledAt: proposal,
        scheduledEndsAt: proposalEndsAt,
      });
      expect(receipt.offerId).not.toBe(offerId);

      const persisted = await readJob(pool, job.id);
      expect(persisted).toMatchObject({
        status: 'ACCEPTED',
        version: declinedVersion + 1,
        assigned_to: seed.staffId,
        accepted_by: seed.staffId,
      });
      // Duration kept: the persisted planned duration moves with the start.
      expect(persisted.scheduled_at?.toISOString()).toBe(proposal);
      expect(persisted.scheduled_ends_at?.toISOString()).toBe(proposalEndsAt);

      const offers = await readOffers(pool, job.id);
      expect(offers).toHaveLength(2);
      const proposalOffer = offers.find((row) => row.id === offerId)!;
      const acceptedOffer = offers.find((row) => row.id === receipt.offerId)!;
      expect(proposalOffer).toMatchObject({
        state: 'DECLINED',
        close_reason: 'SCHEDULE_CONFLICT',
        proposal_accepted_by: seed.managerId,
      });
      expect(proposalOffer.proposed_scheduled_at?.toISOString()).toBe(proposal);
      expect(proposalOffer.proposal_accepted_at).not.toBeNull();
      expect(acceptedOffer).toMatchObject({
        state: 'ACCEPTED',
        opened_reason: 'PROPOSAL_ACCEPTED',
        opened_by: seed.managerId,
        assignee_user_id: seed.staffId,
        closed_by: seed.staffId,
        close_reason: null,
        close_text: null,
        urgent_reason: null,
        proposed_scheduled_at: null,
        proposal_accepted_at: null,
        proposal_accepted_by: null,
      });
      expect(acceptedOffer.closed_at).not.toBeNull();

      // The contract binds accepted_at, proposal_accepted_at and the new
      // offer's closed_at/opened_at to one request instant: the injected clock.
      for (const instant of [
        persisted.accepted_at,
        proposalOffer.proposal_accepted_at,
        acceptedOffer.closed_at,
        acceptedOffer.opened_at,
      ]) {
        expect(instant?.toISOString()).toBe(clock.now.toISOString());
      }
      // OVR-2: the acceptance basis is the new, future interval, so the
      // confirmation materializes no LATE_START incident.
      expect(await readOverdueIncidents(pool, job.id)).toEqual([]);

      // The move is a real management reschedule: schedule revision + version.
      const revisions = await readScheduleRevisions(pool, job.id);
      expect(revisions.map((row) => row.source)).toEqual(['CREATE', 'RESCHEDULE']);
      expect(revisions[1]).toMatchObject({ revision_no: 2, source: 'RESCHEDULE' });
      expect(revisions[1]!.scheduled_at?.toISOString()).toBe(proposal);
      expect(revisions[1]!.scheduled_ends_at?.toISOString()).toBe(proposalEndsAt);

      // Early-start authorization is voided one-way.
      const authorizations = await readEarlyStartAuthorizations(pool, job.id);
      expect(authorizations).toHaveLength(1);
      expect(authorizations[0]).toMatchObject({ void_reason: 'RESCHEDULED' });
      expect(authorizations[0]!.voided_at).not.toBeNull();

      // JOB_FIELDS_UPDATED carries the moved fields.
      const fieldsUpdated = await selectActivity(pool, job.id, 'JOB_FIELDS_UPDATED');
      expect(fieldsUpdated).toHaveLength(1);
      expect(fieldsUpdated[0]!.new_value).toMatchObject({
        scheduledAt: proposal,
        scheduledEndsAt: proposalEndsAt,
      });

      // JOB_ACCEPTED names the proposal path and both offers.
      const acceptedActivities = await selectActivity(pool, job.id, 'JOB_ACCEPTED');
      expect(acceptedActivities).toHaveLength(1);
      expect(acceptedActivities[0]!.actor_id).toBe(seed.managerId);
      expect(acceptedActivities[0]!.metadata).toMatchObject({
        via: 'TIME_PROPOSAL',
        offerId: receipt.offerId,
        proposalOfferId: offerId,
        proposerId: seed.staffId,
      });

      // The synthetic ACCEPTED offer emits no offer-opened event and schedules
      // no reminder/expiry row.
      const activityTypes = await selectActivities(pool, job.id);
      expect(activityTypes).not.toContain('JOB_ASSIGNMENT_OFFER_OPENED');
      const offerNotifications = await pool.query(
        `SELECT 1 FROM job_card_assignment_offer_notifications WHERE offer_id = $1`,
        [receipt.offerId],
      );
      expect(offerNotifications.rowCount).toBe(0);

      // The existing "rescheduled" notification reaches the assignee.
      const notifications = await selectNotifications(pool, seed.organizationId, job.id);
      expect(
        notifications
          .filter((notification) => notification.kind === 'calendar.rescheduled')
          .map((notification) => notification.recipient_user_id),
      ).toEqual([seed.staffId]);

      // Calendar realtime is published for the move.
      expect(published.some((event) => event.resourceKeys.includes('calendar'))).toBe(true);

      // The detail reads the new ACCEPTED offer as the latest offer.
      expect(offerViewOf(await service.detail(seed.manager, job.id))).toMatchObject({
        id: receipt.offerId,
        state: 'ACCEPTED',
        closeReason: null,
      });
    });
  });

  it('6. the confirmation replays idempotently and refuses a different body under the same key', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 6');
      const { job, offerId } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const commands = withProposalCommands(service);

      await service.declineAssignment(seed.staff, job.id, proposalDecisionInput({
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Ancak akşamüstü müsaitim.',
        proposedScheduledAt: isoOffset(baseline, 300 * MINUTE_MS),
      }));
      const input: AcceptProposalInput = {
        clientActionId: randomUUID(),
        expectedVersion: job.version + 1,
        offerId,
      };

      const first = await commands.acceptAssignmentProposal(seed.manager, job.id, input);
      const afterFirst = await readJobEvidence(pool, job.id);

      const replay = await commands.acceptAssignmentProposal(seed.manager, job.id, input);
      expect(replay).toEqual(first);
      expect(await readJobEvidence(pool, job.id)).toEqual(afterFirst);
      expect(await selectActivity(pool, job.id, 'JOB_ACCEPTED')).toHaveLength(1);
      expect(await readOffers(pool, job.id)).toHaveLength(2);

      // Same key, different body: the request hash protects the receipt.
      const reused = await rejectionOf(() => commands.acceptAssignmentProposal(
        seed.manager, job.id, { ...input, offerId: randomUUID() },
      ));
      expect(reused).toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await readJobEvidence(pool, job.id)).toEqual(afterFirst);
    });
  });

  it('7. confirming twice with a new key is ASSIGNMENT_PROPOSAL_NOT_AVAILABLE', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 7');
      const { job, offerId } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const commands = withProposalCommands(service);

      await service.declineAssignment(seed.staff, job.id, proposalDecisionInput({
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Sabah dolu, öğleden sonra uygun.',
        proposedScheduledAt: isoOffset(baseline, 300 * MINUTE_MS),
      }));
      const first = await commands.acceptAssignmentProposal(seed.manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version + 1,
        offerId,
      });
      expect(first.jobCardId).toBe(job.id);

      const afterFirst = await readJobEvidence(pool, job.id);
      const currentVersion = (await readJob(pool, job.id)).version;
      const second = await rejectionOf(() => commands.acceptAssignmentProposal(
        seed.manager, job.id,
        { clientActionId: randomUUID(), expectedVersion: currentVersion, offerId },
      ));
      expect(second).toMatchObject({
        code: 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE',
        statusCode: 409,
      });
      expect(await readJobEvidence(pool, job.id)).toEqual(afterFirst);
    });
  });

  it('8. reassignment, management reschedule and re-offer supersede the proposal', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const commands = withProposalCommands(service);
      const proposal = isoOffset(baseline, 300 * MINUTE_MS);

      const prepareDeclinedProposal = async (label: string) => {
        const seed = await seedOrganization(pool, label);
        const { job, offerId } = await seedOfferedJob(pool, seed, baseline);
        await service.declineAssignment(seed.staff, job.id, proposalDecisionInput({
          clientActionId: randomUUID(),
          expectedVersion: job.version,
          reasonCode: 'SCHEDULE_CONFLICT',
          reasonText: 'Sabah programım dolu.',
          proposedScheduledAt: proposal,
        }));
        return {
          seed,
          job,
          offerId,
          declinedVersion: (await readJob(pool, job.id)).version,
        };
      };

      // (a) after reassignment: the offer no longer belongs to the assignee and
      // the latest offer changed.
      {
        const { seed, job, offerId, declinedVersion } = await prepareDeclinedProposal('Senaryo 8a');
        await service.patch(seed.manager, job.id, {
          expectedVersion: declinedVersion,
          assignedTo: seed.otherStaffId,
        });
        const afterAction = await readJobEvidence(pool, job.id);
        const currentVersion = (await readJob(pool, job.id)).version;
        const error = await rejectionOf(() => commands.acceptAssignmentProposal(
          seed.manager, job.id,
          { clientActionId: randomUUID(), expectedVersion: currentVersion, offerId },
        ));
        expect(error).toMatchObject({
          code: 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE',
          statusCode: 409,
        });
        expect(await readJobEvidence(pool, job.id)).toEqual(afterAction);
      }

      // (b) after a management reschedule: a fresh RESCHEDULE offer is latest.
      {
        const { seed, job, offerId, declinedVersion } = await prepareDeclinedProposal('Senaryo 8b');
        await service.patch(seed.manager, job.id, {
          expectedVersion: declinedVersion,
          scheduledAt: isoOffset(baseline, 600 * MINUTE_MS),
          scheduledEndsAt: isoOffset(baseline, 720 * MINUTE_MS),
        });
        const afterAction = await readJobEvidence(pool, job.id);
        const currentVersion = (await readJob(pool, job.id)).version;
        const error = await rejectionOf(() => commands.acceptAssignmentProposal(
          seed.manager, job.id,
          { clientActionId: randomUUID(), expectedVersion: currentVersion, offerId },
        ));
        expect(error).toMatchObject({
          code: 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE',
          statusCode: 409,
        });
        expect(await readJobEvidence(pool, job.id)).toEqual(afterAction);
      }

      // (c) after a re-offer: a fresh REOFFER offer is latest.
      {
        const { seed, job, offerId, declinedVersion } = await prepareDeclinedProposal('Senaryo 8c');
        await service.reofferAssignment(seed.manager, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: declinedVersion,
        });
        const afterAction = await readJobEvidence(pool, job.id);
        const currentVersion = (await readJob(pool, job.id)).version;
        const error = await rejectionOf(() => commands.acceptAssignmentProposal(
          seed.manager, job.id,
          { clientActionId: randomUUID(), expectedVersion: currentVersion, offerId },
        ));
        expect(error).toMatchObject({
          code: 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE',
          statusCode: 409,
        });
        expect(await readJobEvidence(pool, job.id)).toEqual(afterAction);
      }
    });
  });

  it('9. a proposal whose start has passed cannot be confirmed', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 9');
      const { job, offerId } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const commands = withProposalCommands(service);

      const proposal = isoOffset(baseline, 30 * MINUTE_MS);
      await service.declineAssignment(seed.staff, job.id, proposalDecisionInput({
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Yarım saat sonra müsaitim.',
        proposedScheduledAt: proposal,
      }));
      const declinedVersion = job.version + 1;

      // Contract boundary: proposed_scheduled_at <= requestTime expires.
      const beforeBoundary = await readJobEvidence(pool, job.id);
      clock.now = new Date(baseline.getTime() + 30 * MINUTE_MS);
      const atBoundary = await rejectionOf(() => commands.acceptAssignmentProposal(
        seed.manager, job.id,
        { clientActionId: randomUUID(), expectedVersion: declinedVersion, offerId },
      ));
      expect(atBoundary).toMatchObject({
        code: 'ASSIGNMENT_PROPOSAL_EXPIRED',
        statusCode: 409,
      });

      const afterBoundary = await readJobEvidence(pool, job.id);
      expect(afterBoundary).toEqual(beforeBoundary);
      clock.now = new Date(baseline.getTime() + 45 * MINUTE_MS);
      const past = await rejectionOf(() => commands.acceptAssignmentProposal(
        seed.manager, job.id,
        { clientActionId: randomUUID(), expectedVersion: declinedVersion, offerId },
      ));
      expect(past).toMatchObject({
        code: 'ASSIGNMENT_PROPOSAL_EXPIRED',
        statusCode: 409,
      });
      expect(await readJobEvidence(pool, job.id)).toEqual(afterBoundary);
    });
  });

  it('10. a confirmation that now conflicts with the Staff calendar is CALENDAR_CONFLICT', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 10');
      const { job, offerId } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const commands = withProposalCommands(service);

      const proposal = isoOffset(baseline, 300 * MINUTE_MS);
      await service.declineAssignment(seed.staff, job.id, proposalDecisionInput({
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Öğleden sonra uygun.',
        proposedScheduledAt: proposal,
      }));
      const declinedVersion = job.version + 1;

      // The staff member took another commitment after answering.
      await insertCalendarEvent(pool, {
        organizationId: seed.organizationId,
        assignedUserId: seed.staffId,
        createdBy: seed.managerId,
        title: 'Acil klinik ziyareti',
        startsAt: proposal,
        endsAt: isoOffset(baseline, 360 * MINUTE_MS),
      });

      const before = await readJobEvidence(pool, job.id);
      const error = await rejectionOf(() => commands.acceptAssignmentProposal(
        seed.manager, job.id,
        { clientActionId: randomUUID(), expectedVersion: declinedVersion, offerId },
      ));
      expect(error).toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
      expect(detailsOf(error)).toMatchObject({
        conflicts: [
          expect.objectContaining({
            source: 'MANUAL',
            title: 'Acil klinik ziyareti',
            startsAt: proposal,
            endsAt: isoOffset(baseline, 360 * MINUTE_MS),
            assignedUser: expect.objectContaining({ id: seed.staffId }),
          }),
        ],
      });
      expect(await readJobEvidence(pool, job.id)).toEqual(before);
    });
  });

  it('11. STAFF cannot confirm and the disabled flag gates the command', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 11');
      const { job, offerId } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const commands = withProposalCommands(service);

      await service.declineAssignment(seed.staff, job.id, proposalDecisionInput({
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Sabah dolu.',
        proposedScheduledAt: isoOffset(baseline, 300 * MINUTE_MS),
      }));
      const declinedVersion = job.version + 1;

      // STAFF is rejected before any lookup: an unknown card still yields 403.
      const forbidden = await rejectionOf(() => commands.acceptAssignmentProposal(
        seed.staff, randomUUID(),
        { clientActionId: randomUUID(), expectedVersion: 1, offerId: randomUUID() },
      ));
      expect(forbidden).toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

      // Flag off: the command exists but the window is closed.
      const before = await readJobEvidence(pool, job.id);
      const offCommands = withProposalCommands(buildService(pool, clock, WINDOW_OFF).service);
      const disabled = await rejectionOf(() => offCommands.acceptAssignmentProposal(
        seed.manager, job.id,
        { clientActionId: randomUUID(), expectedVersion: declinedVersion, offerId },
      ));
      expect(disabled).toMatchObject({
        code: 'ASSIGNMENT_WINDOW_DISABLED',
        statusCode: 409,
      });
      expect(await readJobEvidence(pool, job.id)).toEqual(before);
    });
  });

  it('12. a later Staff assignee reads the decision without the reason text or the proposal', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 12');
      const { job } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const proposal = isoOffset(baseline, 300 * MINUTE_MS);
      const reasonText = 'Aynı saatte başka bir klinik teslimatı var.';

      await service.declineAssignment(seed.staff, job.id, proposalDecisionInput({
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText,
        proposedScheduledAt: proposal,
      }));

      // Management hands the job to another Staff member.
      await service.patch(seed.manager, job.id, {
        expectedVersion: job.version + 1,
        assignedTo: seed.otherStaffId,
      });

      // The later assignee learns that the assignment was declined, never the
      // answering Staff member's private reason or proposal.
      expect(await assignmentDecisionDetails(service, seed.otherStaff, job.id)).toMatchObject({
        kind: 'ASSIGNMENT_DECISION',
        decision: 'DECLINED',
        reasonCode: null,
        reasonText: null,
        proposedScheduledAt: null,
      });

      // Management keeps the full decision for recovery.
      expect(await assignmentDecisionDetails(service, seed.manager, job.id)).toMatchObject({
        kind: 'ASSIGNMENT_DECISION',
        decision: 'DECLINED',
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText,
        proposedScheduledAt: proposal,
      });
    });
  });

  it('13. management may ignore the proposal and reschedule with the unchanged path', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Senaryo 13');
      const { job, offerId } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const proposal = isoOffset(baseline, 300 * MINUTE_MS);

      await service.declineAssignment(seed.staff, job.id, proposalDecisionInput({
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Sabah dolu.',
        proposedScheduledAt: proposal,
      }));
      const declinedVersion = job.version + 1;

      // Management ignores the proposal and moves the job elsewhere, with the
      // existing start-only rule that keeps the planned duration.
      const rescheduledAt = isoOffset(baseline, 600 * MINUTE_MS);
      const patched = await service.patch(seed.manager, job.id, {
        expectedVersion: declinedVersion,
        scheduledAt: rescheduledAt,
      });
      expect(patched.version).toBe(declinedVersion + 1);

      const persisted = await readJob(pool, job.id);
      expect(persisted).toMatchObject({
        status: 'NEW',
        version: declinedVersion + 1,
        accepted_at: null,
        accepted_by: null,
      });
      expect(persisted.scheduled_at?.toISOString()).toBe(rescheduledAt);
      expect(persisted.scheduled_ends_at?.toISOString()).toBe(isoOffset(baseline, 720 * MINUTE_MS));

      const revisions = await readScheduleRevisions(pool, job.id);
      expect(revisions.map((row) => row.source)).toEqual(['CREATE', 'RESCHEDULE']);

      // The pending proposal stays unaccepted history; a fresh OPEN offer
      // carries the new interval.
      const offers = await readOffers(pool, job.id);
      expect(offers).toHaveLength(2);
      expect(offers[0]).toMatchObject({
        id: offerId,
        state: 'DECLINED',
        close_reason: 'SCHEDULE_CONFLICT',
        proposal_accepted_by: null,
      });
      expect(offers[0]!.proposal_accepted_at).toBeNull();
      expect(offers[0]!.proposed_scheduled_at?.toISOString()).toBe(proposal);
      expect(offers[1]).toMatchObject({
        state: 'OPEN',
        opened_reason: 'RESCHEDULE',
        assignee_user_id: seed.staffId,
      });
      expect(offers.some((offer) => offer.opened_reason === 'PROPOSAL_ACCEPTED')).toBe(false);

      const activityTypes = await selectActivities(pool, job.id);
      expect(activityTypes).toContain('JOB_FIELDS_UPDATED');
      expect(activityTypes).not.toContain('JOB_ACCEPTED');
    });
  });
});
