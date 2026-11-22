import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { JobCardService } from '../src/modules/job-cards/service.js';
import {
  ALWAYS_OPEN_NOTIFICATION_WINDOW,
  DEFAULT_NOTIFICATION_WINDOW,
} from '../src/modules/notifications/quiet-hours.js';
import { readDbBaseline } from './support/db-clock-baseline.js';
import {
  MINUTE_MS,
  actor,
  addDays,
  atLocal,
  buildJobCardService,
  buildLatenessAlertWorker,
  databaseUrl,
  dateKeyWithOpenFollowingDay,
  insertJob,
  insertOffer,
  insertOpenChangeRequest,
  insertOrg,
  insertScheduleRevision,
  insertUser,
  nextOpenDateKey,
  selectActivities,
  selectLatenessDeliveries,
  selectNotifications,
  selectRealtimeEvents,
  withSchema,
  type OfferState,
} from './support/ovr6-harness.js';

/**
 * OVR-6 §6 — unaccepted past-start jobs: the management list, the ownership
 * matrix (one test per row) and the one-alert-per-planned-start worker.
 *
 * Contract §6.1/§6.2/§10 P1–P4. The list and the needs-action list share one
 * SQL predicate; a job is on exactly one list or still answerable in the
 * JOB-010 offer flow.
 */

const TZ = 'Europe/Istanbul';

type Ctx = {
  organizationId: string;
  managerId: string;
  adminId: string;
  staffId: string;
  otherStaffId: string;
  inactiveStaffId: string;
  manager: ReturnType<typeof actor>;
};

async function seed(pool: Pool): Promise<Ctx> {
  const organizationId = await insertOrg(pool, 'OVR-6 Kabul Klinik');
  const managerId = await insertUser(pool, { organizationId, role: 'MANAGER', name: 'Müdür' });
  const adminId = await insertUser(pool, { organizationId, role: 'ADMIN', name: 'Yönetici' });
  const staffId = await insertUser(pool, { organizationId, role: 'STAFF', name: 'Ayşe' });
  const otherStaffId = await insertUser(pool, { organizationId, role: 'STAFF', name: 'Mehmet' });
  const inactiveStaffId = await insertUser(pool, {
    organizationId, role: 'STAFF', name: 'Pasif Personel', isActive: false, staffProfile: false,
  });
  return {
    organizationId, managerId, adminId, staffId, otherStaffId, inactiveStaffId,
    manager: actor(managerId, organizationId, 'MANAGER'),
  };
}

async function newPastStartJob(pool: Pool, input: {
  ctx: Ctx;
  title: string;
  scheduledAt: Date;
  assignedTo?: string;
  type?: 'GENERAL_TASK' | 'WEEKLY_REPORT';
  baseline: Date;
}) {
  return insertJob(pool, {
    organizationId: input.ctx.organizationId,
    type: input.type ?? 'GENERAL_TASK',
    status: 'NEW',
    assignedTo: input.assignedTo ?? input.ctx.staffId,
    createdBy: input.ctx.managerId,
    title: input.title,
    scheduledAt: input.scheduledAt,
    scheduledEndsAt: new Date(input.scheduledAt.getTime() + 60 * MINUTE_MS),
    baseNow: input.baseline,
  });
}

async function offerFor(pool: Pool, input: {
  ctx: Ctx;
  jobCardId: string;
  openedAt: Date;
  acceptanceDueAt: Date;
  state?: OfferState;
  urgentReason?: 'SHORT_NOTICE' | 'START_PASSED' | null;
  closeReason?: string | null;
  closeText?: string | null;
  closedAt?: Date | null;
  closedBy?: string | null;
}): Promise<string> {
  return insertOffer(pool, {
    organizationId: input.ctx.organizationId,
    jobCardId: input.jobCardId,
    assigneeUserId: input.ctx.staffId,
    openedBy: input.ctx.managerId,
    openedAt: input.openedAt,
    acceptanceDueAt: input.acceptanceDueAt,
    state: input.state,
    urgentReason: input.urgentReason,
    closeReason: input.closeReason,
    closeText: input.closeText,
    closedAt: input.closedAt,
    closedBy: input.closedBy,
  });
}

