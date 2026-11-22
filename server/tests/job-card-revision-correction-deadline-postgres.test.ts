/**
 * OVR-5b writers: the revision correction deadline (contract §3, §9 C1–C8).
 *
 * These scenarios drive the real `JobCardService` writers against PostgreSQL.
 * OVR-5a only *read* `correction_due_at`; OVR-5b makes `REQUEST_REVISION`
 * write it, so nothing below writes the column or the activation row with SQL:
 * the service command under test is the only producer. SQL is used to read
 * what the writer persisted and to build legacy fixture rows that the
 * application itself cannot create (the START_ONLY `SALES_MEETING` of C8).
 *
 * Contract: docs/features/overdue-correction-deadline-and-extension.md §3,
 * §7 (067), §9; DECISIONS.md OVR-5.
 *
 * TYPING NOTE (OVR-5b split): the writer lands in a parallel worktree, so the
 * new optional request field is declared locally as an intersection of the
 * service's own input type and the fixed shared interface. Once the writer is
 * merged the local intersection is redundant (but remains type-correct).
 *
 * CLOCK NOTE (OVR-5a lesson): lifecycle business time is the DB reservation
 * instant, not the injected service clock. A `correctionDueAt` bound is
 * checked against `reserved_at`, which is sampled inside the request, so the
 * exact 1 h / 14 d boundaries are probed from a DB-time bracket: every probe
 * is derived from a DB sample taken immediately before the request and the
 * residual to the true boundary is asserted to be no more than the request's
 * own latency bound.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  JOB_CARD_LIFECYCLE_REQUEST_VERSION,
  hashRequestIdentity,
} from '../src/modules/job-cards/critical-action-request-hash.js';
import {
  PostgresOverdueBreachScannerRepository,
  createOverdueBreachScanner,
} from '../src/modules/job-cards/overdue-breach-scanner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The default the server materializes when `correctionDueAt` is omitted. */
const DEFAULT_CORRECTION_MS = 24 * HOUR_MS;
/** Max tolerated request latency between the DB bracket sample and reserved_at. */
const BRACKET_LATENCY_BUDGET_MS = 60_000;
/**
 * Probe offset around an exact bound. `reserved_at` is sampled inside the
 * request, so an exact-equality probe is unobservable from the client; the
 * probes bracket it by this margin and the residual is asserted to stay
 * inside the request's own latency budget.
 */
const BOUND_PROBE_MARGIN_MS = 5_000;

/** OVR-5b shared interface: `REQUEST_REVISION` gains one optional instant. */
type Ovr5bRevisionInput = Parameters<JobCardService['requestRevision']>[2] & {
  correctionDueAt?: string | null | number | boolean | Record<string, unknown>;
};

/** OVR-5b shared interface: the job detail gains the effective correction. */
type Ovr5bDetail = Awaited<ReturnType<JobCardService['detail']>> & {
  hasOpenOverdueIncident: boolean;
  correctionDueAt: string | null;
};

