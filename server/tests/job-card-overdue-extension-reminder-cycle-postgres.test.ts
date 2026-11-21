/**
 * OVR-5a readers: the OVR-4 reminder cycle after an incident ending.
 *
 * Contract §4.9: delivery identity moves to the canonical open incident of an
 * episode, so an ending (written by OVR-5b) lets a later breach of the same
 * episode start one new reminder and escalation cycle, while a still-past
 * deadline move or a legacy delivery keeps deduplicating.
 *
 * The scenarios write ended rows, which only exist once OVR-5b is live. OVR-5b
 * ships migration 067, which drops the superseded 053 per-episode delivery key;
 * `simulatePost5bDeliveryIdentity` applies that one schema step inside the test
 * schema so the reader rule can be observed at the OVR-5a code level.
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
import { resolveOverdueReminderTiming } from '../src/modules/job-cards/overdue-reminder-policy.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const TIMING = resolveOverdueReminderTiming({});

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `ovr5a_cycle_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, name: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'UTC') RETURNING id`,
    [name],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'MANAGER' | 'STAFF',
  name: string,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
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
  return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** UTC-only helper: the organization-local midnight after a due date. */
function utcBoundaryAfter(dateKey: string): Date {
  return new Date(new Date(`${dateKey}T00:00:00.000Z`).getTime() + 86_400_000);
}

async function createTask(
  service: JobCardService,
  staff: JobCardActor,
  title: string,
  dueDate: string,
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
  } as never)) as unknown as JobCard;
}

async function startJob(service: JobCardService, staff: JobCardActor, job: JobCard): Promise<JobCard> {
  return (await service.start(staff, job.id, {
    clientActionId: randomUUID(), expectedVersion: job.version,
  })) as unknown as JobCard;
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
  recovered_at: Date | null;
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
            deadline_at, breached_at, recovered_at,
            ended_at, ended_by_user_id, end_reason, end_note,
            ended_by_schedule_revision_no
       FROM job_card_overdue_incidents
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY breached_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as IncidentRow[];
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
  )).rows as Array<{
    kind: string; episode_no: number; incident_id: string; sent_at: Date;
  }>;
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

async function selectAutoActivities(
  pool: Pool, organizationId: string, jobId: string,
): Promise<string[]> {
  return (await pool.query<{ event_type: string }>(
    `SELECT event_type FROM job_card_activity_logs
      WHERE organization_id = $1 AND job_card_id = $2
        AND event_type IN (
          'JOB_SUBMISSION_AUTO_REMINDER_SENT',
          'JOB_SUBMISSION_AUTO_ESCALATION_SENT')
      ORDER BY created_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows.map((row) => row.event_type);
}

async function endIncident(
  pool: Pool,
  incidentId: string,
  input: {
    endedAt: Date;
    endedByUserId: string;
    endNote: string;
    endedByScheduleRevisionNo: number;
  },
): Promise<void> {
  await pool.query(
    `UPDATE job_card_overdue_incidents
        SET ended_at = $2,
            ended_by_user_id = $3,
            end_reason = 'DEADLINE_EXTENDED',
            end_note = $4,
            ended_by_schedule_revision_no = $5
      WHERE id = $1`,
    [
      incidentId, input.endedAt, input.endedByUserId,
      input.endNote, input.endedByScheduleRevisionNo,
    ],
  );
}

/**
 * OVR-5b's migration 067 drops the superseded 053 per-episode delivery key and
 * keeps only the per-incident key. These scenarios read data OVR-5b wrote, so
 * they run on that schema shape. Under OVR-5a alone the 053 key still exists
 * (asserted by M1) and would refuse a second cycle of the same episode.
 */
async function simulatePost5bDeliveryIdentity(pool: Pool): Promise<void> {
  const superseded = (await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'job_card_overdue_notification_deliveries'::regclass
        AND contype = 'u'
        AND pg_get_constraintdef(oid) LIKE '%episode_no%'`,
  )).rows[0];
  if (!superseded) return;
  await pool.query(
    `ALTER TABLE job_card_overdue_notification_deliveries
       DROP CONSTRAINT "${superseded.conname}"`,
  );
}

