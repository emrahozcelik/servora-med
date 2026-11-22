/**
 * OVR-6: lateness alert worker (start reminder, approval-wait alert,
 * unaccepted past-start alert).
 *
 * Accepted contract: `DECISIONS.md` OVR-6 and
 * `docs/features/lateness-notifications-quiet-hours.md` (§3–§7).
 *
 * Responsibility split (deliberate):
 * - the JobCard lifecycle owns job truth, the OVR-2/OVR-3 scanner owns
 *   incidents and JOB-010 owns offers; this worker defines none of them;
 * - this worker only sends the three once-per-identity automatic alerts, gated
 *   by the organization-local sending window (§3).
 *
 * Concurrency and atomicity (§7.6): one candidate is one transaction. The
 * delivery row is anchored FIRST — its `NULLS NOT DISTINCT` identity decides
 * the race — and only the insert winner writes the activity, the realtime
 * event, the in-app notifications and the Web Push delivery rows. Any failure
 * rolls back all of them, including the delivery row, so the next tick retries
 * and a delivery row never exists without its notifications.
 *
 * Lock order (§7.1): users → JobCard, as JOB-010 §9 requires. A snapshot read
 * finds the involved users, `lockAssigneesInOrder` locks them, and only then
 * `getJobForUpdate` orders the decision. Every condition is re-checked after
 * both locks; nothing discovered earlier is trusted.
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
  DEFAULT_NOTIFICATION_WINDOW,
  type NotificationWindowPolicy,
} from '../notifications/quiet-hours.js';
import { lockAssigneesInOrder } from './assignee-lock.js';
import {
  LATENESS_ALERT_BATCH_SIZE,
  LATENESS_ALERT_POLL_INTERVAL_MS,
  isStartReminderDue,
  resolveLatenessAlertTiming,
  startReminderDueCutoff,
  type LatenessAlertKind,
  type LatenessAlertTiming,
  type ResolvedLatenessAlertTiming,
} from './lateness-alert-policy.js';
import type {
  ApprovalWaitAlertCandidate,
  JobCardRepository,
  JobCardTransaction,
  PendingAcceptanceAlertCandidate,
  StartReminderCandidate,
} from './repository.js';
import type { JobCardActivityEvent } from './types.js';

/** Result of processing one discovered candidate. */
export type LatenessAlertCandidateOutcome =
  | { kind: 'sent' }
  /** A condition no longer holds, or the identity already exists. */
  | { kind: 'skipped' }
  | { kind: 'skipped-not-due' }
  | { kind: 'skipped-recipient-unprovable' }
  /** OVR-6 §3.6: the window closed between discovery and the under-lock check. */
  | { kind: 'deferred-quiet-hours' };

/** Bounded per-kind operational visibility for one iteration (§3.6). */
export type LatenessAlertKindReport = {
  candidates: number;
  sent: number;
  deferredQuietHours: number;
  skipped: number;
  failed: number;
  /** Live realtime publish failures after a committed outcome (transport-only). */
  publishFailed: number;
};

export type LatenessAlertIterationReport = {
  scanTime: string;
  startReminder: LatenessAlertKindReport;
  approvalWait: LatenessAlertKindReport;
  pendingAcceptance: LatenessAlertKindReport;
};

export type LatenessAlertWorkerLogger = Readonly<{
  debug: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}>;

export interface LatenessAlertWorkerRepository {
  listStartReminderCandidates(input: {
    scanTime: Date;
    cutoff: Date;
    limit: number;
    notificationWindow: NotificationWindowPolicy;
  }): Promise<readonly StartReminderCandidate[]>;
  listApprovalWaitAlertCandidates(input: {
    scanTime: Date;
    limit: number;
    notificationWindow: NotificationWindowPolicy;
  }): Promise<readonly ApprovalWaitAlertCandidate[]>;
  listPendingAcceptanceAlertCandidates(input: {
    scanTime: Date;
    limit: number;
    notificationWindow: NotificationWindowPolicy;
  }): Promise<readonly PendingAcceptanceAlertCandidate[]>;
  processStartReminder(input: {
    candidate: StartReminderCandidate;
    scanTime: Date;
    timing: ResolvedLatenessAlertTiming;
    notificationWindow: NotificationWindowPolicy;
    webPushEnabled: boolean;
  }): Promise<LatenessAlertProcessResult>;
  processApprovalWaitAlert(input: {
    candidate: ApprovalWaitAlertCandidate;
    scanTime: Date;
    notificationWindow: NotificationWindowPolicy;
    webPushEnabled: boolean;
  }): Promise<LatenessAlertProcessResult>;
  processPendingAcceptanceAlert(input: {
    candidate: PendingAcceptanceAlertCandidate;
    scanTime: Date;
    notificationWindow: NotificationWindowPolicy;
    webPushEnabled: boolean;
  }): Promise<LatenessAlertProcessResult>;
}

