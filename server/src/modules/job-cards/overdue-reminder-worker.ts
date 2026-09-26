/**
 * OVR-4: LATE_SUBMISSION automatic reminder / escalation worker.
 *
 * Responsibility split (deliberate):
 * - the OVR-3 breach scanner owns breach truth (discovery/materialization);
 * - this worker owns notification side effects for already-materialized open
 *   incidents, keyed by the incident's `breached_at` age.
 *
 * It never defines a deadline, never writes incidents and never recovers:
 * every send re-reads the open incident under the JobCard row lock and skips
 * when the episode already recovered, left the submittable state, or already
 * carries delivery state for the due kind.
 *
 * Concurrency: the per-candidate JobCard row lock serializes competing
 * workers, and the UNIQUE (job, delay, episode, kind) delivery identity
 * absorbs the residual race — losers converge instead of duplicating
 * activities, realtime events or notifications. Restarts are safe for the
 * same reason: delivery state is durable, so a re-scan never re-sends.
 *
 * Clock discipline: `scanTime` is the single injected clock. It anchors
 * due-ness, `sent_at`, activity metadata, realtime `occurredAt` and
 * notification `created_at` alike. No `new Date()` / `Date.now()` / `NOW()`
 * decides domain time (`recorded_at` keeps its DB default as metadata).
 */

import {
  NOOP_REALTIME_EVENT_PUBLISHER,
  type RealtimeEventPublisher,
} from '../realtime/event-bus.js';
import { mapJobCardActivityToRealtime } from '../realtime/event-mapper.js';
import type { RealtimeEventRecord } from '../realtime/types.js';
import type { NotificationDraft } from '../notifications/types.js';
import {
  dueOverdueReminderKinds,
  resolveOverdueReminderTiming,
  type OverdueReminderKind,
  type OverdueReminderTiming,
  type ResolvedOverdueReminderTiming,
} from './overdue-reminder-policy.js';
import type {
  JobCardRepository,
  JobCardTransaction,
  OverdueScanCandidate,
  PersistedOverdueIncident,
} from './repository.js';
import type { JobCardActivityEvent } from './types.js';

/** Result of processing one discovered job. */
export type OverdueReminderCandidateOutcome =
  | { kind: 'sent'; kinds: readonly OverdueReminderKind[] }
  | { kind: 'converged' }
  | { kind: 'skipped-not-due' }
  | { kind: 'skipped-no-open-incident' }
  | { kind: 'skipped-state-changed' }
  | { kind: 'skipped-recipient-unprovable' };

/** Bounded operational visibility for one worker iteration. */
export type OverdueReminderIterationReport = {
  scanTime: string;
  candidates: number;
  sent: number;
  converged: number;
  skippedNotDue: number;
  skippedNoOpenIncident: number;
  skippedStateChanged: number;
  skippedRecipientUnprovable: number;
  failed: number;
  byKind: Readonly<Record<OverdueReminderKind, number>>;
};

export interface OverdueReminderWorkerRepository {
  listCandidates(input: {
    scanTime: Date;
    limit: number;
  }): Promise<readonly OverdueScanCandidate[]>;
  processCandidate(input: {
    candidate: OverdueScanCandidate;
    scanTime: Date;
    timing: ResolvedOverdueReminderTiming;
  }): Promise<{ outcome: OverdueReminderCandidateOutcome; realtimeEvents: readonly RealtimeEventRecord[] }>;
}

const SUBMITTABLE_STATUSES = ['IN_PROGRESS', 'REVISION_REQUESTED'] as const;

const ACTIVITY_EVENT_BY_KIND: Readonly<Record<OverdueReminderKind, JobCardActivityEvent>> = {
  STAFF_REMINDER: 'JOB_SUBMISSION_AUTO_REMINDER_SENT',
  MANAGEMENT_ESCALATION: 'JOB_SUBMISSION_AUTO_ESCALATION_SENT',
};

const NOTIFICATION_KIND_BY_KIND = {
  STAFF_REMINDER: 'job.submission_auto_reminder',
  MANAGEMENT_ESCALATION: 'job.submission_auto_escalation',
} as const satisfies Record<OverdueReminderKind, NotificationDraft['kind']>;

