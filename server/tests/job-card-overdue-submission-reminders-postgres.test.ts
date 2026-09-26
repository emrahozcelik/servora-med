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
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const TIMING = resolveOverdueReminderTiming({});

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `ovr4_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, name: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [name],
  )).rows[0]!.id;
}

function buildService(
  pool: Pool,
  clock: { now: Date },
  publisher?: RealtimeEventPublisher,
): { service: JobCardService; published: RealtimeEventRecord[] } {
  const published: RealtimeEventRecord[] = [];
  const effective: RealtimeEventPublisher = publisher ?? {
    publish: (event) => published.push(event),
  };
  const service = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    effective,
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
  return { service, published };
}

function actors(organizationId: string, managerId: string, staffAId: string, staffBId: string) {
  return {
    manager: { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
    staffA: { id: staffAId, organizationId, role: 'STAFF' } as JobCardActor,
    staffB: { id: staffBId, organizationId, role: 'STAFF' } as JobCardActor,
  };
}

function shiftMs(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

async function dbBaseline(pool: Pool): Promise<Date> {
  return (await pool.query<{ now: Date }>(
    "SELECT date_trunc('milliseconds', clock_timestamp()) AS now",
  )).rows[0]!.now;
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
  } as never)) as JobCard;
}

async function startJob(service: JobCardService, staff: JobCardActor, job: JobCard): Promise<JobCard> {
  return service.start(staff, job.id, {
    clientActionId: randomUUID(), expectedVersion: job.version,
  });
}

async function submitJob(service: JobCardService, staff: JobCardActor, job: JobCard): Promise<JobCard> {
  return service.submitForApproval(staff, job.id, {
    clientActionId: randomUUID(), expectedVersion: job.version,
    note: 'Tamamlandı, kontrole gönderildi.',
  });
}

type IncidentRow = {
  id: string; delay_type: string; episode_no: number; schedule_revision_no: number;
  deadline_at: Date; breached_at: Date; accountable_user_id: string | null;
  accountable_role: string; source: string; recovered_at: Date | null;
  recovery_actor_user_id: string | null;
};

async function selectIncidents(
  pool: Pool, organizationId: string, jobId: string,
): Promise<IncidentRow[]> {
  return (await pool.query(
    `SELECT id, delay_type, episode_no, schedule_revision_no,
            deadline_at, breached_at, accountable_user_id, accountable_role,
            source, recovered_at, recovery_actor_user_id
       FROM job_card_overdue_incidents
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY breached_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as IncidentRow[];
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