export type LatenessAlertProcessResult = {
  outcome: LatenessAlertCandidateOutcome;
  realtimeEvents: readonly RealtimeEventRecord[];
};

const ACTIVITY_EVENT_BY_KIND: Readonly<Record<LatenessAlertKind, JobCardActivityEvent>> = {
  START_REMINDER: 'JOB_START_REMINDER_SENT',
  APPROVAL_WAIT_ALERT: 'JOB_APPROVAL_WAIT_ALERT_SENT',
  PENDING_ACCEPTANCE_ALERT: 'JOB_PENDING_ACCEPTANCE_ALERT_SENT',
};

const NOTIFICATION_KIND_BY_KIND = {
  START_REMINDER: 'job.start_reminder',
  APPROVAL_WAIT_ALERT: 'job.approval_wait_alert',
  PENDING_ACCEPTANCE_ALERT: 'job.pending_acceptance_alert',
} as const satisfies Record<LatenessAlertKind, NotificationDraft['kind']>;

/** Job types an unaccepted past-start alert can never cover (§6.1 policy). */
const NON_FIELD_WORK_TYPES: readonly string[] = ['WEEKLY_REPORT', 'SALE'];

export class PostgresLatenessAlertWorkerRepository implements LatenessAlertWorkerRepository {
  constructor(private readonly repository: JobCardRepository) {}

  listStartReminderCandidates(input: {
    scanTime: Date;
    cutoff: Date;
    limit: number;
    notificationWindow: NotificationWindowPolicy;
  }) {
    return this.repository.listDueStartReminderCandidates(input);
  }

  listApprovalWaitAlertCandidates(input: {
    scanTime: Date;
    limit: number;
    notificationWindow: NotificationWindowPolicy;
  }) {
    return this.repository.listOpenApprovalWaitAlertCandidates(input);
  }

  listPendingAcceptanceAlertCandidates(input: {
    scanTime: Date;
    limit: number;
    notificationWindow: NotificationWindowPolicy;
  }) {
    return this.repository.listUnacceptedPastStartAlertCandidates(input);
  }

