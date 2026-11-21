/**
 * OVR-5b writers: authorized deadline extension, the Staff deadline block, the
 * corrected job detail and the in-patch change-request resolution
 * (contract §4, §5, §6, §9 E1–E12, S1–S3, N1, J1–J4).
 *
 * Every scenario drives the real `JobCardService` writers against PostgreSQL.
 * OVR-5a already read `ended_at`; OVR-5b makes `patch()` write the ending, so
 * the ending rows below are produced only by the service command under test.
 * SQL is used to read persisted facts (and to seed customers), never to
 * simulate a writer.
 *
 * Contract: docs/features/overdue-correction-deadline-and-extension.md §4,
 * §5, §6, §7 (067), §9; DECISIONS.md OVR-5.
 *
 * TYPING NOTE (OVR-5b split): the writer lands in a parallel worktree, so the
 * two new PATCH fields and the two new detail fields are declared locally as
 * intersections with the service's own types. Once the writer is merged the
 * local intersections are redundant but stay type-correct.
 *
 * CLOCK NOTE (OVR-5a lesson): lifecycle business time is the DB reservation
 * instant; `patch()` samples its own instant after the JobCard lock (contract
 * §4.0) from the injected service clock. Each patch therefore sets the
 * injected clock to a fresh DB sample first, so the patch instant is aligned
 * with every persisted revision and scan instant.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  PostgresOverdueBreachScannerRepository,
  createOverdueBreachScanner,
} from '../src/modules/job-cards/overdue-breach-scanner.js';
import {
  PostgresOverdueReminderWorkerRepository,
  createOverdueReminderWorker,
} from '../src/modules/job-cards/overdue-reminder-worker.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** OVR-4 defaults (overdue-reminder-policy.ts): +15m reminder, +60m escalation. */
const STAFF_REMINDER_DELAY_MS = 15 * MINUTE_MS;
const ESCALATION_DELAY_MS = 60 * MINUTE_MS;
const EXTENSION_REASON = 'Müşteri randevusu ertelendi; yönetim yeni tarih verdi.';

/** OVR-5b shared interface: the PATCH command gains two optional intents. */
type Ovr5bPatchInput = Parameters<JobCardService['patch']>[2] & {
  deadlineExtensionReason?: string | null;
  changeRequestResolution?: {
    changeRequestId: string;
    resolution: 'RESCHEDULED';
    note?: string | null;
  } | null;
};

/** OVR-5b shared interface: the job detail gains two server-computed facts. */
type Ovr5bDetail = Awaited<ReturnType<JobCardService['detail']>> & {
  hasOpenOverdueIncident: boolean;
  correctionDueAt: string | null;
};

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `ovr5b_ext_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, name: string, timezone = 'UTC'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id`,
    [name, timezone],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
  name: string,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function insertCustomer(pool: Pool, organizationId: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, 'OVR5b Klinik', 'clinic', 'active') RETURNING id`,
    [organizationId],
  )).rows[0]!.id;
}

type Ctx = {
  organizationId: string;
  managerId: string;
  staffId: string;
  otherStaffId: string;
  manager: JobCardActor;
  staff: JobCardActor;
  otherStaff: JobCardActor;
  customerId: string;
  clock: { now: Date };
  service: JobCardService;
};

async function setup(pool: Pool, label: string): Promise<Ctx> {
  const organizationId = await insertOrg(pool, `OVR5b ${label}`);
  const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
  const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
  const otherStaffId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
  const customerId = await insertCustomer(pool, organizationId);
  const clock = { now: await dbBaseline(pool) };
  return {
    organizationId,
    managerId,
    staffId,
    otherStaffId,
    manager: { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
    staff: { id: staffId, organizationId, role: 'STAFF' } as JobCardActor,
    otherStaff: { id: otherStaffId, organizationId, role: 'STAFF' } as JobCardActor,
    customerId,
    clock,
    service: buildService(pool, () => clock.now),
  };
}

function buildService(pool: Pool, now: () => Date): JobCardService {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    now,
    { publish: () => undefined },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
}

function reminderWorker(pool: Pool) {
  const repository = new PostgresJobCardRepository(pool);
  return createOverdueReminderWorker(
    new PostgresOverdueReminderWorkerRepository(repository, false),
    { publisher: { publish: () => undefined }, timing: {}, batchSize: 50 },
  );
}

async function dbBaseline(pool: Pool): Promise<Date> {
  return (await pool.query<{ now: Date }>(
    "SELECT date_trunc('milliseconds', clock_timestamp()) AS now",
  )).rows[0]!.now;
}

function shiftMs(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

function dateKeyShift(base: Date, days: number): string {
  return new Date(base.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** UTC-only helper: the organization-local midnight after a due date. */
function utcBoundaryAfter(dateKey: string): Date {
  return new Date(new Date(`${dateKey}T00:00:00.000Z`).getTime() + DAY_MS);
}

async function createTask(
  ctx: Ctx,
  input: { title: string; dueDate: string | null },
): Promise<JobCard> {
  return (await ctx.service.create(ctx.staff, {
    clientActionId: randomUUID(),
    type: 'GENERAL_TASK',
    title: input.title,
    description: null,
    customerId: null,
    contactId: null,
    assignedTo: ctx.staff.id,
    priority: 'normal',
    dueDate: input.dueDate,
    scheduledAt: null,
    scheduledEndsAt: undefined,
    engagementKind: undefined,
  } as never)) as unknown as JobCard;
}

/** Manager-created planned delivery (Staff accepts it later). */
async function createDelivery(
  ctx: Ctx,
  input: { title: string; scheduledAt: Date; dueDate?: string | null },
): Promise<JobCard> {
  return (await ctx.service.create(ctx.manager, {
    clientActionId: randomUUID(),
    type: 'PRODUCT_DELIVERY',
    title: input.title,
    description: null,
    customerId: ctx.customerId,
    contactId: null,
    assignedTo: ctx.staff.id,
    priority: 'normal',
    dueDate: input.dueDate ?? null,
    scheduledAt: input.scheduledAt.toISOString(),
    scheduledEndsAt: new Date(input.scheduledAt.getTime() + 30 * MINUTE_MS).toISOString(),
    engagementKind: undefined,
  } as never)) as unknown as JobCard;
}

async function startJob(ctx: Ctx, job: { id: string; version: number }): Promise<JobCard> {
  return (await ctx.service.start(ctx.staff, job.id, {
    clientActionId: randomUUID(), expectedVersion: job.version,
  })) as unknown as JobCard;
}

async function submitJob(ctx: Ctx, job: { id: string; version: number }): Promise<JobCard> {
  return (await ctx.service.submitForApproval(ctx.staff, job.id, {
    clientActionId: randomUUID(),
    expectedVersion: job.version,
    note: 'Tamamlandı, kontrole gönderildi.',
  })) as unknown as JobCard;
}

async function resumeJob(ctx: Ctx, job: { id: string; version: number }): Promise<JobCard> {
  return (await ctx.service.resume(ctx.staff, job.id, {
    clientActionId: randomUUID(), expectedVersion: job.version,
  })) as unknown as JobCard;
}

async function acceptJob(ctx: Ctx, job: { id: string; version: number }): Promise<JobCard> {
  return (await ctx.service.acceptAssignment(ctx.staff, job.id, {
    clientActionId: randomUUID(), expectedVersion: job.version,
  })) as unknown as JobCard;
}

async function objectAsManager(
  ctx: Ctx,
  job: { id: string; version: number },
  correctionDueAt: string,
): Promise<Ovr5bDetail> {
  return (await ctx.service.requestRevision(ctx.manager, job.id, {
    clientActionId: randomUUID(),
    expectedVersion: job.version,
    revisionReason: 'Düzeltme gerekli.',
    correctionDueAt,
  } as Parameters<JobCardService['requestRevision']>[2] & { correctionDueAt: string })) as unknown as Ovr5bDetail;
}

/** `patch()` through the real writer with the OVR-5b intents available. */
async function patchJob(
  ctx: Ctx,
  actor: JobCardActor,
  job: { id: string; version: number },
  fields: Omit<Partial<Ovr5bPatchInput>, 'expectedVersion'>,
): Promise<Ovr5bDetail> {
  const input = { expectedVersion: job.version, ...fields } as Ovr5bPatchInput;
  return (await ctx.service.patch(actor, job.id, input)) as unknown as Ovr5bDetail;
}

async function scanOnce(pool: Pool, scanTime: Date) {
  const repository = new PostgresJobCardRepository(pool);
  return createOverdueBreachScanner(
    new PostgresOverdueBreachScannerRepository(repository), { batchSize: 50 },
  ).runOnce(scanTime);
}

type IncidentRow = {
  id: string;
  delay_type: string;
  episode_no: number;
  schedule_revision_no: number;
  deadline_at: Date;
  breached_at: Date;
  source: string;
  recovered_at: Date | null;
  recovery_actor_user_id: string | null;
  ended_at: Date | null;
  ended_by_user_id: string | null;
  end_reason: string | null;
  end_note: string | null;
  ended_by_schedule_revision_no: number | null;
};

async function selectIncidents(
  pool: Pool, organizationId: string, jobId: string,
): Promise<IncidentRow[]> {
  return (await pool.query(
    `SELECT id, delay_type, episode_no, schedule_revision_no,
            deadline_at, breached_at, source, recovered_at, recovery_actor_user_id,
            ended_at, ended_by_user_id, end_reason, end_note,
            ended_by_schedule_revision_no
       FROM job_card_overdue_incidents
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY breached_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as IncidentRow[];
}

