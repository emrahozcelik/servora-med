import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

// Monday 2026-08-03 (working day, Europe/Istanbul = UTC+3).
const CREATE_AT = new Date('2026-08-03T06:00:00.000Z');
const LATE_AT = new Date('2026-08-03T08:00:00.000Z');
const DELIVERY_START = '2026-08-03T07:00:00.000Z'; // 10:00 +03, canonical end 07:30Z.

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `ovr2_${randomUUID().replaceAll('-', '')}`;
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
     VALUES ($1, 'OVR2 Klinik', 'clinic', 'active') RETURNING id`,
    [organizationId],
  )).rows[0]!.id;
}

function buildService(pool: Pool, clock: { now: Date }): JobCardService {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    publisher,
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
}

function actors(organizationId: string, managerId: string, staffAId: string, staffBId: string) {
  return {
    manager: { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
    staffA: { id: staffAId, organizationId, role: 'STAFF' } as JobCardActor,
    staffB: { id: staffBId, organizationId, role: 'STAFF' } as JobCardActor,
  };
}

async function createLateDelivery(
  service: JobCardService,
  staff: JobCardActor,
  customerId: string,
): Promise<JobCard> {
  return (await service.create(staff, {
    clientActionId: randomUUID(),
    type: 'PRODUCT_DELIVERY',
    title: 'Geç başlanan teslim',
    description: null,
    customerId,
    contactId: null,
    assignedTo: staff.id,
    priority: 'normal',
    dueDate: null,
    scheduledAt: DELIVERY_START,
    scheduledEndsAt: undefined,
    engagementKind: undefined,
  } as never)) as JobCard;
}

async function selectIncidents(pool: Pool, organizationId: string, jobId: string) {
  return (await pool.query(
    `SELECT id, delay_type, episode_no, schedule_revision_no,
            deadline_at, breached_at,
            accountable_user_id, accountable_role, accountable_source,
            source, recorded_at, recovered_at, recovery_actor_user_id,
            ended_at, ended_by_user_id, end_reason, end_note,
            ended_by_schedule_revision_no
       FROM job_card_overdue_incidents
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY breached_at DESC, id DESC`,
    [organizationId, jobId],
  )).rows as Record<string, unknown>[];
}

// 049: lifecycle business time is the DB-sampled reservation instant, so
// fixtures derive from the millisecond-normalized DB arbitration clock and
// exact lifecycle instants are read back from the intent row (never from
// the injected service clock, which only drives create/patch paths).
async function dbBaseline(pool: Pool): Promise<Date> {
  return (await pool.query<{ now: Date }>(
    "SELECT date_trunc('milliseconds', clock_timestamp()) AS now",
  )).rows[0]!.now;
}

function shiftMs(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

/**
 * The organization-local (Europe/Istanbul) calendar date of an instant. The
 * tests derive a due date's local end as `${date}T21:00:00.000Z`, which is only
 * true for the Istanbul date; the UTC date differs between 21:00 and 24:00 UTC.
 */
function istanbulDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

// Mixed lifecycle/patch flows: patch/create paths run on the injected
// clock while lifecycle paths run on the DB reservation clock. Refresh the
// injected clock after lifecycle commands so a patch requestTime never
// predates lifecycle-produced instants (which would push derived breach
// instants past requestTime and correctly suppress materialization).
async function syncClock(pool: Pool, clock: { now: Date }): Promise<Date> {
  clock.now = await dbBaseline(pool);
  return clock.now;
}

async function reservedAtFor(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
  operationKey: string,
  clientActionId?: string,
): Promise<Date> {
  const row = (await pool.query<{ reserved_at: Date }>(
    `SELECT reserved_at FROM job_card_lifecycle_intents
      WHERE organization_id = $1 AND job_card_id = $2 AND operation_key = $3
        AND ($4::text IS NULL OR client_action_id = $4)
      ORDER BY reserved_at DESC, id DESC
      LIMIT 1`,
    [organizationId, jobCardId, operationKey, clientActionId ?? null],
  )).rows[0];
  if (!row) throw new Error(`missing lifecycle intent for ${operationKey}`);
  return row.reserved_at;
}

// 24h-breach fixtures: 049 cannot time-travel the DB reservation clock, so
// a day-old waiting approval is modeled by rewinding the SUBMITTED fact, the
// mutable staff-completed stamp, and the governing revision activation
// together (test-local past, coherent: revision <= submission < deadline).
async function rewindSubmissionTo(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
  occurredAt: Date,
): Promise<void> {
  await pool.query(
    `UPDATE job_card_accountability_facts
        SET occurred_at = $3
      WHERE organization_id = $1 AND job_card_id = $2 AND fact_type = 'SUBMITTED'`,
    [organizationId, jobCardId, occurredAt],
  );
  await pool.query(
    `UPDATE job_cards SET staff_completed_at = $3
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, jobCardId, occurredAt],
  );
  await pool.query(
    `UPDATE job_card_schedule_revisions SET created_at = $3
      WHERE organization_id = $1 AND job_card_id = $2 AND revision_no = 1`,
    [organizationId, jobCardId, occurredAt],
  );
}