  async processStartReminder(input: {
    candidate: StartReminderCandidate;
    scanTime: Date;
    timing: ResolvedLatenessAlertTiming;
    notificationWindow: NotificationWindowPolicy;
    webPushEnabled: boolean;
  }): Promise<LatenessAlertProcessResult> {
    const { organizationId, jobCardId } = input.candidate;
    return this.repository.executeTransaction(async (tx) => {
      const snapshot = await tx.getLatenessAlertJobSnapshot(organizationId, jobCardId);
      if (snapshot === null || snapshot.status !== 'ACCEPTED' || snapshot.scheduledAt === null) {
        return skippedOutcome();
      }
      // A reschedule (or any other planned-start change) is a different
      // identity: the new start is discovered and alerted on its own tick.
      if (snapshot.scheduledAt.valueOf() !== input.candidate.plannedStartAt.valueOf()) {
        return skippedOutcome();
      }
      // Lock order users -> JobCard (JOB-010 §9).
      const locked = await lockAssigneesInOrder(tx, organizationId, [snapshot.assignedTo]);
      const job = await tx.getJobForUpdate(organizationId, jobCardId);
      if (job === null) return skippedOutcome();
      if (await this.isQuiet(tx, input.scanTime, organizationId, input.notificationWindow)) {
        return skippedOutcome('deferred-quiet-hours');
      }
      // Re-read the facts under the lock: `started_at` is not part of the
      // public JobCard projection, and the assignee may have changed.
      const facts = await tx.getLatenessAlertJobSnapshot(organizationId, jobCardId);
      if (facts === null
        || facts.status !== 'ACCEPTED'
        || facts.scheduledAt === null
        || facts.startedAt !== null
        || facts.assignedTo !== snapshot.assignedTo) {
        return skippedOutcome();
      }
      if (facts.scheduledAt.valueOf() !== input.candidate.plannedStartAt.valueOf()) {
        return skippedOutcome();
      }
      const assignee = locked.get(facts.assignedTo);
      if (!assignee || !assignee.isActive || assignee.role !== 'STAFF') {
        return skippedOutcome('skipped-recipient-unprovable');
      }
      // JOB-010 release 2a (D1 §5): no automatic notification while a
      // change/termination request is OPEN.
      const openChangeRequest = await tx.getOpenChangeRequest(organizationId, jobCardId);
      if (openChangeRequest !== null) return skippedOutcome();
      if (!isStartReminderDue(facts.scheduledAt, input.scanTime, input.timing)) {
        return skippedOutcome('skipped-not-due');
      }
      return this.send(tx, {
        organizationId,
        jobCardId,
        assignedTo: facts.assignedTo,
        scanTime: input.scanTime,
        webPushEnabled: input.webPushEnabled,
        kind: 'START_REMINDER',
        plannedStartAt: facts.scheduledAt,
        recipientUserId: facts.assignedTo,
        incidentId: null,
        metadata: {
          kind: 'START_REMINDER',
          plannedStartAt: facts.scheduledAt.toISOString(),
          targetStaffUserId: facts.assignedTo,
        },
        drafts: [{
          recipientUserId: facts.assignedTo,
          kind: NOTIFICATION_KIND_BY_KIND.START_REMINDER,
          entityType: 'job-card',
          entityId: jobCardId,
        }],
      });
    });
  }

  async processApprovalWaitAlert(input: {
    candidate: ApprovalWaitAlertCandidate;
    scanTime: Date;
    notificationWindow: NotificationWindowPolicy;
    webPushEnabled: boolean;
  }): Promise<LatenessAlertProcessResult> {
    const { organizationId, jobCardId } = input.candidate;
    return this.repository.executeTransaction(async (tx) => {
      const snapshot = await tx.getLatenessAlertJobSnapshot(organizationId, jobCardId);
      if (snapshot === null || snapshot.status !== 'WAITING_APPROVAL') return skippedOutcome();
      // The job's assignee row is locked first for a consistent lock order even
      // though this alert is addressed to management.
      await lockAssigneesInOrder(tx, organizationId, [snapshot.assignedTo]);
      const job = await tx.getJobForUpdate(organizationId, jobCardId);
      if (job === null) return skippedOutcome();
      if (await this.isQuiet(tx, input.scanTime, organizationId, input.notificationWindow)) {
        return skippedOutcome('deferred-quiet-hours');
      }
      const facts = await tx.getLatenessAlertJobSnapshot(organizationId, jobCardId);
      if (facts === null || facts.status !== 'WAITING_APPROVAL') return skippedOutcome();
      const incident = await tx.getOpenApprovalWaitIncident(organizationId, jobCardId);
      // Once per incident: a new submission cycle has its own incident.
      if (incident === null || incident.id !== input.candidate.incidentId) {
        return skippedOutcome();
      }
      // Management is already notified of the open request (D1 §5); once it is
      // resolved and the job still waits, the next in-window tick alerts.
      const openChangeRequest = await tx.getOpenChangeRequest(organizationId, jobCardId);
      if (openChangeRequest !== null) return skippedOutcome();
      const recipients = await tx.listActiveManagementRecipients(organizationId);
      const drafts = recipients.map((recipient) => ({
        recipientUserId: recipient.id,
        kind: NOTIFICATION_KIND_BY_KIND.APPROVAL_WAIT_ALERT,
        entityType: 'job-card' as const,
        entityId: jobCardId,
      }));
      return this.send(tx, {
        organizationId,
        jobCardId,
        assignedTo: facts.assignedTo,
        scanTime: input.scanTime,
        webPushEnabled: input.webPushEnabled,
        kind: 'APPROVAL_WAIT_ALERT',
        plannedStartAt: null,
        recipientUserId: null,
        incidentId: incident.id,
        metadata: {
          kind: 'APPROVAL_WAIT_ALERT',
          incidentId: incident.id,
          episodeNo: incident.episodeNo,
          scheduleRevisionNo: incident.scheduleRevisionNo,
          breachedAt: incident.breachedAt.toISOString(),
          deadlineAt: incident.deadlineAt.toISOString(),
          recipientCount: drafts.length,
        },
        drafts,
      });
    });
  }