async function withSchema(run: (pool: Pool, schema: string) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `ovr5b_rev_${randomUUID().replaceAll('-', '')}`;
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
    await run(pool, schema);
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

function actors(organizationId: string, managerId: string, staffId: string) {
  return {
    manager: { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
    staff: { id: staffId, organizationId, role: 'STAFF' } as JobCardActor,
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
  service: JobCardService,
  staff: JobCardActor,
  input: { title: string; dueDate: string | null },
): Promise<JobCard> {
  return (await service.create(staff, {
    clientActionId: randomUUID(),
    type: 'GENERAL_TASK',
    title: input.title,
    description: null,
    customerId: null,
    contactId: null,
    assignedTo: staff.id,
    priority: 'normal',
    dueDate: input.dueDate,
    scheduledAt: null,
    scheduledEndsAt: undefined,
    engagementKind: undefined,
  } as never)) as unknown as JobCard;
}

async function startJob(service: JobCardService, staff: JobCardActor, job: JobCard): Promise<JobCard> {
  return (await service.start(staff, job.id, {
    clientActionId: randomUUID(), expectedVersion: job.version,
  })) as unknown as JobCard;
}

async function submitJob(service: JobCardService, staff: JobCardActor, job: JobCard): Promise<JobCard> {
  return (await service.submitForApproval(staff, job.id, {
    clientActionId: randomUUID(),
    expectedVersion: job.version,
    note: 'Tamamlandı, kontrole gönderildi.',
  })) as unknown as JobCard;
}

/** `REQUEST_REVISION` through the real writer (no SQL simulation). */
async function requestRevision(
  service: JobCardService,
  manager: JobCardActor,
  job: { id: string; version: number },
  correctionDueAt?: Ovr5bRevisionInput['correctionDueAt'],
): Promise<Ovr5bDetail> {
  const input: Ovr5bRevisionInput = {
    clientActionId: randomUUID(),
    expectedVersion: job.version,
    revisionReason: 'Düzeltme gerekli.',
    ...(correctionDueAt === undefined ? {} : { correctionDueAt }),
  };
  return (await service.requestRevision(manager, job.id, input)) as unknown as Ovr5bDetail;
}

/** A task whose original submission deadline is already past, in approval. */
async function pastDeadlineTaskInApproval(
  service: JobCardService,
  staff: JobCardActor,
  clock: { now: Date },
  title: string,
): Promise<JobCard> {
  let job = await createTask(service, staff, { title, dueDate: dateKeyShift(clock.now, -3) });
  job = await startJob(service, staff, job);
  return submitJob(service, staff, job);
}

/** A task whose original submission deadline is still ahead, in approval. */
async function futureDeadlineTaskInApproval(
  service: JobCardService,
  staff: JobCardActor,
  clock: { now: Date },
  title: string,
): Promise<JobCard> {
  let job = await createTask(service, staff, { title, dueDate: dateKeyShift(clock.now, 3) });
  job = await startJob(service, staff, job);
  return submitJob(service, staff, job);
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
  ended_at: Date | null;
  end_reason: string | null;
  end_note: string | null;
  ended_by_user_id: string | null;
  ended_by_schedule_revision_no: number | null;
};

async function selectIncidents(
  pool: Pool, organizationId: string, jobId: string,
): Promise<IncidentRow[]> {
  return (await pool.query(
    `SELECT id, delay_type, episode_no, schedule_revision_no,
            deadline_at, breached_at, source, recovered_at,
            ended_at, end_reason, end_note, ended_by_user_id,
            ended_by_schedule_revision_no
       FROM job_card_overdue_incidents
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY breached_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as IncidentRow[];
}

/** Rows still current: neither recovered by a lifecycle command nor ended. */
function openIncidents(rows: IncidentRow[]): IncidentRow[] {
  return rows.filter((row) => row.recovered_at === null && row.ended_at === null);
}

function episodeIncidents(
  rows: IncidentRow[], delayType: string, episodeNo: number,
): IncidentRow[] {
  return rows.filter(
    (row) => row.delay_type === delayType && row.episode_no === episodeNo,
  );
}

type ActivationRow = {
  episode_no: number;
  activated_at: Date;
  activated_by_command: string;
  correction_due_at: Date | null;
};
async function selectActivations(
  pool: Pool, organizationId: string, jobId: string,
): Promise<ActivationRow[]> {
  return (await pool.query(
    `SELECT episode_no, activated_at, activated_by_command, correction_due_at
       FROM job_card_submission_episode_activations
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY episode_no ASC`,
    [organizationId, jobId],
  )).rows as ActivationRow[];
}

async function countIntentRows(pool: Pool, organizationId: string, clientActionId: string): Promise<number> {
  return Number((await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM job_card_lifecycle_intents
      WHERE organization_id = $1 AND client_action_id = $2`,
    [organizationId, clientActionId],
  )).rows[0]!.count);
}

async function selectRevisionActivityCount(
  pool: Pool, organizationId: string, jobId: string,
): Promise<number> {
  return Number((await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM job_card_activity_logs
      WHERE organization_id = $1 AND job_card_id = $2
        AND event_type = 'JOB_REVISION_REQUESTED'`,
    [organizationId, jobId],
  )).rows[0]!.count);
}

async function selectLifecycleVersion(pool: Pool, organizationId: string, jobId: string) {
  return (await pool.query<{ status: string; version: number }>(
    `SELECT status, version FROM job_cards WHERE organization_id = $1 AND id = $2`,
    [organizationId, jobId],
  )).rows[0]!;
}

/** One job's stored activation + job row, for "nothing armed" assertions. */
async function armedState(pool: Pool, organizationId: string, jobId: string) {
  return {
    activations: await selectActivations(pool, organizationId, jobId),
    incidents: await selectIncidents(pool, organizationId, jobId),
    revisionActivities: await selectRevisionActivityCount(pool, organizationId, jobId),
    job: await selectLifecycleVersion(pool, organizationId, jobId),
  };
}

describe.skipIf(!databaseUrl)('OVR-5b revision correction deadline writers (PostgreSQL)', () => {
  // -------------------------------------------------------------------------
  // C1: default = reserved_at + 24h, and the scanner's first-late boundary.
  // -------------------------------------------------------------------------

  it('C1: a revision after the original deadline defaults to reserved_at + 24h', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5b C1');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      const job = await pastDeadlineTaskInApproval(service, staff, clock, 'Varsayılan düzeltme');
      await requestRevision(service, manager, job);

      const activations = await selectActivations(pool, organizationId, job.id);
      expect(activations).toHaveLength(1);
      const activation = activations[0]!;
      expect(activation.episode_no).toBe(2);
      expect(activation.activated_by_command).toBe('REQUEST_REVISION');
      // The default is materialized: never NULL for a new revision activation.
      expect(activation.correction_due_at).not.toBeNull();
      expect(activation.correction_due_at)
        .toEqual(shiftMs(activation.activated_at, DEFAULT_CORRECTION_MS));

      const correctionDueAt = activation.correction_due_at!;
      // At the correction instant the episode is still on time (equality).
      const atCorrection = await scanOnce(pool, correctionDueAt);
      expect(atCorrection.candidates).toBe(0);
      expect(atCorrection.inserted).toBe(0);
      expect(episodeIncidents(
        await selectIncidents(pool, organizationId, job.id), 'LATE_SUBMISSION', 2,
      )).toHaveLength(0);

      // One millisecond later the scanner records the single breach.
      const firstLate = shiftMs(correctionDueAt, 1);
      const atFirstLate = await scanOnce(pool, firstLate);
      expect(atFirstLate.candidates).toBe(1);
      expect(atFirstLate.inserted).toBe(1);
      const episodeTwo = episodeIncidents(
        await selectIncidents(pool, organizationId, job.id), 'LATE_SUBMISSION', 2,
      );
      expect(episodeTwo).toHaveLength(1);
      expect(episodeTwo[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 2,
        schedule_revision_no: 1,
        source: 'SCANNER',
        recovered_at: null,
        ended_at: null,
      });
      expect(episodeTwo[0]!.deadline_at).toEqual(firstLate);
      expect(episodeTwo[0]!.breached_at).toEqual(firstLate);
    });
  });

  // -------------------------------------------------------------------------
  // C2: max(original, correction) — an earlier correction never shortens.
  // -------------------------------------------------------------------------

  it('C2: a correction earlier than the original deadline leaves the original governing', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5b C2');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      const dueDate = dateKeyShift(clock.now, 3);
      const originalDeadline = utcBoundaryAfter(dueDate);
      const job = await futureDeadlineTaskInApproval(service, staff, clock, 'Özgün tarih işi');

      // 2h after a DB sample is safely inside the 1h lower bound and still
      // before the three-day-out original deadline.
      const supplied = shiftMs(await dbBaseline(pool), 2 * HOUR_MS);
      expect(supplied.getTime()).toBeLessThan(originalDeadline.getTime());
      await requestRevision(service, manager, job, supplied.toISOString());

      const activation = (await selectActivations(pool, organizationId, job.id))[0]!;
      expect(activation.activated_by_command).toBe('REQUEST_REVISION');
      expect(activation.correction_due_at).toEqual(supplied);

      // On time at the original deadline, late at +1ms: the original governs.
      const atOriginal = await scanOnce(pool, originalDeadline);
      expect(atOriginal.candidates).toBe(0);
      expect(atOriginal.inserted).toBe(0);

      const firstLate = shiftMs(originalDeadline, 1);
      const atFirstLate = await scanOnce(pool, firstLate);
      expect(atFirstLate.inserted).toBe(1);
      const episodeTwo = episodeIncidents(
        await selectIncidents(pool, organizationId, job.id), 'LATE_SUBMISSION', 2,
      );
      expect(episodeTwo).toHaveLength(1);
      expect(episodeTwo[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 2,
        source: 'SCANNER',
      });
      expect(episodeTwo[0]!.deadline_at).toEqual(firstLate);
      expect(episodeTwo[0]!.breached_at).toEqual(firstLate);
    });
  });

  // -------------------------------------------------------------------------
  // C3: the 1h..14d bound, checked against reserved_at.
  // -------------------------------------------------------------------------

  it('C3: correctionDueAt bounds — exactly 1h/14d accepted, outside rejected, nothing armed', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5b C3');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      const boundMessage = 'Düzeltme son tarihi en az 1 saat, en fazla 14 gün sonrası olmalı.';
      const outOfBounds = {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: { fieldErrors: { correctionDueAt: boundMessage } },
      } as const;

      // --- Below the lower bound: rejected, nothing armed. ---
      const lowJob = await futureDeadlineTaskInApproval(service, staff, clock, 'Alt sınır');
      const beforeLow = await dbBaseline(pool);
      const belowLowerId = randomUUID();
      await expect(service.requestRevision(manager, lowJob.id, {
        clientActionId: belowLowerId,
        expectedVersion: lowJob.version,
        revisionReason: 'Sınır altı.',
        correctionDueAt: shiftMs(beforeLow, HOUR_MS - 1_000).toISOString(),
      } as Ovr5bRevisionInput)).rejects.toMatchObject(outOfBounds);
      expect(await countIntentRows(pool, organizationId, belowLowerId)).toBe(0);
      const afterBelowLower = await armedState(pool, organizationId, lowJob.id);
      expect(afterBelowLower.activations).toHaveLength(0);
      expect(afterBelowLower.incidents).toHaveLength(0);
      expect(afterBelowLower.revisionActivities).toBe(0);
      expect(afterBelowLower.job).toMatchObject({ status: 'WAITING_APPROVAL', version: lowJob.version });

      // --- Exactly at the lower bound (within the request's own bracket). ---
      const beforeLower = await dbBaseline(pool);
      const atLower = shiftMs(beforeLower, HOUR_MS + BOUND_PROBE_MARGIN_MS);
      await requestRevision(service, manager, lowJob, atLower.toISOString());
      const lowerActivation = (await selectActivations(pool, organizationId, lowJob.id))[0]!;
      expect(lowerActivation.correction_due_at).toEqual(atLower);
      const lowerResidual = atLower.getTime()
        - (lowerActivation.activated_at.getTime() + HOUR_MS);
      expect(lowerResidual).toBeGreaterThanOrEqual(0);
      expect(lowerResidual).toBeLessThanOrEqual(BOUND_PROBE_MARGIN_MS);

      // --- Above the upper bound: rejected, nothing armed. ---
      const highJob = await futureDeadlineTaskInApproval(service, staff, clock, 'Üst sınır');
      const beforeHigh = await dbBaseline(pool);
      const aboveUpperId = randomUUID();
      await expect(service.requestRevision(manager, highJob.id, {
        clientActionId: aboveUpperId,
        expectedVersion: highJob.version,
        revisionReason: 'Sınır üstü.',
        correctionDueAt: shiftMs(beforeHigh, 14 * DAY_MS + 1_000).toISOString(),
      } as Ovr5bRevisionInput)).rejects.toMatchObject(outOfBounds);
      expect(await countIntentRows(pool, organizationId, aboveUpperId)).toBe(0);
      const afterAboveUpper = await armedState(pool, organizationId, highJob.id);
      expect(afterAboveUpper.activations).toHaveLength(0);
      expect(afterAboveUpper.incidents).toHaveLength(0);
      expect(afterAboveUpper.revisionActivities).toBe(0);
      expect(afterAboveUpper.job).toMatchObject({ status: 'WAITING_APPROVAL', version: highJob.version });

      // --- Exactly at the upper bound (within the request's own bracket). ---
      const beforeUpper = await dbBaseline(pool);
      const atUpper = shiftMs(beforeUpper, 14 * DAY_MS - BOUND_PROBE_MARGIN_MS);
      await requestRevision(service, manager, highJob, atUpper.toISOString());
      const upperActivation = (await selectActivations(pool, organizationId, highJob.id))[0]!;
      expect(upperActivation.correction_due_at).toEqual(atUpper);
      const upperResidual = (upperActivation.activated_at.getTime() + 14 * DAY_MS)
        - atUpper.getTime();
      expect(upperResidual).toBeGreaterThanOrEqual(BOUND_PROBE_MARGIN_MS);
      expect(upperResidual)
        .toBeLessThan(BOUND_PROBE_MARGIN_MS + BRACKET_LATENCY_BUDGET_MS);
    });
  });

  it('C3: correctionDueAt syntax is validated before the intent claim', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5b C3 syntax');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      const job = await futureDeadlineTaskInApproval(service, staff, clock, 'Sözdizimi işi');
      const syntaxError = {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: {
          fieldErrors: { correctionDueAt: 'Geçerli bir düzeltme son tarihi seçin.' },
        },
      } as const;
      for (const invalid of [null, 42, true, 'not-an-instant', {}] as const) {
        const clientActionId = randomUUID();
        await expect(service.requestRevision(manager, job.id, {
          clientActionId,
          expectedVersion: job.version,
          revisionReason: 'Geçersiz tarih.',
          correctionDueAt: invalid,
        } as Ovr5bRevisionInput)).rejects.toMatchObject(syntaxError);
        // Syntax runs before the intent claim and hashing: no claim row exists.
        expect(await countIntentRows(pool, organizationId, clientActionId)).toBe(0);
      }
      const state = await armedState(pool, organizationId, job.id);
      expect(state.activations).toHaveLength(0);
      expect(state.revisionActivities).toBe(0);
      expect(state.job).toMatchObject({ status: 'WAITING_APPROVAL', version: job.version });
    });
  });

  // -------------------------------------------------------------------------
  // C4: no original deadline (and C8: SALES_MEETING scheduledAt-only).
  // -------------------------------------------------------------------------

  it('C4: a job without any deadline stores no correction and never breaches', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5b C4');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      let job = await createTask(service, staff, { title: 'Tarihsiz iş', dueDate: null });
      job = await startJob(service, staff, job);
      job = await submitJob(service, staff, job);

      // A syntactically valid value far outside the 14d bound: the bound is
      // skipped when the job has no original deadline (§3.1/§3.4).
      const supplied = shiftMs(await dbBaseline(pool), 30 * DAY_MS).toISOString();
      await requestRevision(service, manager, job, supplied);

      const activation = (await selectActivations(pool, organizationId, job.id))[0]!;
      expect(activation.activated_by_command).toBe('REQUEST_REVISION');
      expect(activation.correction_due_at).toBeNull();

      const farFuture = shiftMs(await dbBaseline(pool), 60 * DAY_MS);
      const report = await scanOnce(pool, farFuture);
      expect(report.candidates).toBe(0);
      expect(report.inserted).toBe(0);
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);
    });
  });

  it('C8: SALES_MEETING with scheduledAt only stores no correction and never breaches', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5b C8');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      // Legacy START_ONLY visit row: scheduledAt only, no canonical end and no
      // dueDate. The general create path always derives the canonical end, so
      // this shape exists only as a legacy/demo row (§3.4).
      const scheduledAt = shiftMs(clock.now, -2 * HOUR_MS);
      const jobId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by,
            scheduled_at, scheduled_ends_at, due_date, accepted_at, accepted_by,
            staff_completed_at, staff_completed_by, engagement_kind, started_at)
         VALUES ($1, 'SALES_MEETING', 'WAITING_APPROVAL', 'Eski görüşme', $2, $2,
                 $3, NULL, NULL, $4, $2, $3, $2, 'SALES_MEETING', $3)
         RETURNING id`,
        [organizationId, staffId, scheduledAt, shiftMs(scheduledAt, -HOUR_MS)],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO job_card_schedule_revisions
           (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
            organization_timezone, source, created_at)
         VALUES ($1, $2, 1, $3, NULL, 'UTC', 'BASELINE', $4)`,
        [organizationId, jobId, scheduledAt, shiftMs(scheduledAt, -HOUR_MS)],
      );

      const supplied = shiftMs(await dbBaseline(pool), 2 * HOUR_MS).toISOString();
      await service.requestRevision(manager, jobId, {
        clientActionId: randomUUID(),
        expectedVersion: 1,
        revisionReason: 'Görüşme düzeltmesi.',
        correctionDueAt: supplied,
      } as Ovr5bRevisionInput);

      const activation = (await selectActivations(pool, organizationId, jobId))[0]!;
      expect(activation.episode_no).toBe(1);
      expect(activation.activated_by_command).toBe('REQUEST_REVISION');
      expect(activation.correction_due_at).toBeNull();

      const report = await scanOnce(pool, shiftMs(await dbBaseline(pool), 30 * DAY_MS));
      expect(report.candidates).toBe(0);
      expect(report.inserted).toBe(0);
      expect(await selectIncidents(pool, organizationId, jobId)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // C5: WITHDRAW_FROM_APPROVAL keeps today's immediate breach.
  // -------------------------------------------------------------------------

  it('C5: WITHDRAW_FROM_APPROVAL after the deadline stores no correction and breaches immediately', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5b C5');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      const job = await pastDeadlineTaskInApproval(service, staff, clock, 'Geri çekilen iş');
      const withdrawn = await service.withdrawFromApproval(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(withdrawn.status).toBe('IN_PROGRESS');

      const activations = await selectActivations(pool, organizationId, job.id);
      expect(activations).toHaveLength(1);
      expect(activations[0]).toMatchObject({
        episode_no: 2,
        activated_by_command: 'WITHDRAW_FROM_APPROVAL',
        correction_due_at: null,
      });

      // The episode reuses the original (past) deadline. WITHDRAW creates the
      // Staff obligation and does not satisfy it, so the newly armed episode is
      // locked OPEN in the same transition: today's immediate breach.
      const episodes = episodeIncidents(
        await selectIncidents(pool, organizationId, job.id), 'LATE_SUBMISSION', 2,
      );
      expect(episodes).toHaveLength(1);
      expect(episodes[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 2,
        source: 'TRANSITION',
        ended_at: null,
        recovered_at: null,
      });
      const originalDeadline = utcBoundaryAfter(dateKeyShift(clock.now, -3));
      expect(episodes[0]!.deadline_at).toEqual(shiftMs(originalDeadline, 1));
      expect(episodes[0]!.breached_at).toEqual(activations[0]!.activated_at);

      // A later scan does not invent a second row for the same obligation.
      await scanOnce(pool, await dbBaseline(pool));
      expect(episodeIncidents(
        await selectIncidents(pool, organizationId, job.id), 'LATE_SUBMISSION', 2,
      )).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // C6: request identity — absent field hashes as before, drift conflicts.
  // -------------------------------------------------------------------------

  it('C6: a receipt recorded without correctionDueAt replays, a different value conflicts', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5b C6');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      const job = await futureDeadlineTaskInApproval(service, staff, clock, 'Tekrar işi');
      const clientActionId = randomUUID();
      const revisionReason = 'Aynı niyet.';
      const first = await service.requestRevision(manager, job.id, {
        clientActionId,
        expectedVersion: job.version,
        revisionReason,
      } as Ovr5bRevisionInput);
      const afterFirst = await selectActivations(pool, organizationId, job.id);
      expect(afterFirst).toHaveLength(1);

      // §3.8: an absent correctionDueAt must hash byte-identically to the
      // pre-5b identity, so receipts recorded before this release replay.
      const storedHash = (await pool.query<{ request_hash: string }>(
        `SELECT request_hash FROM processed_actions
          WHERE organization_id = $1 AND user_id = $2
            AND client_action_id = $3 AND operation_key = $4`,
        [organizationId, managerId, clientActionId, `JOB_REQUEST_REVISION:${job.id}`],
      )).rows[0]!.request_hash;
      // Pre-5b identity payload, reproduced literally: no correction key.
      const pre5bHash = hashRequestIdentity({
        operation: JOB_CARD_LIFECYCLE_REQUEST_VERSION,
        jobCardId: job.id,
        command: 'REQUEST_REVISION',
        expectedVersion: job.version,
        note: null,
        revisionReason,
        cancelReason: null,
        followUpProposal: null,
        approveFollowUp: null,
        location: null,
      });
      expect(storedHash).toBe(pre5bHash);

      // Same key, same absent field: replay, no second activation.
      const replay = await service.requestRevision(manager, job.id, {
        clientActionId,
        expectedVersion: job.version,
        revisionReason,
      } as Ovr5bRevisionInput) as unknown as Ovr5bDetail;
      expect(replay.id).toBe(job.id);
      expect(replay.version).toBe((first as unknown as Ovr5bDetail).version);
      expect(await selectActivations(pool, organizationId, job.id)).toHaveLength(1);

      // Same key with a correction value: a different semantic request.
      await expect(service.requestRevision(manager, job.id, {
        clientActionId,
        expectedVersion: job.version,
        revisionReason,
        correctionDueAt: shiftMs(await dbBaseline(pool), 3 * HOUR_MS).toISOString(),
      } as Ovr5bRevisionInput)).rejects.toMatchObject({
        code: 'CLIENT_ACTION_REUSED', statusCode: 409,
      });
      expect(await selectActivations(pool, organizationId, job.id)).toHaveLength(1);

      // And the same drift is refused from a completed value-carrying receipt.
      const valueJob = await futureDeadlineTaskInApproval(service, staff, clock, 'Değerli iş');
      const valueKey = randomUUID();
      const value = shiftMs(await dbBaseline(pool), 4 * HOUR_MS).toISOString();
      const withValue = await service.requestRevision(manager, valueJob.id, {
        clientActionId: valueKey,
        expectedVersion: valueJob.version,
        revisionReason,
        correctionDueAt: value,
      } as Ovr5bRevisionInput) as unknown as Ovr5bDetail;
      const replayWithValue = await service.requestRevision(manager, valueJob.id, {
        clientActionId: valueKey,
        expectedVersion: valueJob.version,
        revisionReason,
        correctionDueAt: value,
      } as Ovr5bRevisionInput) as unknown as Ovr5bDetail;
      expect(replayWithValue.version).toBe(withValue.version);
      expect(await selectActivations(pool, organizationId, valueJob.id)).toHaveLength(1);
      await expect(service.requestRevision(manager, valueJob.id, {
        clientActionId: valueKey,
        expectedVersion: valueJob.version,
        revisionReason,
        correctionDueAt: shiftMs(new Date(value), 1_000).toISOString(),
      } as Ovr5bRevisionInput)).rejects.toMatchObject({
        code: 'CLIENT_ACTION_REUSED', statusCode: 409,
      });
      expect(await selectActivations(pool, organizationId, valueJob.id)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // DB: migration 067 drops the superseded 053 delivery identity.
  // -------------------------------------------------------------------------

  it('DB-067: migration 067 is the head and only the per-incident delivery key remains', async () => {
    await withSchema(async (pool) => {
      const catalog = await loadMigrationCatalog(MIGRATIONS_DIRECTORY);
      expect(catalog.head?.version).toBe('069_lateness_alerts_and_quiet_hours');
      const applied = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(applied.rows.at(-1)?.version)
        .toBe('069_lateness_alerts_and_quiet_hours');

      const uniques = await pool.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'job_card_overdue_notification_deliveries'::regclass
            AND contype = 'u'`,
      );
      // The 053 per-episode key is gone; the per-incident key remains.
      expect(uniques.rows.filter((row) => row.definition.includes('episode_no')))
        .toHaveLength(0);
      const incidentKey = uniques.rows.find(
        (row) => row.conname === 'job_card_overdue_notification_deliveries_incident_kind_key',
      );
      expect(incidentKey).toBeDefined();
      expect(incidentKey!.definition).toContain('incident_id');
      expect(incidentKey!.definition).toContain('kind');

      // Two incidents of one episode can each receive a delivery of a kind.
      const organizationId = await insertOrg(pool, 'OVR5b 067');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const jobId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by,
            accepted_at, accepted_by, started_at)
         VALUES ($1, 'GENERAL_TASK', 'IN_PROGRESS', '067 fixture', $2, $2, $3, $2, $3)
         RETURNING id`,
        [organizationId, staffId, new Date('2026-08-03T06:00:00.000Z')],
      )).rows[0]!.id;
      for (const revisionNo of [1, 2]) {
        await pool.query(
          `INSERT INTO job_card_schedule_revisions
             (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
              organization_timezone, source, created_by, created_at)
           VALUES ($1, $2, $3, NULL, NULL, 'Europe/Istanbul', $4, $5, $6)`,
          [organizationId, jobId, revisionNo, revisionNo === 1 ? 'CREATE' : 'RESCHEDULE',
            staffId, new Date('2026-08-03T05:00:00.000Z')],
        );
      }
      const incidents = await Promise.all([1, 2].map((revisionNo) => pool.query<{ id: string }>(
        `INSERT INTO job_card_overdue_incidents
           (organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
            deadline_at, breached_at, accountable_role, accountable_source, source)
         VALUES ($1, $2, 'LATE_SUBMISSION', 1, $3, $4, $4, 'STAFF', 'UNKNOWN', 'SCANNER')
         RETURNING id`,
        [organizationId, jobId, revisionNo, new Date('2026-08-03T07:00:00.000Z')],
      )));
      const insertDelivery = (incidentId: string) => pool.query(
        `INSERT INTO job_card_overdue_notification_deliveries
           (organization_id, job_card_id, delay_type, episode_no, kind, incident_id, sent_at)
         VALUES ($1, $2, 'LATE_SUBMISSION', 1, 'STAFF_REMINDER', $3, $4)`,
        [organizationId, jobId, incidentId, new Date('2026-08-03T07:15:00.000Z')],
      );
      await insertDelivery(incidents[0]!.rows[0]!.id);
      await insertDelivery(incidents[1]!.rows[0]!.id);
      const delivered = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_overdue_notification_deliveries
          WHERE organization_id = $1 AND job_card_id = $2`,
        [organizationId, jobId],
      );
      expect(delivered.rows[0]!.count).toBe('2');
    });
  });
});