function openIncidents(rows: IncidentRow[]): IncidentRow[] {
  return rows.filter((row) => row.recovered_at === null && row.ended_at === null);
}

/** The shared interface allows ISO strings or epoch millis for a boundary. */
function mentionsInstant(value: unknown, instant: Date): boolean {
  const serialized = JSON.stringify(value);
  return serialized.includes(instant.toISOString())
    || serialized.includes(String(instant.getTime()));
}

/** Accepts the effective deadline or its +1ms first-late step. */
function mentionsFirstLate(value: unknown, effectiveDeadline: Date): boolean {
  return mentionsInstant(value, effectiveDeadline)
    || mentionsInstant(value, shiftMs(effectiveDeadline, 1));
}

async function selectJobRow(pool: Pool, organizationId: string, jobId: string) {
  return (await pool.query<{
    status: string; version: number; due_date: string | null;
    scheduled_at: Date | null; scheduled_ends_at: Date | null;
  }>(
    `SELECT status, version, due_date::text AS due_date,
            scheduled_at, scheduled_ends_at
       FROM job_cards
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, jobId],
  )).rows[0]!;
}

async function selectScheduleRevisions(
  pool: Pool, organizationId: string, jobId: string,
): Promise<Array<{ revision_no: number; created_at: Date; due_date: string | null }>> {
  return (await pool.query(
    `SELECT revision_no, created_at, due_date::text AS due_date
       FROM job_card_schedule_revisions
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY revision_no ASC`,
    [organizationId, jobId],
  )).rows as Array<{ revision_no: number; created_at: Date; due_date: string | null }>;
}

async function reservedAtFor(
  pool: Pool, organizationId: string, jobId: string, operationKey: string,
): Promise<Date> {
  const row = (await pool.query<{ reserved_at: Date }>(
    `SELECT reserved_at FROM job_card_lifecycle_intents
      WHERE organization_id = $1 AND job_card_id = $2 AND operation_key = $3
      ORDER BY reserved_at DESC, id DESC LIMIT 1`,
    [organizationId, jobId, operationKey],
  )).rows[0];
  if (!row) throw new Error(`missing lifecycle intent for ${operationKey}`);
  return row.reserved_at;
}

async function selectActivities(
  pool: Pool, organizationId: string, jobId: string, eventType: string,
): Promise<Array<{ id: string; metadata: Record<string, unknown> | null; created_at: Date }>> {
  return (await pool.query(
    `SELECT id, metadata, created_at FROM job_card_activity_logs
      WHERE organization_id = $1 AND job_card_id = $2 AND event_type = $3
      ORDER BY created_at ASC, id ASC`,
    [organizationId, jobId, eventType],
  )).rows as Array<{ id: string; metadata: Record<string, unknown> | null; created_at: Date }>;
}

async function selectDeliveries(
  pool: Pool, organizationId: string, jobId: string,
): Promise<Array<{ kind: string; episode_no: number; incident_id: string; sent_at: Date }>> {
  return (await pool.query(
    `SELECT kind, episode_no, incident_id, sent_at
       FROM job_card_overdue_notification_deliveries
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY sent_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as Array<{ kind: string; episode_no: number; incident_id: string; sent_at: Date }>;
}

async function selectNotifications(
  pool: Pool, organizationId: string, jobId: string,
): Promise<Array<{ recipient_user_id: string; kind: string }>> {
  return (await pool.query(
    `SELECT recipient_user_id, kind FROM in_app_notifications
      WHERE organization_id = $1 AND entity_type = 'job-card' AND entity_id = $2
      ORDER BY created_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as Array<{ recipient_user_id: string; kind: string }>;
}

type ChangeRequestRow = {
  id: string;
  state: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
};

async function selectChangeRequest(
  pool: Pool, organizationId: string, requestId: string,
): Promise<ChangeRequestRow> {
  return (await pool.query(
    `SELECT id, state, resolution, resolved_by, resolved_at, resolution_note
       FROM job_card_change_requests
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, requestId],
  )).rows[0] as ChangeRequestRow;
}

async function createChangeRequest(ctx: Ctx, job: { id: string; version: number }): Promise<string> {
  const receipt = await ctx.service.createChangeRequest(ctx.staff, job.id, {
    clientActionId: randomUUID(),
    reasonCode: 'CUSTOMER_POSTPONED',
    reasonText: 'Müşteri görüşmeyi ileri bir tarihe aldı.',
  });
  return receipt.changeRequestId;
}

/**
 * The shared interface allows either a per-delay-type `endings` array or a
 * flat episode/boundary shape; both are normalised here so the assertion
 * covers the fixed facts (types, reason, revision, instants) without
 * over-fitting to one spelling.
 */
function endingFacts(metadata: Record<string, unknown> | null): Array<{
  delayType: string | null;
  episodeNo: number | null;
  previousFirstLateAt: unknown;
  newFirstLateAt: unknown;
}> {
  if (metadata === null) return [];
  const endings = metadata.endings;
  if (Array.isArray(endings)) {
    return endings.map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        delayType: typeof record.delayType === 'string' ? record.delayType : null,
        episodeNo: typeof record.episodeNo === 'number' ? record.episodeNo : null,
        previousFirstLateAt: record.previousFirstLateAt,
        newFirstLateAt: record.newFirstLateAt,
      };
    });
  }
  const delayTypes = Array.isArray(metadata.delayTypes)
    ? metadata.delayTypes.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const flatEpisodeNo = typeof metadata.episodeNo === 'number' ? metadata.episodeNo : null;
  const episodeMap = metadata.episodeNo !== null && typeof metadata.episodeNo === 'object'
    ? metadata.episodeNo as Record<string, unknown>
    : {};
  return delayTypes.map((delayType) => ({
    delayType,
    episodeNo: flatEpisodeNo
      ?? (typeof episodeMap[delayType] === 'number' ? episodeMap[delayType] as number : null),
    previousFirstLateAt: metadata.previousFirstLateAt,
    newFirstLateAt: metadata.newFirstLateAt,
  }));
}