  async processPendingAcceptanceAlert(input: {
    candidate: PendingAcceptanceAlertCandidate;
    scanTime: Date;
    notificationWindow: NotificationWindowPolicy;
    webPushEnabled: boolean;
  }): Promise<LatenessAlertProcessResult> {
    const { organizationId, jobCardId } = input.candidate;
    return this.repository.executeTransaction(async (tx) => {
      const snapshot = await tx.getLatenessAlertJobSnapshot(organizationId, jobCardId);
      if (snapshot === null || snapshot.status !== 'NEW' || snapshot.scheduledAt === null) {
        return skippedOutcome();
      }
      await lockAssigneesInOrder(tx, organizationId, [snapshot.assignedTo]);
      const job = await tx.getJobForUpdate(organizationId, jobCardId);
      if (job === null) return skippedOutcome();
      if (await this.isQuiet(tx, input.scanTime, organizationId, input.notificationWindow)) {
        return skippedOutcome('deferred-quiet-hours');
      }
      const facts = await tx.getLatenessAlertJobSnapshot(organizationId, jobCardId);
      if (facts === null
        || facts.status !== 'NEW'
        || facts.scheduledAt === null
        || NON_FIELD_WORK_TYPES.includes(facts.type)) {
        return skippedOutcome();
      }
      // A future reschedule removes the job from the list entirely.
      if (facts.scheduledAt.valueOf() > input.scanTime.valueOf()) {
        return skippedOutcome('skipped-not-due');
      }
      if (facts.scheduledAt.valueOf() !== input.candidate.plannedStartAt.valueOf()) {
        return skippedOutcome();
      }
      // An open change request keeps the job listed but sends no alert (D1 §5).
      const openChangeRequest = await tx.getOpenChangeRequest(organizationId, jobCardId);
      if (openChangeRequest !== null) return skippedOutcome();
      // The same shared predicate the management list uses, evaluated under
      // the lock against the worker's clock.
      const qualifies = await tx.matchesUnacceptedPastStart({
        organizationId,
        jobCardId,
        requestTime: input.scanTime,
      });
      if (!qualifies) return skippedOutcome();
      const recipients = await tx.listActiveManagementRecipients(organizationId);
      const drafts = recipients.map((recipient) => ({
        recipientUserId: recipient.id,
        kind: NOTIFICATION_KIND_BY_KIND.PENDING_ACCEPTANCE_ALERT,
        entityType: 'job-card' as const,
        entityId: jobCardId,
      }));
      return this.send(tx, {
        organizationId,
        jobCardId,
        assignedTo: facts.assignedTo,
        scanTime: input.scanTime,
        webPushEnabled: input.webPushEnabled,
        kind: 'PENDING_ACCEPTANCE_ALERT',
        plannedStartAt: facts.scheduledAt,
        recipientUserId: null,
        incidentId: null,
        metadata: {
          kind: 'PENDING_ACCEPTANCE_ALERT',
          plannedStartAt: facts.scheduledAt.toISOString(),
          assigneeUserId: facts.assignedTo,
          recipientCount: drafts.length,
        },
        drafts,
      });
    });
  }

  /**
   * OVR-6 §3.5: the window is a due-gate evaluated at `scanTime`. A candidate
   * discovered inside the window whose under-lock check finds it closed is
   * deferred with nothing written.
   */
  private async isQuiet(
    tx: JobCardTransaction,
    scanTime: Date,
    organizationId: string,
    notificationWindow: NotificationWindowPolicy,
  ): Promise<boolean> {
    const timezone = await tx.getOrganizationTimezone(organizationId);
    return !notificationWindow.isOpen(scanTime, timezone);
  }

