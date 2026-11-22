import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresOverdueBreachScannerRepository, createOverdueBreachScanner } from '../src/modules/job-cards/overdue-breach-scanner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { mapJobCardActivityToRealtime } from '../src/modules/realtime/event-mapper.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { JobCardActivityEvent } from '../src/modules/job-cards/types.js';
import {
  ALWAYS_OPEN_NOTIFICATION_WINDOW,
  DEFAULT_NOTIFICATION_WINDOW,
  type NotificationWindowPolicy,
} from '../src/modules/notifications/quiet-hours.js';
import { readDbBaseline } from './support/db-clock-baseline.js';
import {
  HOUR_MS,
  MINUTE_MS,
  actor,
  addDays,
  atLocal,
  buildJobCardService,
  buildLatenessAlertWorker,
  closeChangeRequest,
  databaseUrl,
  insertIncident,
  insertJob,
  insertOpenChangeRequest,
  insertOrg,
  insertScheduleRevision,
  insertUser,
  nextOpenDateKey,
  selectActivities,
  selectIncidents,
  selectLatenessDeliveries,
  selectNotifications,
  selectRealtimeEvents,
  withSchema,
} from './support/ovr6-harness.js';

/**
 * OVR-6 — the lateness alert worker (start reminder, approval-wait alert and
 * unaccepted past-start alert).
 *
 * Contract §4–§7 and §10 S1–S3, A1–A2, W1–W2. The worker is clock-injected and
 * window-injected; every fixture instant is organization-local and precedes
 * the scan instant that observes it.
 */

const TZ = 'Europe/Istanbul';
const START_DELAY_MS = 15 * MINUTE_MS;

const ALWAYS_OPEN = ALWAYS_OPEN_NOTIFICATION_WINDOW;

type Ctx = {
  organizationId: string;
  managerId: string;
  adminId: string;
  staffId: string;
  otherStaffId: string;
  inactiveStaffId: string;
  manager: ReturnType<typeof actor>;
  staff: ReturnType<typeof actor>;
};

async function seedUsers(pool: Pool): Promise<Ctx> {
  const organizationId = await insertOrg(pool, 'OVR-6 Hatırlatma Klinik');
  const managerId = await insertUser(pool, { organizationId, role: 'MANAGER', name: 'Müdür' });
  const adminId = await insertUser(pool, { organizationId, role: 'ADMIN', name: 'Yönetici' });
  const staffId = await insertUser(pool, { organizationId, role: 'STAFF', name: 'Ayşe' });
  const otherStaffId = await insertUser(pool, { organizationId, role: 'STAFF', name: 'Mehmet' });
  const inactiveStaffId = await insertUser(pool, {
    organizationId, role: 'STAFF', name: 'Pasif Personel', isActive: false, staffProfile: false,
  });
  const inactiveManagerId = await insertUser(pool, {
    organizationId, role: 'MANAGER', name: 'Pasif Müdür', isActive: false,
  });
  expect(inactiveManagerId).toBeTruthy();
  return {
    organizationId, managerId, adminId, staffId, otherStaffId, inactiveStaffId,
    manager: actor(managerId, organizationId, 'MANAGER'),
    staff: actor(staffId, organizationId, 'STAFF'),
  };
}

function workerWithClock(pool: Pool, scan: { at: Date }, options: {
  notificationWindow?: NotificationWindowPolicy;
  batchSize?: number;
  webPushEnabled?: boolean;
  publisher?: RealtimeEventPublisher;
} = {}) {
  return buildLatenessAlertWorker(pool, {
    now: () => scan.at,
    notificationWindow: options.notificationWindow ?? ALWAYS_OPEN,
    timing: { startReminderDelayMs: START_DELAY_MS },
    batchSize: options.batchSize ?? 50,
    webPushEnabled: options.webPushEnabled,
    publisher: options.publisher,
  });
}

/**
 * An active Web Push subscription for `userId`: the queue insert joins the
 * subscription, its session (unrevoked, unexpired at `at`) and the active user.
 */
async function createPushSubscription(
  pool: Pool,
  organizationId: string,
  userId: string,
  at: Date,
): Promise<string> {
  const hex = () => randomUUID().replaceAll('-', '')
    + randomUUID().replaceAll('-', '').slice(0, 32);
  const sessionId = (await pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, hex(), new Date(at.getTime() + 24 * HOUR_MS)],
  )).rows[0]!.id;
  return (await pool.query<{ id: string }>(
    `INSERT INTO web_push_subscriptions
       (organization_id, recipient_user_id, session_id, endpoint, endpoint_hash,
        p256dh, auth, vapid_public_key_fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'p256dh', 'auth', $6)
     RETURNING id`,
    [
      organizationId, userId, sessionId,
      `https://push.example.test/${randomUUID()}`,
      hex(), 'a'.repeat(64),
    ],
  )).rows[0]!.id;
}

async function reassignJob(pool: Pool, input: {
  organizationId: string;
  jobCardId: string;
  fromUserId: string;
  toUserId: string;
  changedBy: string;
  changedAt: Date;
}): Promise<void> {
  await pool.query(
    `UPDATE job_cards SET assigned_to = $2 WHERE id = $1`,
    [input.jobCardId, input.toUserId],
  );
  await pool.query(
    `INSERT INTO job_card_assignment_history
       (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
     VALUES ($1, $2, $3, $4, $5, 'PATCH_REASSIGN', $6)`,
    [
      input.organizationId, input.jobCardId, input.fromUserId, input.toUserId,
      input.changedBy, input.changedAt,
    ],
  );
}