export class PostgresOverdueReminderWorkerRepository
implements OverdueReminderWorkerRepository {
  constructor(
    private readonly repository: JobCardRepository,
    private readonly webPushEnabled: boolean = false,
  ) {}

  listCandidates(input: { scanTime: Date; limit: number }) {
    return this.repository.listDueOpenSubmissionLateEpisodes(input);
  }

  async processCandidate(input: {
    candidate: OverdueScanCandidate;
    scanTime: Date;
    timing: ResolvedOverdueReminderTiming;
  }): Promise<{ outcome: OverdueReminderCandidateOutcome; realtimeEvents: readonly RealtimeEventRecord[] }> {
    const { organizationId, jobCardId } = input.candidate;
    return this.repository.executeTransaction(async (tx) => {
      const job = await tx.getJobForUpdate(organizationId, jobCardId);
      if (job === null
        || !(SUBMITTABLE_STATUSES as readonly string[]).includes(job.status)) {
        return { outcome: { kind: 'skipped-state-changed' }, realtimeEvents: [] };
      }
      const open = await tx.listOpenLateSubmissionIncidents(organizationId, jobCardId);
      if (open.length === 0) {
        return { outcome: { kind: 'skipped-no-open-incident' }, realtimeEvents: [] };
      }
      // One job normally carries a single open submission episode (SUBMIT
      // recovers the previous one before a re-arm opens the next), but group
      // defensively: every open episode is evaluated independently.
      const byEpisode = new Map<number, PersistedOverdueIncident[]>();
      for (const incident of open) {
        const group = byEpisode.get(incident.episodeNo);
        if (group) group.push(incident);
        else byEpisode.set(incident.episodeNo, [incident]);
      }
      const realtimeEvents: RealtimeEventRecord[] = [];
      const sentKinds: OverdueReminderKind[] = [];
      let converged = 0;
      let notDue = 0;
      let recipientUnprovable = 0;
      for (const [episodeNo, rows] of byEpisode) {
        // Canonical operational signal: the earliest open breach of the
        // episode. Revision-bound duplicates never move the reminder clock.
        const canonical = rows[0]!;
        const dueKinds = dueOverdueReminderKinds(
          canonical.breachedAt, input.scanTime, input.timing,
        );
        if (dueKinds.length === 0) {
          notDue += 1;
          continue;
        }
        for (const kind of dueKinds) {
          const result = await this.sendDueKind(tx, {
            job: { organizationId, jobCardId, assignedTo: job.assignedTo },
            canonical,
            episodeNo,
            kind,
            scanTime: input.scanTime,
          });
          if (result.status === 'sent') {
            sentKinds.push(kind);
            if (result.realtimeEvent) realtimeEvents.push(result.realtimeEvent);
          } else if (result.status === 'converged') {
            converged += 1;
          } else if (result.status === 'not-due') {
            notDue += 1;
          } else {
            // One unprovable recipient must not starve the sibling kind:
            // an escalation still fires while the staff reminder retries on
            // later ticks (e.g. after a corrective reassignment).
            recipientUnprovable += 1;
          }
        }
      }
      if (sentKinds.length > 0) {
        return {
          outcome: { kind: 'sent', kinds: sentKinds },
          realtimeEvents,
        };
      }
      if (recipientUnprovable > 0) {
        return { outcome: { kind: 'skipped-recipient-unprovable' }, realtimeEvents };
      }
      if (converged > 0) return { outcome: { kind: 'converged' }, realtimeEvents };
      return { outcome: { kind: 'skipped-not-due' }, realtimeEvents };
    });
  }

  /**
   * Send one due kind for one open episode. The delivery row is anchored
   * FIRST: its UNIQUE identity decides the race, so only the insert winner
   * proceeds to activity / realtime / notification side effects. The realtime
   * event is returned for the loop to publish after commit.
   */
  private async sendDueKind(
    tx: JobCardTransaction,
    input: {
      job: { organizationId: string; jobCardId: string; assignedTo: string };
      canonical: PersistedOverdueIncident;
      episodeNo: number;
      kind: OverdueReminderKind;
      scanTime: Date;
    },
  ): Promise<
    | { status: 'sent'; realtimeEvent: RealtimeEventRecord | null }
    | { status: 'converged' | 'not-due' | 'recipient-unprovable'; realtimeEvent?: undefined }
  > {
    const { organizationId, jobCardId } = input.job;
    const existing = await tx.getOverdueNotificationDelivery({
      organizationId,
      jobCardId,
      delayType: 'LATE_SUBMISSION',
      episodeNo: input.episodeNo,
      kind: input.kind,
    });
    if (existing) return { status: 'converged' };

    let drafts: NotificationDraft[];
    let recipientUserId: string | null;
    if (input.kind === 'STAFF_REMINDER') {
      // Operational recipient is the current assignee (who can act now);
      // incident accountability history is never rewritten by this choice.
      const assignee = await tx.getAssigneeForUpdate(organizationId, input.job.assignedTo);
      if (assignee === null || !assignee.isActive || assignee.role !== 'STAFF') {
        return { status: 'recipient-unprovable' };
      }
      recipientUserId = assignee.id;
      drafts = [{
        recipientUserId: assignee.id,
        kind: NOTIFICATION_KIND_BY_KIND[input.kind],
        entityType: 'job-card',
        entityId: jobCardId,
      }];
    } else {
      const managers = await tx.listActiveManagementRecipients(organizationId);
      recipientUserId = null;
      // No active managers: the delivery row is still anchored (the incident
      // stays visible in the manager open-late list), so a later tick does
      // not spin on an unnotifiable episode.
      drafts = managers.map((manager) => ({
        recipientUserId: manager.id,
        kind: NOTIFICATION_KIND_BY_KIND[input.kind],
        entityType: 'job-card' as const,
        entityId: jobCardId,
      }));
    }

    const delivery = await tx.insertOverdueNotificationDelivery({
      organizationId,
      jobCardId,
      delayType: 'LATE_SUBMISSION',
      episodeNo: input.episodeNo,
      kind: input.kind,
      incidentId: input.canonical.id,
      sentAt: input.scanTime,
      recipientUserId,
    });
    if (!delivery.created) return { status: 'converged' };

    const activity = await tx.appendActivity({
      organizationId,
      jobCardId,
      actorId: null,
      event: ACTIVITY_EVENT_BY_KIND[input.kind],
      metadata: {
        incidentId: input.canonical.id,
        delayType: 'LATE_SUBMISSION',
        episodeNo: input.episodeNo,
        scheduleRevisionNo: input.canonical.scheduleRevisionNo,
        breachedAt: input.canonical.breachedAt.toISOString(),
        deadlineAt: input.canonical.deadlineAt.toISOString(),
        sentAt: input.scanTime.toISOString(),
        kind: input.kind,
        ...(recipientUserId ? { targetStaffUserId: recipientUserId } : {}),
      },
    });
    const mapped = mapJobCardActivityToRealtime({
      activityId: activity.id,
      organizationId,
      jobCardId,
      actorUserId: null,
      event: ACTIVITY_EVENT_BY_KIND[input.kind],
      occurredAt: input.scanTime,
      beforeAssigneeId: null,
      afterAssigneeId: input.job.assignedTo,
    });
    if (!mapped) return { status: 'sent', realtimeEvent: null };
    const realtimeEvent = await tx.appendRealtimeEvent({
      ...mapped,
      resourceKeys: [...new Set([...mapped.resourceKeys, 'notifications'])].sort(),
    });
    if (drafts.length > 0) {
      const notifications = await tx.appendNotifications({
        organizationId,
        sourceRealtimeEventId: realtimeEvent.id,
        createdAt: input.scanTime,
        drafts,
      });
      if (this.webPushEnabled && notifications.length > 0) {
        await tx.appendWebPushDeliveries({
          organizationId,
          notificationIds: notifications.map((notification) => notification.id),
          at: input.scanTime,
        });
      }
    }
    return { status: 'sent', realtimeEvent };
  }
}