  /**
   * Anchor and send one alert inside the candidate's transaction. The delivery
   * row goes first; a loser writes nothing. Every recipient-facing row is
   * written before commit, so a failure leaves no trace at all.
   */
  private async send(
    tx: JobCardTransaction,
    input: {
      organizationId: string;
      jobCardId: string;
      assignedTo: string;
      scanTime: Date;
      webPushEnabled: boolean;
      kind: LatenessAlertKind;
      plannedStartAt: Date | null;
      recipientUserId: string | null;
      incidentId: string | null;
      metadata: Record<string, unknown>;
      drafts: readonly NotificationDraft[];
    },
  ): Promise<LatenessAlertProcessResult> {
    const delivery = await tx.insertLatenessAlertDelivery({
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      kind: input.kind,
      plannedStartAt: input.plannedStartAt,
      recipientUserId: input.recipientUserId,
      incidentId: input.incidentId,
      sentAt: input.scanTime,
    });
    if (!delivery.created) return skippedOutcome();
    const activity = await tx.appendActivity({
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      actorId: null,
      event: ACTIVITY_EVENT_BY_KIND[input.kind],
      metadata: {
        ...input.metadata,
        deliveryId: delivery.id,
        sentAt: input.scanTime.toISOString(),
      },
    });
    const mapped = mapJobCardActivityToRealtime({
      activityId: activity.id,
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      actorUserId: null,
      event: ACTIVITY_EVENT_BY_KIND[input.kind],
      occurredAt: input.scanTime,
      beforeAssigneeId: null,
      afterAssigneeId: input.assignedTo,
    });
    if (!mapped) {
      // §7.3: the activity-backed realtime event is the only transport for the
      // in-app notification. A missing mapping must fail the whole transaction
      // rather than anchor a delivery row without its notifications.
      throw new Error('LATENESS_ALERT_REALTIME_MAPPING_MISSING');
    }
    const realtimeEvent = await tx.appendRealtimeEvent({
      ...mapped,
      resourceKeys: input.drafts.length > 0
        ? [...new Set([...mapped.resourceKeys, 'notifications'])].sort()
        : [...mapped.resourceKeys].sort(),
    });
    if (input.drafts.length > 0) {
      const notifications = await tx.appendNotifications({
        organizationId: input.organizationId,
        sourceRealtimeEventId: realtimeEvent.id,
        createdAt: input.scanTime,
        drafts: input.drafts,
      });
      if (input.webPushEnabled && notifications.length > 0) {
        await tx.appendWebPushDeliveries({
          organizationId: input.organizationId,
          notificationIds: notifications.map((notification) => notification.id),
          at: input.scanTime,
        });
      }
    }
    return { outcome: { kind: 'sent' }, realtimeEvents: [realtimeEvent] };
  }
}

type SkippedKind = Extract<
  LatenessAlertCandidateOutcome['kind'],
  'skipped' | 'skipped-not-due' | 'skipped-recipient-unprovable' | 'deferred-quiet-hours'
>;

function skippedOutcome(kind: SkippedKind = 'skipped'): LatenessAlertProcessResult {
  return { outcome: { kind }, realtimeEvents: [] };
}

export type LatenessAlertWorker = Readonly<{
  start(): void;
  stop(): Promise<void>;
  runIteration(): Promise<LatenessAlertIterationReport>;
}>;

/**
 * Bounded, non-overlapping worker loop following the OVR-3 / OVR-4 / JOB-010
 * conventions. Three per-kind discovery queries each get their own `batchSize`
 * budget, so a full kind never starves another (§7.2). No distributed lease
 * layer: the per-candidate JobCard row lock plus the delivery identity already
 * make concurrent workers converge on one durable delivery per identity.
 */