describe.skipIf(!databaseUrl)('OVR-6 lateness alert worker', () => {
  it('S1 sends one start reminder at +15m per planned start and recipient', { timeout: 30_000 }, async () => {
    await withSchema('ovr6_s1', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const ctx = await seedUsers(pool);
      const clock = { now: baseline };
      const { service } = buildJobCardService(pool, clock);
      const scheduledAt = atLocal(day, 14, 0);
      const scheduledEndsAt = atLocal(day, 15, 0);
      const scan = { at: scheduledAt };
      const worker = workerWithClock(pool, scan);

      const makeAccepted = (assignedTo: string, title: string, start = scheduledAt) => insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo, createdBy: ctx.managerId, title,
        scheduledAt: start, scheduledEndsAt: new Date(start.getTime() + HOUR_MS), baseNow: baseline,
      });

      const reminded = await makeAccepted(ctx.staffId, 'Hatırlatılacak iş');

      // 14:14:59 is not due; 14:15 exactly is.
      scan.at = new Date(scheduledAt.getTime() + START_DELAY_MS - 1_000);
      const early = await worker.runIteration();
      expect(early.startReminder.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, reminded.id)).toHaveLength(0);

      scan.at = new Date(scheduledAt.getTime() + START_DELAY_MS);
      const due = await worker.runIteration();
      expect(due.startReminder.sent).toBe(1);
      const firstDeliveries = await selectLatenessDeliveries(pool, ctx.organizationId, reminded.id);
      expect(firstDeliveries).toHaveLength(1);
      expect(firstDeliveries[0]).toMatchObject({
        kind: 'START_REMINDER', recipient_user_id: ctx.staffId, incident_id: null,
      });
      expect(firstDeliveries[0]!.planned_start_at?.getTime()).toBe(scheduledAt.getTime());
      expect(firstDeliveries[0]!.sent_at.getTime()).toBe(scan.at.getTime());

      const firstNotifications = await selectNotifications(pool, ctx.organizationId, reminded.id);
      expect(firstNotifications).toHaveLength(1);
      expect(firstNotifications[0]).toMatchObject({
        kind: 'job.start_reminder', recipient_user_id: ctx.staffId,
      });
      expect(firstNotifications[0]!.created_at.getTime()).toBe(scan.at.getTime());
      const activities = await selectActivities(pool, ctx.organizationId, reminded.id);
      const reminderActivity = activities.find((row) => row.event_type === 'JOB_START_REMINDER_SENT');
      expect(reminderActivity).toBeDefined();
      const realtime = await selectRealtimeEvents(pool, ctx.organizationId, reminded.id);
      expect(realtime).toHaveLength(1);
      expect(realtime[0]!.event_type).toBe('job.updated');
      expect(realtime[0]!.source_activity_id).toBe(reminderActivity!.id);
      expect(firstNotifications[0]!.source_realtime_event_id).toBe(realtime[0]!.id);
      // The reminder is not lateness.
      expect(await selectIncidents(pool, ctx.organizationId, reminded.id)).toHaveLength(0);

      // Repeats, restarts and a due-date-only edit never resend.
      scan.at = new Date(scheduledAt.getTime() + START_DELAY_MS + 5 * MINUTE_MS);
      expect((await worker.runIteration()).startReminder.sent).toBe(0);
      const restarted = workerWithClock(pool, scan);
      expect((await restarted.runIteration()).startReminder.sent).toBe(0);
      await pool.query(`UPDATE job_cards SET due_date = $2 WHERE id = $1`, [reminded.id, day]);
      expect((await restarted.runIteration()).startReminder.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, reminded.id)).toHaveLength(1);

      // A reschedule allows one reminder for the new planned start.
      const rescheduledAt = atLocal(day, 16, 0);
      const rescheduledEndsAt = atLocal(day, 17, 0);
      const revisionAt = new Date(scheduledAt.getTime() + 20 * MINUTE_MS);
      await pool.query(
        `UPDATE job_cards SET scheduled_at = $2, scheduled_ends_at = $3 WHERE id = $1`,
        [reminded.id, rescheduledAt, rescheduledEndsAt],
      );
      await insertScheduleRevision(pool, {
        organizationId: ctx.organizationId, jobCardId: reminded.id, revisionNo: 2,
        scheduledAt: rescheduledAt, scheduledEndsAt: rescheduledEndsAt,
        createdBy: ctx.managerId, createdAt: revisionAt,
      });

      scan.at = new Date(rescheduledAt.getTime() + START_DELAY_MS - 1_000);
      expect((await worker.runIteration()).startReminder.sent).toBe(0);
      scan.at = new Date(rescheduledAt.getTime() + START_DELAY_MS);
      expect((await worker.runIteration()).startReminder.sent).toBe(1);
      const afterReschedule = await selectLatenessDeliveries(pool, ctx.organizationId, reminded.id);
      expect(afterReschedule).toHaveLength(2);
      expect(afterReschedule[1]!.planned_start_at?.getTime()).toBe(rescheduledAt.getTime());

      // A reassignment lets the new assignee be reminded once for the same
      // planned start; the previous assignee is not reminded again.
      scan.at = new Date(rescheduledAt.getTime() + START_DELAY_MS + 10 * MINUTE_MS);
      await reassignJob(pool, {
        organizationId: ctx.organizationId, jobCardId: reminded.id,
        fromUserId: ctx.staffId, toUserId: ctx.otherStaffId,
        changedBy: ctx.managerId, changedAt: scan.at,
      });
      expect((await worker.runIteration()).startReminder.sent).toBe(1);
      const afterReassignment = await selectLatenessDeliveries(pool, ctx.organizationId, reminded.id);
      expect(afterReassignment).toHaveLength(3);
      expect(afterReassignment.filter((row) => row.recipient_user_id === ctx.staffId)).toHaveLength(2);
      expect(afterReassignment.filter((row) => row.recipient_user_id === ctx.otherStaffId))
        .toHaveLength(1);
      expect((await worker.runIteration()).startReminder.sent).toBe(0);

      // START before the reminder: none. The planned start is behind the
      // authoritative database clock (the lifecycle reservation instant is DB
      // `clock_timestamp()`), so START is inside the planned interval.
      const startedScheduledAt = new Date(baseline.getTime() - 2 * HOUR_MS);
      const startedBefore = await makeAccepted(ctx.staffId, 'Başlamış iş', startedScheduledAt);
      clock.now = new Date(startedScheduledAt.getTime() + 5 * MINUTE_MS);
      await service.start(ctx.staff, startedBefore.id, {
        clientActionId: randomUUID(), expectedVersion: startedBefore.version,
      });
      scan.at = new Date(rescheduledAt.getTime() + START_DELAY_MS + 20 * MINUTE_MS);
      expect((await worker.runIteration()).startReminder.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, startedBefore.id))
        .toHaveLength(0);

      // An inactive assignee is never a reminder recipient.
      const inactive = await makeAccepted(ctx.inactiveStaffId, 'Pasif personele iş');
      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      expect((await worker.runIteration()).startReminder.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, inactive.id)).toHaveLength(0);

      // An OPEN change request pauses the reminder; resolving it sends at the
      // next tick.
      const withRequest = await makeAccepted(ctx.staffId, 'Değişiklik talepli iş');
      const requestId = await insertOpenChangeRequest(pool, {
        organizationId: ctx.organizationId, jobCardId: withRequest.id,
        requestedBy: ctx.staffId, requestedAt: new Date(scheduledAt.getTime() + 60 * MINUTE_MS),
        jobStatusAtRequest: 'ACCEPTED',
      });
      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      expect((await worker.runIteration()).startReminder.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, withRequest.id))
        .toHaveLength(0);
      const resolvedAt = new Date(scan.at.getTime() + MINUTE_MS);
      await closeChangeRequest(pool, {
        changeRequestId: requestId, resolvedBy: ctx.managerId, resolvedAt,
        resolution: 'REJECTED',
      });
      scan.at = resolvedAt;
      expect((await worker.runIteration()).startReminder.sent).toBe(1);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, withRequest.id))
        .toHaveLength(1);

      // Acceptance after the planned start makes the reminder due at the next
      // tick (the acceptance instant is part of the fixture clock).
      const unaccepted = await insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'NEW',
        assignedTo: ctx.staffId, createdBy: ctx.managerId, title: 'Kabul edilmemiş iş',
        scheduledAt, scheduledEndsAt, baseNow: baseline,
      });
      clock.now = new Date(scan.at.getTime() + 10 * MINUTE_MS);
      await service.acceptAssignment(ctx.staff, unaccepted.id, {
        clientActionId: randomUUID(), expectedVersion: unaccepted.version,
      });
      scan.at = clock.now;
      expect((await worker.runIteration()).startReminder.sent).toBe(1);
      const acceptedDelivery = await selectLatenessDeliveries(
        pool, ctx.organizationId, unaccepted.id,
      );
      expect(acceptedDelivery).toHaveLength(1);
      expect(acceptedDelivery[0]!.planned_start_at?.getTime()).toBe(scheduledAt.getTime());
      expect(acceptedDelivery[0]!.sent_at.getTime()).toBe(clock.now.getTime());
    });
  });

  it('S2 creates no incident and leaves LATE_START at scheduled_ends_at', async () => {
    await withSchema('ovr6_s2', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const ctx = await seedUsers(pool);
      const scheduledAt = atLocal(day, 14, 0);
      const scheduledEndsAt = atLocal(day, 15, 0);
      const job = await insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: ctx.staffId, createdBy: ctx.managerId, title: 'Geç başlangıç işi',
        scheduledAt, scheduledEndsAt, baseNow: baseline,
      });
      const scan = { at: new Date(scheduledAt.getTime() + START_DELAY_MS) };
      const worker = workerWithClock(pool, scan);
      const report = await worker.runIteration();
      expect(report.startReminder.sent).toBe(1);
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);

      // Only the scanner records LATE_START, at scheduled_ends_at.
      const scanner = createOverdueBreachScanner(
        new PostgresOverdueBreachScannerRepository(new PostgresJobCardRepository(pool)),
        { batchSize: 50 },
      );
      const scanReport = await scanner.runOnce(scheduledEndsAt);
      expect(scanReport.byDelayType.LATE_START).toBe(1);
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({ delay_type: 'LATE_START' });
      expect(incidents[0]!.deadline_at.getTime()).toBe(scheduledEndsAt.getTime());
    });
  });

  it('S3 sends a 07:00 start reminder at 08:00', async () => {
    await withSchema('ovr6_s3', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const ctx = await seedUsers(pool);
      const scheduledAt = atLocal(day, 7, 0);
      const job = await insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: ctx.staffId, createdBy: ctx.managerId, title: 'Erken başlangıç',
        scheduledAt, scheduledEndsAt: atLocal(day, 8, 0), baseNow: baseline,
      });
      const scan = { at: new Date(scheduledAt.getTime() + START_DELAY_MS) };
      const worker = workerWithClock(pool, scan, { notificationWindow: DEFAULT_NOTIFICATION_WINDOW });
      const quiet = await worker.runIteration();
      expect(quiet.startReminder.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, job.id)).toHaveLength(0);

      scan.at = atLocal(day, 8, 0);
      const open = await worker.runIteration();
      expect(open.startReminder.sent).toBe(1);
      const deliveries = await selectLatenessDeliveries(pool, ctx.organizationId, job.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.sent_at.getTime()).toBe(atLocal(day, 8, 0).getTime());
    });
  });

  it('A1 sends one approval-wait alert per incident to every active manager/admin', async () => {
    await withSchema('ovr6_a1', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const ctx = await seedUsers(pool);
      const scan = { at: atLocal(day, 8, 0) };
      const worker = workerWithClock(pool, scan, { notificationWindow: DEFAULT_NOTIFICATION_WINDOW });

      const waitingJob = await insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        assignedTo: ctx.staffId, createdBy: ctx.managerId, title: 'Onay bekleyen iş',
        baseNow: baseline,
      });
      const firstIncidentId = await insertIncident(pool, {
        organizationId: ctx.organizationId, jobCardId: waitingJob.id,
        delayType: 'APPROVAL_WAIT', episodeNo: 1,
        deadlineAt: atLocal(day, 0, 10), breachedAt: new Date(atLocal(day, 0, 10).getTime() + 1),
      });

      // An approval that lands before the window opens sends nothing.
      const approvedJob = await insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        assignedTo: ctx.staffId, createdBy: ctx.managerId, title: 'Erken onaylanan iş',
        baseNow: baseline,
      });
      await insertIncident(pool, {
        organizationId: ctx.organizationId, jobCardId: approvedJob.id,
        delayType: 'APPROVAL_WAIT', episodeNo: 1,
        deadlineAt: atLocal(day, 0, 20), breachedAt: new Date(atLocal(day, 0, 20).getTime() + 1),
      });
      const approvedAt = atLocal(day, 7, 0);
      await pool.query(
        `UPDATE job_cards
            SET status = 'COMPLETED', manager_approved_at = $2, manager_approved_by = $3
          WHERE id = $1`,
        [approvedJob.id, approvedAt, ctx.managerId],
      );

      const report = await worker.runIteration();
      expect(report.approvalWait.sent).toBe(1);
      const notifications = await selectNotifications(pool, ctx.organizationId, waitingJob.id);
      expect(notifications.map((row) => row.recipient_user_id).sort())
        .toEqual([ctx.adminId, ctx.managerId].sort());
      expect(notifications.every((row) => row.kind === 'job.approval_wait_alert')).toBe(true);
      const deliveries = await selectLatenessDeliveries(pool, ctx.organizationId, waitingJob.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        kind: 'APPROVAL_WAIT_ALERT', incident_id: firstIncidentId,
        planned_start_at: null, recipient_user_id: null,
      });
      expect(deliveries[0]!.sent_at.getTime()).toBe(scan.at.getTime());
      expect(await selectActivities(pool, ctx.organizationId, waitingJob.id))
        .toContainEqual(expect.objectContaining({ event_type: 'JOB_APPROVAL_WAIT_ALERT_SENT' }));
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, approvedJob.id))
        .toHaveLength(0);
      expect(await selectNotifications(pool, ctx.organizationId, approvedJob.id)).toHaveLength(0);

      // Repeats and restarts converge on the one incident.
      scan.at = new Date(scan.at.getTime() + 5 * MINUTE_MS);
      expect((await worker.runIteration()).approvalWait.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, waitingJob.id)).toHaveLength(1);

      // A second submission cycle has its own incident and its own alert. The
      // previous cycle is recovered first: production never carries two open
      // APPROVAL_WAIT incidents on one job (the new cycle starts after SUBMIT
      // resolves the previous one).
      await pool.query(
        `UPDATE job_card_overdue_incidents
            SET recovered_at = $2, recovery_actor_user_id = $3
          WHERE id = $1`,
        [firstIncidentId, atLocal(day, 9, 0), ctx.staffId],
      );
      const secondBreach = atLocal(day, 9, 1);
      const secondIncidentId = await insertIncident(pool, {
        organizationId: ctx.organizationId, jobCardId: waitingJob.id,
        delayType: 'APPROVAL_WAIT', episodeNo: 2,
        deadlineAt: atLocal(day, 9, 0), breachedAt: secondBreach,
      });
      scan.at = atLocal(day, 9, 30);
      const second = await worker.runIteration();
      expect(second.approvalWait.sent).toBe(1);
      const secondDeliveries = await selectLatenessDeliveries(
        pool, ctx.organizationId, waitingJob.id,
      );
      expect(secondDeliveries).toHaveLength(2);
      expect(secondDeliveries.map((row) => row.incident_id).sort())
        .toEqual([firstIncidentId, secondIncidentId].sort());
      expect((await selectNotifications(pool, ctx.organizationId, waitingJob.id))
        .filter((row) => row.kind === 'job.approval_wait_alert')).toHaveLength(4);
      scan.at = new Date(scan.at.getTime() + 5 * MINUTE_MS);
      expect((await worker.runIteration()).approvalWait.sent).toBe(0);
    });
  });

  it('A2 suppresses the approval-wait alert while a change request is open', async () => {
    await withSchema('ovr6_a2', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const ctx = await seedUsers(pool);
      const scan = { at: atLocal(day, 8, 0) };
      const worker = workerWithClock(pool, scan, { notificationWindow: DEFAULT_NOTIFICATION_WINDOW });

      const makeWaiting = async (title: string) => {
        const job = await insertJob(pool, {
          organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
          assignedTo: ctx.staffId, createdBy: ctx.managerId, title, baseNow: baseline,
        });
        return job;
      };

      const paused = await makeWaiting('Talepli beklemede');
      await insertIncident(pool, {
        organizationId: ctx.organizationId, jobCardId: paused.id,
        delayType: 'APPROVAL_WAIT', episodeNo: 1,
        deadlineAt: atLocal(day, 0, 10), breachedAt: new Date(atLocal(day, 0, 10).getTime() + 1),
      });
      const requestId = await insertOpenChangeRequest(pool, {
        organizationId: ctx.organizationId, jobCardId: paused.id,
        requestedBy: ctx.staffId, requestedAt: atLocal(day, 0, 30),
        jobStatusAtRequest: 'WAITING_APPROVAL',
      });

      expect((await worker.runIteration()).approvalWait.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, paused.id)).toHaveLength(0);

      // Resolved while the job still waits: the next in-window tick alerts.
      const resolvedAt = atLocal(day, 8, 30);
      await closeChangeRequest(pool, {
        changeRequestId: requestId, resolvedBy: ctx.managerId, resolvedAt,
        resolution: 'REJECTED',
      });
      scan.at = resolvedAt;
      expect((await worker.runIteration()).approvalWait.sent).toBe(1);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, paused.id)).toHaveLength(1);

      // Approved before the resolution: no alert, ever.
      const approved = await makeWaiting('Çözümden önce onaylandı');
      await insertIncident(pool, {
        organizationId: ctx.organizationId, jobCardId: approved.id,
        delayType: 'APPROVAL_WAIT', episodeNo: 1,
        deadlineAt: atLocal(day, 0, 40), breachedAt: new Date(atLocal(day, 0, 40).getTime() + 1),
      });
      const approvedRequestId = await insertOpenChangeRequest(pool, {
        organizationId: ctx.organizationId, jobCardId: approved.id,
        requestedBy: ctx.staffId, requestedAt: atLocal(day, 0, 50),
        jobStatusAtRequest: 'WAITING_APPROVAL',
      });
      await pool.query(
        `UPDATE job_cards
            SET status = 'COMPLETED', manager_approved_at = $2, manager_approved_by = $3
          WHERE id = $1`,
        [approved.id, atLocal(day, 8, 40), ctx.managerId],
      );
      await closeChangeRequest(pool, {
        changeRequestId: approvedRequestId, resolvedBy: ctx.managerId,
        resolvedAt: atLocal(day, 8, 40), resolution: 'REJECTED',
      });
      scan.at = atLocal(day, 8, 45);
      expect((await worker.runIteration()).approvalWait.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, approved.id)).toHaveLength(0);
    });
  });

  it('W1 batches per kind, converges concurrent workers and never resends after restart', async () => {
    await withSchema('ovr6_w1', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const ctx = await seedUsers(pool);
      const scan = { at: atLocal(day, 15, 0) };
      const worker = workerWithClock(pool, scan, { batchSize: 1 });

      const startJobs = [] as Array<{ id: string; scheduledAt: Date }>;
      for (const hour of [13, 14]) {
        const scheduledAt = atLocal(day, hour, 0);
        const job = await insertJob(pool, {
          organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
          assignedTo: ctx.staffId, createdBy: ctx.managerId,
          title: `Başlangıç ${hour}`, scheduledAt,
          scheduledEndsAt: atLocal(day, hour + 1, 0), baseNow: baseline,
        });
        startJobs.push({ id: job.id, scheduledAt });
      }

      const approvalJobs: string[] = [];
      for (const minute of [10, 20]) {
        const job = await insertJob(pool, {
          organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
          assignedTo: ctx.staffId, createdBy: ctx.managerId,
          title: `Onay ${minute}`, baseNow: baseline,
        });
        await insertIncident(pool, {
          organizationId: ctx.organizationId, jobCardId: job.id,
          delayType: 'APPROVAL_WAIT', episodeNo: 1,
          deadlineAt: atLocal(day, 0, minute),
          breachedAt: new Date(atLocal(day, 0, minute).getTime() + 1),
        });
        approvalJobs.push(job.id);
      }

      const pendingJobs: string[] = [];
      for (const minute of [0, 30]) {
        const job = await insertJob(pool, {
          organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'NEW',
          assignedTo: ctx.staffId, createdBy: ctx.managerId,
          title: `Kabul ${minute}`, scheduledAt: atLocal(day, 12, minute),
          scheduledEndsAt: atLocal(day, 13, minute), baseNow: baseline,
        });
        pendingJobs.push(job.id);
      }

      const first = await worker.runIteration();
      // One slot per kind: no kind starves another even though each kind has
      // more candidates than the batch size.
      expect(first.startReminder.sent).toBe(1);
      expect(first.approvalWait.sent).toBe(1);
      expect(first.pendingAcceptance.sent).toBe(1);
      expect(first.startReminder.candidates).toBe(1);
      expect(first.approvalWait.candidates).toBe(1);
      expect(first.pendingAcceptance.candidates).toBe(1);
      // The earliest due instant wins inside a kind.
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, startJobs[0]!.id))
        .toHaveLength(1);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, startJobs[1]!.id))
        .toHaveLength(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, approvalJobs[0]!))
        .toHaveLength(1);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, pendingJobs[0]!))
        .toHaveLength(1);

      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      const second = await worker.runIteration();
      expect(second.startReminder.sent).toBe(1);
      expect(second.approvalWait.sent).toBe(1);
      expect(second.pendingAcceptance.sent).toBe(1);
      for (const id of [startJobs[1]!.id, approvalJobs[1]!, pendingJobs[1]!]) {
        expect(await selectLatenessDeliveries(pool, ctx.organizationId, id)).toHaveLength(1);
      }

      // Two concurrent workers agree on one delivery per candidate.
      const concurrentJob = await insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: ctx.staffId, createdBy: ctx.managerId, title: 'Eşzamanlı iş',
        scheduledAt: atLocal(day, 14, 30), scheduledEndsAt: atLocal(day, 15, 30),
        baseNow: baseline,
      });
      scan.at = atLocal(day, 15, 5);
      const workerA = workerWithClock(pool, scan, { batchSize: 50 });
      const workerB = workerWithClock(pool, scan, { batchSize: 50 });
      const [reportA, reportB] = await Promise.all([
        workerA.runIteration(), workerB.runIteration(),
      ]);
      expect(reportA.startReminder.sent + reportB.startReminder.sent).toBe(1);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, concurrentJob.id))
        .toHaveLength(1);
      expect((await selectNotifications(pool, ctx.organizationId, concurrentJob.id))
        .filter((row) => row.kind === 'job.start_reminder')).toHaveLength(1);
      expect((await selectActivities(pool, ctx.organizationId, concurrentJob.id))
        .filter((row) => row.event_type === 'JOB_START_REMINDER_SENT')).toHaveLength(1);

      // A restart never resends.
      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      const restarted = workerWithClock(pool, scan, { batchSize: 50 });
      expect((await restarted.runIteration()).startReminder.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, concurrentJob.id))
        .toHaveLength(1);

      // The realtime mapping must exist for all three activity events, or the
      // notification would be dropped after the delivery row is anchored.
      const occurredAt = atLocal(day, 15, 30);
      const events: JobCardActivityEvent[] = [
        'JOB_START_REMINDER_SENT',
        'JOB_APPROVAL_WAIT_ALERT_SENT',
        'JOB_PENDING_ACCEPTANCE_ALERT_SENT',
      ];
      for (const event of events) {
        const mapped = mapJobCardActivityToRealtime({
          activityId: randomUUID(),
          organizationId: ctx.organizationId,
          jobCardId: concurrentJob.id,
          actorUserId: null,
          event,
          occurredAt,
          beforeAssigneeId: null,
          afterAssigneeId: ctx.staffId,
        });
        expect(mapped, event).not.toBeNull();
        expect(mapped!.type, event).toBe('job.updated');
      }
    });
  });

  it('W1 keeps lifecycle truth when the realtime transport throws', async () => {
    await withSchema('ovr6_transport', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const ctx = await seedUsers(pool);
      const scheduledAt = atLocal(day, 14, 0);
      const job = await insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: ctx.staffId, createdBy: ctx.managerId, title: 'Taşıma hatası işi',
        scheduledAt, scheduledEndsAt: atLocal(day, 15, 0), baseNow: baseline,
      });
      const scan = { at: new Date(scheduledAt.getTime() + START_DELAY_MS) };
      let transportDown = true;
      const worker = workerWithClock(pool, scan, {
        publisher: {
          publish: () => {
            if (transportDown) throw new Error('OVR6_REALTIME_TRANSPORT_DOWN');
          },
        },
      });

      const report = await worker.runIteration();
      // The transaction committed before the transport hop: the delivery is a
      // durable fact, and the publish failure is reported without duplicating
      // or erasing lifecycle truth.
      expect(report.startReminder.failed).toBe(1);
      const deliveries = await selectLatenessDeliveries(pool, ctx.organizationId, job.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.kind).toBe('START_REMINDER');
      expect((await selectActivities(pool, ctx.organizationId, job.id))
        .filter((row) => row.event_type === 'JOB_START_REMINDER_SENT')).toHaveLength(1);
      expect(await selectRealtimeEvents(pool, ctx.organizationId, job.id)).toHaveLength(1);
      expect((await selectNotifications(pool, ctx.organizationId, job.id))
        .filter((row) => row.kind === 'job.start_reminder')).toHaveLength(1);

      // A restart with a healthy transport never resends.
      transportDown = false;
      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      const healthy = workerWithClock(pool, scan, { publisher: { publish: () => undefined } });
      expect((await healthy.runIteration()).startReminder.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, job.id)).toHaveLength(1);
      expect((await selectNotifications(pool, ctx.organizationId, job.id))
        .filter((row) => row.kind === 'job.start_reminder')).toHaveLength(1);
    });
  });

  it('Q6 defers a lateness alert whose under-lock re-check finds the window closed', async () => {
    await withSchema('ovr6_lateness_q6', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const ctx = await seedUsers(pool);
      // Planned 20:00: the reminder is due at 20:15 and the boundary tick is
      // exactly 21:00 (the end is exclusive).
      const scheduledAt = atLocal(day, 20, 0);
      const job = await insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: ctx.staffId, createdBy: ctx.managerId, title: 'Sınır işi',
        scheduledAt, scheduledEndsAt: atLocal(day, 21, 0), baseNow: baseline,
      });
      const boundary = atLocal(day, 21, 0);
      const scan = { at: boundary };
      // Discovery saw an open window (SQL TRUE); the under-lock re-check runs
      // with the boundary already passed. Nothing may be written.
      const boundaryWorker = workerWithClock(pool, scan, {
        notificationWindow: { isOpen: () => false, sql: () => 'TRUE' },
      });
      const deferred = await boundaryWorker.runIteration();
      expect(deferred.startReminder.candidates).toBe(1);
      expect(deferred.startReminder.deferredQuietHours).toBe(1);
      expect(deferred.startReminder.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, job.id)).toHaveLength(0);
      expect(await selectNotifications(pool, ctx.organizationId, job.id)).toHaveLength(0);

      // The next in-window tick sends it once, under the real policy.
      scan.at = atLocal(addDays(day, 1), 8, 0);
      const openWorker = workerWithClock(pool, scan, {
        notificationWindow: DEFAULT_NOTIFICATION_WINDOW,
      });
      expect((await openWorker.runIteration()).startReminder.sent).toBe(1);
      const deliveries = await selectLatenessDeliveries(pool, ctx.organizationId, job.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.sent_at.getTime()).toBe(scan.at.getTime());
    });
  });

  it('W2 rolls the delivery row back when the web push queue insert fails', async () => {
    await withSchema('ovr6_w2_push', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const ctx = await seedUsers(pool);
      const scheduledAt = atLocal(day, 14, 0);
      const job = await insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: ctx.staffId, createdBy: ctx.managerId, title: 'Push atomik işi',
        scheduledAt, scheduledEndsAt: atLocal(day, 15, 0), baseNow: baseline,
      });
      const scan = { at: new Date(scheduledAt.getTime() + START_DELAY_MS) };
      const subscriptionId = await createPushSubscription(
        pool, ctx.organizationId, ctx.staffId, scan.at,
      );
      expect(subscriptionId).toBeTruthy();

      await pool.query(`
        CREATE OR REPLACE FUNCTION ovr6_fail_push_delivery() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'OVR6_INJECTED_PUSH_QUEUE_FAILURE';
        END
        $$`);
      await pool.query(
        `CREATE TRIGGER ovr6_fail_push BEFORE INSERT ON web_push_deliveries
           FOR EACH ROW WHEN (NEW.organization_id = '${ctx.organizationId}'::uuid)
           EXECUTE FUNCTION ovr6_fail_push_delivery()`,
      );
      const worker = workerWithClock(pool, scan, {
        webPushEnabled: true,
        publisher: { publish: () => undefined },
      });
      try {
        const failed = await worker.runIteration();
        expect(failed.startReminder.failed).toBe(1);
        expect(failed.startReminder.sent).toBe(0);
      } finally {
        await pool.query('DROP TRIGGER IF EXISTS ovr6_fail_push ON web_push_deliveries');
      }

      // Everything the transaction wrote is gone, including the delivery row.
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, job.id)).toHaveLength(0);
      expect(await selectNotifications(pool, ctx.organizationId, job.id)).toHaveLength(0);
      expect((await selectActivities(pool, ctx.organizationId, job.id))
        .filter((row) => row.event_type === 'JOB_START_REMINDER_SENT')).toHaveLength(0);
      expect(await selectRealtimeEvents(pool, ctx.organizationId, job.id)).toHaveLength(0);

      // The next tick retries and queues exactly one push delivery.
      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      expect((await worker.runIteration()).startReminder.sent).toBe(1);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, job.id)).toHaveLength(1);
      const notifications = await selectNotifications(pool, ctx.organizationId, job.id);
      expect(notifications).toHaveLength(1);
      const pushes = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM web_push_deliveries
          WHERE organization_id = $1 AND subscription_id = $2`,
        [ctx.organizationId, subscriptionId],
      );
      expect(pushes.rows[0]!.count).toBe(1);
    });
  });

  it('W1 takes the users lock before the JobCard lock', { timeout: 30_000 }, async () => {
    await withSchema('ovr6_lock', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const ctx = await seedUsers(pool);
      const scheduledAt = atLocal(day, 14, 0);
      const job = await insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: ctx.staffId, createdBy: ctx.managerId, title: 'Kilit sırası işi',
        scheduledAt, scheduledEndsAt: atLocal(day, 15, 0), baseNow: baseline,
      });
      const scan = { at: new Date(scheduledAt.getTime() + START_DELAY_MS) };
      const worker = workerWithClock(pool, scan);

      const locker = await pool.connect();
      const probe = await pool.connect();
      let pending: ReturnType<typeof worker.runIteration> | null = null;
      try {
        // Hold the JobCard row only. The worker must first take the assignee
        // user row (users → JobCard), so the user row becomes unavailable while
        // the worker waits for the job row.
        await locker.query('BEGIN');
        await locker.query(
          `SELECT id FROM job_cards WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [ctx.organizationId, job.id],
        );

        pending = worker.runIteration();
        const deadline = Date.now() + 10_000;
        let userLockHeldByWorker = false;
        while (Date.now() < deadline) {
          await probe.query('BEGIN');
          try {
            await probe.query(
              `SELECT id FROM users WHERE organization_id = $1 AND id = $2 FOR UPDATE NOWAIT`,
              [ctx.organizationId, ctx.staffId],
            );
            await probe.query('ROLLBACK');
          } catch (error) {
            await probe.query('ROLLBACK');
            if ((error as { code?: string }).code === '55P03') {
              userLockHeldByWorker = true;
              break;
            }
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(
          userLockHeldByWorker,
          'worker reached the JobCard lock before locking the assignee user row',
        ).toBe(true);

        await locker.query('ROLLBACK');
        const report = await pending;
        expect(report.startReminder.sent).toBe(1);
      } finally {
        try {
          await locker.query('ROLLBACK');
        } catch {
          // already rolled back
        }
        // The worker continues once the held lock is released; never leave an
        // unhandled rejection behind an assertion failure.
        await pending?.catch(() => undefined);
        locker.release();
        probe.release();
      }

      // One delivery for the whole probe: the lock test did not duplicate it.
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, job.id)).toHaveLength(1);
    });
  });

  it('W2 rolls the delivery row back when a later write fails, then sends exactly once', async () => {
    await withSchema('ovr6_w2', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const ctx = await seedUsers(pool);

      await pool.query(`
        CREATE OR REPLACE FUNCTION ovr6_fail_candidate() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'OVR6_INJECTED_TRANSPORT_FAILURE';
        END
        $$`);

      const injectionPoints = [
        {
          label: 'activity insert',
          table: 'job_card_activity_logs',
          when: 'NEW.job_card_id',
        },
        {
          label: 'realtime insert',
          table: 'realtime_events',
          when: 'NEW.entity_id',
        },
        {
          label: 'in-app notification insert',
          table: 'in_app_notifications',
          when: 'NEW.entity_id',
        },
      ] as const;

      for (const [index, point] of injectionPoints.entries()) {
        const scheduledAt = atLocal(day, 14 + index, 0);
        const job = await insertJob(pool, {
          organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
          assignedTo: ctx.staffId, createdBy: ctx.managerId,
          title: `Atomik ${point.label}`, scheduledAt,
          scheduledEndsAt: atLocal(day, 15 + index, 0), baseNow: baseline,
        });
        const scan = { at: new Date(scheduledAt.getTime() + START_DELAY_MS) };
        const worker = workerWithClock(pool, scan);

        const trigger = `ovr6_fail_${index}`;
        await pool.query(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${point.table}
             FOR EACH ROW WHEN (${point.when} = '${job.id}') EXECUTE FUNCTION ovr6_fail_candidate()`,
        );
        try {
          const failed = await worker.runIteration();
          expect(failed.startReminder.failed, point.label).toBe(1);
          expect(failed.startReminder.sent, point.label).toBe(0);
        } finally {
          await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${point.table}`);
        }

        // The delivery row, activity, realtime event and notifications were
        // all rolled back: nothing survives the failed transaction.
        expect(await selectLatenessDeliveries(pool, ctx.organizationId, job.id), point.label)
          .toHaveLength(0);
        expect((await selectActivities(pool, ctx.organizationId, job.id))
          .filter((row) => row.event_type === 'JOB_START_REMINDER_SENT'), point.label)
          .toHaveLength(0);
        expect(await selectRealtimeEvents(pool, ctx.organizationId, job.id), point.label)
          .toHaveLength(0);
        expect(await selectNotifications(pool, ctx.organizationId, job.id), point.label)
          .toHaveLength(0);

        // The next tick retries and sends exactly once.
        scan.at = new Date(scan.at.getTime() + MINUTE_MS);
        const retried = await worker.runIteration();
        expect(retried.startReminder.sent, point.label).toBe(1);
        expect(await selectLatenessDeliveries(pool, ctx.organizationId, job.id), point.label)
          .toHaveLength(1);
        scan.at = new Date(scan.at.getTime() + MINUTE_MS);
        expect((await worker.runIteration()).startReminder.sent, point.label).toBe(0);
        expect(await selectLatenessDeliveries(pool, ctx.organizationId, job.id), point.label)
          .toHaveLength(1);
      }
    });
  });
});