describe.skipIf(!databaseUrl)('OVR-5b authorized deadline extension (PostgreSQL)', () => {
  // -------------------------------------------------------------------------
  // E1: management extension ends every open row of the episode.
  // -------------------------------------------------------------------------

  it('E1: a reasoned management dueDate extension ends the open episode and stops OVR-4', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E1');
      const firstDueDate = dateKeyShift(ctx.clock.now, -3);
      const job = await createTask(ctx, { title: 'Gecikmiş genel iş', dueDate: firstDueDate });
      let current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));

      const before = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(before).toHaveLength(1);
      expect(openIncidents(before)).toHaveLength(1);
      const breachedAt = before[0]!.breached_at;

      ctx.clock.now = await dbBaseline(pool);
      const patchInstant = ctx.clock.now;
      const nextDueDate = dateKeyShift(patchInstant, 3);
      current = await patchJob(ctx, ctx.manager, current, {
        dueDate: nextDueDate,
        deadlineExtensionReason: EXTENSION_REASON,
      }) as unknown as JobCard;
      expect(current.status).toBe('IN_PROGRESS');

      const rows = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(openIncidents(rows)).toHaveLength(0);
      const ended = rows.find((row) => row.delay_type === 'LATE_SUBMISSION')!;
      expect(ended.ended_at).toEqual(patchInstant);
      expect(ended.ended_by_user_id).toBe(ctx.managerId);
      expect(ended.end_reason).toBe('DEADLINE_EXTENDED');
      expect(ended.end_note).toBe(EXTENSION_REASON);
      expect(ended.ended_by_schedule_revision_no).toBe(2);
      // Evidence is immutable.
      expect(ended.breached_at).toEqual(breachedAt);
      expect(ended.recovered_at).toBeNull();

      const revisions = await selectScheduleRevisions(pool, ctx.organizationId, job.id);
      expect(revisions.map((revision) => revision.revision_no)).toEqual([1, 2]);
      expect(revisions[1]!.created_at).toEqual(patchInstant);
      expect(revisions[1]!.due_date).toBe(nextDueDate);

      const activities = await selectActivities(
        pool, ctx.organizationId, job.id, 'JOB_OVERDUE_ENDED_BY_EXTENSION',
      );
      expect(activities).toHaveLength(1);
      const metadata = activities[0]!.metadata;
      expect(metadata).toMatchObject({
        reason: EXTENSION_REASON,
        scheduleRevisionNo: 2,
      });
      const facts = endingFacts(metadata);
      expect(facts.some((fact) =>
        fact.delayType === 'LATE_SUBMISSION' && fact.episodeNo === 1)).toBe(true);
      // Contract §4.7: both the old and the new first-late boundary are recorded.
      const oldBoundary = utcBoundaryAfter(firstDueDate);
      const newDueBoundary = utcBoundaryAfter(nextDueDate);
      expect(mentionsFirstLate(metadata, oldBoundary)).toBe(true);
      expect(mentionsFirstLate(metadata, newDueBoundary)).toBe(true);
      // The ordinary field change is still recorded as its own fact (§4.7).
      expect(await selectActivities(
        pool, ctx.organizationId, job.id, 'JOB_FIELDS_UPDATED',
      )).toHaveLength(1);

      // OVR-4 stops: no delivery for an ended obligation.
      const workerReport = await reminderWorker(pool)
        .runOnce(shiftMs(patchInstant, 2 * HOUR_MS));
      expect(workerReport.candidates).toBe(0);
      expect(workerReport.sent).toBe(0);
      expect(await selectDeliveries(pool, ctx.organizationId, job.id)).toHaveLength(0);

      // The management open-late list drops it.
      const openLate = await ctx.service.listOpenSubmissionLate(ctx.manager, { limit: 25, offset: 0 });
      expect(openLate.items.filter((item) => item.jobCardId === job.id)).toHaveLength(0);

      // History shows the ending; it is never presented as a recovery.
      const history = await ctx.service.listOverdueIncidents(
        ctx.manager, job.id, { limit: 25, offset: 0 },
      );
      expect(history.items).toHaveLength(1);
      expect(history.items[0]).toMatchObject({
        endedAt: patchInstant.toISOString(),
        endedBy: { id: ctx.managerId, name: 'Müdür' },
        endReason: 'DEADLINE_EXTENDED',
        endNote: EXTENSION_REASON,
        endedByScheduleRevisionNo: 2,
        recoveredAt: null,
        recoveryActor: null,
        totalDelaySeconds: null,
      });
      expect(history.items[0]!.endedDurationSeconds).toBe(
        Math.floor((patchInstant.getTime() - breachedAt.getTime()) / 1000),
      );

      const detail = (await ctx.service.detail(ctx.manager, job.id)) as unknown as Ovr5bDetail;
      expect(detail.hasOpenOverdueIncident).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // E2: no reason, nothing written.
  // -------------------------------------------------------------------------

  it('E2: an extension that would end lateness without a reason writes nothing', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E2');
      const job = await createTask(ctx, { title: 'Gerekçesiz uzatma', dueDate: dateKeyShift(ctx.clock.now, -3) });
      const current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));
      const dueDateBefore = (await selectJobRow(pool, ctx.organizationId, job.id)).due_date;

      ctx.clock.now = await dbBaseline(pool);
      await expect(patchJob(ctx, ctx.manager, current, {
        dueDate: dateKeyShift(ctx.clock.now, 3),
      })).rejects.toMatchObject({
        code: 'DEADLINE_EXTENSION_REASON_REQUIRED',
        statusCode: 400,
        details: { fieldErrors: { deadlineExtensionReason: expect.any(String) } },
      });

      const row = await selectJobRow(pool, ctx.organizationId, job.id);
      expect(row).toMatchObject({
        status: 'IN_PROGRESS',
        version: current.version,
        due_date: dueDateBefore,
      });
      expect(await selectScheduleRevisions(pool, ctx.organizationId, job.id)).toHaveLength(1);
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        ended_at: null,
        end_reason: null,
        end_note: null,
        ended_by_user_id: null,
        ended_by_schedule_revision_no: null,
        recovered_at: null,
      });
      expect(await selectActivities(
        pool, ctx.organizationId, job.id, 'JOB_OVERDUE_ENDED_BY_EXTENSION',
      )).toHaveLength(0);
      expect(await selectActivities(
        pool, ctx.organizationId, job.id, 'JOB_FIELDS_UPDATED',
      )).toHaveLength(0);

      // A sent reason is validated even when nothing ends.
      await expect(patchJob(ctx, ctx.manager, current, {
        dueDate: dateKeyShift(ctx.clock.now, 3),
        deadlineExtensionReason: 'x'.repeat(501),
      })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: { fieldErrors: { deadlineExtensionReason: expect.any(String) } },
      });
    });
  });

  // -------------------------------------------------------------------------
  // E3: a boundary that is still past / not the governing deadline.
  // -------------------------------------------------------------------------

  it('E3: a still-past move and a non-governing dueDate move end nothing', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E3');

      // (a) A dueDate move that is still in the past: today's B2 row appears,
      // nothing is ended, and a sent reason is ignored.
      const task = await createTask(ctx, { title: 'Geçmişe taşıma', dueDate: dateKeyShift(ctx.clock.now, -3) });
      let taskCurrent = await startJob(ctx, task);
      await scanOnce(pool, await dbBaseline(pool));
      ctx.clock.now = await dbBaseline(pool);
      taskCurrent = await patchJob(ctx, ctx.manager, taskCurrent, {
        dueDate: dateKeyShift(ctx.clock.now, -2),
        deadlineExtensionReason: 'Yine geçmiş bir tarih.',
      }) as unknown as JobCard;

      const taskRows = await selectIncidents(pool, ctx.organizationId, task.id);
      expect(taskRows).toHaveLength(2);
      expect(openIncidents(taskRows)).toHaveLength(2);
      expect(taskRows.every((row) => row.ended_at === null && row.end_note === null)).toBe(true);
      expect(taskRows.map((row) => row.schedule_revision_no).sort()).toEqual([1, 2]);
      const taskRevision = await selectScheduleRevisions(pool, ctx.organizationId, task.id);
      expect(taskRevision).toHaveLength(2);
      expect(await selectActivities(
        pool, ctx.organizationId, task.id, 'JOB_OVERDUE_ENDED_BY_EXTENSION',
      )).toHaveLength(0);

      // (b) A dueDate move on a job whose submission/late-start boundary is
      // governed by scheduledEndsAt leaves every boundary unchanged.
      const startAt = shiftMs(ctx.clock.now, -4 * HOUR_MS);
      let delivery = await createDelivery(ctx, {
        title: 'Planlı teslim', scheduledAt: startAt, dueDate: dateKeyShift(ctx.clock.now, -1),
      });
      delivery = await acceptJob(ctx, delivery);
      await scanOnce(pool, await dbBaseline(pool));
      const deliveryBefore = await selectIncidents(pool, ctx.organizationId, delivery.id);
      expect(deliveryBefore).toHaveLength(1);
      expect(deliveryBefore[0]).toMatchObject({ delay_type: 'LATE_START', ended_at: null });

      ctx.clock.now = await dbBaseline(pool);
      const moved = await patchJob(ctx, ctx.manager, delivery, {
        dueDate: dateKeyShift(ctx.clock.now, 2),
      });
      expect(moved.status).toBe('ACCEPTED');
      const deliveryAfter = await selectIncidents(pool, ctx.organizationId, delivery.id);
      expect(deliveryAfter).toHaveLength(1);
      expect(deliveryAfter[0]).toMatchObject({
        delay_type: 'LATE_START',
        ended_at: null,
        recovered_at: null,
        deadline_at: deliveryBefore[0]!.deadline_at,
        breached_at: deliveryBefore[0]!.breached_at,
      });
      expect(await selectActivities(
        pool, ctx.organizationId, delivery.id, 'JOB_OVERDUE_ENDED_BY_EXTENSION',
      )).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // E4: an ACCEPTED delivery with open LATE_START is ended by a reschedule.
  // -------------------------------------------------------------------------

  it('E4: rescheduling an ACCEPTED delivery into the future ends LATE_START and returns NEW', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E4');
      let job = await createDelivery(ctx, {
        title: 'Geç kabul edilen teslim',
        scheduledAt: shiftMs(ctx.clock.now, -2 * HOUR_MS),
      });
      job = await acceptJob(ctx, job);
      const before = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({
        delay_type: 'LATE_START', episode_no: 1, schedule_revision_no: 1, ended_at: null,
      });

      ctx.clock.now = await dbBaseline(pool);
      const patchInstant = ctx.clock.now;
      const futureStart = shiftMs(patchInstant, 2 * HOUR_MS);
      const rescheduled = await patchJob(ctx, ctx.manager, job, {
        scheduledAt: futureStart.toISOString(),
        scheduledEndsAt: shiftMs(futureStart, 30 * MINUTE_MS).toISOString(),
        deadlineExtensionReason: EXTENSION_REASON,
      });
      expect(rescheduled.status).toBe('NEW');

      const after = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(after).toHaveLength(1);
      const ended = after[0]!;
      expect(ended).toMatchObject({
        delay_type: 'LATE_START',
        ended_at: patchInstant,
        ended_by_user_id: ctx.managerId,
        end_reason: 'DEADLINE_EXTENDED',
        end_note: EXTENSION_REASON,
        ended_by_schedule_revision_no: 2,
        recovered_at: null,
      });
      const revisions = await selectScheduleRevisions(pool, ctx.organizationId, job.id);
      expect(revisions.map((revision) => revision.revision_no)).toEqual([1, 2]);
      expect(revisions[1]!.created_at).toEqual(patchInstant);
      expect(await selectActivities(
        pool, ctx.organizationId, job.id, 'JOB_OVERDUE_ENDED_BY_EXTENSION',
      )).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // E5: the new revision breaches again; SUBMIT recovers only the new row.
  // -------------------------------------------------------------------------

  it('E5: after an ending, a later breach under the new revision is recovered alone', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E5');
      const job = await createTask(ctx, { title: 'Yeniden gecikme', dueDate: dateKeyShift(ctx.clock.now, -3) });
      let current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));

      ctx.clock.now = await dbBaseline(pool);
      const nextDueDate = dateKeyShift(ctx.clock.now, 3);
      current = await patchJob(ctx, ctx.manager, current, {
        dueDate: nextDueDate, deadlineExtensionReason: EXTENSION_REASON,
      }) as unknown as JobCard;
      const endedRow = (await selectIncidents(pool, ctx.organizationId, job.id))[0]!;
      expect(endedRow.ended_at).not.toBeNull();

      // The new deadline passes: a new incident under revision 2.
      const newBoundary = utcBoundaryAfter(nextDueDate);
      const scanReport = await scanOnce(pool, shiftMs(newBoundary, 1));
      expect(scanReport.inserted).toBe(1);
      const rows = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(rows).toHaveLength(2);
      const openRow = rows.find((row) => row.id !== endedRow.id)!;
      expect(openRow).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        schedule_revision_no: 2,
        recovered_at: null,
        ended_at: null,
      });
      expect(openRow.deadline_at).toEqual(shiftMs(newBoundary, 1));

      // SUBMIT recovers only the open row; the ended row stays evidence.
      const submitted = await submitJob(ctx, current);
      expect(submitted.status).toBe('WAITING_APPROVAL');
      const recoveredAt = await reservedAtFor(
        pool, ctx.organizationId, job.id, `JOB_SUBMIT_FOR_APPROVAL:${job.id}`,
      );
      const finalRows = await selectIncidents(pool, ctx.organizationId, job.id);
      const endedAfter = finalRows.find((row) => row.id === endedRow.id)!;
      const recoveredRow = finalRows.find((row) => row.id === openRow.id)!;
      expect(endedAfter.ended_at).not.toBeNull();
      expect(endedAfter.recovered_at).toBeNull();
      expect(recoveredRow.recovered_at).toEqual(recoveredAt);
      expect(recoveredRow.recovery_actor_user_id).toBe(ctx.staffId);
      expect(recoveredRow.ended_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // E6: APPROVAL_WAIT is never ended by an extension.
  // -------------------------------------------------------------------------

  it('E6: an open APPROVAL_WAIT is never ended by a management field edit', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E6');
      const job = await createTask(ctx, { title: 'Onayda bekleyen', dueDate: dateKeyShift(ctx.clock.now, -3) });
      const started = await startJob(ctx, job);
      const submitted = await submitJob(ctx, started);
      const submittedAt = await reservedAtFor(
        pool, ctx.organizationId, job.id, `JOB_SUBMIT_FOR_APPROVAL:${job.id}`,
      );

      const approvalDeadline = shiftMs(submittedAt, 24 * HOUR_MS);
      const scanReport = await scanOnce(pool, shiftMs(approvalDeadline, 1));
      expect(scanReport.inserted).toBe(1);
      const before = await selectIncidents(pool, ctx.organizationId, job.id);
      const approvalWait = before.find((row) => row.delay_type === 'APPROVAL_WAIT')!;
      expect(approvalWait).toBeDefined();
      expect(openIncidents(before)).toHaveLength(1);

      ctx.clock.now = await dbBaseline(pool);
      const nextDueDate = dateKeyShift(ctx.clock.now, 4);
      // A job in review is not editable (existing rule), so no field edit can
      // reach — let alone end — its management APPROVAL_WAIT.
      await expect(patchJob(ctx, ctx.manager, submitted, {
        dueDate: nextDueDate,
        deadlineExtensionReason: 'Onay beklemesi uzatılmaz.',
      })).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE' });
      expect((await selectJobRow(pool, ctx.organizationId, job.id)).due_date)
        .not.toBe(nextDueDate);

      const after = await selectIncidents(pool, ctx.organizationId, job.id);
      const approvalWaitAfter = after.find((row) => row.id === approvalWait.id)!;
      expect(approvalWaitAfter).toMatchObject({
        ended_at: null,
        end_reason: null,
        end_note: null,
        ended_by_user_id: null,
        ended_by_schedule_revision_no: null,
        recovered_at: null,
      });
      expect(openIncidents(after)).toHaveLength(1);
      expect(await selectActivities(
        pool, ctx.organizationId, job.id, 'JOB_OVERDUE_ENDED_BY_EXTENSION',
      )).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // E7: extension before the scanner ticked — materialize and end atomically.
  // -------------------------------------------------------------------------

  it('E7: an extension before the scanner ticked materializes and ends atomically', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E7');

      const reasoned = await createTask(ctx, {
        title: 'Taranmadan uzatılan', dueDate: dateKeyShift(ctx.clock.now, -3),
      });
      let reasonedCurrent = await startJob(ctx, reasoned);
      // No scan: the obligation is materialized by the patch itself.
      ctx.clock.now = await dbBaseline(pool);
      const patchInstant = ctx.clock.now;
      reasonedCurrent = await patchJob(ctx, ctx.manager, reasonedCurrent, {
        dueDate: dateKeyShift(patchInstant, 3),
        deadlineExtensionReason: EXTENSION_REASON,
      }) as unknown as JobCard;

      const reasonedRows = await selectIncidents(pool, ctx.organizationId, reasoned.id);
      expect(reasonedRows).toHaveLength(1);
      expect(reasonedRows[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        ended_at: patchInstant,
        end_reason: 'DEADLINE_EXTENDED',
        end_note: EXTENSION_REASON,
        ended_by_schedule_revision_no: 2,
        recovered_at: null,
      });
      expect(openIncidents(reasonedRows)).toHaveLength(0);
      expect(await selectScheduleRevisions(pool, ctx.organizationId, reasoned.id)).toHaveLength(2);
      expect(await selectActivities(
        pool, ctx.organizationId, reasoned.id, 'JOB_OVERDUE_ENDED_BY_EXTENSION',
      )).toHaveLength(1);

      // Without a reason both the pre-mutation incident and the field edit roll back.
      const unreasoned = await createTask(ctx, {
        title: 'Gerekçesiz taranmamış', dueDate: dateKeyShift(ctx.clock.now, -3),
      });
      const unreasonedCurrent = await startJob(ctx, unreasoned);
      const unreasonedDueDate = (await selectJobRow(pool, ctx.organizationId, unreasoned.id)).due_date;
      ctx.clock.now = await dbBaseline(pool);
      await expect(patchJob(ctx, ctx.manager, unreasonedCurrent, {
        dueDate: dateKeyShift(ctx.clock.now, 3),
      })).rejects.toMatchObject({
        code: 'DEADLINE_EXTENSION_REASON_REQUIRED', statusCode: 400,
      });
      expect(await selectIncidents(pool, ctx.organizationId, unreasoned.id)).toHaveLength(0);
      expect(await selectScheduleRevisions(pool, ctx.organizationId, unreasoned.id)).toHaveLength(1);
      expect((await selectJobRow(pool, ctx.organizationId, unreasoned.id)).due_date)
        .toBe(unreasonedDueDate);
      expect(await selectActivities(
        pool, ctx.organizationId, unreasoned.id, 'JOB_OVERDUE_ENDED_BY_EXTENSION',
      )).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // E8: open LATE_START on a NEW job after reassignment, then rescheduled.
  // -------------------------------------------------------------------------

  it('E8: an open LATE_START on a reassigned NEW job is ended by the next reschedule', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E8');
      let job = await createDelivery(ctx, {
        title: 'Yeniden atanan teslim',
        scheduledAt: shiftMs(ctx.clock.now, -2 * HOUR_MS),
      });
      job = await acceptJob(ctx, job);
      expect(openIncidents(await selectIncidents(pool, ctx.organizationId, job.id)))
        .toHaveLength(1);

      // A management reassignment returns the ACCEPTED job to NEW without
      // ending the incident (no schedule revision is appended).
      ctx.clock.now = await dbBaseline(pool);
      const reassigned = await patchJob(ctx, ctx.manager, job, {
        assignedTo: ctx.otherStaffId,
      });
      expect(reassigned.status).toBe('NEW');
      const afterReassign = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(afterReassign).toHaveLength(1);
      expect(afterReassign[0]!.ended_at).toBeNull();
      expect(openIncidents(afterReassign)).toHaveLength(1);

      ctx.clock.now = await dbBaseline(pool);
      const patchInstant = ctx.clock.now;
      const futureStart = shiftMs(patchInstant, 3 * HOUR_MS);
      const rescheduled = await patchJob(ctx, ctx.manager, reassigned, {
        scheduledAt: futureStart.toISOString(),
        scheduledEndsAt: shiftMs(futureStart, 30 * MINUTE_MS).toISOString(),
        deadlineExtensionReason: EXTENSION_REASON,
      });
      expect(rescheduled.status).toBe('NEW');
      const after = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        delay_type: 'LATE_START',
        ended_at: patchInstant,
        end_reason: 'DEADLINE_EXTENDED',
        ended_by_user_id: ctx.managerId,
        ended_by_schedule_revision_no: 2,
      });
      expect(openIncidents(after)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // E9: several open rows of one episode are ended by one patch.
  // -------------------------------------------------------------------------

  it('E9: every open row of the episode is ended by a single extension', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E9');
      const job = await createTask(ctx, { title: 'Çok satırlı gecikme', dueDate: dateKeyShift(ctx.clock.now, -3) });
      let current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));

      // A still-past move adds a second open row of the same episode (B2).
      ctx.clock.now = await dbBaseline(pool);
      current = await patchJob(ctx, ctx.manager, current, {
        dueDate: dateKeyShift(ctx.clock.now, -2),
      }) as unknown as JobCard;
      const beforeExtension = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(beforeExtension).toHaveLength(2);
      expect(openIncidents(beforeExtension)).toHaveLength(2);

      ctx.clock.now = await dbBaseline(pool);
      const patchInstant = ctx.clock.now;
      current = await patchJob(ctx, ctx.manager, current, {
        dueDate: dateKeyShift(patchInstant, 3),
        deadlineExtensionReason: EXTENSION_REASON,
      }) as unknown as JobCard;

      const rows = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(rows).toHaveLength(2);
      expect(openIncidents(rows)).toHaveLength(0);
      for (const row of rows) {
        expect(row).toMatchObject({
          ended_at: patchInstant,
          ended_by_user_id: ctx.managerId,
          end_reason: 'DEADLINE_EXTENDED',
          ended_by_schedule_revision_no: 3,
        });
      }
      expect(await selectActivities(
        pool, ctx.organizationId, job.id, 'JOB_OVERDUE_ENDED_BY_EXTENSION',
      )).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // E10/E11/E12: removing the deadline, governing vs non-governing, roles.
  // -------------------------------------------------------------------------

  it('E10: removing the governing dueDate of an open incident is rejected', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E10');
      const dueDate = dateKeyShift(ctx.clock.now, -3);
      const job = await createTask(ctx, { title: 'Tarihi kaldırma', dueDate });
      const current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));
      const before = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(openIncidents(before)).toHaveLength(1);

      ctx.clock.now = await dbBaseline(pool);
      await expect(patchJob(ctx, ctx.manager, current, { dueDate: null }))
        .rejects.toMatchObject({
          code: 'OPEN_LATENESS_DEADLINE_REQUIRED', statusCode: 409,
        });

      const row = await selectJobRow(pool, ctx.organizationId, job.id);
      expect(row).toMatchObject({ status: 'IN_PROGRESS', version: current.version, due_date: dueDate });
      expect(await selectScheduleRevisions(pool, ctx.organizationId, job.id)).toHaveLength(1);
      const after = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ ended_at: null, recovered_at: null });
    });
  });

  it('E11: removing a non-governing dueDate is allowed and ends nothing', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E11');
      let job = await createDelivery(ctx, {
        title: 'Gözetimsiz tarih',
        scheduledAt: shiftMs(ctx.clock.now, -4 * HOUR_MS),
        dueDate: dateKeyShift(ctx.clock.now, 1),
      });
      // Management accepts it late: the planned interval governs lateness while
      // the dueDate is only a secondary field.
      job = await acceptJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));
      const before = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ delay_type: 'LATE_START', ended_at: null });

      ctx.clock.now = await dbBaseline(pool);
      const patched = await patchJob(ctx, ctx.manager, job, { dueDate: null });
      expect(patched.status).toBe('ACCEPTED');
      expect((await selectJobRow(pool, ctx.organizationId, job.id)).due_date).toBeNull();
      const after = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        delay_type: 'LATE_START',
        deadline_at: before[0]!.deadline_at,
        breached_at: before[0]!.breached_at,
        ended_at: null,
        recovered_at: null,
      });
      expect(await selectActivities(
        pool, ctx.organizationId, job.id, 'JOB_OVERDUE_ENDED_BY_EXTENSION',
      )).toHaveLength(0);
    });
  });

  it('E12: Staff removing a deadline on a late job gets the Staff block, never E10', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'E12');
      const dueDate = dateKeyShift(ctx.clock.now, -3);
      const job = await createTask(ctx, { title: 'Personel tarih kaldırma', dueDate });
      const current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));

      ctx.clock.now = await dbBaseline(pool);
      const rejection = await patchJob(ctx, ctx.staff, current, { dueDate: null })
        .catch((error: unknown) => error as { code?: string; statusCode?: number });
      expect(rejection).toMatchObject({
        code: 'DEADLINE_CHANGE_REQUIRES_MANAGEMENT', statusCode: 409,
      });
      expect((rejection as { code?: string }).code)
        .not.toBe('OPEN_LATENESS_DEADLINE_REQUIRED');
      expect((await selectJobRow(pool, ctx.organizationId, job.id)).due_date).toBe(dueDate);
      expect(openIncidents(await selectIncidents(pool, ctx.organizationId, job.id)))
        .toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // S1/S3: the Staff deadline block.
  // -------------------------------------------------------------------------

  it('S1: Staff cannot move deadlines of a late job; a clean job still edits', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'S1');

      // (a) Staff self-created job is included in the block.
      const lateSelf = await createTask(ctx, { title: 'Personelin geç işi', dueDate: dateKeyShift(ctx.clock.now, -3) });
      const lateCurrent = await startJob(ctx, lateSelf);
      await scanOnce(pool, await dbBaseline(pool));
      const lateDueDate = (await selectJobRow(pool, ctx.organizationId, lateSelf.id)).due_date;

      ctx.clock.now = await dbBaseline(pool);
      await expect(patchJob(ctx, ctx.staff, lateCurrent, {
        dueDate: dateKeyShift(ctx.clock.now, 3),
      })).rejects.toMatchObject({
        code: 'DEADLINE_CHANGE_REQUIRES_MANAGEMENT',
        statusCode: 409,
      });
      const lateRow = await selectJobRow(pool, ctx.organizationId, lateSelf.id);
      expect(lateRow).toMatchObject({
        version: lateCurrent.version, due_date: lateDueDate, status: 'IN_PROGRESS',
      });
      expect(await selectScheduleRevisions(pool, ctx.organizationId, lateSelf.id)).toHaveLength(1);
      const lateIncidents = await selectIncidents(pool, ctx.organizationId, lateSelf.id);
      expect(lateIncidents).toHaveLength(1);
      expect(lateIncidents[0]).toMatchObject({ ended_at: null, recovered_at: null });

      // (b) A manager-created job assigned to Staff is blocked the same way.
      const assigned = await createDelivery(ctx, {
        title: 'Yönetici işi',
        scheduledAt: shiftMs(ctx.clock.now, -2 * HOUR_MS),
      });
      const accepted = await acceptJob(ctx, assigned);
      await scanOnce(pool, await dbBaseline(pool));
      ctx.clock.now = await dbBaseline(pool);
      await expect(patchJob(ctx, ctx.staff, accepted, {
        dueDate: dateKeyShift(ctx.clock.now, 2),
      })).rejects.toMatchObject({
        code: 'DEADLINE_CHANGE_REQUIRES_MANAGEMENT', statusCode: 409,
      });

      // (c) Without open lateness Staff keeps today's edit rights.
      const clean = await createTask(ctx, { title: 'Temiz iş', dueDate: dateKeyShift(ctx.clock.now, 4) });
      const cleanStarted = await startJob(ctx, clean);
      const nextCleanDueDate = dateKeyShift(ctx.clock.now, 6);
      const edited = await patchJob(ctx, ctx.staff, cleanStarted, { dueDate: nextCleanDueDate });
      expect(edited.status).toBe('IN_PROGRESS');
      expect((await selectJobRow(pool, ctx.organizationId, clean.id)).due_date)
        .toBe(nextCleanDueDate);
      expect(await selectScheduleRevisions(pool, ctx.organizationId, clean.id)).toHaveLength(2);
    });
  });

  it('S3: a Staff deadline patch before the scanner ticked rolls everything back', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'S3');
      const job = await createTask(ctx, { title: 'Taranmamış personel', dueDate: dateKeyShift(ctx.clock.now, -3) });
      const current = await startJob(ctx, job);
      const dueDateBefore = (await selectJobRow(pool, ctx.organizationId, job.id)).due_date;

      ctx.clock.now = await dbBaseline(pool);
      await expect(patchJob(ctx, ctx.staff, current, {
        dueDate: dateKeyShift(ctx.clock.now, 3),
      })).rejects.toMatchObject({
        code: 'DEADLINE_CHANGE_REQUIRES_MANAGEMENT', statusCode: 409,
      });

      // Neither the field edit nor the pre-mutation incident survives.
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
      expect(await selectScheduleRevisions(pool, ctx.organizationId, job.id)).toHaveLength(1);
      expect(await selectJobRow(pool, ctx.organizationId, job.id)).toMatchObject({
        status: 'IN_PROGRESS', version: current.version, due_date: dueDateBefore,
      });
    });
  });

  // -------------------------------------------------------------------------
  // S2: the detail DTO exposes the two server-computed facts.
  // -------------------------------------------------------------------------

  it('S2: the detail exposes hasOpenOverdueIncident and the effective correctionDueAt', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'S2');

      // Open LATE_SUBMISSION → true; no revision episode → correction null.
      const dueDate = dateKeyShift(ctx.clock.now, -3);
      const job = await createTask(ctx, { title: 'DTO işi', dueDate });
      let current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));
      let detail = (await ctx.service.detail(ctx.manager, job.id)) as unknown as Ovr5bDetail;
      expect(detail.hasOpenOverdueIncident).toBe(true);
      expect(detail.correctionDueAt).toBeNull();

      // SUBMIT recovers episode 1 → false, still null.
      current = await submitJob(ctx, current);
      detail = (await ctx.service.detail(ctx.manager, job.id)) as unknown as Ovr5bDetail;
      expect(detail.hasOpenOverdueIncident).toBe(false);
      expect(detail.correctionDueAt).toBeNull();

      // A reasoned revision correction becomes the effective deadline.
      const originalDeadline = utcBoundaryAfter(dueDate);
      const supplied = shiftMs(await dbBaseline(pool), 5 * HOUR_MS);
      expect(supplied.getTime()).toBeGreaterThan(originalDeadline.getTime());
      current = await objectAsManager(ctx, current, supplied.toISOString()) as unknown as JobCard;
      detail = (await ctx.service.detail(ctx.manager, job.id)) as unknown as Ovr5bDetail;
      expect(detail.status).toBe('REVISION_REQUESTED');
      expect(detail.correctionDueAt).toBe(supplied.toISOString());
      expect(detail.hasOpenOverdueIncident).toBe(false);

      // Once the correction passes the episode is open again.
      await scanOnce(pool, shiftMs(supplied, 1));
      detail = (await ctx.service.detail(ctx.manager, job.id)) as unknown as Ovr5bDetail;
      expect(detail.hasOpenOverdueIncident).toBe(true);
      expect(detail.correctionDueAt).toBe(supplied.toISOString());

      // Outside REVISION_REQUESTED/IN_PROGRESS the field is null.
      current = await resumeJob(ctx, current);
      current = await submitJob(ctx, current);
      detail = (await ctx.service.detail(ctx.manager, job.id)) as unknown as Ovr5bDetail;
      expect(detail.status).toBe('WAITING_APPROVAL');
      expect(detail.correctionDueAt).toBeNull();
      expect(detail.hasOpenOverdueIncident).toBe(false);

      // The max rule: an earlier correction never reports a shorter deadline.
      const futureDueDate = dateKeyShift(ctx.clock.now, 4);
      const futureBoundary = utcBoundaryAfter(futureDueDate);
      const clean = await createTask(ctx, { title: 'Max kuralı', dueDate: futureDueDate });
      let cleanCurrent = await startJob(ctx, clean);
      cleanCurrent = await submitJob(ctx, cleanCurrent);
      const earlierCorrection = shiftMs(await dbBaseline(pool), 2 * HOUR_MS);
      expect(earlierCorrection.getTime()).toBeLessThan(futureBoundary.getTime());
      cleanCurrent = await objectAsManager(
        ctx, cleanCurrent, earlierCorrection.toISOString(),
      ) as unknown as JobCard;
      const maxDetail = (await ctx.service.detail(ctx.manager, clean.id)) as unknown as Ovr5bDetail;
      expect(maxDetail.correctionDueAt).toBe(futureBoundary.toISOString());

      // No original deadline → no correction in the DTO either.
      const timeless = await createTask(ctx, { title: 'Tarihsiz DTO', dueDate: null });
      let timelessCurrent = await startJob(ctx, timeless);
      timelessCurrent = await submitJob(ctx, timelessCurrent);
      timelessCurrent = await objectAsManager(
        ctx, timelessCurrent, shiftMs(await dbBaseline(pool), 3 * HOUR_MS).toISOString(),
      ) as unknown as JobCard;
      const timelessDetail = (await ctx.service.detail(ctx.manager, timeless.id)) as unknown as Ovr5bDetail;
      expect(timelessDetail.status).toBe('REVISION_REQUESTED');
      expect(timelessDetail.correctionDueAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // N1: a real ending starts a fresh OVR-4 cycle on the next breach.
  // -------------------------------------------------------------------------

  it('N1: a real extension ending lets the next breach start a fresh reminder cycle', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'N1');
      const job = await createTask(ctx, { title: 'Döngülü gecikme', dueDate: dateKeyShift(ctx.clock.now, -3) });
      let current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));

      const firstIncident = (await selectIncidents(pool, ctx.organizationId, job.id))[0]!;
      const worker = reminderWorker(pool);
      expect((await worker.runOnce(
        shiftMs(firstIncident.breached_at, STAFF_REMINDER_DELAY_MS),
      )).byKind).toMatchObject({ STAFF_REMINDER: 1, MANAGEMENT_ESCALATION: 0 });
      expect((await worker.runOnce(
        shiftMs(firstIncident.breached_at, ESCALATION_DELAY_MS),
      )).byKind).toMatchObject({ STAFF_REMINDER: 0, MANAGEMENT_ESCALATION: 1 });
      let deliveries = await selectDeliveries(pool, ctx.organizationId, job.id);
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((row) => row.incident_id === firstIncident.id)).toBe(true);

      // A real reasoned extension ends the obligation (no SQL simulation).
      ctx.clock.now = await dbBaseline(pool);
      const nextDueDate = dateKeyShift(ctx.clock.now, 2);
      current = await patchJob(ctx, ctx.manager, current, {
        dueDate: nextDueDate, deadlineExtensionReason: EXTENSION_REASON,
      }) as unknown as JobCard;
      const afterEnding = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(afterEnding).toHaveLength(1);
      expect(afterEnding[0]!.ended_at).not.toBeNull();

      // The new deadline passes: a new incident under revision 2, same episode.
      const newBoundary = utcBoundaryAfter(nextDueDate);
      expect((await scanOnce(pool, shiftMs(newBoundary, 1))).inserted).toBe(1);
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(2);
      const nextIncident = incidents.find((row) => row.id !== firstIncident.id)!;
      expect(nextIncident).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        schedule_revision_no: 2,
        recovered_at: null,
        ended_at: null,
      });

      // A fresh cycle: one reminder and one escalation for the new incident.
      const nextBreach = nextIncident.breached_at;
      expect((await worker.runOnce(
        shiftMs(nextBreach, STAFF_REMINDER_DELAY_MS),
      )).byKind).toMatchObject({ STAFF_REMINDER: 1, MANAGEMENT_ESCALATION: 0 });
      expect((await worker.runOnce(
        shiftMs(nextBreach, ESCALATION_DELAY_MS),
      )).byKind).toMatchObject({ STAFF_REMINDER: 0, MANAGEMENT_ESCALATION: 1 });

      deliveries = await selectDeliveries(pool, ctx.organizationId, job.id);
      expect(deliveries.filter((row) => row.incident_id === firstIncident.id)).toHaveLength(2);
      expect(deliveries.filter((row) => row.incident_id === nextIncident.id)
        .map((row) => row.kind).sort())
        .toEqual(['MANAGEMENT_ESCALATION', 'STAFF_REMINDER']);

      const notifications = await selectNotifications(pool, ctx.organizationId, job.id);
      expect(notifications.filter((row) => row.kind === 'job.submission_auto_reminder'))
        .toHaveLength(2);
      expect(notifications.filter((row) => row.kind === 'job.submission_auto_escalation'))
        .toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // J1–J4: resolving the Staff change request inside the extension patch.
  // -------------------------------------------------------------------------

  it('J1: an extension resolves the open change request in the same transaction', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'J1');
      const job = await createTask(ctx, { title: 'Öneri ve uzatma', dueDate: dateKeyShift(ctx.clock.now, -3) });
      let current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));
      const requestId = await createChangeRequest(ctx, current);
      expect((await selectChangeRequest(pool, ctx.organizationId, requestId)).state).toBe('OPEN');

      ctx.clock.now = await dbBaseline(pool);
      const patchInstant = ctx.clock.now;
      const nextDueDate = dateKeyShift(patchInstant, 3);
      const note = 'Personelin önerisi kabul edildi.';
      current = await patchJob(ctx, ctx.manager, current, {
        dueDate: nextDueDate,
        deadlineExtensionReason: EXTENSION_REASON,
        changeRequestResolution: {
          changeRequestId: requestId, resolution: 'RESCHEDULED', note,
        },
      }) as unknown as JobCard;

      // The lateness ended.
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(openIncidents(incidents)).toHaveLength(0);
      expect(incidents[0]!.ended_at).toEqual(patchInstant);

      // The request is resolved with the same effects as resolveChangeRequest.
      const request = await selectChangeRequest(pool, ctx.organizationId, requestId);
      expect(request).toMatchObject({
        state: 'CLOSED',
        resolution: 'RESCHEDULED',
        resolved_by: ctx.managerId,
        resolved_at: patchInstant,
        resolution_note: note,
      });
      const resolvedActivities = await selectActivities(
        pool, ctx.organizationId, job.id, 'JOB_CHANGE_REQUEST_RESOLVED',
      );
      expect(resolvedActivities).toHaveLength(1);
      expect(resolvedActivities[0]!.metadata).toMatchObject({ requestId, resolution: 'RESCHEDULED' });
      const notifications = await selectNotifications(pool, ctx.organizationId, job.id);
      expect(notifications.filter((row) =>
        row.kind === 'job.change_request_resolved' && row.recipient_user_id === ctx.staffId))
        .toHaveLength(1);

      // OVR-4 resumes only once the new deadline passes.
      const worker = reminderWorker(pool);
      expect((await worker.runOnce(shiftMs(patchInstant, 2 * HOUR_MS))).sent).toBe(0);
      const newBoundary = utcBoundaryAfter(nextDueDate);
      expect((await scanOnce(pool, shiftMs(newBoundary, 1))).inserted).toBe(1);
      const breachedAt = (await selectIncidents(pool, ctx.organizationId, job.id))
        .find((row) => row.ended_at === null)!.breached_at;
      expect((await worker.runOnce(
        shiftMs(breachedAt, STAFF_REMINDER_DELAY_MS),
      )).byKind).toMatchObject({ STAFF_REMINDER: 1, MANAGEMENT_ESCALATION: 0 });
    });
  });

  it('J2: an unknown, foreign or already closed request writes nothing', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'J2');
      const job = await createTask(ctx, { title: 'Yanlış öneri', dueDate: dateKeyShift(ctx.clock.now, -3) });
      let current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));
      const requestId = await createChangeRequest(ctx, current);
      const dueDateBefore = (await selectJobRow(pool, ctx.organizationId, job.id)).due_date;

      // (a) Unknown id.
      ctx.clock.now = await dbBaseline(pool);
      await expect(patchJob(ctx, ctx.manager, current, {
        dueDate: dateKeyShift(ctx.clock.now, 3),
        deadlineExtensionReason: EXTENSION_REASON,
        changeRequestResolution: {
          changeRequestId: randomUUID(), resolution: 'RESCHEDULED',
        },
      })).rejects.toMatchObject({ code: 'CHANGE_REQUEST_NOT_FOUND', statusCode: 404 });

      // (b) Another job's open request.
      const otherJob = await createTask(ctx, { title: 'Başka iş', dueDate: dateKeyShift(ctx.clock.now, 5) });
      const otherStarted = await startJob(ctx, otherJob);
      const foreignRequestId = await createChangeRequest(ctx, otherStarted);
      await expect(patchJob(ctx, ctx.manager, current, {
        dueDate: dateKeyShift(ctx.clock.now, 3),
        deadlineExtensionReason: EXTENSION_REASON,
        changeRequestResolution: {
          changeRequestId: foreignRequestId, resolution: 'RESCHEDULED',
        },
      })).rejects.toMatchObject({ code: 'CHANGE_REQUEST_NOT_FOUND', statusCode: 404 });

      // (c) An already resolved request.
      await ctx.service.resolveChangeRequest(ctx.manager, job.id, requestId, {
        clientActionId: randomUUID(),
        resolution: 'REJECTED',
        note: 'Reddedildi.',
      });
      await expect(patchJob(ctx, ctx.manager, current, {
        dueDate: dateKeyShift(ctx.clock.now, 3),
        deadlineExtensionReason: EXTENSION_REASON,
        changeRequestResolution: {
          changeRequestId: requestId, resolution: 'RESCHEDULED',
        },
      })).rejects.toMatchObject({ code: 'CHANGE_REQUEST_NOT_OPEN', statusCode: 409 });

      // Nothing was written by any rejected attempt.
      expect((await selectJobRow(pool, ctx.organizationId, job.id)).due_date).toBe(dueDateBefore);
      expect(await selectScheduleRevisions(pool, ctx.organizationId, job.id)).toHaveLength(1);
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({ ended_at: null, recovered_at: null });
      expect(await selectActivities(
        pool, ctx.organizationId, job.id, 'JOB_OVERDUE_ENDED_BY_EXTENSION',
      )).toHaveLength(0);
    });
  });

  it('J3: an extension without changeRequestResolution leaves the request OPEN', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'J3');
      const job = await createTask(ctx, { title: 'Sessiz öneri', dueDate: dateKeyShift(ctx.clock.now, -3) });
      let current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));
      const requestId = await createChangeRequest(ctx, current);

      ctx.clock.now = await dbBaseline(pool);
      current = await patchJob(ctx, ctx.manager, current, {
        dueDate: dateKeyShift(ctx.clock.now, 3),
        deadlineExtensionReason: EXTENSION_REASON,
      }) as unknown as JobCard;

      expect(openIncidents(await selectIncidents(pool, ctx.organizationId, job.id))).toHaveLength(0);
      expect(await selectChangeRequest(pool, ctx.organizationId, requestId)).toMatchObject({
        state: 'OPEN', resolution: null, resolved_by: null, resolved_at: null,
      });
      expect(await selectActivities(
        pool, ctx.organizationId, job.id, 'JOB_CHANGE_REQUEST_RESOLVED',
      )).toHaveLength(0);
    });
  });

  it('J4: a resolution outside a revision-appending management patch is rejected', async () => {
    await withSchema(async (pool) => {
      const ctx = await setup(pool, 'J4');

      // (a) Management, but the patch appends no schedule revision.
      const job = await createTask(ctx, { title: 'Revizyonsuz öneri', dueDate: dateKeyShift(ctx.clock.now, -3) });
      const current = await startJob(ctx, job);
      await scanOnce(pool, await dbBaseline(pool));
      const requestId = await createChangeRequest(ctx, current);

      ctx.clock.now = await dbBaseline(pool);
      await expect(patchJob(ctx, ctx.manager, current, {
        title: 'Yalnızca başlık değişti',
        changeRequestResolution: {
          changeRequestId: requestId, resolution: 'RESCHEDULED',
        },
      })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: { fieldErrors: { changeRequestResolution: expect.any(String) } },
      });
      expect((await selectJobRow(pool, ctx.organizationId, job.id)).version)
        .toBe(current.version);
      expect(await selectChangeRequest(pool, ctx.organizationId, requestId))
        .toMatchObject({ state: 'OPEN' });

      // (b) Staff can never send the resolution, even on a clean job.
      const clean = await createTask(ctx, { title: 'Personel önerisi', dueDate: dateKeyShift(ctx.clock.now, 4) });
      const cleanStarted = await startJob(ctx, clean);
      const cleanRequestId = await createChangeRequest(ctx, cleanStarted);
      await expect(patchJob(ctx, ctx.staff, cleanStarted, {
        title: 'Personel başlığı',
        changeRequestResolution: {
          changeRequestId: cleanRequestId, resolution: 'RESCHEDULED',
        },
      })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: { fieldErrors: { changeRequestResolution: expect.any(String) } },
      });
      expect((await selectJobRow(pool, ctx.organizationId, clean.id)).version)
        .toBe(cleanStarted.version);
      expect(await selectChangeRequest(pool, ctx.organizationId, cleanRequestId))
        .toMatchObject({ state: 'OPEN' });
    });
  });
});