export function createLatenessAlertWorker(options: {
  repository: LatenessAlertWorkerRepository;
  now?: () => Date;
  notificationWindow?: NotificationWindowPolicy;
  timing?: LatenessAlertTiming;
  batchSize?: number;
  pollIntervalMs?: number;
  webPushEnabled?: boolean;
  /** Realtime transport for the appended events (default: no subscriber). */
  publisher?: RealtimeEventPublisher;
  logger?: LatenessAlertWorkerLogger;
}): LatenessAlertWorker {
  const now = options.now ?? (() => new Date());
  const notificationWindow = options.notificationWindow ?? DEFAULT_NOTIFICATION_WINDOW;
  const timing = resolveLatenessAlertTiming(options.timing);
  const batchSize = options.batchSize ?? LATENESS_ALERT_BATCH_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? LATENESS_ALERT_POLL_INTERVAL_MS;
  const webPushEnabled = options.webPushEnabled === true;
  const publisher = options.publisher ?? NOOP_REALTIME_EVENT_PUBLISHER;
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<LatenessAlertIterationReport> | null = null;

  const logError = (error: unknown) => {
    try {
      options.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Lateness alert iteration failed',
      );
    } catch {
      // best-effort logging only
    }
  };

  const runKind = async <TCandidate>(
    report: LatenessAlertKindReport,
    candidates: readonly TCandidate[],
    process: (candidate: TCandidate) => Promise<LatenessAlertProcessResult>,
  ) => {
    for (const candidate of candidates) {
      report.candidates += 1;
      try {
        const { outcome, realtimeEvents } = await process(candidate);
        switch (outcome.kind) {
          case 'sent': report.sent += 1; break;
          case 'deferred-quiet-hours': report.deferredQuietHours += 1; break;
          case 'skipped':
          case 'skipped-not-due':
          case 'skipped-recipient-unprovable':
            report.skipped += 1;
            break;
        }
        // Committed outcome: a live-publish failure is transport-only; it is
        // counted in `publishFailed`, never also as a failed candidate.
        for (const event of realtimeEvents) {
          try {
            publisher.publish(event);
          } catch (error) {
            report.publishFailed += 1;
            logError(error);
          }
        }
      } catch (error) {
        // One failing candidate never stops the batch or the other kinds; it
        // is retried on a later tick.
        report.failed += 1;
        logError(error);
      }
    }
  };

  const runIteration = async (): Promise<LatenessAlertIterationReport> => {
    const scanTime = now();
    const startReminder = emptyKindReport();
    const approvalWait = emptyKindReport();
    const pendingAcceptance = emptyKindReport();

    const startCandidates = await options.repository.listStartReminderCandidates({
      scanTime,
      cutoff: startReminderDueCutoff(scanTime, timing.startReminderDelayMs),
      limit: batchSize,
      notificationWindow,
    });
    await runKind(startReminder, startCandidates, (candidate) => (
      options.repository.processStartReminder({
        candidate, scanTime, timing, notificationWindow, webPushEnabled,
      })
    ));

    const approvalCandidates = await options.repository.listApprovalWaitAlertCandidates({
      scanTime,
      limit: batchSize,
      notificationWindow,
    });
    await runKind(approvalWait, approvalCandidates, (candidate) => (
      options.repository.processApprovalWaitAlert({
        candidate, scanTime, notificationWindow, webPushEnabled,
      })
    ));

    const pendingCandidates = await options.repository.listPendingAcceptanceAlertCandidates({
      scanTime,
      limit: batchSize,
      notificationWindow,
    });
    await runKind(pendingAcceptance, pendingCandidates, (candidate) => (
      options.repository.processPendingAcceptanceAlert({
        candidate, scanTime, notificationWindow, webPushEnabled,
      })
    ));

    const report: LatenessAlertIterationReport = {
      scanTime: scanTime.toISOString(),
      startReminder,
      approvalWait,
      pendingAcceptance,
    };
    try {
      options.logger?.debug({ latenessAlerts: report }, 'Lateness alert iteration');
    } catch {
      // best-effort logging only
    }
    return report;
  };

  return {
    start() {
      if (timer) return;
      const tick = () => {
        active = runIteration().catch((error: unknown) => {
          logError(error);
          return failedReport(now());
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
    runIteration,
  };
}

function emptyKindReport(): LatenessAlertKindReport {
  return { candidates: 0, sent: 0, deferredQuietHours: 0, skipped: 0, failed: 0, publishFailed: 0 };
}

/** Explicit not-run report so a failed tick is never mistaken for a clean one. */
function failedReport(scanTime: Date): LatenessAlertIterationReport {
  return {
    scanTime: scanTime.toISOString(),
    startReminder: { ...emptyKindReport(), failed: 1 },
    approvalWait: { ...emptyKindReport(), failed: 1 },
    pendingAcceptance: { ...emptyKindReport(), failed: 1 },
  };
}