describe.skipIf(!databaseUrl)('OVR-2 overdue accountability incidents', () => {
  it('migration 067 is the schema head with 050 present', async () => {
    await withSchema(async (pool) => {
      const catalog = await loadMigrationCatalog(MIGRATIONS_DIRECTORY);
      expect(catalog.head?.version).toBe('069_lateness_alerts_and_quiet_hours');
      // The 049 lifecycle-intent prerequisite stays applied beneath OVR-3.
      expect(catalog.entries.map((entry) => entry.version))
        .toContain('049_job_card_lifecycle_intents');
      const applied = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(applied.rows.map((row) => row.version).at(-1))
        .toBe('069_lateness_alerts_and_quiet_hours');
    });
  });

  it('late START materializes a recovered LATE_START incident', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      await insertUser(pool, organizationId, 'STAFF', 'Mehmet Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      void manager;
      // 049: business time is the DB reservation instant. The delivery
      // window sits fully in the past so the START reservation lands late;
      // create-time instants stay on the injected baseline.
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);
      // The human create path no longer rejects the organization-local Sunday,
      // so the elapsed delivery slot needs no working-day steering.
      const scheduledAt = shiftMs(baseline, -60 * 60_000);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'PRODUCT_DELIVERY',
        title: 'Geç başlanan teslim',
        description: null,
        customerId,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: scheduledAt.toISOString(),
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      const startActionId = randomUUID();
      job = await service.start(staffA, job.id, {
        clientActionId: startActionId, expectedVersion: job.version,
      });
      expect(job.status).toBe('IN_PROGRESS');

      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 1,
        accountable_user_id: staffAId,
        accountable_role: 'STAFF',
        accountable_source: 'ASSIGNMENT_AT_BREACH',
      });
      // PD canonical end is +30m; breach = max(deadline, acceptance,
      // revision activation) = the create-time baseline (all in the past).
      expect(incidents[0]!.deadline_at).toEqual(shiftMs(scheduledAt, 30 * 60_000));
      expect(incidents[0]!.breached_at).toEqual(baseline);
      // Recovery runs in the START transaction at its reservation instant.
      const reservedStart = await reservedAtFor(pool, organizationId, job.id, `JOB_START:${job.id}`);
      expect(incidents[0]!.recovered_at).toEqual(reservedStart);
      expect(incidents[0]!.recovery_actor_user_id).toBe(staffAId);
    });
  });

  it('late SUBMIT materializes a recovered LATE_SUBMISSION incident', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { staffA } = actors(organizationId, managerId, staffAId, staffAId);
      // Created days ago so assignment history proves the assignee at the
      // breach instant; the due date (Istanbul local end) is long past, so
      // the SUBMIT reservation lands late.
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);
      const dueDate = istanbulDate(shiftMs(baseline, -3 * 24 * 60 * 60_000));

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Geç teslim edilen görev',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      const startActionId = randomUUID();
      job = await service.start(staffA, job.id, {
        clientActionId: startActionId, expectedVersion: job.version,
      });
      const submitActionId = randomUUID();
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: submitActionId, expectedVersion: job.version,
        note: 'Geç de olsa tamamlandı.',
      });
      expect(job.status).toBe('WAITING_APPROVAL');

      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        accountable_user_id: staffAId,
        accountable_role: 'STAFF',
      });
      // Istanbul local end of the due date is 21:00Z; the effective deadline
      // is that instant and the first late instant is one millisecond later
      // (domain clock is millisecond-quantized end-to-end).
      const dueEnd = new Date(`${dueDate}T21:00:00.000Z`);
      expect((incidents[0]!.deadline_at as Date).getTime())
        .toBeGreaterThan(dueEnd.getTime());
      // Breach = max(first late, episode start = START reservation).
      const reservedStart = await reservedAtFor(pool, organizationId, job.id, `JOB_START:${job.id}`);
      expect(incidents[0]!.breached_at).toEqual(reservedStart);
      const reservedSubmit = await reservedAtFor(
        pool, organizationId, job.id, `JOB_SUBMIT_FOR_APPROVAL:${job.id}`,
      );
      expect(incidents[0]!.recovered_at).toEqual(reservedSubmit);
    });
  });

  it('approval after the 24h threshold materializes APPROVAL_WAIT for MANAGEMENT', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Onayı geciken görev',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Onaya gönderildi.',
      });
      // Model a day-old waiting approval: the submission happened 25h ago.
      const submittedAt = shiftMs(baseline, -25 * 60 * 60_000);
      await rewindSubmissionTo(pool, organizationId, job.id, submittedAt);
      const approveActionId = randomUUID();
      job = await service.approve(manager, job.id, {
        clientActionId: approveActionId, expectedVersion: job.version,
      });
      expect(job.status).toBe('COMPLETED');

      const incidents = await selectIncidents(pool, organizationId, job.id);
      const waits = incidents.filter((row) => row.delay_type === 'APPROVAL_WAIT');
      expect(waits).toHaveLength(1);
      expect(waits[0]).toMatchObject({
        episode_no: 1,
        accountable_user_id: null,
        accountable_role: 'MANAGEMENT',
      });
      // Deadline = submission + 24h; breach collapses to it here.
      expect(waits[0]!.deadline_at).toEqual(shiftMs(submittedAt, 24 * 60 * 60_000));
      expect(waits[0]!.breached_at).toEqual(shiftMs(submittedAt, 24 * 60 * 60_000));
      const reservedApprove = await reservedAtFor(pool, organizationId, job.id, `JOB_APPROVE:${job.id}`);
      expect(waits[0]!.recovered_at).toEqual(reservedApprove);
      expect(waits[0]!.recovery_actor_user_id).toBe(managerId);
    });
  });

  it('deadline revision after breach preserves the old-revision evidence and ends the obligation', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      clock.now = LATE_AT;
      // Deadline (07:30Z) already passed; management extends it to 09:30Z
      // with the reason the extension rule requires.
      job = await service.patch(manager, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T09:00:00.000Z',
        deadlineExtensionReason: 'Müşteri teslimi iki saat erteledi.',
      } as never);

      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      // OVR-5b §4.6: the evidence is never erased or rewritten; the obligation
      // is ended separately, with the actor, instant, reason and revision.
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 1,
        accountable_user_id: staffAId,
        recovered_at: null,
        ended_at: LATE_AT,
        ended_by_user_id: managerId,
        end_reason: 'DEADLINE_EXTENDED',
        end_note: 'Müşteri teslimi iki saat erteledi.',
        ended_by_schedule_revision_no: 2,
      });
      expect(incidents[0]!.deadline_at).toEqual(new Date('2026-08-03T07:30:00.000Z'));
      const activity = await pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM job_card_activity_logs
          WHERE organization_id = $1 AND job_card_id = $2
            AND event_type = 'JOB_OVERDUE_ENDED_BY_EXTENSION'`,
        [organizationId, job.id],
      );
      expect(activity.rows).toHaveLength(1);
      expect(activity.rows[0]!.metadata).toMatchObject({
        delayTypes: ['LATE_START'],
        reason: 'Müşteri teslimi iki saat erteledi.',
        scheduleRevisionNo: 2,
      });
    });
  });

  it('START recovers every open LATE_START revision incident for the episode', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Recovery', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Recovery Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Recovery Ayşe');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      // Pre-breach revisions: Staff deadline edits stay legal while nothing is
      // late yet (OVR-5b §5 only blocks edits on a job with open lateness).
      clock.now = new Date('2026-08-03T06:10:00.000Z');
      job = await service.patch(staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T06:30:00.000Z',
      } as never);
      clock.now = new Date('2026-08-03T06:20:00.000Z');
      job = await service.patch(staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T06:40:00.000Z',
      } as never);
      // Three revision-bound open LATE_START rows of episode 1. The writer
      // under test is START's episode-wide recovery, not the patch producers.
      for (const [revisionNo, deadlineAt] of [
        [1, '2026-08-03T07:30:00.000Z'],
        [2, '2026-08-03T07:00:00.000Z'],
        [3, '2026-08-03T07:10:00.000Z'],
      ] as const) {
        await pool.query(
          `INSERT INTO job_card_overdue_incidents
             (organization_id, job_card_id, delay_type, episode_no,
              schedule_revision_no, deadline_at, breached_at,
              accountable_user_id, accountable_role, accountable_source, source)
           VALUES ($1, $2, 'LATE_START', 1, $3, $4, $5, $6,
                   'STAFF', 'ASSIGNMENT_AT_BREACH', 'MUTATION')`,
          [organizationId, job.id, revisionNo, deadlineAt, deadlineAt, staffAId],
        );
      }

      const open = await selectIncidents(pool, organizationId, job.id);
      expect(open).toHaveLength(3);
      expect(open.every((row) => row.recovered_at === null)).toBe(true);

      clock.now = new Date('2026-08-03T11:00:00.000Z');
      const startActionId = randomUUID();
      job = await service.start(staffA, job.id, {
        clientActionId: startActionId, expectedVersion: job.version,
      });
      expect(job.status).toBe('IN_PROGRESS');
      const recovered = await selectIncidents(pool, organizationId, job.id);
      expect(recovered).toHaveLength(3);
      // Recovery runs in the START transaction at its reservation instant.
      const reservedStart = await reservedAtFor(pool, organizationId, job.id, `JOB_START:${job.id}`);
      expect(recovered.every((row) => (row.recovered_at as Date)?.getTime() === reservedStart.getTime())).toBe(true);
      expect(recovered.every((row) => row.recovery_actor_user_id === staffAId)).toBe(true);
      void manager;
    });
  });

  it('reassignment after breach keeps the old assignee accountable', async () => {    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA, staffB } = actors(organizationId, managerId, staffAId, staffBId);
      void staffB;
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      clock.now = LATE_AT;
      job = await service.patch(manager, job.id, {
        expectedVersion: job.version,
        assignedTo: staffBId,
      } as never);

      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        accountable_user_id: staffAId,
        accountable_source: 'ASSIGNMENT_AT_BREACH',
      });
      expect(incidents[0]!.recovered_at).toBeNull();

      // Mehmet accepts and STARTs the late work: same incident recovered by Mehmet.
      clock.now = new Date('2026-08-03T09:00:00.000Z');
      const accepted = await service.acceptAssignment(staffB, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      const startActionId = randomUUID();
      const started = await service.start(staffB, job.id, {
        clientActionId: startActionId, expectedVersion: accepted.version,
      });
      expect(started.status).toBe('IN_PROGRESS');
      const after = await selectIncidents(pool, organizationId, job.id);
      expect(after).toHaveLength(1);
      const reservedStart = await reservedAtFor(pool, organizationId, job.id, `JOB_START:${job.id}`);
      expect(after[0]).toMatchObject({
        accountable_user_id: staffAId,
        recovered_at: reservedStart,
        recovery_actor_user_id: staffBId,
      });
    });
  });

  it('history read is management-only with 404 concealment', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const otherOrgId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Other', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const foreignManagerId = await insertUser(pool, otherOrgId, 'MANAGER', 'Foreign Manager');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const foreignManager: JobCardActor = {
        id: foreignManagerId, organizationId: otherOrgId, role: 'MANAGER',
      };
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      const job = await createLateDelivery(service, staffA, await insertCustomer(pool, organizationId));

      await expect(service.listOverdueIncidents(staffA, job.id, { limit: 25, offset: 0 }))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(service.listOverdueIncidents(foreignManager, job.id, { limit: 25, offset: 0 }))
        .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      await expect(service.listOverdueIncidents(
        manager, '22222222-2222-4222-8222-222222222222', { limit: 25, offset: 0 },
      )).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });

      const page = await service.listOverdueIncidents(manager, job.id, { limit: 25, offset: 0 });
      expect(page).toMatchObject({ items: [], total: 0, limit: 25, offset: 0 });
    });
  });

  it('history page returns incident DTOs in breached_at DESC order', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      clock.now = LATE_AT;
      const startActionId = randomUUID();
      job = await service.start(staffA, job.id, {
        clientActionId: startActionId, expectedVersion: job.version,
      });

      const page = await service.listOverdueIncidents(manager, job.id, { limit: 1, offset: 0 });
      expect(page.total).toBe(1);
      expect(page.limit).toBe(1);
      expect(page.offset).toBe(0);
      const reservedStart = await reservedAtFor(pool, organizationId, job.id, `JOB_START:${job.id}`);
      expect(page.items[0]).toEqual({
        id: expect.any(String),
        delayType: 'LATE_START',
        episodeNo: 1,
        scheduleRevisionNo: 1,
        deadlineAt: '2026-08-03T07:30:00.000Z',
        breachedAt: '2026-08-03T07:30:00.000Z',
        accountableRole: 'STAFF',
        accountableSource: 'ASSIGNMENT_AT_BREACH',
        accountableUser: { id: staffAId, name: 'Ayşe Personel' },
        source: 'TRANSITION',
        recordedAt: expect.any(String),
        recoveredAt: reservedStart.toISOString(),
        recoveryActor: { id: staffAId, name: 'Ayşe Personel' },
        // OVR-5 ending appendix: a recovered incident was never ended.
        endedAt: null,
        endedBy: null,
        endReason: null,
        endNote: null,
        endedByScheduleRevisionNo: null,
        endedDurationSeconds: null,
        // OVR-4 measurement appendix: recovered with no manual reminder.
        totalDelaySeconds: Math.floor(
          (reservedStart.getTime() - new Date('2026-08-03T07:30:00.000Z').getTime()) / 1000,
        ),
        manualReminderSentAt: null,
        manualReminderCount: 0,
        postReminderDelaySeconds: null,
      });
      const empty = await service.listOverdueIncidents(manager, job.id, { limit: 1, offset: 1 });
      expect(empty).toMatchObject({ items: [], total: 1, limit: 1, offset: 1 });
    });
  });

  it('D2-4 proves multi-row history order by breached_at DESC, id DESC including ties', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Ordering', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Ordering Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ordering Ayşe');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      // Pre-breach revisions (nothing is late yet, so Staff edits are legal).
      clock.now = new Date('2026-08-03T06:10:00.000Z');
      job = await service.patch(staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T06:30:00.000Z',
      } as never);
      clock.now = new Date('2026-08-03T06:20:00.000Z');
      job = await service.patch(staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T06:40:00.000Z',
      } as never);
      // Three revision-bound rows, the last two sharing one breach instant so
      // the reader's breached_at DESC, id DESC tie-break is exercised.
      for (const [revisionNo, deadlineAt, breachedAt] of [
        [1, '2026-08-03T07:30:00.000Z', '2026-08-03T09:00:00.000Z'],
        [2, '2026-08-03T07:00:00.000Z', '2026-08-03T10:00:00.000Z'],
        [3, '2026-08-03T07:10:00.000Z', '2026-08-03T10:00:00.000Z'],
      ] as const) {
        await pool.query(
          `INSERT INTO job_card_overdue_incidents
             (organization_id, job_card_id, delay_type, episode_no,
              schedule_revision_no, deadline_at, breached_at,
              accountable_user_id, accountable_role, accountable_source, source)
           VALUES ($1, $2, 'LATE_START', 1, $3, $4, $5, $6,
                   'STAFF', 'ASSIGNMENT_AT_BREACH', 'MUTATION')`,
          [organizationId, job.id, revisionNo, deadlineAt, breachedAt, staffAId],
        );
      }

      const expected = await pool.query<{ id: string; breached_at: Date }>(
        `SELECT id, breached_at
           FROM job_card_overdue_incidents
          WHERE organization_id = $1 AND job_card_id = $2
          ORDER BY breached_at DESC, id DESC`,
        [organizationId, job.id],
      );
      expect(expected.rows.length).toBeGreaterThanOrEqual(3);
      const page = await service.listOverdueIncidents(manager, job.id, {
        limit: 25, offset: 0,
      });
      expect(page.total).toBe(expected.rows.length);
      expect(page.items.map((item) => item.id)).toEqual(expected.rows.map((row) => row.id));
      expect(page.items.map((item) => item.breachedAt)).toEqual(
        expected.rows.map((row) => row.breached_at.toISOString()),
      );
      const tied = expected.rows.filter((row) => row.breached_at.getTime() === Date.parse('2026-08-03T10:00:00.000Z'));
      expect(tied.length).toBeGreaterThanOrEqual(2);
      expect(tied.map((row) => row.id)).toEqual([...tied].sort((a, b) => b.id.localeCompare(a.id)).map((row) => row.id));
    });
  });

  it('on-time START and end-less jobs create no incident', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);

      // Started after the planned start but before the end: on time, no incident.
      // (START requires scheduledAt <= reservation, so the window straddles now
      // with a generous margin: PD canonical end is start + 30m.) On-time
      // semantics need the real reservation instant to fall INSIDE the slot;
      // the human create path imposes no working-day constraint, so the
      // canonical 30m straddle envelope is always usable.
      const scheduledAt = shiftMs(baseline, -10 * 60_000);
      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'PRODUCT_DELIVERY',
        title: 'Zamanında başlanan teslim',
        description: null,
        customerId,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: scheduledAt.toISOString(),
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(job.status).toBe('IN_PROGRESS');
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);

      // GENERAL_TASK has no interval end: never attributable as LATE_START.
      const task = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Araliksiz gorev',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      await service.start(staffA, task.id, {
        clientActionId: randomUUID(), expectedVersion: task.version,
      });
      expect(await selectIncidents(pool, organizationId, task.id)).toHaveLength(0);
    });
  });

  // Exact deadline equality is proven by the pure boundary tests
  // (overdue-incidents.test.ts §21): the service reservation clock cannot
  // land exactly on a deadline, so the PG path uses a clear margin.
  it('SUBMIT before the effective deadline stays on time', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Erken teslim',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: istanbulDate(shiftMs(baseline, 3 * 24 * 60 * 60_000)),
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      // Days before the Istanbul local end of the due date.
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Tam zamanında.',
      });
      expect(job.status).toBe('WAITING_APPROVAL');
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);
    });
  });

  it('replay and resubmission keep one incident per episode', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Tekrar gonderilen gorev',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: '2026-08-01',
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      clock.now = new Date('2026-08-04T09:00:00.000Z');
      const submitId = randomUUID();
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: submitId, expectedVersion: job.version,
        note: 'Ilk gonderim.',
      });
      // Exact replay of the same logical command: no second incident.
      const replayed = await service.submitForApproval(staffA, job.id, {
        clientActionId: submitId, expectedVersion: job.version - 1,
        note: 'Ilk gonderim.',
      });
      expect(replayed.status).toBe('WAITING_APPROVAL');
      let incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);

      // Genuine second cycle: revision -> resume -> submit again.
      job = await service.requestRevision(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        revisionReason: 'Detay ekleyin.',
      });
      job = await service.resume(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ikinci gonderim.',
      });
      // OVR-5b §3: the revision episode is armed with a correction deadline
      // (reserved_at + 24h), so the same-instant resubmission is no longer
      // late against the original deadline and produces no second incident.
      incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
      });
      const activation = await pool.query<{ activated_at: Date; correction_due_at: Date }>(
        `SELECT activated_at, correction_due_at
           FROM job_card_submission_episode_activations
          WHERE organization_id = $1 AND job_card_id = $2 AND episode_no = 2`,
        [organizationId, job.id],
      );
      expect(activation.rows).toHaveLength(1);
      expect(activation.rows[0]!.correction_due_at)
        .toEqual(shiftMs(activation.rows[0]!.activated_at, 24 * 3_600_000));
      const revisionActivity = await pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM job_card_activity_logs
          WHERE organization_id = $1 AND job_card_id = $2
            AND event_type = 'JOB_REVISION_REQUESTED'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [organizationId, job.id],
      );
      expect(revisionActivity.rows[0]!.metadata).toMatchObject({
        correctionDueAt: activation.rows[0]!.correction_due_at.toISOString(),
      });
      const facts = await pool.query<{ seq_no: number }>(
        `SELECT seq_no FROM job_card_accountability_facts
          WHERE organization_id = $1 AND job_card_id = $2 AND fact_type = 'SUBMITTED'
          ORDER BY seq_no`,
        [organizationId, job.id],
      );
      expect(facts.rows.map((row) => Number(row.seq_no))).toEqual([1, 2]);
    });
  });

  // The exact 24h equality is proven by the pure boundary tests
  // (overdue-incidents.test.ts §21); the PG path uses margins around it.
  it('approval under 24h stays clean; past 24h breaches', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const baseline = await dbBaseline(pool);

      async function submittedJob(title: string) {
        const clock = { now: baseline };
        const service = buildService(pool, clock);
        let job = (await service.create(staffA, {
          clientActionId: randomUUID(),
          type: 'GENERAL_TASK',
          title,
          description: null,
          customerId: null,
          contactId: null,
          assignedTo: staffA.id,
          priority: 'normal',
          dueDate: null,
          scheduledAt: null,
          scheduledEndsAt: undefined,
          engagementKind: undefined,
        } as never)) as JobCard;
        job = await service.start(staffA, job.id, {
          clientActionId: randomUUID(), expectedVersion: job.version,
        });
        job = await service.submitForApproval(staffA, job.id, {
          clientActionId: randomUUID(), expectedVersion: job.version,
          note: 'Onaya gönderildi.',
        });
        return { service, clock, job };
      }

      const early = await submittedJob('Hizli onay');
      const completed = await early.service.approve(manager, early.job.id, {
        clientActionId: randomUUID(), expectedVersion: early.job.version,
      });
      expect(completed.status).toBe('COMPLETED');
      expect(await selectIncidents(pool, organizationId, early.job.id)).toHaveLength(0);

      const late = await submittedJob('Gecen onay');
      const submittedAt = shiftMs(baseline, -25 * 60 * 60_000);
      await rewindSubmissionTo(pool, organizationId, late.job.id, submittedAt);
      const approveActionId = randomUUID();
      await late.service.approve(manager, late.job.id, {
        clientActionId: approveActionId, expectedVersion: late.job.version,
      });
      const incidents = await selectIncidents(pool, organizationId, late.job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'APPROVAL_WAIT',
        episode_no: 1,
        accountable_user_id: null,
        accountable_role: 'MANAGEMENT',
      });
      expect(incidents[0]!.deadline_at).toEqual(shiftMs(submittedAt, 24 * 60 * 60_000));
      const reservedApprove = await reservedAtFor(pool, organizationId, late.job.id, `JOB_APPROVE:${late.job.id}`);
      expect(incidents[0]!.recovered_at).toEqual(reservedApprove);
    });
  });

  it('revision request past the threshold recovers APPROVAL_WAIT', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Duzeltmeye donen onay',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Onaya gönderildi.',
      });
      // The submission waited 25h before the revision request arrived.
      await rewindSubmissionTo(pool, organizationId, job.id, shiftMs(baseline, -25 * 60 * 60_000));
      const revisionActionId = randomUUID();
      job = await service.requestRevision(manager, job.id, {
        clientActionId: revisionActionId, expectedVersion: job.version,
        revisionReason: 'Eksik bilgi var.',
      });
      expect(job.status).toBe('REVISION_REQUESTED');
      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      const reservedRevision = await reservedAtFor(
        pool, organizationId, job.id, `JOB_REQUEST_REVISION:${job.id}`,
      );
      expect(incidents[0]).toMatchObject({
        delay_type: 'APPROVAL_WAIT',
        recovered_at: reservedRevision,
        recovery_actor_user_id: managerId,
      });
    });
  });

  it('revision before breach creates nothing; a Staff move after a provable breach is refused', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      void manager;
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      const job = await createLateDelivery(service, staffA, customerId);
      // 06:30Z is before the 07:30Z deadline: pure revision, no breach.
      // Staff edit keeps ACCEPTED (a manager edit would void acceptance).
      clock.now = new Date('2026-08-03T06:30:00.000Z');
      const moved = await service.patch(staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T09:00:00.000Z',
      } as never);
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);

      // Move the deadline into the past: the current obligation is lateness
      // the server can prove, so Staff may no longer move the deadline
      // (OVR-5b §5). The patch — including the pre-mutation incident it just
      // materialized — rolls back and writes nothing.
      clock.now = new Date('2026-08-03T10:00:00.000Z');
      await expect(service.patch(staffA, moved.id, {
        expectedVersion: moved.version,
        scheduledAt: '2026-08-03T07:00:00.000Z',
      } as never)).rejects.toMatchObject({
        code: 'DEADLINE_CHANGE_REQUIRES_MANAGEMENT',
        statusCode: 409,
      });
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);
      const revisions = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_schedule_revisions
          WHERE organization_id = $1 AND job_card_id = $2`,
        [organizationId, job.id],
      );
      expect(revisions.rows[0]!.count).toBe('2');
    });
  });

  it('cancel past the approval threshold recovers without deleting history', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Iptal edilen bekleme',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Onaya gönderildi.',
      });
      // The submission waited 25h before the cancellation arrived.
      await rewindSubmissionTo(pool, organizationId, job.id, shiftMs(baseline, -25 * 60 * 60_000));
      job = await service.cancel(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(job.status).toBe('CANCELLED');
      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      const reservedCancel = await reservedAtFor(pool, organizationId, job.id, `JOB_CANCEL:${job.id}`);
      expect(incidents[0]).toMatchObject({
        delay_type: 'APPROVAL_WAIT',
        recovered_at: reservedCancel,
        recovery_actor_user_id: managerId,
      });
    });
  });

  it('invalidation creates no incident and preserves history', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'OVR2 Admin');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const admin: JobCardActor = { id: adminId, organizationId, role: 'ADMIN' };
      const { staffA } = actors(organizationId, adminId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      clock.now = LATE_AT;
      const startActionId = randomUUID();
      job = await service.start(staffA, job.id, {
        clientActionId: startActionId, expectedVersion: job.version,
      });
      const before = await selectIncidents(pool, organizationId, job.id);
      expect(before).toHaveLength(1);

      job = await service.invalidate(admin, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'DUPLICATE',
        note: null,
      } as never);
      expect(job.status).toBe('INVALIDATED');
      const after = await selectIncidents(pool, organizationId, job.id);
      expect(after).toHaveLength(1);
      const reservedStart = await reservedAtFor(pool, organizationId, job.id, `JOB_START:${job.id}`);
      expect(after[0]).toMatchObject({
        delay_type: 'LATE_START',
        accountable_user_id: staffAId,
        recovered_at: reservedStart,
        recovery_actor_user_id: staffAId,
      });
    });
  });

  it('unprovable history attributes UNKNOWN without current-assignee fallback', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const staffA: JobCardActor = { id: staffAId, organizationId, role: 'STAFF' };
      const clock = { now: LATE_AT };
      const service = buildService(pool, clock);

      // Legacy-style row: no assignment history at all.
      const jobId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by,
                                scheduled_at, scheduled_ends_at, accepted_at, accepted_by)
         VALUES ($1, 'PRODUCT_DELIVERY', 'ACCEPTED', 'Tarihsel kayıtsız iş', $2, $2,
                 '2026-08-03T07:00:00.000Z', '2026-08-03T07:30:00.000Z',
                 '2026-08-03T06:30:00.000Z', $2)
         RETURNING id`,
        [organizationId, staffAId],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO job_card_schedule_revisions
           (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
            organization_timezone, source, created_at)
         VALUES ($1, $2, 1, '2026-08-03T07:00:00.000Z', '2026-08-03T07:30:00.000Z',
                 'Europe/Istanbul', 'BASELINE', '2026-08-03T06:00:00.000Z')`,
        [organizationId, jobId],
      );
      const started = await service.start(staffA, jobId, {
        clientActionId: randomUUID(), expectedVersion: 1,
      });
      expect(started.status).toBe('IN_PROGRESS');
      const incidents = await selectIncidents(pool, organizationId, jobId);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        accountable_user_id: null,
        accountable_role: 'STAFF',
        accountable_source: 'UNKNOWN',
      });
    });
  });

  it('failed mutations persist no incident; duplicate identity converges', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);
      const repository = new PostgresJobCardRepository(pool);

      const job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Catismali gonderim',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: '2026-08-01',
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      const started = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      // Stale version: the protected mutation rolls back, nothing persists.
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: 1,
        note: 'Bayat deneme.',
      })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);

      const identity = {
        organizationId,
        jobCardId: job.id,
        delayType: 'LATE_SUBMISSION' as const,
        episodeNo: 1,
        scheduleRevisionNo: 1,
        deadlineAt: new Date('2026-08-01T21:00:01.000Z'),
        breachedAt: new Date('2026-08-01T21:00:01.000Z'),
        accountableUserId: staffAId,
        accountableRole: 'STAFF' as const,
        accountableSource: 'ASSIGNMENT_AT_BREACH' as const,
        source: 'TRANSITION' as const,
      };
      const first = await repository.executeTransaction((tx) =>
        tx.insertOverdueIncident(identity));
      const second = await repository.executeTransaction((tx) =>
        tx.insertOverdueIncident(identity));
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(1);
      void started;
    });
  });

  it('D2-5 proves concurrent incident and activation identities converge to one row', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Concurrency', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Concurrency Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Concurrency Staff');
      const customerId = await insertCustomer(pool, organizationId);
      const { staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      const job = await createLateDelivery(service, staffA, customerId);
      const repository = new PostgresJobCardRepository(pool);
      const identity = {
        organizationId,
        jobCardId: job.id,
        delayType: 'LATE_SUBMISSION' as const,
        episodeNo: 1,
        scheduleRevisionNo: 1,
        deadlineAt: new Date('2026-08-03T07:30:00.001Z'),
        breachedAt: new Date('2026-08-03T07:30:00.001Z'),
        accountableUserId: staffAId,
        accountableRole: 'STAFF' as const,
        accountableSource: 'ASSIGNMENT_AT_BREACH' as const,
        source: 'TRANSITION' as const,
      };

      // Promise.all starts two independent PostgreSQL transactions before
      // either result is observed; the UNIQUE identity is the race arbiter.
      const [incidentA, incidentB] = await Promise.all([
        repository.executeTransaction((tx) => tx.insertOverdueIncident(identity)),
        repository.executeTransaction((tx) => tx.insertOverdueIncident(identity)),
      ]);
      expect(incidentA.id).toBe(incidentB.id);
      expect([incidentA.created, incidentB.created].sort()).toEqual([false, true]);
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(1);

      const activation = {
        organizationId,
        jobCardId: job.id,
        episodeNo: 1,
        activatedAt: new Date('2026-08-03T08:00:00.000Z'),
        activatedByCommand: 'REQUEST_REVISION' as const,
      };
      const [activationA, activationB] = await Promise.all([
        repository.executeTransaction((tx) => tx.insertSubmissionEpisodeActivation(activation)),
        repository.executeTransaction((tx) => tx.insertSubmissionEpisodeActivation(activation)),
      ]);
      expect(activationA.id).toBe(activationB.id);
      expect([activationA.created, activationB.created].sort()).toEqual([false, true]);
      const activationCount = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM job_card_submission_episode_activations
          WHERE organization_id = $1 AND job_card_id = $2 AND episode_no = 1`,
        [organizationId, job.id],
      );
      expect(activationCount.rows[0]!.count).toBe('1');
    });
  });

  it('D2-2 proves rollback after incident insertion: failed submission leaves all deltas absent', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Rollback', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Rollback Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Rollback Ayşe');
      const customerId = await insertCustomer(pool, organizationId);
      const { staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);

      // On-time START (GENERAL_TASK has no interval end: never attributable
      // as LATE_START). The past due date makes the SUBMIT late.
      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Geri alinan gorev',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: istanbulDate(shiftMs(baseline, -3 * 24 * 60 * 60_000)),
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);
      const versionBeforeFailedSubmit = job.version;

      // SUBMIT materializes LATE_SUBMISSION before submission validation
      // runs. This job type rejects follow-up proposals, so validation fails
      // after the insert and the critical transaction must roll everything
      // back while the intent records the definitive failure.
      const submitActionId = randomUUID();
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: submitActionId,
        expectedVersion: versionBeforeFailedSubmit,
        note: 'Eksik teslim bilgisiyle deneme.',
        followUpProposal: {
          scheduledAt: shiftMs(baseline, 7 * 24 * 60 * 60_000).toISOString(),
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Tekrar arayın',
        },
      })).rejects.toMatchObject({ code: 'FOLLOW_UP_PROPOSAL_INVALID', statusCode: 400 });

      const persistedJob = await pool.query<{ status: string; version: number }>(
        `SELECT status, version FROM job_cards WHERE organization_id = $1 AND id = $2`,
        [organizationId, job.id],
      );
      expect(persistedJob.rows[0]).toMatchObject({
        status: 'IN_PROGRESS',
        version: versionBeforeFailedSubmit,
      });
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);
      const facts = await pool.query<{ fact_type: string }>(
        `SELECT fact_type FROM job_card_accountability_facts
          WHERE organization_id = $1 AND job_card_id = $2
          ORDER BY occurred_at, id`,
        [organizationId, job.id],
      );
      expect(facts.rows.map((row) => row.fact_type)).toEqual(['STARTED']);
      const activations = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM job_card_submission_episode_activations
         WHERE organization_id = $1 AND job_card_id = $2`,
        [organizationId, job.id],
      );
      expect(activations.rows[0]!.count).toBe('0');
      // The definitive failure is recorded on the intent; the original
      // domain error (not a bookkeeping error) surfaced above.
      const intent = (await pool.query(
        `SELECT state, failed_at FROM job_card_lifecycle_intents
          WHERE organization_id = $1 AND job_card_id = $2
            AND operation_key = $3`,
        [organizationId, job.id, `JOB_SUBMIT_FOR_APPROVAL:${job.id}`],
      )).rows[0] as Record<string, unknown>;
      expect(intent.state).toBe('FAILED');
      expect(intent.failed_at).not.toBeNull();
    });
  });

  it('schema guards hold: empty start, cross references, pairs', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const otherOrgId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Other', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { staffA } = actors(organizationId, organizationId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      const job = await createLateDelivery(service, staffA, await insertCustomer(pool, organizationId));
      const otherJob = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'NEW', 'Diger is', $2, $2) RETURNING id`,
        [otherOrgId, await insertUser(pool, otherOrgId, 'STAFF', 'Yabanci')],
      )).rows[0]!.id;

      const empty = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM job_card_overdue_incidents',
      );
      expect(empty.rows[0]!.count).toBe('0');

      const valid = {
        organization_id: organizationId,
        job_card_id: job.id,
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 1,
        deadline_at: '2026-08-03T07:30:00.000Z',
        breached_at: '2026-08-03T07:30:00.000Z',
        accountable_user_id: staffAId,
        accountable_role: 'STAFF',
        accountable_source: 'ASSIGNMENT_AT_BREACH',
        source: 'TRANSITION',
      };
      const cols = Object.keys(valid).join(', ');
      const params = Object.keys(valid).map((_, index) => `$${index + 1}`).join(', ');
      const insert = (row: Record<string, unknown>) =>
        pool.query(
          `INSERT INTO job_card_overdue_incidents (${cols}) VALUES (${params})`,
          Object.values({ ...valid, ...row }),
        );
      // Cross-org job reference is rejected.
      await expect(insert({ organization_id: otherOrgId })).rejects.toMatchObject({ code: '23503' });
      // Cross-job schedule revision is rejected.
      await insert({
        job_card_id: otherJob,
        organization_id: otherOrgId,
        schedule_revision_no: 1,
      }).then(
        () => { throw new Error('expected cross-job revision to fail'); },
        (error: { code?: string }) => {
          // otherJob has no revision rows at all: FK violation either way.
          expect(['23503', '23514']).toContain(error.code);
        },
      );
      // Semantic duplicates are rejected at the DB level.
      await insert({});
      await expect(insert({})).rejects.toMatchObject({ code: '23505' });
      // Half-populated recovery pair is rejected.
      await expect(
        pool.query(
          `UPDATE job_card_overdue_incidents SET recovered_at = NOW()
            WHERE organization_id = $1 AND job_card_id = $2`,
          [organizationId, job.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // Breach instant must not precede the first-late boundary.
      await expect(insert({
        episode_no: 2,
        breached_at: '2026-08-03T07:29:00.000Z',
      })).rejects.toMatchObject({ code: '23514' });
      // Episode numbers start at 1.
      await expect(insert({ episode_no: 0 })).rejects.toMatchObject({ code: '23514' });
      // OVR-3 (migration 050) admits the clock-only scanner as a third
      // producer source, and every pre-existing source stays accepted.
      await insert({ episode_no: 3, source: 'SCANNER' });
      await insert({ episode_no: 4, source: 'MUTATION' });
      // An unknown producer source is still rejected.
      await expect(insert({
        episode_no: 5,
        source: 'NOT_A_PRODUCER',
      })).rejects.toMatchObject({ code: '23514' });
      // Migration 048 permits the tracked legacy first episode while keeping
      // the durable identity unique.
      await pool.query(
        `INSERT INTO job_card_submission_episode_activations
           (organization_id, job_card_id, episode_no, activated_at, activated_by_command)
         VALUES ($1, $2, 1, $3, 'REQUEST_REVISION')`,
        [organizationId, job.id, new Date('2026-08-03T07:00:00.000Z')],
      );
      // Submission episode activations are one row per next episode.
      await pool.query(
        `INSERT INTO job_card_submission_episode_activations
           (organization_id, job_card_id, episode_no, activated_at, activated_by_command)
         VALUES ($1, $2, 2, $3, 'WITHDRAW_FROM_APPROVAL')`,
        [organizationId, job.id, new Date('2026-08-03T08:00:00.000Z')],
      );
      await expect(pool.query(
        `INSERT INTO job_card_submission_episode_activations
           (organization_id, job_card_id, episode_no, activated_at, activated_by_command)
         VALUES ($1, $2, 2, $3, 'REQUEST_REVISION')`,
        [organizationId, job.id, new Date('2026-08-03T09:00:00.000Z')],
      )).rejects.toMatchObject({ code: '23505' });
    });
  });
});

describe.skipIf(!databaseUrl)('OVR-2 contract reconciliation (candidate RED)', () => {
  async function setupOrg(pool: Pool) {
    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Reconcile', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Reconcile Manager');
    const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Reconcile Ayşe');
    const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Reconcile Mehmet');
    const customerId = await insertCustomer(pool, organizationId);
    return { organizationId, ...actors(organizationId, managerId, staffAId, staffBId), staffAId, staffBId, managerId, customerId };
  }

  /** Manager creates for staff: no self-accept, the job stays NEW. */
  async function createNewLateDelivery(
    service: JobCardService,
    manager: JobCardActor,
    staffId: string,
    customerId: string,
  ): Promise<JobCard> {
    return (await service.create(manager, {
      clientActionId: randomUUID(),
      type: 'PRODUCT_DELIVERY',
      title: 'Kabul edilmemiş teslim',
      description: null,
      customerId,
      contactId: null,
      assignedTo: staffId,
      priority: 'normal',
      dueDate: null,
      scheduledAt: DELIVERY_START,
      scheduledEndsAt: undefined,
      engagementKind: undefined,
    } as never)) as JobCard;
  }

  async function createDueTask(
    service: JobCardService,
    staff: JobCardActor,
    dueDate: string | null,
    title = 'Aktif teslim tarihi görevi',
  ): Promise<JobCard> {
    return (await service.create(staff, {
      clientActionId: randomUUID(),
      type: 'GENERAL_TASK',
      title,
      description: null,
      customerId: null,
      contactId: null,
      assignedTo: staff.id,
      priority: 'normal',
      dueDate,
      scheduledAt: null,
      scheduledEndsAt: undefined,
      engagementKind: undefined,
    } as never)) as JobCard;
  }

  async function moveToRevisionRequested(
    service: JobCardService,
    clock: { now: Date },
    staff: JobCardActor,
    manager: JobCardActor,
    dueDate: string | null,
  ): Promise<JobCard> {
    let job = await createDueTask(service, staff, dueDate, 'Düzeltme bekleyen görev');
    job = await service.start(staff, job.id, {
      clientActionId: randomUUID(), expectedVersion: job.version,
    });
    job = await service.submitForApproval(staff, job.id, {
      clientActionId: randomUUID(), expectedVersion: job.version,
      note: 'İlk teslim.',
    });
    clock.now = new Date('2026-07-30T10:00:00.000Z');
    return service.requestRevision(manager, job.id, {
      clientActionId: randomUUID(), expectedVersion: job.version,
      revisionReason: 'Düzeltme gerekli.',
    });
  }

  it('NEW past deadline + reassign creates no incident', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      let job = await createNewLateDelivery(service, ctx.manager, ctx.staffAId, ctx.customerId);
      expect(job.status).toBe('NEW');
      clock.now = LATE_AT;
      job = await service.patch(ctx.manager, job.id, {
        expectedVersion: job.version,
        assignedTo: ctx.staffBId,
      } as never);
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
    });
  });

  it('NEW past deadline + cancel creates no incident', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      const job = await createNewLateDelivery(service, ctx.manager, ctx.staffAId, ctx.customerId);
      clock.now = LATE_AT;
      const cancelled = await service.cancel(ctx.manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(cancelled.status).toBe('CANCELLED');
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
    });
  });

  it('NEW past deadline + schedule patch creates no incident', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      let job = await createNewLateDelivery(service, ctx.manager, ctx.staffAId, ctx.customerId);
      clock.now = LATE_AT;
      job = await service.patch(ctx.manager, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T07:15:00.000Z',
      } as never);
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
    });
  });

  it('late ACCEPT_ASSIGNMENT materializes an OPEN incident at acceptance', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      const job = await createNewLateDelivery(service, ctx.manager, ctx.staffAId, ctx.customerId);
      const acceptActionId = randomUUID();
      const accepted = await service.acceptAssignment(ctx.staffA, job.id, {
        clientActionId: acceptActionId, expectedVersion: job.version,
      });
      expect(accepted.status).toBe('ACCEPTED');
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 1,
        accountable_user_id: ctx.staffAId,
        accountable_role: 'STAFF',
      });
      expect(incidents[0]!.deadline_at).toEqual(new Date('2026-08-03T07:30:00.000Z'));
      // No backdating before the commitment existed: breach starts at the
      // acceptance reservation.
      const reservedAccept = await reservedAtFor(
        pool, ctx.organizationId, job.id, `JOB_ACCEPT_ASSIGNMENT:${job.id}`,
      );
      expect(incidents[0]!.breached_at).toEqual(reservedAccept);
      expect(incidents[0]!.recovered_at).toBeNull();
    });
  });

  it('B1 candidate RED: a forward extension ends the older revision incident and START never resurrects it', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      // The self-created delivery starts ACCEPTED, so the manager edit below
      // first preserves a provable LATE_START incident for revision 1, then
      // extends the deadline (OVR-5b §4.1) and returns the job to NEW.
      let job = await createLateDelivery(service, ctx.staffA, ctx.customerId);
      clock.now = LATE_AT;
      // Revision 2 straddles the reservation (PD canonical end is start +
      // 30m): START lands on time for the current revision.
      const baseline = await dbBaseline(pool);
      // The current-revision START must land on time inside a slot that
      // straddles the real reservation instant; the human patch path imposes
      // no working-day constraint, so the canonical 30m envelope always works.
      const rev2Start = shiftMs(baseline, -10 * 60_000);
      job = await service.patch(ctx.manager, job.id, {
        expectedVersion: job.version,
        scheduledAt: rev2Start.toISOString(),
        deadlineExtensionReason: 'Yeni teslim penceresi verildi.',
      } as never);
      expect(job.status).toBe('NEW');
      const beforeStart = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(beforeStart).toHaveLength(1);
      // OVR-5b §4.6: the older revision's evidence stays; the obligation is
      // ended by the extension instead of being left open for START.
      expect(beforeStart[0]).toMatchObject({
        delay_type: 'LATE_START',
        schedule_revision_no: 1,
        recovered_at: null,
        ended_at: LATE_AT,
        ended_by_user_id: ctx.managerId,
        end_reason: 'DEADLINE_EXTENDED',
        ended_by_schedule_revision_no: 2,
      });

      // START is on time for the current revision and must not recover (or
      // otherwise touch) the ended row: ending and recovery are exclusive.
      clock.now = new Date('2026-08-03T09:00:00.000Z');
      job = await service.acceptAssignment(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });

      expect(job.status).toBe('IN_PROGRESS');
      const afterStart = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(afterStart).toHaveLength(1);
      expect(afterStart[0]).toMatchObject({
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 1,
        recovered_at: null,
        ended_at: LATE_AT,
        ended_by_user_id: ctx.managerId,
        end_reason: 'DEADLINE_EXTENDED',
        ended_by_schedule_revision_no: 2,
      });
    });
  });

  it('B1 regression: an on-time SUBMIT never resurrects a LATE_SUBMISSION revision ended by an extension', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);
      let job = await createDueTask(service, ctx.staffA, '2026-08-01', 'Eski teslim tarihi');
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });

      // Management extends the elapsed deadline into the future with the
      // required reason: the old revision evidence stays, the obligation ends.
      const baseline = await dbBaseline(pool);
      const futureDue = istanbulDate(shiftMs(baseline, 7 * 24 * 60 * 60_000));
      await syncClock(pool, clock);
      job = await service.patch(ctx.manager, job.id, {
        expectedVersion: job.version,
        dueDate: futureDue,
        deadlineExtensionReason: 'Müşteri yeni tarih verdi.',
      } as never);
      const beforeSubmit = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(beforeSubmit).toHaveLength(1);
      expect(beforeSubmit[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        schedule_revision_no: 1,
        recovered_at: null,
        ended_at: clock.now,
        ended_by_user_id: ctx.managerId,
        end_reason: 'DEADLINE_EXTENDED',
        ended_by_schedule_revision_no: 2,
      });

      // The new deadline is in the future at the DB reservation instant, so
      // the submit is on time; recovery only closes rows that are still open
      // and never turns an ended row into a recovered one (§4.8 / §6).
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ikinci gonderim.',
      });
      expect(job.status).toBe('WAITING_APPROVAL');
      const afterSubmit = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(afterSubmit).toHaveLength(1);
      expect(afterSubmit[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        schedule_revision_no: 1,
        recovered_at: null,
        ended_at: clock.now,
        end_reason: 'DEADLINE_EXTENDED',
      });
    });
  });

  it('B1 regression: CANCEL from NEW recovers a stale accepted-commitment incident', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      let job = await createLateDelivery(service, ctx.staffA, ctx.customerId);
      clock.now = LATE_AT;
      // The revised interval (07:10–07:40Z) is still past at the patch
      // instant, so nothing is ended (OVR-5b §4.2): the incident stays open
      // and the job returns to NEW.
      job = await service.patch(ctx.manager, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T07:10:00.000Z',
      } as never);
      expect(job.status).toBe('NEW');
      expect((await selectIncidents(pool, ctx.organizationId, job.id))[0]).toMatchObject({
        delay_type: 'LATE_START',
        recovered_at: null,
        ended_at: null,
      });

      clock.now = new Date('2026-08-03T08:05:00.000Z');
      const cancelActionId = randomUUID();
      job = await service.cancel(ctx.manager, job.id, {
        clientActionId: cancelActionId, expectedVersion: job.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(job.status).toBe('CANCELLED');
      const reservedCancel = await reservedAtFor(pool, ctx.organizationId, job.id, `JOB_CANCEL:${job.id}`);
      expect((await selectIncidents(pool, ctx.organizationId, job.id))[0]).toMatchObject({
        delay_type: 'LATE_START',
        recovered_at: reservedCancel,
        recovery_actor_user_id: ctx.managerId,
      });
    });
  });

  it('B2 candidate RED: IN_PROGRESS dueDate extension preserves the breached old submission evidence', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);
      let job = (await service.create(ctx.staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Aktif teslim tarihi revizyonu',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: ctx.staffA.id,
        priority: 'normal',
        dueDate: '2026-08-01',
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(job.status).toBe('IN_PROGRESS');

      // The old dueDate is already late. A management extension must preserve
      // the old revision-bound evidence before appending rev 2, then end the
      // obligation with the required reason (OVR-5b §4.1/§4.6).
      // Sync the patch clock past the START reservation first (see syncClock).
      await syncClock(pool, clock);
      const futureDue = shiftMs(clock.now, 7 * 24 * 60 * 60_000).toISOString().slice(0, 10);
      job = await service.patch(ctx.manager, job.id, {
        expectedVersion: job.version,
        dueDate: futureDue,
        deadlineExtensionReason: 'Yönetim yeni teslim tarihi verdi.',
      } as never);

      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      const reservedStart = await reservedAtFor(pool, ctx.organizationId, job.id, `JOB_START:${job.id}`);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        schedule_revision_no: 1,
        recovered_at: null,
        ended_at: clock.now,
        ended_by_user_id: ctx.managerId,
        end_reason: 'DEADLINE_EXTENDED',
        end_note: 'Yönetim yeni teslim tarihi verdi.',
        ended_by_schedule_revision_no: 2,
      });
      expect(incidents[0]!.deadline_at).toEqual(new Date('2026-08-01T21:00:00.001Z'));
      // Breach = max(first late, episode start = START reservation).
      expect(incidents[0]!.breached_at).toEqual(reservedStart);
    });
  });

  it('B2 regression: IN_PROGRESS dueDate move into the past creates only a new revision incident', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);
      // Old deadline in the future (no rev1 incident), new deadline elapsed.
      const futureDue = istanbulDate(shiftMs(baseline, 7 * 24 * 60 * 60_000));
      let job = await createDueTask(service, ctx.staffA, futureDue);
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      // The patch requestTime must postdate the START reservation (syncClock),
      // mirroring the old fixed 08-04 clock which postdated its requestTime.
      await syncClock(pool, clock);
      job = await service.patch(ctx.staffA, job.id, {
        expectedVersion: job.version,
        dueDate: '2026-08-01',
      } as never);

      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        schedule_revision_no: 2,
        deadline_at: new Date('2026-08-01T21:00:00.001Z'),
        breached_at: clock.now,
        recovered_at: null,
      });
    });
  });

  it('B2 regression: management dueDate removal on an open late obligation is refused', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);
      let job = await createDueTask(service, ctx.staffA, '2026-08-01');
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      // Patch clock must postdate the START reservation (see syncClock).
      await syncClock(pool, clock);
      // The dueDate governs the open lateness, so removing it is not an
      // extension: OVR-5b §4.3 refuses the patch and writes nothing.
      await expect(service.patch(ctx.manager, job.id, {
        expectedVersion: job.version,
        dueDate: null,
      } as never)).rejects.toMatchObject({
        code: 'OPEN_LATENESS_DEADLINE_REQUIRED',
        statusCode: 409,
      });

      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
      const row = await pool.query<{ version: number }>(
        'SELECT version FROM job_cards WHERE organization_id = $1 AND id = $2',
        [ctx.organizationId, job.id],
      );
      expect(Number(row.rows[0]!.version)).toBe(job.version);
      const revisions = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_schedule_revisions
          WHERE organization_id = $1 AND job_card_id = $2`,
        [ctx.organizationId, job.id],
      );
      expect(revisions.rows[0]!.count).toBe('1');
    });
  });

  it('B2 regression: REVISION_REQUESTED pending episode binds the old revision before an extension ends it', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);
      // Submit on time against a future due date (no ep1 incident), then
      // revise: episode 2 is pending with the same future deadline.
      const due = istanbulDate(shiftMs(baseline, 24 * 60 * 60_000));
      const dueEnd = new Date(`${due}T21:00:00.000Z`);
      let job = await moveToRevisionRequested(
        service, clock, ctx.staffA, ctx.manager, due,
      );
      // Patch after the old deadline but with a forward move: the pending
      // episode binds the OLD revision deadline, which stays as the evidence
      // of the breached obligation the extension then ends.
      clock.now = shiftMs(dueEnd, 60 * 60_000);
      const forwardDue = shiftMs(dueEnd, 24 * 60 * 60_000).toISOString().slice(0, 10);
      job = await service.patch(ctx.manager, job.id, {
        expectedVersion: job.version,
        dueDate: forwardDue,
        deadlineExtensionReason: 'Personel için ek süre verildi.',
      } as never);

      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 2,
        schedule_revision_no: 1,
        recovered_at: null,
        ended_at: clock.now,
        ended_by_user_id: ctx.managerId,
        end_reason: 'DEADLINE_EXTENDED',
        ended_by_schedule_revision_no: 2,
      });
      expect(incidents[0]!.deadline_at).toEqual(shiftMs(dueEnd, 1));
      expect(incidents[0]!.breached_at).toEqual(shiftMs(dueEnd, 1));
    });
  });

  it('B2 regression: REVISION_REQUESTED dueDate move backward creates episode-2 incident at requestTime', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);
      // Far-future due: submit on time, then revise (episode 2 pending).
      const farDue = istanbulDate(shiftMs(baseline, 2 * 24 * 60 * 60_000));
      let job = await moveToRevisionRequested(
        service, clock, ctx.staffA, ctx.manager, farDue,
      );
      // Backward move to a nearer (but still elapsed-at-request) due date:
      // the new revision breaches at the patch requestTime.
      const nearDue = istanbulDate(shiftMs(baseline, 24 * 60 * 60_000));
      const nearEnd = new Date(`${nearDue}T21:00:00.000Z`);
      clock.now = shiftMs(nearEnd, 60 * 60_000);
      job = await service.patch(ctx.staffA, job.id, {
        expectedVersion: job.version,
        dueDate: nearDue,
      } as never);

      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 2,
        schedule_revision_no: 2,
        recovered_at: null,
      });
      expect(incidents[0]!.deadline_at).toEqual(shiftMs(nearEnd, 1));
      expect(incidents[0]!.breached_at).toEqual(clock.now);
    });
  });

  it('B2 regression: a Staff dueDate removal on an open late obligation is refused', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);
      const due = istanbulDate(shiftMs(baseline, 24 * 60 * 60_000));
      const dueEnd = new Date(`${due}T21:00:00.000Z`);
      let job = await moveToRevisionRequested(
        service, clock, ctx.staffA, ctx.manager, due,
      );
      // Remove the due date after the old deadline: the pending episode is
      // already provably late, so Staff may not move the deadline; the whole
      // patch (including the pre-mutation incident) rolls back (OVR-5b §5).
      clock.now = shiftMs(dueEnd, 60 * 60_000);
      await expect(service.patch(ctx.staffA, job.id, {
        expectedVersion: job.version,
        dueDate: null,
      } as never)).rejects.toMatchObject({
        code: 'DEADLINE_CHANGE_REQUIRES_MANAGEMENT',
        statusCode: 409,
      });

      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
      const revisions = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_schedule_revisions
          WHERE organization_id = $1 AND job_card_id = $2`,
        [ctx.organizationId, job.id],
      );
      expect(revisions.rows[0]!.count).toBe('1');
    });
  });

  it('B3 candidate RED: legacy factless WAITING_APPROVAL re-arm persists tracked episode 1 at requestTime', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const startedAt = new Date('2026-07-30T09:00:00.000Z');
      const clock = { now: startedAt };
      const service = buildService(pool, clock);
      let job = (await service.create(ctx.staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Legacy factless approval',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: ctx.staffA.id,
        priority: 'normal',
        dueDate: '2026-08-01',
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });

      // Legacy data can contain WAITING_APPROVAL without a SUBMITTED fact.
      // Build exactly that state without inventing a historical fact.
      await pool.query(
        `UPDATE job_cards
            SET status = 'WAITING_APPROVAL', staff_completed_at = $3, staff_completed_by = $4
          WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, job.id, startedAt, ctx.staffAId],
      );
      const submittedFacts = await pool.query(
        `SELECT 1 FROM job_card_accountability_facts
          WHERE organization_id = $1 AND job_card_id = $2 AND fact_type = 'SUBMITTED'`,
        [ctx.organizationId, job.id],
      );
      expect(submittedFacts.rows).toHaveLength(0);
      const modernActivations = await pool.query(
        `SELECT 1 FROM job_card_submission_episode_activations
          WHERE organization_id = $1 AND job_card_id = $2`,
        [ctx.organizationId, job.id],
      );
      expect(modernActivations.rows).toHaveLength(0);

      const withdrawActionId = randomUUID();
      job = await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: withdrawActionId, expectedVersion: job.version,
      });
      expect(job.status).toBe('IN_PROGRESS');

      const activations = await pool.query(
        `SELECT episode_no, activated_at, activated_by_command
           FROM job_card_submission_episode_activations
          WHERE organization_id = $1 AND job_card_id = $2`,
        [ctx.organizationId, job.id],
      );
      expect(activations.rows).toHaveLength(1);
      const reservedWithdraw = await reservedAtFor(
        pool, ctx.organizationId, job.id, `JOB_WITHDRAW_FROM_APPROVAL:${job.id}`, withdrawActionId,
      );
      expect(activations.rows[0]).toMatchObject({
        episode_no: 1,
        activated_at: reservedWithdraw,
        activated_by_command: 'WITHDRAW_FROM_APPROVAL',
      });

      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        breached_at: reservedWithdraw,
        recovered_at: null,
      });
      expect(incidents[0]!.breached_at).not.toEqual(startedAt);

      // The first post-fact submission remains seq_no 1. A later re-arm then
      // advances to episode 2; it must not reinterpret the legacy row as a
      // historical submission count.
      const submitActionId = randomUUID();
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: submitActionId, expectedVersion: job.version,
        note: 'Legacy kaydın ilk takip teslimi.',
      });
      const facts = await pool.query<{ seq_no: number }>(
        `SELECT seq_no FROM job_card_accountability_facts
          WHERE organization_id = $1 AND job_card_id = $2 AND fact_type = 'SUBMITTED'
          ORDER BY seq_no`,
        [ctx.organizationId, job.id],
      );
      expect(facts.rows.map((row) => Number(row.seq_no))).toEqual([1]);
      const reservedSubmit = await reservedAtFor(
        pool, ctx.organizationId, job.id, `JOB_SUBMIT_FOR_APPROVAL:${job.id}`, submitActionId,
      );
      expect((await selectIncidents(pool, ctx.organizationId, job.id))[0]).toMatchObject({
        episode_no: 1,
        breached_at: reservedWithdraw,
        recovered_at: reservedSubmit,
      });

      const revisionActionId = randomUUID();
      job = await service.requestRevision(ctx.manager, job.id, {
        clientActionId: revisionActionId, expectedVersion: job.version,
        revisionReason: 'İkinci takip düzeltmesi.',
      });
      const allActivations = await pool.query<{ episode_no: number; activated_at: Date }>(
        `SELECT episode_no, activated_at
           FROM job_card_submission_episode_activations
          WHERE organization_id = $1 AND job_card_id = $2
          ORDER BY episode_no`,
        [ctx.organizationId, job.id],
      );
      const reservedRevision = await reservedAtFor(
        pool, ctx.organizationId, job.id, `JOB_REQUEST_REVISION:${job.id}`, revisionActionId,
      );
      expect(allActivations.rows).toEqual([
        { episode_no: 1, activated_at: reservedWithdraw },
        { episode_no: 2, activated_at: reservedRevision },
      ]);
    });
  });

  it('B3 regression: factless legacy REQUEST_REVISION arms episode 1 with the default correction and CANCEL records no backdated breach', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const startedAt = new Date('2026-07-30T09:00:00.000Z');
      const clock = { now: startedAt };
      const service = buildService(pool, clock);
      let job = await createDueTask(service, ctx.staffA, '2026-08-01', 'Legacy revision request');
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      await pool.query(
        `UPDATE job_cards
            SET status = 'WAITING_APPROVAL',
                staff_completed_at = $3,
                staff_completed_by = $4
          WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, job.id, startedAt, ctx.staffAId],
      );
      expect((await pool.query(
        `SELECT 1 FROM job_card_accountability_facts
          WHERE organization_id = $1 AND job_card_id = $2 AND fact_type = 'SUBMITTED'`,
        [ctx.organizationId, job.id],
      )).rows).toHaveLength(0);

      const revisionActionId = randomUUID();
      job = await service.requestRevision(ctx.manager, job.id, {
        clientActionId: revisionActionId, expectedVersion: job.version,
        revisionReason: 'Legacy kaydı yeniden başlat.',
      });
      expect(job.status).toBe('REVISION_REQUESTED');
      const activation = await pool.query<{
        episode_no: number; activated_at: Date; correction_due_at: Date | null;
      }>(
        `SELECT episode_no, activated_at, correction_due_at
           FROM job_card_submission_episode_activations
          WHERE organization_id = $1 AND job_card_id = $2`,
        [ctx.organizationId, job.id],
      );
      const reservedRevision = await reservedAtFor(
        pool, ctx.organizationId, job.id, `JOB_REQUEST_REVISION:${job.id}`, revisionActionId,
      );
      expect(activation.rows).toHaveLength(1);
      expect(activation.rows[0]).toMatchObject({
        episode_no: 1,
        activated_at: reservedRevision,
        // OVR-5b §3.2: the default is materialized, never stored as NULL.
        correction_due_at: shiftMs(reservedRevision, 24 * 3_600_000),
      });

      const cancelActionId = randomUUID();
      job = await service.cancel(ctx.manager, job.id, {
        clientActionId: cancelActionId, expectedVersion: job.version,
        cancelReason: 'Legacy iş iptal edildi.',
      });
      expect(job.status).toBe('CANCELLED');
      // The armed episode is not late yet (its correction deadline is in the
      // future), so CANCEL truthfully records no incident at all — it never
      // backdates the obligation to the old deadline or the old fact.
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
    });
  });

  it('D2-1 regression: a derived breach after requestTime is not materialized', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const baseline = await dbBaseline(pool);
      const startedAt = new Date('2026-07-30T09:00:00.000Z');
      // A durable activation in the future relative to the DB reservation
      // clock (not merely relative to a fixed fixture date).
      const futureActivation = shiftMs(baseline, 7 * 24 * 60 * 60_000);
      const clock = { now: startedAt };
      const service = buildService(pool, clock);
      let job = await createDueTask(service, ctx.staffA, '2026-08-01', 'Gelecek aktivasyon');
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      // Simulate a malformed/future durable activation without changing the
      // production writer. The materializer must fail closed on max(...).
      await pool.query(
        `UPDATE job_cards
            SET status = 'REVISION_REQUESTED',
                staff_completed_at = $3,
                staff_completed_by = $4,
                revision_requested_at = $3,
                revision_requested_by = $4,
                revision_reason = 'Legacy fixture'
          WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, job.id, startedAt, ctx.staffAId],
      );
      await pool.query(
        `INSERT INTO job_card_submission_episode_activations
           (organization_id, job_card_id, episode_no, activated_at, activated_by_command)
         VALUES ($1, $2, 1, $3, 'REQUEST_REVISION')`,
        [ctx.organizationId, job.id, futureActivation],
      );

      // The cancel reservation (≈ now) predates the future activation, so
      // the derived breach stays unmaterialized.
      job = await service.cancel(ctx.manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        cancelReason: 'Gelecek aktivasyon testi.',
      });
      expect(job.status).toBe('CANCELLED');
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
    });
  });

  it('IN_PROGRESS late + CANCEL recovers the pending LATE_SUBMISSION', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);
      // GENERAL_TASK has no interval end (START never attributable), while
      // the past due date makes the submission episode late at CANCEL.
      const dueDate = istanbulDate(shiftMs(baseline, -3 * 24 * 60 * 60_000));
      const dueEnd = new Date(`${dueDate}T21:00:00.000Z`);
      let job = (await service.create(ctx.staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Iptal edilen gecikme',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: ctx.staffA.id,
        priority: 'normal',
        dueDate,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      const startActionId = randomUUID();
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: startActionId, expectedVersion: job.version,
      });
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
      const cancelActionId = randomUUID();
      job = await service.cancel(ctx.manager, job.id, {
        clientActionId: cancelActionId, expectedVersion: job.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(job.status).toBe('CANCELLED');
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      const reservedStart = await reservedAtFor(pool, ctx.organizationId, job.id, `JOB_START:${job.id}`);
      const reservedCancel = await reservedAtFor(pool, ctx.organizationId, job.id, `JOB_CANCEL:${job.id}`);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        schedule_revision_no: 1,
        accountable_user_id: ctx.staffAId,
      });
      expect(incidents[0]!.deadline_at).toEqual(shiftMs(dueEnd, 1));
      // Breach = max(first late, episode start = START reservation).
      expect(incidents[0]!.breached_at).toEqual(reservedStart);
      expect(incidents[0]!.recovered_at).toEqual(reservedCancel);
      expect(incidents[0]!.recovery_actor_user_id).toBe(ctx.managerId);
    });
  });

  it('REVISION_REQUESTED arms the next episode with its correction deadline; CANCEL records no backdated breach', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);
      let job = (await service.create(ctx.staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Düzeltmede iptal',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: ctx.staffA.id,
        priority: 'normal',
        dueDate: '2026-08-01',
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      clock.now = new Date('2026-08-04T09:00:00.000Z');
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Geç de olsa tamamlandı.',
      });
      // Simulate a pre-OVR-2 submit: the breach is provable from immutable
      // facts, but no incident row was persisted for it.
      await pool.query(
        `DELETE FROM job_card_overdue_incidents
          WHERE organization_id = $1 AND job_card_id = $2`,
        [ctx.organizationId, job.id],
      );
      clock.now = new Date('2026-08-04T10:00:00.000Z');
      const revisionActionId = randomUUID();
      job = await service.requestRevision(ctx.manager, job.id, {
        clientActionId: revisionActionId, expectedVersion: job.version,
        revisionReason: 'Eksik bilgi var.',
      });
      expect(job.status).toBe('REVISION_REQUESTED');
      clock.now = new Date('2026-08-04T11:00:00.000Z');
      const cancelActionId = randomUUID();
      job = await service.cancel(ctx.manager, job.id, {
        clientActionId: cancelActionId, expectedVersion: job.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(job.status).toBe('CANCELLED');
      // The episode armed by REQUEST_REVISION carries the materialized 24h
      // correction deadline, so the cancellation is not late against the old
      // deadline: no incident is fabricated or backdated (§3.2, §3.5).
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
      const reservedRevision = await reservedAtFor(
        pool, ctx.organizationId, job.id, `JOB_REQUEST_REVISION:${job.id}`,
      );
      const activation = await pool.query<{
        episode_no: number; activated_at: Date; correction_due_at: Date | null;
      }>(
        `SELECT episode_no, activated_at, correction_due_at
           FROM job_card_submission_episode_activations
          WHERE organization_id = $1 AND job_card_id = $2 AND episode_no = 2`,
        [ctx.organizationId, job.id],
      );
      expect(activation.rows).toHaveLength(1);
      expect(activation.rows[0]).toMatchObject({
        activated_at: reservedRevision,
        correction_due_at: shiftMs(reservedRevision, 24 * 3_600_000),
      });
    });
  });

  // The exact 24h equality is proven by the pure boundary tests; the PG
  // path uses a same-instant withdraw (clean) and day-old submissions.
  it('WITHDRAW before 24h creates nothing; at/after 24h recovers APPROVAL_WAIT', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const baseline = await dbBaseline(pool);
      async function submittedNow(title: string) {
        const clock = { now: baseline };
        const service = buildService(pool, clock);
        let job = (await service.create(ctx.staffA, {
          clientActionId: randomUUID(),
          type: 'GENERAL_TASK',
          title,
          description: null,
          customerId: null,
          contactId: null,
          assignedTo: ctx.staffA.id,
          priority: 'normal',
          dueDate: null,
          scheduledAt: null,
          scheduledEndsAt: undefined,
          engagementKind: undefined,
        } as never)) as JobCard;
        job = await service.start(ctx.staffA, job.id, {
          clientActionId: randomUUID(), expectedVersion: job.version,
        });
        job = await service.submitForApproval(ctx.staffA, job.id, {
          clientActionId: randomUUID(), expectedVersion: job.version,
          note: 'Onaya gönderildi.',
        });
        return { clock, service, job };
      }

      const early = await submittedNow('Erken geri çekme');
      const withdrawnEarly = await early.service.withdrawFromApproval(ctx.staffA, early.job.id, {
        clientActionId: randomUUID(), expectedVersion: early.job.version,
      });
      expect(withdrawnEarly.status).toBe('IN_PROGRESS');
      expect(await selectIncidents(pool, ctx.organizationId, early.job.id)).toHaveLength(0);

      const breached = await submittedNow('Geç geri çekme');
      const submittedAt = shiftMs(baseline, -25 * 60 * 60_000);
      await rewindSubmissionTo(pool, ctx.organizationId, breached.job.id, submittedAt);
      const withdrawActionId = randomUUID();
      const withdrawn = await breached.service.withdrawFromApproval(ctx.staffA, breached.job.id, {
        clientActionId: withdrawActionId,
        expectedVersion: breached.job.version,
      });
      expect(withdrawn.status).toBe('IN_PROGRESS');
      const breachedIncidents = await selectIncidents(pool, ctx.organizationId, breached.job.id);
      expect(breachedIncidents).toHaveLength(1);
      const reservedWithdraw = await reservedAtFor(
        pool, ctx.organizationId, breached.job.id, `JOB_WITHDRAW_FROM_APPROVAL:${breached.job.id}`,
      );
      expect(breachedIncidents[0]).toMatchObject({
        delay_type: 'APPROVAL_WAIT',
        episode_no: 1,
        accountable_user_id: null,
        accountable_role: 'MANAGEMENT',
        accountable_source: 'ROLE_POLICY',
        recovered_at: reservedWithdraw,
        // The recovering actor may be STAFF; accountability stays MANAGEMENT.
        recovery_actor_user_id: ctx.staffAId,
      });
      expect(breachedIncidents[0]!.deadline_at).toEqual(shiftMs(submittedAt, 24 * 60 * 60_000));

      const late = await submittedNow('Tekrar geri çekme');
      await rewindSubmissionTo(pool, ctx.organizationId, late.job.id, submittedAt);
      const lateWithdrawActionId = randomUUID();
      const lateWithdrawExpectedVersion = late.job.version;
      const withdrawnLate = await late.service.withdrawFromApproval(ctx.staffA, late.job.id, {
        clientActionId: lateWithdrawActionId,
        expectedVersion: lateWithdrawExpectedVersion,
      });
      const lateIncidents = await selectIncidents(pool, ctx.organizationId, late.job.id);
      expect(lateIncidents).toHaveLength(1);
      expect(lateIncidents[0]).toMatchObject({ delay_type: 'APPROVAL_WAIT' });
      const reservedLateWithdraw = await reservedAtFor(
        pool, ctx.organizationId, late.job.id, `JOB_WITHDRAW_FROM_APPROVAL:${late.job.id}`,
      );
      expect(lateIncidents[0]!.recovered_at).toEqual(reservedLateWithdraw);

      // Exact semantic replay uses the same action identity, payload and
      // expected-version contract; it returns the original receipt rather
      // than entering a second lifecycle attempt.
      const replayed = await late.service.withdrawFromApproval(ctx.staffA, late.job.id, {
        clientActionId: lateWithdrawActionId,
        expectedVersion: lateWithdrawExpectedVersion,
      });
      expect(replayed).toMatchObject({
        id: withdrawnLate.id,
        version: withdrawnLate.version,
        status: 'IN_PROGRESS',
      });
    });
  });

  it('a Staff deadline move after a provable breach writes nothing, so no breach is backdated', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      let job = await createLateDelivery(service, ctx.staffA, ctx.customerId);
      // Staff edit keeps ACCEPTED (manager edit would void acceptance).
      clock.now = new Date('2026-08-03T06:30:00.000Z');
      job = await service.patch(ctx.staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T09:00:00.000Z',
      } as never);
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);

      // Moving the deadline back into the past is refused before the new
      // revision is appended: no row can ever be backdated to a revision the
      // refused patch never created (OVR-5b §5, S3).
      clock.now = new Date('2026-08-03T10:00:00.000Z');
      await expect(service.patch(ctx.staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T07:00:00.000Z',
      } as never)).rejects.toMatchObject({
        code: 'DEADLINE_CHANGE_REQUIRES_MANAGEMENT',
        statusCode: 409,
      });
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
      const revisions = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_schedule_revisions
          WHERE organization_id = $1 AND job_card_id = $2`,
        [ctx.organizationId, job.id],
      );
      expect(revisions.rows[0]!.count).toBe('2');
    });
  });

  it('second submission episode breaches no earlier than its activation', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);
      // GENERAL_TASK with a future due date: the first submit lands on time
      // (no ep1 incident). START never attributes (no interval end).
      const futureDue = istanbulDate(shiftMs(baseline, 24 * 60 * 60_000));
      let job = (await service.create(ctx.staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Ikinci episode gorevi',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: ctx.staffA.id,
        priority: 'normal',
        dueDate: futureDue,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ilk gonderim.',
      });
      // Withdraw re-arms the episode while IN_PROGRESS (episode 2 activation
      // at its reservation); the dueDate move below needs an editable state.
      job = await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      // Move the due date into the past (new revision).
      await syncClock(pool, clock);
      const pastDue = istanbulDate(shiftMs(baseline, -24 * 60 * 60_000));
      const pastEnd = new Date(`${pastDue}T21:00:00.000Z`);
      job = await service.patch(ctx.staffA, job.id, {
        expectedVersion: job.version,
        dueDate: pastDue,
      } as never);
      const submitActionId = randomUUID();
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: submitActionId, expectedVersion: job.version,
        note: 'Ikinci gonderim.',
      });
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 2,
        schedule_revision_no: 2,
        accountable_user_id: ctx.staffAId,
      });
      // The breach starts at the patch that introduced the elapsed deadline —
      // never earlier than the provable episode activation (asserted below) —
      // and recovery runs at the submit reservation.
      expect(incidents[0]!.deadline_at).toEqual(shiftMs(pastEnd, 1));
      expect(incidents[0]!.breached_at).toEqual(clock.now);
      const activation = await pool.query<{ activated_at: Date }>(
        `SELECT activated_at FROM job_card_submission_episode_activations
          WHERE organization_id = $1 AND job_card_id = $2 AND episode_no = 2`,
        [ctx.organizationId, job.id],
      );
      expect(activation.rows).toHaveLength(1);
      expect((incidents[0]!.breached_at as Date).getTime())
        .toBeGreaterThanOrEqual(activation.rows[0]!.activated_at.getTime());
      const reservedSubmit = await reservedAtFor(
        pool, ctx.organizationId, job.id, `JOB_SUBMIT_FOR_APPROVAL:${job.id}`, submitActionId,
      );
      expect(incidents[0]!.recovered_at).toEqual(reservedSubmit);
    });
  });

  it('database still rejects breached_at before deadline_at', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      const job = await createLateDelivery(service, ctx.staffA, ctx.customerId);
      await expect(pool.query(
        `INSERT INTO job_card_overdue_incidents
           (organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
            deadline_at, breached_at, accountable_role, accountable_source, source)
         VALUES ($1, $2, 'LATE_START', 1, 1,
           '2026-08-03T07:30:00.000Z', '2026-08-03T07:29:00.000Z', 'STAFF', 'UNKNOWN', 'TRANSITION')`,
        [ctx.organizationId, job.id],
      )).rejects.toMatchObject({ code: '23514' });
    });
  });
});

describe.skipIf(!databaseUrl)('OVR-2 exact episode activation (candidate RED)', () => {
  async function setupOrg(pool: Pool) {
    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Exact', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Exact Manager');
    const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Exact Ayşe');
    const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Exact Mehmet');
    const customerId = await insertCustomer(pool, organizationId);
    return { organizationId, ...actors(organizationId, managerId, staffAId, staffBId), staffAId, staffBId, managerId, customerId };
  }

  /** GENERAL_TASK with an explicit organization-local due date, no delivery items. */
  async function createDueTask(service: JobCardService, staff: JobCardActor, dueDate: string): Promise<JobCard> {
    return (await service.create(staff, {
      clientActionId: randomUUID(),
      type: 'GENERAL_TASK',
      title: 'Teslim gorevi',
      description: null,
      customerId: null,
      contactId: null,
      assignedTo: staff.id,
      priority: 'normal',
      dueDate,
      scheduledAt: null,
      scheduledEndsAt: undefined,
      engagementKind: undefined,
    } as never)) as JobCard;
  }

  async function selectActivations(pool: Pool, organizationId: string, jobId: string) {
    return (await pool.query(
      `SELECT episode_no, activated_at, activated_by_command
         FROM job_card_submission_episode_activations
        WHERE organization_id = $1 AND job_card_id = $2
        ORDER BY episode_no`,
      [organizationId, jobId],
    )).rows as Record<string, unknown>[];
  }

  async function submittedSeqs(pool: Pool, organizationId: string, jobId: string) {
    return (await pool.query<{ seq_no: number }>(
      `SELECT seq_no FROM job_card_accountability_facts
        WHERE organization_id = $1 AND job_card_id = $2 AND fact_type = 'SUBMITTED'
        ORDER BY seq_no`,
      [organizationId, jobId],
    )).rows.map((row) => Number(row.seq_no));
  }

  it('A. withdraw after deadline opens the new episode at withdraw time', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const service = buildService(pool, clock);
      // Future due: the first submit lands on time (no ep1 incident).
      const futureDue = istanbulDate(shiftMs(baseline, 24 * 60 * 60_000));
      let job = (await service.create(ctx.staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Teslim gorevi',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: ctx.staffA.id,
        priority: 'normal',
        dueDate: futureDue,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ilk gonderim.',
      });
      // Model a day-old waiting approval so the withdraw finds the 24h wait
      // elapsed (the new obligation still starts at withdraw, not earlier).
      const submittedAt = shiftMs(baseline, -25 * 60 * 60_000);
      await rewindSubmissionTo(pool, ctx.organizationId, job.id, submittedAt);
      const withdrawActionId = randomUUID();
      job = await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: withdrawActionId, expectedVersion: job.version,
      });
      expect(job.status).toBe('IN_PROGRESS');

      // Move the due date into the past while IN_PROGRESS: the pending
      // episode binds the new revision from the patch requestTime.
      await syncClock(pool, clock);
      const pastDue = istanbulDate(shiftMs(baseline, -24 * 60 * 60_000));
      const pastEnd = new Date(`${pastDue}T21:00:00.000Z`);
      job = await service.patch(ctx.staffA, job.id, {
        expectedVersion: job.version,
        dueDate: pastDue,
      } as never);

      const activations = await selectActivations(pool, ctx.organizationId, job.id);
      expect(activations).toHaveLength(1);
      expect(activations[0]).toMatchObject({
        episode_no: 2,
        activated_by_command: 'WITHDRAW_FROM_APPROVAL',
      });
      const reservedWithdraw = await reservedAtFor(
        pool, ctx.organizationId, job.id, `JOB_WITHDRAW_FROM_APPROVAL:${job.id}`, withdrawActionId,
      );
      expect(activations[0]!.activated_at).toEqual(reservedWithdraw);

      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      // Two legitimate effects (§15): the 25h approval wait is recovered
      // (MANAGEMENT), the new staff episode opens.
      expect(incidents).toHaveLength(2);
      const byType = new Map(incidents.map((row) => [row.delay_type, row]));
      expect(byType.get('APPROVAL_WAIT')).toMatchObject({
        episode_no: 1,
        accountable_role: 'MANAGEMENT',
        deadline_at: shiftMs(submittedAt, 24 * 60 * 60_000),
        breached_at: shiftMs(submittedAt, 24 * 60 * 60_000),
        recovered_at: reservedWithdraw,
      });
      const late = byType.get('LATE_SUBMISSION')!;
      expect(late).toMatchObject({
        episode_no: 2,
        schedule_revision_no: 2,
        accountable_user_id: ctx.staffAId,
        accountable_role: 'STAFF',
      });
      expect(late.deadline_at).toEqual(shiftMs(pastEnd, 1));
      expect(late.breached_at).toEqual(clock.now);
      expect(late.recovered_at).toBeNull();

      // The later submit recovers the same incident; seq aligns with episode.
      const submitActionId = randomUUID();
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: submitActionId, expectedVersion: job.version,
        note: 'Ikinci gonderim.',
      });
      expect(await submittedSeqs(pool, ctx.organizationId, job.id)).toEqual([1, 2]);
      const after = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(after).toHaveLength(2);
      const afterByType = new Map(after.map((row) => [row.delay_type, row]));
      expect(afterByType.get('APPROVAL_WAIT')).toMatchObject({
        recovered_at: reservedWithdraw,
      });
      const reservedSubmit = await reservedAtFor(
        pool, ctx.organizationId, job.id, `JOB_SUBMIT_FOR_APPROVAL:${job.id}`, submitActionId,
      );
      expect(afterByType.get('LATE_SUBMISSION')).toMatchObject({
        episode_no: 2,
        recovered_at: reservedSubmit,
        recovery_actor_user_id: ctx.staffAId,
      });
    });
  });

  it('B. withdraw before deadline persists activation; later cancel proves breach', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const futureDue = istanbulDate(shiftMs(baseline, 2 * 86_400_000));
      const service = buildService(pool, clock);
      let job = await createDueTask(service, ctx.staffA, futureDue);
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ilk gonderim.',
      });
      // Withdraw before the deadline: activation persisted, no incident yet.
      job = await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      const withdrawnAt = await reservedAtFor(pool, ctx.organizationId, job.id, `JOB_WITHDRAW_FROM_APPROVAL:${job.id}`);
      const activations = await selectActivations(pool, ctx.organizationId, job.id);
      expect(activations).toHaveLength(1);
      expect(activations[0]!.activated_at).toEqual(withdrawnAt);
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);

      // Later cancel proves the episode was already active at the deadline:
      // breach at the first-late boundary, from durable evidence.
      // The writer assertion above uses the real reservation. Now construct a
      // coherent historical domain snapshot three days older, simulating elapsed
      // days without sleeping or changing the arbitration clock/intent receipt.
      await pool.query(`UPDATE job_cards SET due_date=due_date-3,
        started_at=started_at-interval '3 days' WHERE id=$1`, [job.id]);
      await pool.query(`UPDATE job_card_schedule_revisions SET due_date=due_date-3,
        created_at=created_at-interval '3 days' WHERE job_card_id=$1`, [job.id]);
      await pool.query(`UPDATE job_card_submission_episode_activations
        SET activated_at=activated_at-interval '3 days' WHERE job_card_id=$1`, [job.id]);
      await pool.query(`UPDATE job_card_accountability_facts SET occurred_at=occurred_at-interval '3 days'
        WHERE job_card_id=$1`, [job.id]);
      await pool.query(`UPDATE job_card_assignment_history SET changed_at=changed_at-interval '3 days'
        WHERE job_card_id=$1`, [job.id]);
      const firstLate = shiftMs(new Date(`${futureDue}T21:00:00.000Z`), -3 * 86_400_000 + 1);
      expect(shiftMs(withdrawnAt, -3 * 86_400_000).valueOf()).toBeLessThan(firstLate.valueOf());
      job = await service.cancel(ctx.manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(job.status).toBe('CANCELLED');
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 2,
        recovered_at: await reservedAtFor(pool, ctx.organizationId, job.id, `JOB_CANCEL:${job.id}`),
      });
      expect(incidents[0]!.deadline_at).toEqual(firstLate);
      expect(incidents[0]!.breached_at).toEqual(firstLate);
    });
  });

  it('C. repeated withdraw cycles keep independent episode identities', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const baseline = await dbBaseline(pool);
      const clock = { now: baseline };
      const futureDue = istanbulDate(shiftMs(baseline, 2 * 86_400_000));
      const service = buildService(pool, clock);
      let job = await createDueTask(service, ctx.staffA, futureDue);
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ilk gonderim.',
      });
      const withdrawId = randomUUID();
      const withdraw1Version = job.version;
      job = await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: withdrawId, expectedVersion: withdraw1Version,
      });
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ikinci gonderim.',
      });
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
      const withdraw1At = await reservedAtFor(pool, ctx.organizationId, job.id, `JOB_WITHDRAW_FROM_APPROVAL:${job.id}`, withdrawId);
      // Completed episode 2 has no breach. Model an already elapsed deadline
      // before re-arming episode 3; its activation must prevent backdating.
      const pastDue = istanbulDate(shiftMs(baseline, -2 * 86_400_000));
      await pool.query('UPDATE job_cards SET due_date=$2 WHERE id=$1', [job.id, pastDue]);
      await pool.query('UPDATE job_card_schedule_revisions SET due_date=$2 WHERE job_card_id=$1', [job.id, pastDue]);
      const withdraw2Id = randomUUID();
      job = await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: withdraw2Id, expectedVersion: job.version,
      });
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ucuncu gonderim.',
      });

      const withdraw2At = await reservedAtFor(pool, ctx.organizationId, job.id, `JOB_WITHDRAW_FROM_APPROVAL:${job.id}`, withdraw2Id);
      expect(await submittedSeqs(pool, ctx.organizationId, job.id)).toEqual([1, 2, 3]);
      const activations = await selectActivations(pool, ctx.organizationId, job.id);
      expect(activations.map((row) => row.episode_no)).toEqual([2, 3]);
      expect(activations[0]!.activated_at).toEqual(withdraw1At);
      expect(activations[1]!.activated_at).toEqual(withdraw2At);
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      // Episode 2 lived fully before the deadline; only episode 3 breached.
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 3,
        recovered_at: (await pool.query<{ staff_completed_at: Date }>('SELECT staff_completed_at FROM job_cards WHERE id=$1', [job.id])).rows[0]!.staff_completed_at,
      });
      expect(incidents[0]!.breached_at).toEqual(withdraw2At);

      // Replay of the first withdraw converges: still one activation row.
      await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: withdrawId, expectedVersion: withdraw1Version,
      });
      expect(await selectActivations(pool, ctx.organizationId, job.id)).toHaveLength(2);
    });
  });
});