async function insertLegacyDelivery(
  pool: Pool,
  input: {
    organizationId: string;
    jobId: string;
    incidentId: string;
    kind: 'STAFF_REMINDER' | 'MANAGEMENT_ESCALATION';
    sentAt: Date;
    recipientUserId: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO job_card_overdue_notification_deliveries
       (organization_id, job_card_id, delay_type, episode_no, kind,
        incident_id, sent_at, recipient_user_id)
     VALUES ($1, $2, 'LATE_SUBMISSION', 1, $3, $4, $5, $6)`,
    [
      input.organizationId, input.jobId, input.kind,
      input.incidentId, input.sentAt, input.recipientUserId,
    ],
  );
}

describe.skipIf(!databaseUrl)('OVR-5a reminder cycle after an ending (PostgreSQL)', () => {
  it('N1: an ending lets the next breach of the episode start a fresh reminder cycle', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a N1');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const manager = { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor;
      const staff = { id: staffId, organizationId, role: 'STAFF' } as JobCardActor;
      // Ended rows only exist once OVR-5b is live (migration 067), so this
      // whole scenario runs on that delivery identity.
      await simulatePost5bDeliveryIdentity(pool);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      let job = await createTask(service, staff, 'Döngülü gecikme', dateKeyShift(clock.now, -3));
      job = await startJob(service, staff, job);
      await scanOnce(pool, await dbBaseline(pool));

      const firstIncident = (await selectIncidents(pool, organizationId, job.id))[0]!;
      expect(firstIncident).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        schedule_revision_no: 1,
        recovered_at: null,
        ended_at: null,
      });

      // First cycle: staff reminder at +15m, escalation at +60m.
      const worker = reminderWorker(pool);
      const reminded = await worker.runOnce(shiftMs(firstIncident.breached_at, 15 * 60_000));
      expect(reminded.sent).toBe(1);
      expect(reminded.byKind).toMatchObject({ STAFF_REMINDER: 1, MANAGEMENT_ESCALATION: 0 });
      const escalated = await worker.runOnce(shiftMs(firstIncident.breached_at, 60 * 60_000));
      expect(escalated.sent).toBe(1);
      expect(escalated.byKind).toMatchObject({ STAFF_REMINDER: 0, MANAGEMENT_ESCALATION: 1 });

      let deliveries = await selectDeliveries(pool, organizationId, job.id);
      expect(deliveries).toHaveLength(2);
      expect(deliveries.map((row) => row.kind).sort())
        .toEqual(['MANAGEMENT_ESCALATION', 'STAFF_REMINDER']);
      expect(deliveries.every((row) => row.incident_id === firstIncident.id)).toBe(true);

      // OVR-5b would end this obligation when management extends the deadline.
      await endIncident(pool, firstIncident.id, {
        endedAt: shiftMs(firstIncident.breached_at, 90 * 60_000),
        endedByUserId: managerId,
        endNote: 'Müşteri randevusu ertelendi.',
        endedByScheduleRevisionNo: 1,
      });

      // A newer schedule revision with a future deadline. OVR-5a writes no
      // ending, so the reader-side ending above is the simulated 5b write.
      clock.now = await dbBaseline(pool);
      const futureDueDate = dateKeyShift(clock.now, 2);
      const nextDeadline = utcBoundaryAfter(futureDueDate);
      job = await service.patch(manager, job.id, {
        expectedVersion: job.version, dueDate: futureDueDate,
      } as never) as unknown as JobCard;

      // The scanner breaches the new revision when the new deadline passes.
      const nextBreach = shiftMs(nextDeadline, 1);
      const scanReport = await scanOnce(pool, nextBreach);
      expect(scanReport.inserted).toBe(1);
      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(2);
      const endedRow = incidents.find((row) => row.id === firstIncident.id)!;
      expect(endedRow.ended_at).not.toBeNull();
      expect(endedRow.recovered_at).toBeNull();
      const nextIncident = incidents.find((row) => row.id !== firstIncident.id)!;
      expect(nextIncident).toMatchObject({
        episode_no: 1,
        schedule_revision_no: 2,
        recovered_at: null,
        ended_at: null,
      });
      expect(nextIncident.deadline_at).toEqual(nextBreach);
      expect(nextIncident.breached_at).toEqual(nextBreach);

      // Second cycle for the new canonical open incident.
      const nextReminder = await worker.runOnce(shiftMs(nextBreach, 15 * 60_000));
      expect(nextReminder.sent).toBe(1);
      expect(nextReminder.byKind).toMatchObject({ STAFF_REMINDER: 1, MANAGEMENT_ESCALATION: 0 });
      const nextEscalation = await worker.runOnce(shiftMs(nextBreach, 60 * 60_000));
      expect(nextEscalation.sent).toBe(1);
      expect(nextEscalation.byKind).toMatchObject({
        STAFF_REMINDER: 0, MANAGEMENT_ESCALATION: 1,
      });

      deliveries = await selectDeliveries(pool, organizationId, job.id);
      expect(deliveries.filter((row) => row.incident_id === firstIncident.id)).toHaveLength(2);
      expect(deliveries.filter((row) => row.incident_id === nextIncident.id)).toHaveLength(2);
      expect(deliveries.filter((row) => row.incident_id === nextIncident.id)
        .map((row) => row.kind).sort())
        .toEqual(['MANAGEMENT_ESCALATION', 'STAFF_REMINDER']);

      const notifications = await selectNotifications(pool, organizationId, job.id);
      expect(notifications.filter((row) => row.kind === 'job.submission_auto_reminder'))
        .toHaveLength(2);
      expect(notifications.filter((row) => row.kind === 'job.submission_auto_escalation'))
        .toHaveLength(2);
      const activities = await selectAutoActivities(pool, organizationId, job.id);
      expect(activities.filter((event) => event === 'JOB_SUBMISSION_AUTO_REMINDER_SENT'))
        .toHaveLength(2);
      expect(activities.filter((event) => event === 'JOB_SUBMISSION_AUTO_ESCALATION_SENT'))
        .toHaveLength(2);
    });
  });

  it('N2: a still-past deadline move without an ending starts no new cycle', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a N2');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const manager = { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor;
      const staff = { id: staffId, organizationId, role: 'STAFF' } as JobCardActor;
      await simulatePost5bDeliveryIdentity(pool);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      let job = await createTask(service, staff, 'Geçmiş tarih işi', dateKeyShift(clock.now, -3));
      job = await startJob(service, staff, job);
      await scanOnce(pool, await dbBaseline(pool));
      const firstIncident = (await selectIncidents(pool, organizationId, job.id))[0]!;

      const worker = reminderWorker(pool);
      await worker.runOnce(shiftMs(firstIncident.breached_at, 15 * 60_000));
      await worker.runOnce(shiftMs(firstIncident.breached_at, 60 * 60_000));
      expect(await selectDeliveries(pool, organizationId, job.id)).toHaveLength(2);
      const notificationsBefore = await selectNotifications(pool, organizationId, job.id);
      expect(notificationsBefore).toHaveLength(2);

      // The B2 move is still in the past: it appends a new revision and its
      // own already-breached incident, but ends nothing.
      clock.now = await dbBaseline(pool);
      job = await service.patch(manager, job.id, {
        expectedVersion: job.version, dueDate: dateKeyShift(clock.now, -2),
      } as never) as unknown as JobCard;

      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(2);
      expect(incidents.every((row) => row.ended_at === null && row.recovered_at === null)).toBe(true);
      expect(incidents.map((row) => row.schedule_revision_no).sort()).toEqual([1, 2]);

      // The earlier open row stays canonical and its delivered kinds are
      // durable: neither a shift of the canonical row nor the B2 row can start
      // a second cycle.
      const scanTime = shiftMs(clock.now, 2 * 60 * 60_000);
      expect(scanTime.getTime()).toBeGreaterThan(
        Math.max(...incidents.map((row) => row.breached_at.getTime())),
      );
      const report = await worker.runOnce(scanTime);
      expect(report.candidates).toBe(0);
      expect(report.sent).toBe(0);
      expect(report.byKind).toMatchObject({ STAFF_REMINDER: 0, MANAGEMENT_ESCALATION: 0 });
      expect(await selectDeliveries(pool, organizationId, job.id)).toHaveLength(2);
      expect(await selectNotifications(pool, organizationId, job.id)).toHaveLength(2);
      expect(await selectAutoActivities(pool, organizationId, job.id)).toHaveLength(2);
    });
  });

  it('N3: deliveries recorded before any ending keep deduplicating their episode', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a N3');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const manager = { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor;
      const staff = { id: staffId, organizationId, role: 'STAFF' } as JobCardActor;
      await simulatePost5bDeliveryIdentity(pool);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      let job = await createTask(service, staff, 'Eski teslimat işi', dateKeyShift(clock.now, -3));
      job = await startJob(service, staff, job);
      await scanOnce(pool, await dbBaseline(pool));
      const firstIncident = (await selectIncidents(pool, organizationId, job.id))[0]!;

      // Legacy state recorded before 066: one delivery per episode and kind,
      // referencing the canonical incident. Both rows also satisfy the 053 key.
      const legacyStaffAt = shiftMs(firstIncident.breached_at, 15 * 60_000);
      const legacyEscalationAt = shiftMs(firstIncident.breached_at, 60 * 60_000);
      await insertLegacyDelivery(pool, {
        organizationId, jobId: job.id, incidentId: firstIncident.id,
        kind: 'STAFF_REMINDER', sentAt: legacyStaffAt, recipientUserId: staffId,
      });
      await insertLegacyDelivery(pool, {
        organizationId, jobId: job.id, incidentId: firstIncident.id,
        kind: 'MANAGEMENT_ESCALATION', sentAt: legacyEscalationAt,
        recipientUserId: managerId,
      });

      // A still-past move adds a second revision-bound incident, but the
      // legacy deliveries still reference the open canonical incident.
      clock.now = await dbBaseline(pool);
      job = await service.patch(manager, job.id, {
        expectedVersion: job.version, dueDate: dateKeyShift(clock.now, -2),
      } as never) as unknown as JobCard;
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(2);

      const report = await reminderWorker(pool).runOnce(shiftMs(clock.now, 2 * 60 * 60_000));
      expect(report.candidates).toBe(0);
      expect(report.sent).toBe(0);
      expect(await selectDeliveries(pool, organizationId, job.id)).toHaveLength(2);

      // The per-incident delivery read still resolves the legacy rows for the
      // canonical incident, so the snapshot keeps the proven instants.
      const snapshot = await service.getSubmissionLateness(manager, job.id);
      expect(snapshot.open).not.toBeNull();
      expect(snapshot.open!.incidentId).toBe(firstIncident.id);
      expect(snapshot.open!.staffReminderSentAt).toBe(legacyStaffAt.toISOString());
      expect(snapshot.open!.escalationSentAt).toBe(legacyEscalationAt.toISOString());
    });
  });
});
