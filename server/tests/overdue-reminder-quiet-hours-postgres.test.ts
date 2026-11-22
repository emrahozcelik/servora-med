import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  createCalendarReminderWorker,
  type CalendarReminderClaim,
  type CalendarReminderWorkerRepository,
} from '../src/modules/calendar/reminder-worker.js';
import {
  DEFAULT_NOTIFICATION_WINDOW,
} from '../src/modules/notifications/quiet-hours.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { readDbBaseline } from './support/db-clock-baseline.js';
import {
  addDays,
  atLocal,
  buildAssignmentOfferExpiryWorker,
  buildOverdueReminderWorker,
  databaseUrl,
  dateKeyWithOpenFollowingDay,
  insertIncident,
  insertJob,
  insertOffer,
  insertOrg,
  insertUser,
  nextOpenDateKey,
  nextSundayDateKey,
  selectNotifications,
  selectOfferNotifications,
  selectOverdueDeliveries,
  withSchema,
} from './support/ovr6-harness.js';

/**
 * OVR-6 Q2/Q3/Q4/Q5/Q6 — the quiet-hours gate on the OVR-4 reminder worker
 * and the producers it deliberately does not touch.
 *
 * Contract §3 (window, "quiet at discovery" vs "closed at send time",
 * fairness) and §10 Q2–Q6. OVR-4 thresholds, delivery identity and recipients
 * are unchanged; only the send instant moves.
 */

const TZ = 'Europe/Istanbul';

async function insertLateSubmissionEpisode(pool: Pool, input: {
  organizationId: string;
  jobCardId: string;
  deadlineAt: Date;
  breachedAt: Date;
  episodeNo?: number;
}): Promise<string> {
  return insertIncident(pool, {
    organizationId: input.organizationId,
    jobCardId: input.jobCardId,
    delayType: 'LATE_SUBMISSION',
    episodeNo: input.episodeNo ?? 1,
    deadlineAt: input.deadlineAt,
    breachedAt: input.breachedAt,
    accountableUserId: null,
    source: 'SCANNER',
  });
}