async function listIds(
  service: JobCardService,
  ctx: Ctx,
  page: { limit: number; offset: number } = { limit: 25, offset: 0 },
): Promise<string[]> {
  const result = await service.listUnacceptedPastStart(ctx.manager, page);
  return result.items.map((item) => item.jobCardId);
}

async function needsActionIds(
  service: JobCardService,
  ctx: Ctx,
  page: { limit: number; offset: number } = { limit: 25, offset: 0 },
): Promise<string[]> {
  const result = await service.listAssignmentOffersNeedingAction(ctx.manager, page);
  return result.items.map((item) => item.jobCardId);
}

function expectDisjoint(a: readonly string[], b: readonly string[]): void {
  expect(a.filter((id) => b.includes(id))).toEqual([]);
}

describe.skipIf(!databaseUrl)('OVR-6 unaccepted past-start jobs', () => {
  it('P1 lists at the planned time, alerts once, and follows accept/reschedule/edit/request', async () => {
    await withSchema('ovr6_p1', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const ctx = await seed(pool);
      const day = dateKeyWithOpenFollowingDay(baseline, TZ);
      const scheduledAt = atLocal(day, 13, 0);
      const clock = { now: scheduledAt };
      const { service } = buildJobCardService(pool, clock);
      const scan = { at: new Date(scheduledAt.getTime() + 5 * MINUTE_MS) };
      const worker = buildLatenessAlertWorker(pool, {
        now: () => scan.at,
        notificationWindow: ALWAYS_OPEN_NOTIFICATION_WINDOW,
        timing: { startReminderDelayMs: 15 * MINUTE_MS },
      });

      const listed = await newPastStartJob(pool, {
        ctx, title: 'Kabul bekleyen görev', scheduledAt, baseline,
      });
      const weekly = await newPastStartJob(pool, {
        ctx, title: 'Haftalık rapor', scheduledAt, type: 'WEEKLY_REPORT', baseline,
      });
      const inactiveAssignee = await newPastStartJob(pool, {
        ctx, title: 'Pasif atanmış görev', scheduledAt,
        assignedTo: ctx.inactiveStaffId, baseline,
      });

      // Exactly at the planned time the job is listed; elapsed is zero.
      const atStart = await service.listUnacceptedPastStart(ctx.manager, { limit: 25, offset: 0 });
      expect(atStart.total).toBe(2);
      expect(atStart.items.map((item) => item.jobCardId).sort())
        .toEqual([listed.id, inactiveAssignee.id].sort());
      const listedItem = atStart.items.find((item) => item.jobCardId === listed.id)!;
      expect(listedItem).toMatchObject({
        jobPath: `/jobs/${listed.id}`,
        type: 'GENERAL_TASK',
        assignee: { id: ctx.staffId, name: 'Ayşe', active: true },
        hasOpenChangeRequest: false,
      });
      expect(Date.parse(listedItem.scheduledAt)).toBe(scheduledAt.getTime());
      expect(listedItem.elapsedSeconds).toBe(0);
      expect(atStart.items.find((item) => item.jobCardId === inactiveAssignee.id)?.assignee.active)
        .toBe(false);
      // WEEKLY_REPORT is not planned field work and never appears.
      expect(atStart.items.map((item) => item.jobCardId)).not.toContain(weekly.id);

      clock.now = new Date(scheduledAt.getTime() + 5 * MINUTE_MS);
      const later = await service.listUnacceptedPastStart(ctx.manager, { limit: 25, offset: 0 });
      expect(later.items.find((item) => item.jobCardId === listed.id)?.elapsedSeconds).toBe(300);

      // One alert per planned start to every active manager/admin.
      const report = await worker.runIteration();
      expect(report.pendingAcceptance.sent).toBe(2);
      const deliveries = await selectLatenessDeliveries(pool, ctx.organizationId, listed.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        kind: 'PENDING_ACCEPTANCE_ALERT',
        planned_start_at: scheduledAt,
        recipient_user_id: null,
        incident_id: null,
      });
      expect(deliveries[0]!.sent_at.getTime()).toBe(scan.at.getTime());
      const notifications = await selectNotifications(pool, ctx.organizationId, listed.id);
      expect(notifications.map((row) => row.recipient_user_id).sort())
        .toEqual([ctx.adminId, ctx.managerId].sort());
      expect(notifications.every((row) => row.kind === 'job.pending_acceptance_alert')).toBe(true);
      expect(await selectActivities(pool, ctx.organizationId, listed.id))
        .toContainEqual(expect.objectContaining({ event_type: 'JOB_PENDING_ACCEPTANCE_ALERT_SENT' }));
      expect((await selectRealtimeEvents(pool, ctx.organizationId, listed.id))[0]?.event_type)
        .toBe('job.updated');
      // Not lateness: no incident.
      const incidentCount = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM job_card_overdue_incidents
          WHERE organization_id = $1 AND job_card_id = $2`,
        [ctx.organizationId, listed.id],
      );
      expect(incidentCount.rows[0]!.count).toBe(0);

      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      expect((await worker.runIteration()).pendingAcceptance.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, listed.id)).toHaveLength(1);

      // Accepting removes the job from the list.
      clock.now = new Date(scheduledAt.getTime() + 10 * MINUTE_MS);
      await service.acceptAssignment(actor(ctx.staffId, ctx.organizationId, 'STAFF'), listed.id, {
        clientActionId: randomUUID(), expectedVersion: listed.version,
      });
      expect(await listIds(service, ctx)).not.toContain(listed.id);

      // A future reschedule removes the job from the list.
      const futureRescheduled = await newPastStartJob(pool, {
        ctx, title: 'İleri alınan görev', scheduledAt, baseline,
      });
      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      expect((await worker.runIteration()).pendingAcceptance.sent).toBe(1);
      const futureStart = atLocal(day, 18, 0);
      await pool.query(
        `UPDATE job_cards SET scheduled_at = $2, scheduled_ends_at = $3 WHERE id = $1`,
        [futureRescheduled.id, futureStart, new Date(futureStart.getTime() + 60 * MINUTE_MS)],
      );
      await insertScheduleRevision(pool, {
        organizationId: ctx.organizationId, jobCardId: futureRescheduled.id, revisionNo: 2,
        scheduledAt: futureStart, scheduledEndsAt: new Date(futureStart.getTime() + 60 * MINUTE_MS),
        createdBy: ctx.managerId, createdAt: scan.at,
      });
      expect(await listIds(service, ctx)).not.toContain(futureRescheduled.id);

      // A past reschedule alerts once more for the new planned start.
      const pastRescheduled = await newPastStartJob(pool, {
        ctx, title: 'Geri alınan görev', scheduledAt, baseline,
      });
      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      expect((await worker.runIteration()).pendingAcceptance.sent).toBe(1);
      const pastStart = atLocal(day, 12, 0);
      await pool.query(
        `UPDATE job_cards SET scheduled_at = $2, scheduled_ends_at = $3 WHERE id = $1`,
        [pastRescheduled.id, pastStart, new Date(pastStart.getTime() + 60 * MINUTE_MS)],
      );
      await insertScheduleRevision(pool, {
        organizationId: ctx.organizationId, jobCardId: pastRescheduled.id, revisionNo: 2,
        scheduledAt: pastStart, scheduledEndsAt: new Date(pastStart.getTime() + 60 * MINUTE_MS),
        createdBy: ctx.managerId, createdAt: scan.at,
      });
      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      expect((await worker.runIteration()).pendingAcceptance.sent).toBe(1);
      const rescheduledDeliveries = await selectLatenessDeliveries(
        pool, ctx.organizationId, pastRescheduled.id,
      );
      expect(rescheduledDeliveries).toHaveLength(2);
      expect(rescheduledDeliveries.map((row) => row.planned_start_at?.getTime()).sort())
        .toEqual([scheduledAt.getTime(), pastStart.getTime()].sort());

      // A due-date edit or reassignment of the same planned start never alerts
      // again.
      const edited = await newPastStartJob(pool, {
        ctx, title: 'Düzenlenen görev', scheduledAt, baseline,
      });
      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      expect((await worker.runIteration()).pendingAcceptance.sent).toBe(1);
      await pool.query(`UPDATE job_cards SET due_date = $2 WHERE id = $1`, [edited.id, day]);
      await pool.query(`UPDATE job_cards SET assigned_to = $2 WHERE id = $1`, [
        edited.id, ctx.otherStaffId,
      ]);
      scan.at = new Date(scan.at.getTime() + MINUTE_MS);
      expect((await worker.runIteration()).pendingAcceptance.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, edited.id)).toHaveLength(1);

      // An open change request keeps the job listed but suppresses the alert.
      const requested = await newPastStartJob(pool, {
        ctx, title: 'Talepli görev', scheduledAt, baseline,
      });
      await insertOpenChangeRequest(pool, {
        organizationId: ctx.organizationId, jobCardId: requested.id,
        requestedBy: ctx.staffId, requestedAt: new Date(scheduledAt.getTime() + 10 * MINUTE_MS),
        jobStatusAtRequest: 'NEW',
      });
      clock.now = new Date(scan.at.getTime() + MINUTE_MS);
      const requestedPage = await service.listUnacceptedPastStart(
        ctx.manager, { limit: 25, offset: 0 },
      );
      expect(requestedPage.items.find((item) => item.jobCardId === requested.id))
        .toMatchObject({ hasOpenChangeRequest: true });
      scan.at = clock.now;
      expect((await worker.runIteration()).pendingAcceptance.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, requested.id)).toHaveLength(0);

      // A 22:00 planned start waits for the next in-window tick (day + 1 08:00
      // is open by construction of dateKeyWithOpenFollowingDay).
      const quietStart = atLocal(day, 22, 0);
      const quiet = await insertJob(pool, {
        organizationId: ctx.organizationId, type: 'GENERAL_TASK', status: 'NEW',
        assignedTo: ctx.staffId, createdBy: ctx.managerId, title: 'Gece planlanan iş',
        scheduledAt: quietStart, scheduledEndsAt: new Date(quietStart.getTime() + 60 * MINUTE_MS),
        baseNow: baseline,
      });
      const quietWorker = buildLatenessAlertWorker(pool, {
        now: () => scan.at,
        notificationWindow: DEFAULT_NOTIFICATION_WINDOW,
        timing: { startReminderDelayMs: 15 * MINUTE_MS },
      });
      scan.at = new Date(quietStart.getTime() + 5 * MINUTE_MS);
      expect((await quietWorker.runIteration()).pendingAcceptance.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, ctx.organizationId, quiet.id)).toHaveLength(0);

      scan.at = atLocal(addDays(day, 1), 8, 0);
      expect((await quietWorker.runIteration()).pendingAcceptance.sent).toBe(1);
      const quietDeliveries = await selectLatenessDeliveries(pool, ctx.organizationId, quiet.id);
      expect(quietDeliveries).toHaveLength(1);
      expect(quietDeliveries[0]!.sent_at.getTime()).toBe(scan.at.getTime());
    });
  });

  it('P2 row 1: no offer is owned by this list', async () => {
    await withSchema('ovr6_p2_r1', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const ctx = await seed(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const scheduledAt = atLocal(day, 13, 0);
      const clock = { now: atLocal(day, 14, 0) };
      const { service } = buildJobCardService(pool, clock, { assignmentWindowEnabled: true });
      const job = await newPastStartJob(pool, { ctx, title: 'Teklifsiz', scheduledAt, baseline });

      const listed = await listIds(service, ctx);
      const needsAction = await needsActionIds(service, ctx);
      expect(listed).toEqual([job.id]);
      expect(needsAction).toEqual([]);
      expectDisjoint(listed, needsAction);
    });
  });

  it('P2 row 2: an urgent OPEN offer is owned by needs-action only', async () => {
    await withSchema('ovr6_p2_r2', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const ctx = await seed(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const scheduledAt = atLocal(day, 13, 0);
      const clock = { now: atLocal(day, 14, 0) };
      const { service } = buildJobCardService(pool, clock, { assignmentWindowEnabled: true });
      const job = await newPastStartJob(pool, { ctx, title: 'Acil teklif', scheduledAt, baseline });
      await offerFor(pool, {
        ctx, jobCardId: job.id, openedAt: atLocal(day, 11, 0),
        acceptanceDueAt: atLocal(day, 15, 0), urgentReason: 'SHORT_NOTICE',
      });

      const listed = await listIds(service, ctx);
      const needsAction = await needsActionIds(service, ctx);
      expect(listed).toEqual([]);
      expect(needsAction).toEqual([job.id]);
      expectDisjoint(listed, needsAction);
    });
  });

  it('P2 row 3: a still-answerable OPEN offer is in neither list', async () => {
    await withSchema('ovr6_p2_r3', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const ctx = await seed(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const scheduledAt = atLocal(day, 13, 0);
      const clock = { now: atLocal(day, 14, 0) };
      const { service } = buildJobCardService(pool, clock, { assignmentWindowEnabled: true });
      const job = await newPastStartJob(pool, { ctx, title: 'Yanıtlanabilir teklif', scheduledAt, baseline });
      await offerFor(pool, {
        ctx, jobCardId: job.id, openedAt: atLocal(day, 11, 0),
        acceptanceDueAt: atLocal(day, 15, 0),
      });

      const listed = await listIds(service, ctx);
      const needsAction = await needsActionIds(service, ctx);
      expect(listed).toEqual([]);
      expect(needsAction).toEqual([]);
      expectDisjoint(listed, needsAction);
    });
  });

  it('P2 row 4: DECLINED / RELEASED / EXPIRED offers are owned by needs-action only', async () => {
    await withSchema('ovr6_p2_r4', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const ctx = await seed(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const scheduledAt = atLocal(day, 13, 0);
      const clock = { now: atLocal(day, 14, 0) };
      const { service } = buildJobCardService(pool, clock, { assignmentWindowEnabled: true });

      const declined = await newPastStartJob(pool, { ctx, title: 'Reddedilen', scheduledAt, baseline });
      await offerFor(pool, {
        ctx, jobCardId: declined.id, openedAt: atLocal(day, 11, 0),
        acceptanceDueAt: atLocal(day, 15, 0), state: 'DECLINED',
        closeReason: 'ON_LEAVE', closeText: 'İzinliyim.',
      });
      const released = await newPastStartJob(pool, { ctx, title: 'Bırakılan', scheduledAt, baseline });
      await offerFor(pool, {
        ctx, jobCardId: released.id, openedAt: atLocal(day, 11, 0),
        acceptanceDueAt: atLocal(day, 15, 0), state: 'RELEASED',
        closeReason: 'SCHEDULE_CONFLICT', closeText: 'Aynı saatte başka iş var.',
      });
      const expired = await newPastStartJob(pool, { ctx, title: 'Süresi dolan', scheduledAt, baseline });
      await offerFor(pool, {
        ctx, jobCardId: expired.id, openedAt: atLocal(day, 11, 0),
        acceptanceDueAt: atLocal(day, 12, 0), state: 'EXPIRED',
        closedAt: atLocal(day, 12, 0),
      });

      const listed = await listIds(service, ctx);
      const needsAction = await needsActionIds(service, ctx);
      expect(listed).toEqual([]);
      expect(needsAction.sort()).toEqual([declined.id, released.id, expired.id].sort());
      expectDisjoint(listed, needsAction);
    });
  });

  it('P2 row 5: WITHDRAWN + PLANNED_WINDOW_PASSED is owned by needs-action only', async () => {
    await withSchema('ovr6_p2_r5', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const ctx = await seed(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const scheduledAt = atLocal(day, 13, 0);
      const clock = { now: atLocal(day, 14, 0) };
      const { service } = buildJobCardService(pool, clock, { assignmentWindowEnabled: true });
      const job = await newPastStartJob(pool, { ctx, title: 'Pencere geçti', scheduledAt, baseline });
      await offerFor(pool, {
        ctx, jobCardId: job.id, openedAt: atLocal(day, 11, 0),
        acceptanceDueAt: atLocal(day, 15, 0), state: 'WITHDRAWN',
        closeReason: 'PLANNED_WINDOW_PASSED', closeText: null,
      });

      const listed = await listIds(service, ctx);
      const needsAction = await needsActionIds(service, ctx);
      expect(listed).toEqual([]);
      expect(needsAction).toEqual([job.id]);
      expectDisjoint(listed, needsAction);
    });
  });

  it('P2 row 6: WITHDRAWN with every other reason is owned by this list only', async () => {
    await withSchema('ovr6_p2_r6', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const ctx = await seed(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const scheduledAt = atLocal(day, 13, 0);
      const clock = { now: atLocal(day, 14, 0) };
      const { service } = buildJobCardService(pool, clock, { assignmentWindowEnabled: true });
      const reasons = [
        'REASSIGNED', 'RESCHEDULED', 'CANCELLED', 'INVALIDATED', 'OFFBOARDING_TRANSFER',
      ] as const;
      const jobIds: string[] = [];
      for (const [index, reason] of reasons.entries()) {
        const job = await newPastStartJob(pool, {
          ctx, title: `Geri çekilen ${reason}`, scheduledAt, baseline,
        });
        await offerFor(pool, {
          ctx, jobCardId: job.id, openedAt: atLocal(day, 10, index),
          acceptanceDueAt: atLocal(day, 15, 0), state: 'WITHDRAWN',
          closeReason: reason, closeText: null,
        });
        jobIds.push(job.id);
      }

      const listed = await listIds(service, ctx);
      const needsAction = await needsActionIds(service, ctx);
      expect(listed.sort()).toEqual(jobIds.sort());
      expect(needsAction).toEqual([]);
      expectDisjoint(listed, needsAction);
    });
  });

  it('P2 row 7: a stale ACCEPTED offer on a NEW job is owned by this list only', async () => {
    await withSchema('ovr6_p2_r7', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const ctx = await seed(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const scheduledAt = atLocal(day, 13, 0);
      const clock = { now: atLocal(day, 14, 0) };
      const { service } = buildJobCardService(pool, clock, { assignmentWindowEnabled: true });
      const job = await newPastStartJob(pool, { ctx, title: 'Eski kabul', scheduledAt, baseline });
      await offerFor(pool, {
        ctx, jobCardId: job.id, openedAt: atLocal(day, 10, 0),
        acceptanceDueAt: atLocal(day, 15, 0), state: 'ACCEPTED',
        closedAt: atLocal(day, 11, 0), closedBy: ctx.staffId,
      });

      const listed = await listIds(service, ctx);
      const needsAction = await needsActionIds(service, ctx);
      expect(listed).toEqual([job.id]);
      expect(needsAction).toEqual([]);
      expectDisjoint(listed, needsAction);
    });
  });

  it('P3 rejects a Staff read of the list with 403', async () => {
    await withSchema('ovr6_p3', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const ctx = await seed(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const scheduledAt = atLocal(day, 13, 0);
      const clock = { now: atLocal(day, 14, 0) };
      const { service } = buildJobCardService(pool, clock);
      await newPastStartJob(pool, { ctx, title: 'Gizli iş', scheduledAt, baseline });

      await expect(service.listUnacceptedPastStart(
        actor(ctx.staffId, ctx.organizationId, 'STAFF'), { limit: 10, offset: 0 },
      )).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });
  });

  it('P4 keeps the same owners after the assignment window is disabled', async () => {
    await withSchema('ovr6_p4', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const ctx = await seed(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const scheduledAt = atLocal(day, 13, 0);
      const clock = { now: atLocal(day, 14, 0) };
      const windowOn = buildJobCardService(pool, clock, { assignmentWindowEnabled: true }).service;
      const windowOff = buildJobCardService(pool, clock, { assignmentWindowEnabled: false }).service;

      const noOffer = await newPastStartJob(pool, { ctx, title: 'Teklifsiz', scheduledAt, baseline });
      const openUrgent = await newPastStartJob(pool, { ctx, title: 'Acil', scheduledAt, baseline });
      await offerFor(pool, {
        ctx, jobCardId: openUrgent.id, openedAt: atLocal(day, 11, 0),
        acceptanceDueAt: atLocal(day, 15, 0), urgentReason: 'START_PASSED',
      });
      const openAnswerable = await newPastStartJob(pool, {
        ctx, title: 'Yanıtlanabilir', scheduledAt, baseline,
      });
      await offerFor(pool, {
        ctx, jobCardId: openAnswerable.id, openedAt: atLocal(day, 11, 0),
        acceptanceDueAt: atLocal(day, 15, 0),
      });
      const declined = await newPastStartJob(pool, { ctx, title: 'Reddedilen', scheduledAt, baseline });
      await offerFor(pool, {
        ctx, jobCardId: declined.id, openedAt: atLocal(day, 11, 0),
        acceptanceDueAt: atLocal(day, 15, 0), state: 'DECLINED',
        closeReason: 'OTHER', closeText: 'Uygun değil.',
      });
      const withdrawnOther = await newPastStartJob(pool, {
        ctx, title: 'Yeniden atanan', scheduledAt, baseline,
      });
      await offerFor(pool, {
        ctx, jobCardId: withdrawnOther.id, openedAt: atLocal(day, 11, 0),
        acceptanceDueAt: atLocal(day, 15, 0), state: 'WITHDRAWN',
        closeReason: 'REASSIGNED', closeText: null,
      });
      const withdrawnWindow = await newPastStartJob(pool, {
        ctx, title: 'Pencere geçti', scheduledAt, baseline,
      });
      await offerFor(pool, {
        ctx, jobCardId: withdrawnWindow.id, openedAt: atLocal(day, 11, 0),
        acceptanceDueAt: atLocal(day, 15, 0), state: 'WITHDRAWN',
        closeReason: 'PLANNED_WINDOW_PASSED', closeText: null,
      });
      const staleAccepted = await newPastStartJob(pool, {
        ctx, title: 'Eski kabul', scheduledAt, baseline,
      });
      await offerFor(pool, {
        ctx, jobCardId: staleAccepted.id, openedAt: atLocal(day, 10, 0),
        acceptanceDueAt: atLocal(day, 15, 0), state: 'ACCEPTED',
        closedAt: atLocal(day, 10, 30), closedBy: ctx.staffId,
      });

      // Owned by this list: no offer, WITHDRAWN+other, stale ACCEPTED.
      const expectedOwned = [noOffer.id, withdrawnOther.id, staleAccepted.id].sort();
      // Owned by needs-action: OPEN urgent, DECLINED, WITHDRAWN+window.
      const expectedNeedsAction = [openUrgent.id, declined.id, withdrawnWindow.id].sort();

      for (const service of [windowOn, windowOff]) {
        const listed = (await listIds(service, ctx)).sort();
        const needsAction = (await needsActionIds(service, ctx)).sort();
        expect(listed).toEqual(expectedOwned);
        expect(needsAction).toEqual(expectedNeedsAction);
        expect(listed).not.toContain(openAnswerable.id);
        expectDisjoint(listed, needsAction);
      }
    });
  });
});
