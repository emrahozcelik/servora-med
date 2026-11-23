import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  latestAssignmentOfferLateralSql,
  unacceptedPastStartSql,
} from '../src/modules/job-cards/repository.js';
import {
  ALWAYS_OPEN_NOTIFICATION_WINDOW,
  DEFAULT_NOTIFICATION_WINDOW,
} from '../src/modules/notifications/quiet-hours.js';
import { readDbBaseline } from './support/db-clock-baseline.js';
import {
  MINUTE_MS,
  atLocal,
  buildLatenessAlertWorker,
  databaseUrl,
  insertIncident,
  insertJob,
  insertOpenChangeRequest,
  insertOrg,
  insertUser,
  nextOpenDateKey,
  readRollbackEvidence,
  withSchema,
} from './support/ovr6-harness.js';

/**
 * OVR-6 §9.2/§9.3 / §10 R1 — rollback evidence and activation candidate counts.
 *
 * A `current` repoint to the previous release is allowed only when the
 * read-only query proves zero rows of the three new notification kinds, the
 * three new activity events and `job_card_lateness_alert_deliveries`. The flag
 * having been off is not evidence; the rows are.
 *
 * Activation (§9.3) is a separate owner approval: the operator records the
 * read-only candidate count per kind before setting
 * `LATENESS_ALERTS_ENABLED=true`, then checks that the first ticks wrote
 * exactly that many deliveries. R1 requires those counts to match a seeded
 * catch-up scenario.
 */

const TZ = 'Europe/Istanbul';

type ActivationCounts = {
  startReminder: number;
  approvalWait: number;
  pendingAcceptance: number;
};

/**
 * The §9.3 activation candidate counts, written as the read-only operator
 * queries (per kind: what a first tick inside the window would deliver).
 * They share the owned pieces — the sending-window renderer and the
 * unaccepted past-start/ownership SQL — but are otherwise independent of the
 * worker's discovery so a drift in either direction is visible.
 */