describe.skipIf(!databaseUrl)('OVR-6 quiet hours — OVR-4 reminders', () => {
  it('Q2 keeps an overnight due_date breach out of the batch and sends at 08:00; a 07:30 SUBMIT sends nothing', async () => {
    await withSchema('ovr6_q2', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const midnight = atLocal(day, 0, 0);
      const breachAt = new Date(midnight.getTime() + 1);
      const organizationId = await insertOrg(pool, 'OVR-6 Q2 Klinik');
      const managerId = await insertUser(pool, { organizationId, role: 'MANAGER', name: 'Müdür' });
      const staffId = await insertUser(pool, { organizationId, role: 'STAFF', name: 'Ayşe' });

      const overnight = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
        dueDate: addDays(day, -1), baseNow: baseline,
      });
      await insertLateSubmissionEpisode(pool, {
        organizationId, jobCardId: overnight.id,
        deadlineAt: midnight, breachedAt: breachAt,
      });

      const submitted = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
        dueDate: addDays(day, -1), baseNow: baseline,
      });
      await insertLateSubmissionEpisode(pool, {
        organizationId, jobCardId: submitted.id,
        deadlineAt: midnight, breachedAt: breachAt,
      });

      // SUBMIT at 07:30 (before the window opens) recovers the episode and
      // leaves the job waiting for approval: nothing is sent later.
      const submitAt = atLocal(day, 7, 30);
      await pool.query(
        `UPDATE job_cards
            SET status = 'WAITING_APPROVAL', staff_completed_at = $2, staff_completed_by = $3
          WHERE id = $1`,
        [submitted.id, submitAt, staffId],
      );
      await pool.query(
        `UPDATE job_card_overdue_incidents
            SET recovered_at = $2, recovery_actor_user_id = $3
          WHERE organization_id = $1 AND job_card_id = $4 AND delay_type = 'LATE_SUBMISSION'`,
        [organizationId, submitAt, staffId, submitted.id],
      );

      const worker = buildOverdueReminderWorker(pool, {
        now: () => atLocal(day, 0, 15),
      });

      // 00:15 and 00:16 are quiet: the candidate is excluded by discovery and
      // is not counted anywhere in the iteration report.
      const overnightReport = await worker.runOnce(atLocal(day, 0, 15));
      expect(overnightReport.candidates).toBe(0);
      expect(overnightReport.sent).toBe(0);
      expect(await selectNotifications(pool, organizationId, overnight.id)).toHaveLength(0);
      expect(await selectOverdueDeliveries(pool, organizationId, overnight.id)).toHaveLength(0);
      const stillQuiet = await worker.runOnce(atLocal(day, 0, 16));
      expect(stillQuiet.candidates).toBe(0);

      // 08:00 is the first in-window tick: reminder and escalation are both
      // due and are sent in the same tick, anchored at the scan instant.
      const openAt = atLocal(day, 8, 0);
      const report = await worker.runOnce(openAt);
      expect(report.candidates).toBe(1);
      expect(report.sent).toBe(1);
      expect(report.byKind).toMatchObject({ STAFF_REMINDER: 1, MANAGEMENT_ESCALATION: 1 });

      const notifications = await selectNotifications(pool, organizationId, overnight.id);
      expect(notifications).toHaveLength(2);
      expect(notifications.every((row) => row.created_at.getTime() === openAt.getTime())).toBe(true);
      const reminder = notifications.find((row) => row.kind === 'job.submission_auto_reminder');
      const escalation = notifications.find((row) => row.kind === 'job.submission_auto_escalation');
      expect(reminder?.recipient_user_id).toBe(staffId);
      expect(escalation?.recipient_user_id).toBe(managerId);

      const deliveries = await selectOverdueDeliveries(pool, organizationId, overnight.id);
      expect(deliveries.map((row) => row.kind).sort())
        .toEqual(['MANAGEMENT_ESCALATION', 'STAFF_REMINDER']);
      expect(deliveries.every((row) => row.sent_at.getTime() === openAt.getTime())).toBe(true);

      // The 07:30 SUBMIT recovered its episode before the window opened.
      expect(await selectOverdueDeliveries(pool, organizationId, submitted.id)).toHaveLength(0);
      expect(await selectNotifications(pool, organizationId, submitted.id)).toHaveLength(0);
    });
  });

  it('Q3 sends a Sunday breach on Monday 08:00', async () => {
    await withSchema('ovr6_q3', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const sunday = nextSundayDateKey(baseline, TZ);
      const monday = addDays(sunday, 1);
      const midnight = atLocal(sunday, 0, 0);
      const organizationId = await insertOrg(pool, 'OVR-6 Q3 Klinik');
      const managerId = await insertUser(pool, { organizationId, role: 'MANAGER', name: 'Müdür' });
      const staffId = await insertUser(pool, { organizationId, role: 'STAFF', name: 'Mehmet' });
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
        dueDate: addDays(sunday, -1), baseNow: baseline,
      });
      await insertLateSubmissionEpisode(pool, {
        organizationId, jobCardId: job.id,
        deadlineAt: midnight, breachedAt: new Date(midnight.getTime() + 1),
      });

      const worker = buildOverdueReminderWorker(pool, {
        now: () => atLocal(sunday, 8, 0),
      });
      const sundayReport = await worker.runOnce(atLocal(sunday, 8, 0));
      expect(sundayReport.candidates).toBe(0);
      expect(sundayReport.sent).toBe(0);
      expect(await selectOverdueDeliveries(pool, organizationId, job.id)).toHaveLength(0);

      const mondayOpen = atLocal(monday, 8, 0);
      const mondayReport = await worker.runOnce(mondayOpen);
      expect(mondayReport.candidates).toBe(1);
      expect(mondayReport.sent).toBe(1);
      const deliveries = await selectOverdueDeliveries(pool, organizationId, job.id);
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((row) => row.sent_at.getTime() === mondayOpen.getTime())).toBe(true);
    });
  });

  it('Q4 a quiet organization never blocks another organization batch', async () => {
    await withSchema('ovr6_q4', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      // 21:30 Istanbul is 13:30 New York: one organization is closed, the
      // other open at the same absolute instant.
      const scanAt = atLocal(day, 21, 30, 'Europe/Istanbul');

      const quietOrgId = await insertOrg(pool, 'OVR-6 Sessiz Klinik', 'Europe/Istanbul');
      const quietManagerId = await insertUser(pool, {
        organizationId: quietOrgId, role: 'MANAGER', name: 'Sessiz Müdür',
      });
      const quietStaffId = await insertUser(pool, {
        organizationId: quietOrgId, role: 'STAFF', name: 'Sessiz Personel',
      });
      const quietJob = await insertJob(pool, {
        organizationId: quietOrgId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: quietStaffId, createdBy: quietManagerId,
        dueDate: addDays(day, -1), baseNow: baseline,
        startedAt: atLocal(addDays(day, -1), 9, 0),
      });
      await insertLateSubmissionEpisode(pool, {
        organizationId: quietOrgId, jobCardId: quietJob.id,
        deadlineAt: atLocal(day, 0, 0), breachedAt: atLocal(day, 0, 0),
      });

      const openOrgId = await insertOrg(pool, 'OVR-6 Açık Klinik', 'America/New_York');
      const openManagerId = await insertUser(pool, {
        organizationId: openOrgId, role: 'MANAGER', name: 'Açık Müdür',
      });
      const openStaffId = await insertUser(pool, {
        organizationId: openOrgId, role: 'STAFF', name: 'Açık Personel',
      });
      const openJob = await insertJob(pool, {
        organizationId: openOrgId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: openStaffId, createdBy: openManagerId,
        dueDate: addDays(day, -1), baseNow: baseline,
        startedAt: atLocal(addDays(day, -2), 9, 0, 'America/New_York'),
      });
      await insertLateSubmissionEpisode(pool, {
        organizationId: openOrgId, jobCardId: openJob.id,
        deadlineAt: atLocal(addDays(day, -1), 0, 0, 'America/New_York'),
        breachedAt: atLocal(addDays(day, -1), 0, 0, 'America/New_York'),
      });

      const worker = buildOverdueReminderWorker(pool, {
        now: () => scanAt, batchSize: 1,
      });
      const report = await worker.runOnce(scanAt);
      // Only the open organization's episode is a candidate; the quiet one
      // never consumes the single batch slot.
      expect(report.candidates).toBe(1);
      expect(report.sent).toBe(1);
      expect(await selectOverdueDeliveries(pool, quietOrgId, quietJob.id)).toHaveLength(0);
      expect(await selectOverdueDeliveries(pool, openOrgId, openJob.id)).toHaveLength(2);
    });
  });

  it('Q6 defers a candidate whose under-lock re-check runs after 21:00 and sends it at the next window', async () => {
    await withSchema('ovr6_q6', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = dateKeyWithOpenFollowingDay(baseline, TZ);
      const nextDay = addDays(day, 1);
      const organizationId = await insertOrg(pool, 'OVR-6 Q6 Klinik');
      const managerId = await insertUser(pool, { organizationId, role: 'MANAGER', name: 'Müdür' });
      const staffId = await insertUser(pool, { organizationId, role: 'STAFF', name: 'Ayşe' });
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
        dueDate: addDays(day, -1), baseNow: baseline,
      });
      await insertLateSubmissionEpisode(pool, {
        organizationId, jobCardId: job.id,
        deadlineAt: atLocal(day, 0, 0), breachedAt: atLocal(day, 0, 0),
      });

      // Discovery saw an open window (SQL TRUE); the under-lock re-check runs
      // with the boundary already passed (isOpen false). The candidate is
      // skipped as deferred-quiet-hours and nothing is anchored.
      const boundary = atLocal(day, 21, 0);
      const boundaryWorker = buildOverdueReminderWorker(pool, {
        now: () => boundary,
        notificationWindow: {
          isOpen: () => false,
          sql: () => 'TRUE',
        },
      });
      const deferred = await boundaryWorker.runOnce(boundary);
      expect(deferred.candidates).toBe(1);
      expect(deferred.sent).toBe(0);
      expect(await selectOverdueDeliveries(pool, organizationId, job.id)).toHaveLength(0);
      expect(await selectNotifications(pool, organizationId, job.id)).toHaveLength(0);

      // The next window's first tick sends it normally.
      const nextOpen = atLocal(nextDay, 8, 0);
      const openWorker = buildOverdueReminderWorker(pool, {
        now: () => nextOpen,
        notificationWindow: DEFAULT_NOTIFICATION_WINDOW,
      });
      const sent = await openWorker.runOnce(nextOpen);
      expect(sent.sent).toBe(1);
      const deliveries = await selectOverdueDeliveries(pool, organizationId, job.id);
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((row) => row.sent_at.getTime() === nextOpen.getTime())).toBe(true);
    });
  });

  it('Q5 JOB-010 acceptance notifications and calendar reminders still send at 03:00', async () => {
    await withSchema('ovr6_q5', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const organizationId = await insertOrg(pool, 'OVR-6 Q5 Klinik');
      const managerId = await insertUser(pool, { organizationId, role: 'MANAGER', name: 'Müdür' });
      const staffId = await insertUser(pool, { organizationId, role: 'STAFF', name: 'Ayşe' });

      const scheduledAt = atLocal(day, 10, 0);
      const scheduledEndsAt = atLocal(day, 11, 0);
      const reminderJob = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt, baseNow: baseline,
      });
      const reminderOfferId = await insertOffer(pool, {
        organizationId, jobCardId: reminderJob.id, assigneeUserId: staffId,
        openedBy: managerId, openedAt: atLocal(day, 2, 0), acceptanceDueAt: atLocal(day, 4, 0),
      });
      const expiryJob = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt, baseNow: baseline,
      });
      const expiryOfferId = await insertOffer(pool, {
        organizationId, jobCardId: expiryJob.id, assigneeUserId: staffId,
        openedBy: managerId, openedAt: atLocal(day, 2, 0), acceptanceDueAt: atLocal(day, 3, 0),
      });

      const scanAt = atLocal(day, 3, 0);
      const expiryWorker = buildAssignmentOfferExpiryWorker(pool, { now: () => scanAt });
      const report = await expiryWorker.runOnce(scanAt);
      expect(report.reminded).toBe(1);
      expect(report.expired).toBe(1);

      const reminderRows = await selectOfferNotifications(pool, reminderOfferId);
      expect(reminderRows).toHaveLength(1);
      expect(reminderRows[0]!.kind).toBe('ACCEPTANCE_REMINDER');
      expect(reminderRows[0]!.sent_at.getTime()).toBe(scanAt.getTime());
      const expiryRows = await selectOfferNotifications(pool, expiryOfferId);
      expect(expiryRows).toHaveLength(1);
      expect(expiryRows[0]!.kind).toBe('ACCEPTANCE_EXPIRED');
      expect(expiryRows[0]!.sent_at.getTime()).toBe(scanAt.getTime());

      // Calendar reminders are not part of the lateness family either. The
      // worker receives no notification window at all; a 03:00 tick projects.
      const claim: CalendarReminderClaim = {
        id: randomUUID(),
        organizationId,
        recipientUserId: staffId,
        jobCardId: null,
        calendarEventId: randomUUID(),
        attemptCount: 1,
        leaseToken: randomUUID(),
      };
      const realtime: RealtimeEventRecord = {
        id: 1n,
        organizationId,
        sourceActivityId: null,
        messagingActivityId: null,
        type: 'calendar.reminder_due',
        entityType: 'calendar-event',
        entityId: claim.calendarEventId!,
        actorUserId: null,
        audience: { roles: [], userIds: [staffId] },
        resourceKeys: ['calendar', 'notifications'],
        occurredAt: scanAt,
      };
      const calendarRepository: CalendarReminderWorkerRepository = {
        claimDue: async () => [claim],
        project: async () => realtime,
        retry: async () => undefined,
        abandon: async () => undefined,
        release: async () => undefined,
      };
      const calendarWorker = createCalendarReminderWorker(calendarRepository, {
        now: () => scanAt,
      });
      await expect(calendarWorker.runOnce()).resolves.toBe(1);
    });
  });
});