async function selectActivities(pool: Pool, organizationId: string, jobId: string): Promise<string[]> {
  return (await pool.query<{ event_type: string }>(
    `SELECT event_type FROM job_card_activity_logs
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY created_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows.map((row) => row.event_type);
}

async function selectDeliveries(
  pool: Pool, organizationId: string, jobId: string,
): Promise<Array<{ kind: string; episode_no: number; sent_at: Date; recipient_user_id: string | null }>> {
  return (await pool.query(
    `SELECT kind, episode_no, sent_at, recipient_user_id
       FROM job_card_overdue_notification_deliveries
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY sent_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as Array<{ kind: string; episode_no: number; sent_at: Date; recipient_user_id: string | null }>;
}

async function selectManualReminders(
  pool: Pool, organizationId: string, jobId: string,
): Promise<Array<{ manager_user_id: string; target_staff_user_id: string; sent_at: Date; client_action_id: string }>> {
  return (await pool.query(
    `SELECT manager_user_id, target_staff_user_id, sent_at, client_action_id
       FROM job_card_submission_reminders
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY sent_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as Array<{
    manager_user_id: string; target_staff_user_id: string; sent_at: Date; client_action_id: string;
  }>;
}

async function reservedAtFor(
  pool: Pool, organizationId: string, jobCardId: string, operationKey: string,
): Promise<Date> {
  const row = (await pool.query<{ reserved_at: Date }>(
    `SELECT reserved_at FROM job_card_lifecycle_intents
      WHERE organization_id = $1 AND job_card_id = $2 AND operation_key = $3
      ORDER BY reserved_at DESC, id DESC LIMIT 1`,
    [organizationId, jobCardId, operationKey],
  )).rows[0];
  if (!row) throw new Error(`missing lifecycle intent for ${operationKey}`);
  return row.reserved_at;
}

async function scanOnce(pool: Pool, scanTime: Date) {
  const repository = new PostgresJobCardRepository(pool);
  const scanner = createOverdueBreachScanner(
    new PostgresOverdueBreachScannerRepository(repository), { batchSize: 50 },
  );
  return scanner.runOnce(scanTime);
}

function reminderWorker(pool: Pool, published: RealtimeEventRecord[]) {
  const repository = new PostgresJobCardRepository(pool);
  return createOverdueReminderWorker(
    new PostgresOverdueReminderWorkerRepository(repository, false),
    {
      publisher: { publish: (event) => published.push(event) },
      timing: {},
      batchSize: 50,
    },
  );
}

describe('OVR-4 LATE_SUBMISSION operational closure', () => {
  it('1: on-time START + SUBMIT produces no incident, reminder or escalation', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Zamanında görev', dueDate });
      job = await startJob(service, staffA, job);
      job = await submitJob(service, staffA, job);
      expect(job.status).toBe('WAITING_APPROVAL');

      const scanTime = await dbBaseline(pool);
      await scanOnce(pool, scanTime);
      const published: RealtimeEventRecord[] = [];
      const report = await reminderWorker(pool, published).runOnce(scanTime);
      expect(report.candidates).toBe(0);
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);
      expect(await selectDeliveries(pool, organizationId, job.id)).toHaveLength(0);
      // The on-time SUBMIT still notifies management (existing
      // job.awaiting_approval contract); only late-submission signals matter.
      const lateSignals = (await selectNotifications(pool, organizationId, job.id))
        .filter((n) => n.kind.startsWith('job.submission_'));
      expect(lateSignals).toHaveLength(0);

      const snapshot = await service.getSubmissionLateness(staffA, job.id);
      expect(snapshot.open).toBeNull();
      const history = await service.listOverdueIncidents(
        { id: managerId, organizationId, role: 'MANAGER' }, job.id, { limit: 25, offset: 0 },
      );
      expect(history.total).toBe(0);
    });
  });

  it('2: a passed submission deadline materializes exactly one LATE_SUBMISSION incident', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Geciken görev', dueDate });
      job = await startJob(service, staffA, job);
      expect(job.status).toBe('IN_PROGRESS');

      // No incident yet: clock-only lateness needs the scanner, never the
      // lifecycle path that just ran.
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);
      const scanTime = await dbBaseline(pool);
      const scanReport = await scanOnce(pool, scanTime);
      expect(scanReport.inserted).toBe(1);

      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        accountable_user_id: staffAId,
        accountable_role: 'STAFF',
        source: 'SCANNER',
      });
      expect(incidents[0]!.recovered_at).toBeNull();

      // A second scan converges instead of duplicating history.
      const repeat = await scanOnce(pool, shiftMs(scanTime, 60_000));
      expect(repeat.inserted).toBe(0);
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(1);
    });
  });

  it('3: +15m staff reminder fires once and survives repeat scans and restarts', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Hatırlatmalı görev', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));
      const breachedAt = (await selectIncidents(pool, organizationId, job.id))[0]!.breached_at;

      const published: RealtimeEventRecord[] = [];
      const worker = reminderWorker(pool, published);

      const early = await worker.runOnce(shiftMs(breachedAt, 14 * 60_000));
      expect(early.sent).toBe(0);
      expect(early.skippedNotDue).toBe(1);
      expect(await selectNotifications(pool, organizationId, job.id)).toHaveLength(0);

      const due = await worker.runOnce(shiftMs(breachedAt, 15 * 60_000));
      expect(due.sent).toBe(1);
      expect(due.byKind).toMatchObject({ STAFF_REMINDER: 1, MANAGEMENT_ESCALATION: 0 });

      const notifications = await selectNotifications(pool, organizationId, job.id);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        recipient_user_id: staffAId, kind: 'job.submission_auto_reminder',
      });
      const deliveries = await selectDeliveries(pool, organizationId, job.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ kind: 'STAFF_REMINDER', episode_no: 1 });
      expect(deliveries[0]!.sent_at).toEqual(shiftMs(breachedAt, 15 * 60_000));
      expect(await selectActivities(pool, organizationId, job.id)).toContain(
        'JOB_SUBMISSION_AUTO_REMINDER_SENT',
      );

      // Repeat scan with the same worker and a fresh worker (restart) converge.
      const repeat = await worker.runOnce(shiftMs(breachedAt, 16 * 60_000));
      expect(repeat.sent).toBe(0);
      expect(repeat.converged).toBe(1);
      const restarted = await reminderWorker(pool, []).runOnce(shiftMs(breachedAt, 30 * 60_000));
      expect(restarted.sent).toBe(0);
      expect(await selectNotifications(pool, organizationId, job.id)).toHaveLength(1);
    });
  });

  it('4: +60m management escalation fires once without duplicates', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Yükselen görev', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));
      const breachedAt = (await selectIncidents(pool, organizationId, job.id))[0]!.breached_at;

      const published: RealtimeEventRecord[] = [];
      const worker = reminderWorker(pool, published);
      await worker.runOnce(shiftMs(breachedAt, 15 * 60_000));

      const early = await worker.runOnce(shiftMs(breachedAt, 59 * 60_000));
      expect(early.byKind.MANAGEMENT_ESCALATION).toBe(0);

      const due = await worker.runOnce(shiftMs(breachedAt, 60 * 60_000));
      expect(due.sent).toBe(1);
      expect(due.byKind).toMatchObject({ MANAGEMENT_ESCALATION: 1 });

      const notifications = await selectNotifications(pool, organizationId, job.id);
      const escalations = notifications.filter((n) => n.kind === 'job.submission_auto_escalation');
      expect(escalations).toHaveLength(1);
      expect(escalations[0]!.recipient_user_id).toBe(managerId);
      expect(await selectActivities(pool, organizationId, job.id)).toContain(
        'JOB_SUBMISSION_AUTO_ESCALATION_SENT',
      );

      const repeat = await worker.runOnce(shiftMs(breachedAt, 120 * 60_000));
      expect(repeat.sent).toBe(0);
      expect((await selectNotifications(pool, organizationId, job.id))
        .filter((n) => n.kind === 'job.submission_auto_escalation')).toHaveLength(1);
    });
  });

  it('5: late SUBMIT recovers with the submit request time and stops further reminders', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Geç gönderilen görev', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));
      const breachedAt = (await selectIncidents(pool, organizationId, job.id))[0]!.breached_at;

      const published: RealtimeEventRecord[] = [];
      await reminderWorker(pool, published).runOnce(shiftMs(breachedAt, 15 * 60_000));
      const notificationsBefore = (await selectNotifications(pool, organizationId, job.id))
        .filter((n) => n.kind.startsWith('job.submission_'));

      await syncClock(pool, clock);
      job = await submitJob(service, staffA, job);
      expect(job.status).toBe('WAITING_APPROVAL');

      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      const reservedSubmit = await reservedAtFor(
        pool, organizationId, job.id, `JOB_SUBMIT_FOR_APPROVAL:${job.id}`,
      );
      expect(incidents[0]!.recovered_at).toEqual(reservedSubmit);

      const history = await service.listOverdueIncidents(manager, job.id, { limit: 25, offset: 0 });
      expect(history.items).toHaveLength(1);
      const expectedTotal = Math.floor(
        (reservedSubmit.getTime() - breachedAt.getTime()) / 1000,
      );
      expect(history.items[0]!.totalDelaySeconds).toBe(expectedTotal);
      expect(history.items[0]!.manualReminderSentAt).toBeNull();
      expect(history.items[0]!.postReminderDelaySeconds).toBeNull();

      // No APPROVAL_WAIT side effect from this flow and no further reminders.
      expect(incidents.filter((row) => row.delay_type !== 'LATE_SUBMISSION')).toHaveLength(0);
      const after = await reminderWorker(pool, []).runOnce(shiftMs(breachedAt, 180 * 60_000));
      expect(after.candidates).toBe(0);
      expect((await selectNotifications(pool, organizationId, job.id))
        .filter((n) => n.kind.startsWith('job.submission_'))).toHaveLength(
        notificationsBefore.length,
      );
      const snapshot = await service.getSubmissionLateness(staffA, job.id);
      expect(snapshot.open).toBeNull();
    });
  });

  it('6: manual manager reminder creates one immutable fact and replays idempotently', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Manuel hatırlatmalı görev', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));
      const incidentId = (await selectIncidents(pool, organizationId, job.id))[0]!.id;

      await syncClock(pool, clock);
      const clientActionId = randomUUID();
      const first = await service.sendSubmissionReminder(manager, job.id, {
        clientActionId, expectedVersion: job.version,
      });
      expect(first.jobCardId).toBe(job.id);
      expect(first.sentAt).toBe(clock.now.toISOString());

      const facts = await selectManualReminders(pool, organizationId, job.id);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        manager_user_id: managerId,
        target_staff_user_id: staffAId,
        client_action_id: clientActionId,
      });
      expect(facts[0]!.sent_at).toEqual(clock.now);

      const activities = await selectActivities(pool, organizationId, job.id);
      expect(activities.filter((event) => event === 'JOB_SUBMISSION_REMINDER_SENT')).toHaveLength(1);
      const notifications = await selectNotifications(pool, organizationId, job.id);
      expect(notifications.filter((n) => n.kind === 'job.submission_reminder')).toHaveLength(1);
      expect(notifications.find((n) => n.kind === 'job.submission_reminder')).toMatchObject({
        recipient_user_id: staffAId,
      });

      // Double-click with the same clientActionId replays without duplication.
      const replayed = await service.sendSubmissionReminder(manager, job.id, {
        clientActionId, expectedVersion: job.version,
      });
      expect(replayed).toEqual(first);
      expect(await selectManualReminders(pool, organizationId, job.id)).toHaveLength(1);
      expect((await selectNotifications(pool, organizationId, job.id))
        .filter((n) => n.kind === 'job.submission_reminder')).toHaveLength(1);
      expect((await selectActivities(pool, organizationId, job.id))
        .filter((event) => event === 'JOB_SUBMISSION_REMINDER_SENT')).toHaveLength(1);

      // The snapshot exposes the manual reminder without guessing.
      const snapshot = await service.getSubmissionLateness(manager, job.id);
      expect(snapshot.open).not.toBeNull();
      expect(snapshot.open!.manualReminderCount).toBe(1);
      expect(snapshot.open!.manualReminderSentAt).toBe(clock.now.toISOString());
      expect(snapshot.open!.incidentId).toBe(incidentId);
    });
  });

  it('7: submit after a manual reminder measures the post-reminder delay', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Ölçülen görev', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));
      const breachedAt = (await selectIncidents(pool, organizationId, job.id))[0]!.breached_at;

      await syncClock(pool, clock);
      const reminderSentAt = clock.now;
      await service.sendSubmissionReminder(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });

      await syncClock(pool, clock);
      job = await submitJob(service, staffA, job);
      const reservedSubmit = await reservedAtFor(
        pool, organizationId, job.id, `JOB_SUBMIT_FOR_APPROVAL:${job.id}`,
      );

      const history = await service.listOverdueIncidents(manager, job.id, { limit: 25, offset: 0 });
      expect(history.items).toHaveLength(1);
      expect(history.items[0]!.manualReminderSentAt).toBe(reminderSentAt.toISOString());
      expect(history.items[0]!.manualReminderCount).toBe(1);
      expect(history.items[0]!.totalDelaySeconds).toBe(
        Math.floor((reservedSubmit.getTime() - breachedAt.getTime()) / 1000),
      );
      expect(history.items[0]!.postReminderDelaySeconds).toBe(
        Math.floor((reservedSubmit.getTime() - reminderSentAt.getTime()) / 1000),
      );
    });
  });

  it('8: episodes without a manual reminder never invent one', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Hatırlatmasız görev', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));
      await syncClock(pool, clock);
      job = await submitJob(service, staffA, job);

      const history = await service.listOverdueIncidents(manager, job.id, { limit: 25, offset: 0 });
      expect(history.items).toHaveLength(1);
      expect(history.items[0]!.manualReminderCount).toBe(0);
      expect(history.items[0]!.manualReminderSentAt).toBeNull();
      expect(history.items[0]!.postReminderDelaySeconds).toBeNull();
      expect(history.items[0]!.totalDelaySeconds).not.toBeNull();
    });
  });

  it('9: mid-episode mutation paths stay closed, so no revision can rewrite the open breach', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Revizyonlu görev', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));
      const before = (await selectIncidents(pool, organizationId, job.id))[0]!;

      // The domain closes schedule/assignee mutation once the job leaves
      // ACCEPTED, so no reachable path can rebind or erase the open breach.
      await syncClock(pool, clock);
      const revisedAt = shiftMs(await dbBaseline(pool), 60 * 60_000);
      await expect(service.patch(manager, job.id, {
        expectedVersion: job.version,
        scheduledAt: revisedAt.toISOString(),
      } as never)).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });
      await expect(service.patch(manager, job.id, {
        expectedVersion: job.version, assignedTo: staffBId,
      } as never)).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });

      const after = await selectIncidents(pool, organizationId, job.id);
      expect(after).toHaveLength(1);
      expect(after[0]!.deadline_at).toEqual(before.deadline_at);
      expect(after[0]!.breached_at).toEqual(before.breached_at);
      expect(after[0]!.recovered_at).toBeNull();

      const snapshot = await service.getSubmissionLateness(manager, job.id);
      expect(snapshot.open!.breachedAt).toBe(before.breached_at.toISOString());
    });
  });

  it('10: pre-breach reassignment resolves accountability at the breach instant', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { manager, staffA, staffB } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      // Reassignment while ACCEPTED is the reachable domain path; immutable
      // assignment history then proves staffB (not the creator staffA) at
      // the later breach instant.
      let job = await createTask(service, staffA, { title: 'Devredilen görev', dueDate });
      await syncClock(pool, clock);
      const reassigned = await service.patch(manager, job.id, {
        expectedVersion: job.version, assignedTo: staffBId,
      } as never);
      expect(reassigned.assignedTo).toBe(staffBId);
      // Management reassignment of an ACCEPTED job returns it to NEW, so the
      // new assignee accepts before starting.
      const accepted = await service.acceptAssignment(staffB, reassigned.id, {
        clientActionId: randomUUID(), expectedVersion: reassigned.version,
      });

      job = await startJob(service, staffB, accepted);
      await scanOnce(pool, await dbBaseline(pool));
      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]!.accountable_user_id).toBe(staffBId);
      const breachedAt = incidents[0]!.breached_at;

      const published: RealtimeEventRecord[] = [];
      const due = await reminderWorker(pool, published).runOnce(shiftMs(breachedAt, 15 * 60_000));
      expect(due.sent).toBe(1);
      // The reassignment itself notifies staffB (existing job.reassigned
      // contract); only the late-submission signal matters here.
      const notifications = (await selectNotifications(pool, organizationId, job.id))
        .filter((n) => n.kind.startsWith('job.submission_'));
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        recipient_user_id: staffBId, kind: 'job.submission_auto_reminder',
      });
    });
  });

  it('11: concurrent workers converge on a single delivery per episode and kind', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      const job = await startJob(
        service, staffA, await createTask(service, staffA, { title: 'Yarışan görev', dueDate }),
      );
      await scanOnce(pool, await dbBaseline(pool));
      const breachedAt = (await selectIncidents(pool, organizationId, job.id))[0]!.breached_at;

      const repository = new PostgresJobCardRepository(pool);
      const workerRepository = new PostgresOverdueReminderWorkerRepository(repository, false);
      const scanTime = shiftMs(breachedAt, 61 * 60_000);
      const candidate = { organizationId, jobCardId: job.id };
      const [first, second] = await Promise.all([
        workerRepository.processCandidate({ candidate, scanTime, timing: TIMING }),
        workerRepository.processCandidate({ candidate, scanTime, timing: TIMING }),
      ]);
      const outcomes = [first.outcome.kind, second.outcome.kind].sort();
      expect(outcomes).toEqual(['converged', 'sent']);

      const deliveries = await selectDeliveries(pool, organizationId, job.id);
      expect(deliveries.filter((d) => d.kind === 'STAFF_REMINDER')).toHaveLength(1);
      expect(deliveries.filter((d) => d.kind === 'MANAGEMENT_ESCALATION')).toHaveLength(1);
      const notifications = await selectNotifications(pool, organizationId, job.id);
      expect(notifications.filter((n) => n.kind === 'job.submission_auto_reminder')).toHaveLength(1);
      expect(notifications.filter((n) => n.kind === 'job.submission_auto_escalation')).toHaveLength(1);
    });
  });

  it('12: manual reminder on a recovered incident fails closed', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Kapanan görev', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));
      await syncClock(pool, clock);
      job = await submitJob(service, staffA, job);
      expect(job.status).toBe('WAITING_APPROVAL');

      await expect(service.sendSubmissionReminder(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      })).rejects.toMatchObject({ code: 'SUBMISSION_REMINDER_NOT_APPLICABLE', statusCode: 409 });
      expect(await selectManualReminders(pool, organizationId, job.id)).toHaveLength(0);
    });
  });

  it('13: STAFF cannot invoke the manager reminder action', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { staffA, staffB } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Yetkisiz görev', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));

      await expect(service.sendSubmissionReminder(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(service.sendSubmissionReminder(staffB, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      expect(await selectManualReminders(pool, organizationId, job.id)).toHaveLength(0);
    });
  });

  it('14: cross-tenant access leaks nothing', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { staffA, staffB } = actors(organizationId, managerId, staffAId, staffBId);

      const otherOrgId = await insertOrg(pool, 'OVR4 Diğer Org');
      const otherManagerId = await insertUser(pool, otherOrgId, 'MANAGER', 'Diğer Müdür');
      const otherStaffId = await insertUser(pool, otherOrgId, 'STAFF', 'Diğer Personel');
      const otherManager = { id: otherManagerId, organizationId: otherOrgId, role: 'MANAGER' } as JobCardActor;
      const otherStaff = { id: otherStaffId, organizationId: otherOrgId, role: 'STAFF' } as JobCardActor;

      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Komşu görev', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));

      await expect(service.getSubmissionLateness(otherManager, job.id))
        .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      await expect(service.getSubmissionLateness(otherStaff, job.id))
        .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      await expect(service.sendSubmissionReminder(otherManager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      await expect(service.listOverdueIncidents(otherManager, job.id, { limit: 25, offset: 0 }))
        .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      // Same-org staff that does not own the job sees the same concealment
      // through the existing detail guard.
      await expect(service.getSubmissionLateness(staffB, job.id))
        .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      expect(await selectManualReminders(pool, organizationId, job.id)).toHaveLength(0);
    });
  });

  it('15: legacy and on-time evidence is never estimated', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      // On-time and still running: no deadline passed, so no snapshot, no
      // history, and the worker has nothing to do.
      let job = await createTask(service, staffA, { title: 'Süren görev', dueDate });
      job = await startJob(service, staffA, job);
      const scanTime = await dbBaseline(pool);
      await scanOnce(pool, scanTime);
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);

      const report = await reminderWorker(pool, []).runOnce(scanTime);
      expect(report.candidates).toBe(0);
      expect((await service.getSubmissionLateness(staffA, job.id)).open).toBeNull();
      expect((await service.listOverdueIncidents(manager, job.id, { limit: 25, offset: 0 })).total)
        .toBe(0);

      // Awaiting approval without lateness is not a submission episode either.
      await syncClock(pool, clock);
      job = await submitJob(service, staffA, job);
      expect((await service.getSubmissionLateness(manager, job.id)).open).toBeNull();
    });
  });

  it('17: escalation is not starved by an unprovable staff recipient', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Pasif personelli görev', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));
      const breachedAt = (await selectIncidents(pool, organizationId, job.id))[0]!.breached_at;

      // The assignee leaves mid-episode: the staff reminder has no provable
      // recipient, but the management escalation must still fire.
      await pool.query(
        `UPDATE users SET is_active = FALSE WHERE organization_id = $1 AND id = $2`,
        [organizationId, staffAId],
      );

      const published: RealtimeEventRecord[] = [];
      const due = await reminderWorker(pool, published)
        .runOnce(shiftMs(breachedAt, 61 * 60_000));
      expect(due.sent).toBe(1);
      expect(due.byKind).toMatchObject({ STAFF_REMINDER: 0, MANAGEMENT_ESCALATION: 1 });

      const notifications = await selectNotifications(pool, organizationId, job.id);
      expect(notifications.filter((n) => n.kind === 'job.submission_auto_reminder')).toHaveLength(0);
      expect(notifications.filter((n) => n.kind === 'job.submission_auto_escalation')).toHaveLength(1);
      void manager;
    });
  });

  it('16: notification transport failure never corrupts lifecycle truth', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR4 Org');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const clock = { now: await dbBaseline(pool) };
      const failingPublisher: RealtimeEventPublisher = {
        publish: () => { throw new Error('transport down'); },
      };
      const { service } = buildService(pool, clock);
      const { service: failingService } = buildService(pool, clock, failingPublisher);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      let job = await createTask(service, staffA, { title: 'Kırık taşıma görevi', dueDate });
      job = await startJob(service, staffA, job);
      await scanOnce(pool, await dbBaseline(pool));
      const breachedAt = (await selectIncidents(pool, organizationId, job.id))[0]!.breached_at;

      // The worker commits delivery + notification rows before publishing, so
      // a transport failure is contained per candidate and converges on retry.
      const repository = new PostgresJobCardRepository(pool);
      const worker = createOverdueReminderWorker(
        new PostgresOverdueReminderWorkerRepository(repository, false),
        { publisher: failingPublisher, timing: {}, batchSize: 50 },
      );
      // Delivery + notification rows commit before the transport publish,
      // so the iteration reports both the send and the publish failure.
      const failed = await worker.runOnce(shiftMs(breachedAt, 15 * 60_000));
      expect(failed.sent).toBe(1);
      expect(failed.failed).toBe(1);
      expect(await selectDeliveries(pool, organizationId, job.id)).toHaveLength(1);
      expect(await selectNotifications(pool, organizationId, job.id)).toHaveLength(1);

      const retry = await worker.runOnce(shiftMs(breachedAt, 16 * 60_000));
      expect(retry.converged).toBe(1);
      expect(await selectNotifications(pool, organizationId, job.id)).toHaveLength(1);

      // Lifecycle recovery commits with the same publisher contract as every
      // other transition: the throw propagates, but the committed truth stays.
      await syncClock(pool, clock);
      await expect(submitJob(failingService, staffA, job)).rejects.toThrow('transport down');
      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]!.recovered_at).not.toBeNull();
    });
  });
});

async function syncClock(pool: Pool, clock: { now: Date }): Promise<Date> {
  clock.now = await dbBaseline(pool);
  return clock.now;
}