export type OverdueReminderWorker = Readonly<{
  start(): void;
  stop(): Promise<void>;
  runOnce(scanTime: Date): Promise<OverdueReminderIterationReport>;
}>;

/**
 * Bounded, non-overlapping worker loop following the OVR-3 scanner
 * conventions. No distributed lease layer: the per-candidate JobCard row
 * lock plus the UNIQUE delivery identity already make concurrent workers
 * converge on one durable delivery per episode and kind.
 */
export function createOverdueReminderWorker(
  repository: OverdueReminderWorkerRepository,
  options: Readonly<{
    now?: () => Date;
    publisher?: RealtimeEventPublisher;
    timing?: OverdueReminderTiming;
    pollIntervalMs?: number;
    batchSize?: number;
    onReport?: (report: OverdueReminderIterationReport) => void;
    onError?: (error: unknown) => void;
  }> = {},
): OverdueReminderWorker {
  const now = options.now ?? (() => new Date());
  const publisher = options.publisher ?? NOOP_REALTIME_EVENT_PUBLISHER;
  const timing = resolveOverdueReminderTiming(options.timing);
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const batchSize = options.batchSize ?? 50;
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<OverdueReminderIterationReport> | null = null;

  const report = (reportValue: OverdueReminderIterationReport) => {
    try {
      options.onReport?.(reportValue);
    } catch {
      // best-effort reporting only
    }
  };
  const reportError = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // best-effort reporting only
    }
  };

  const runOnce = async (scanTime: Date): Promise<OverdueReminderIterationReport> => {
    const byKind: Record<OverdueReminderKind, number> = {
      STAFF_REMINDER: 0,
      MANAGEMENT_ESCALATION: 0,
    };
    const counts = {
      candidates: 0,
      sent: 0,
      converged: 0,
      skippedNotDue: 0,
      skippedNoOpenIncident: 0,
      skippedStateChanged: 0,
      skippedRecipientUnprovable: 0,
      failed: 0,
    };
    const candidates = await repository.listCandidates({ scanTime, limit: batchSize });
    for (const candidate of candidates) {
      counts.candidates += 1;
      try {
        const { outcome, realtimeEvents } = await repository.processCandidate({
          candidate,
          scanTime,
          timing,
        });
        switch (outcome.kind) {
          case 'sent':
            counts.sent += 1;
            for (const kind of outcome.kinds) byKind[kind] += 1;
            break;
          case 'converged': counts.converged += 1; break;
          case 'skipped-not-due': counts.skippedNotDue += 1; break;
          case 'skipped-no-open-incident': counts.skippedNoOpenIncident += 1; break;
          case 'skipped-state-changed': counts.skippedStateChanged += 1; break;
          case 'skipped-recipient-unprovable': counts.skippedRecipientUnprovable += 1; break;
        }
        for (const event of realtimeEvents) publisher.publish(event);
      } catch (error) {
        counts.failed += 1;
        reportError(error);
      }
    }
    const result: OverdueReminderIterationReport = {
      scanTime: scanTime.toISOString(),
      ...counts,
      byKind,
    };
    report(result);
    return result;
  };

  return {
    start() {
      if (timer) return;
      const tick = () => {
        active = runOnce(now()).catch((error: unknown) => {
          reportError(error);
          return runOnceFailedReport(now());
        }).finally(() => {
          active = null;
          if (timer) timer = setTimeout(tick, pollIntervalMs);
        });
      };
      timer = setTimeout(tick, 0);
    },
    async stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      await active;
    },
    runOnce,
  };
}

/** Explicit not-run report so a failed tick is never mistaken for a clean one. */
function runOnceFailedReport(scanTime: Date): OverdueReminderIterationReport {
  return {
    scanTime: scanTime.toISOString(),
    candidates: 0,
    sent: 0,
    converged: 0,
    skippedNotDue: 0,
    skippedNoOpenIncident: 0,
    skippedStateChanged: 0,
    skippedRecipientUnprovable: 0,
    failed: 1,
    byKind: { STAFF_REMINDER: 0, MANAGEMENT_ESCALATION: 0 },
  };
}