async function readActivationCandidateCounts(
  pool: Pool,
  scanTime: Date,
  startReminderCutoff: Date,
): Promise<ActivationCounts> {
  const window = DEFAULT_NOTIFICATION_WINDOW.sql({
    instant: '$1::timestamptz',
    timezone: 'org.timezone',
  });
  const startReminder = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM job_cards j
       JOIN organizations org ON org.id = j.organization_id
       JOIN users assignee
         ON assignee.organization_id = j.organization_id
        AND assignee.id = j.assigned_to
      WHERE j.status = 'ACCEPTED'
        AND j.scheduled_at IS NOT NULL
        AND j.started_at IS NULL
        AND j.scheduled_at <= $2::timestamptz
        AND assignee.is_active AND assignee.role = 'STAFF'
        AND ${window}
        AND NOT EXISTS (
          SELECT 1 FROM job_card_change_requests change_request
           WHERE change_request.organization_id = j.organization_id
             AND change_request.job_card_id = j.id
             AND change_request.state = 'OPEN'
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_card_lateness_alert_deliveries delivery
           WHERE delivery.organization_id = j.organization_id
             AND delivery.job_card_id = j.id
             AND delivery.kind = 'START_REMINDER'
             AND delivery.planned_start_at = j.scheduled_at
             AND delivery.recipient_user_id = j.assigned_to
        )`,
    [scanTime, startReminderCutoff],
  );
  const approvalWait = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM job_card_overdue_incidents i
       JOIN job_cards j
         ON j.organization_id = i.organization_id AND j.id = i.job_card_id
       JOIN organizations org ON org.id = j.organization_id
      WHERE i.delay_type = 'APPROVAL_WAIT'
        AND i.recovered_at IS NULL AND i.ended_at IS NULL
        AND j.status = 'WAITING_APPROVAL'
        AND i.breached_at <= $1::timestamptz
        AND ${window}
        AND NOT EXISTS (
          SELECT 1 FROM job_card_change_requests change_request
           WHERE change_request.organization_id = j.organization_id
             AND change_request.job_card_id = j.id
             AND change_request.state = 'OPEN'
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_card_lateness_alert_deliveries delivery
           WHERE delivery.organization_id = i.organization_id
             AND delivery.job_card_id = i.job_card_id
             AND delivery.kind = 'APPROVAL_WAIT_ALERT'
             AND delivery.incident_id = i.id
        )`,
    [scanTime],
  );
  const pendingPredicate = unacceptedPastStartSql({
    requestTime: '$1::timestamptz',
    job: 'j',
    latest: 'latest',
  });
  const pendingAcceptance = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM job_cards j
       LEFT JOIN ${latestAssignmentOfferLateralSql({ job: 'j', latest: 'latest' })} ON TRUE
       JOIN organizations org ON org.id = j.organization_id
      WHERE ${pendingPredicate}
        AND ${window}
        AND NOT EXISTS (
          SELECT 1 FROM job_card_change_requests change_request
           WHERE change_request.organization_id = j.organization_id
             AND change_request.job_card_id = j.id
             AND change_request.state = 'OPEN'
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_card_lateness_alert_deliveries delivery
           WHERE delivery.organization_id = j.organization_id
             AND delivery.job_card_id = j.id
             AND delivery.kind = 'PENDING_ACCEPTANCE_ALERT'
             AND delivery.planned_start_at = j.scheduled_at
        )`,
    [scanTime],
  );
  return {
    startReminder: startReminder.rows[0]!.count,
    approvalWait: approvalWait.rows[0]!.count,
    pendingAcceptance: pendingAcceptance.rows[0]!.count,
  };
}

describe.skipIf(!databaseUrl)('OVR-6 rollback evidence', () => {
  it('R1 returns zero on a fresh 069 and non-zero after one alert', async () => {
    await withSchema('ovr6_r1', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const organizationId = await insertOrg(pool, 'OVR-6 R1 Klinik');
      const managerId = await insertUser(pool, { organizationId, role: 'MANAGER' });
      const staffId = await insertUser(pool, { organizationId, role: 'STAFF' });
      const scheduledAt = atLocal(day, 14, 0);
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId, title: 'Geri alma kanıtı',
        scheduledAt, scheduledEndsAt: atLocal(day, 15, 0), baseNow: baseline,
      });

      // An unrelated activity is not rollback evidence.
      await pool.query(
        `INSERT INTO job_card_activity_logs (organization_id, job_card_id, event_type)
         VALUES ($1, $2, 'JOB_CREATED')`,
        [organizationId, job.id],
      );
      expect(await readRollbackEvidence(pool)).toEqual({
        notificationCount: 0,
        activityCount: 0,
        deliveryCount: 0,
      });

      const scan = { at: new Date(scheduledAt.getTime() + 15 * MINUTE_MS) };
      const worker = buildLatenessAlertWorker(pool, {
        now: () => scan.at,
        notificationWindow: ALWAYS_OPEN_NOTIFICATION_WINDOW,
        timing: { startReminderDelayMs: 15 * MINUTE_MS },
      });
      await worker.runIteration();

      const evidence = await readRollbackEvidence(pool);
      expect(evidence.deliveryCount).toBe(1);
      expect(evidence.activityCount).toBe(1);
      expect(evidence.notificationCount).toBe(1);

      // The query is read-only: running it again changes nothing.
      expect(await readRollbackEvidence(pool)).toEqual(evidence);
      const deliveries = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM job_card_lateness_alert_deliveries`,
      );
      expect(deliveries.rows[0]!.count).toBe(1);
    });
  });

  it('R1 activation counts match the worker first-tick deliveries in a seeded catch-up', async () => {
    await withSchema('ovr6_r1_counts', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const organizationId = await insertOrg(pool, 'OVR-6 Aktivasyon Klinik');
      const managerId = await insertUser(pool, { organizationId, role: 'MANAGER', name: 'Müdür' });
      const adminId = await insertUser(pool, { organizationId, role: 'ADMIN', name: 'Yönetici' });
      const staffId = await insertUser(pool, { organizationId, role: 'STAFF', name: 'Ayşe' });
      const otherStaffId = await insertUser(pool, {
        organizationId, role: 'STAFF', name: 'Mehmet',
      });
      const scanAt = atLocal(day, 10, 0);
      const startReminderCutoff = new Date(scanAt.getTime() - 15 * MINUTE_MS);

      // Two due start reminders and one that is not due yet.
      for (const [index, hour] of [8, 9].entries()) {
        await insertJob(pool, {
          organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
          assignedTo: staffId, createdBy: managerId,
          title: `Başlangıç ${index + 1}`,
          scheduledAt: atLocal(day, hour, 0),
          scheduledEndsAt: atLocal(day, hour + 1, 0), baseNow: baseline,
        });
      }
      await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: otherStaffId, createdBy: managerId, title: 'Henüz vakti gelmeyen',
        scheduledAt: atLocal(day, 9, 55), scheduledEndsAt: atLocal(day, 10, 55),
        baseNow: baseline,
      });

      // Two open approval-wait incidents, one recovered cycle and one job
      // paused by an open change request.
      for (const [index, minute] of [10, 20].entries()) {
        const waiting = await insertJob(pool, {
          organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
          assignedTo: staffId, createdBy: managerId,
          title: `Onay ${index + 1}`, baseNow: baseline,
        });
        await insertIncident(pool, {
          organizationId, jobCardId: waiting.id, delayType: 'APPROVAL_WAIT', episodeNo: 1,
          deadlineAt: atLocal(day, 0, minute),
          breachedAt: new Date(atLocal(day, 0, minute).getTime() + 1),
        });
      }
      const recovered = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        assignedTo: staffId, createdBy: managerId, title: 'Toparlanan onay', baseNow: baseline,
      });
      const recoveredIncidentId = await insertIncident(pool, {
        organizationId, jobCardId: recovered.id, delayType: 'APPROVAL_WAIT', episodeNo: 1,
        deadlineAt: atLocal(day, 0, 30), breachedAt: new Date(atLocal(day, 0, 30).getTime() + 1),
      });
      await pool.query(
        `UPDATE job_card_overdue_incidents
            SET recovered_at = $2, recovery_actor_user_id = $3
          WHERE id = $1`,
        [recoveredIncidentId, atLocal(day, 7, 0), staffId],
      );
      const paused = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        assignedTo: staffId, createdBy: managerId, title: 'Talepli onay', baseNow: baseline,
      });
      await insertIncident(pool, {
        organizationId, jobCardId: paused.id, delayType: 'APPROVAL_WAIT', episodeNo: 1,
        deadlineAt: atLocal(day, 0, 40), breachedAt: new Date(atLocal(day, 0, 40).getTime() + 1),
      });
      await insertOpenChangeRequest(pool, {
        organizationId, jobCardId: paused.id, requestedBy: staffId,
        requestedAt: atLocal(day, 1, 0), jobStatusAtRequest: 'WAITING_APPROVAL',
      });

      // Two unaccepted past-start jobs, one paused by an open change request
      // and one whose planned start has not arrived.
      for (const [index, minute] of [0, 30].entries()) {
        await insertJob(pool, {
          organizationId, type: 'GENERAL_TASK', status: 'NEW',
          assignedTo: staffId, createdBy: managerId,
          title: `Kabul ${index + 1}`,
          scheduledAt: atLocal(day, 9, minute),
          scheduledEndsAt: atLocal(day, 10, minute), baseNow: baseline,
        });
      }
      const requested = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'NEW',
        assignedTo: staffId, createdBy: managerId, title: 'Talepli kabul',
        scheduledAt: atLocal(day, 9, 45), scheduledEndsAt: atLocal(day, 10, 45),
        baseNow: baseline,
      });
      await insertOpenChangeRequest(pool, {
        organizationId, jobCardId: requested.id, requestedBy: staffId,
        requestedAt: atLocal(day, 9, 50), jobStatusAtRequest: 'NEW',
      });
      await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'NEW',
        assignedTo: otherStaffId, createdBy: managerId, title: 'İleri planlanan',
        scheduledAt: atLocal(day, 11, 0), scheduledEndsAt: atLocal(day, 12, 0),
        baseNow: baseline,
      });

      // §9.3: record the read-only counts before activation.
      const counts = await readActivationCandidateCounts(pool, scanAt, startReminderCutoff);
      expect(counts).toEqual({
        startReminder: 2,
        approvalWait: 2,
        pendingAcceptance: 2,
      });
      // The activation counts are read-only evidence.
      expect(await readRollbackEvidence(pool)).toEqual({
        notificationCount: 0, activityCount: 0, deliveryCount: 0,
      });

      // The first tick inside the window (catch-up) delivers exactly the
      // recorded counts, per kind.
      const worker = buildLatenessAlertWorker(pool, {
        now: () => scanAt,
        notificationWindow: DEFAULT_NOTIFICATION_WINDOW,
        timing: { startReminderDelayMs: 15 * MINUTE_MS },
      });
      const report = await worker.runIteration();
      expect(report.startReminder.sent).toBe(counts.startReminder);
      expect(report.approvalWait.sent).toBe(counts.approvalWait);
      expect(report.pendingAcceptance.sent).toBe(counts.pendingAcceptance);
      expect(report.startReminder.sent + report.approvalWait.sent
        + report.pendingAcceptance.sent).toBe(6);
      // Every manager/admin received one pending-acceptance and one
      // approval-wait alert; the staff assignee received the start reminders.
      const notifications = await pool.query<{ kind: string; count: number }>(
        `SELECT kind, COUNT(*)::int AS count
           FROM in_app_notifications
          WHERE organization_id = $1
            AND kind IN ('job.start_reminder', 'job.approval_wait_alert',
                         'job.pending_acceptance_alert')
          GROUP BY kind ORDER BY kind`,
        [organizationId],
      );
      expect(notifications.rows).toEqual([
        { kind: 'job.approval_wait_alert', count: 4 },
        { kind: 'job.pending_acceptance_alert', count: 4 },
        { kind: 'job.start_reminder', count: 2 },
      ]);
      expect((await readRollbackEvidence(pool)).deliveryCount).toBe(6);
    });
  });
});
