/**
 * JOB-010 release 2b: assignment offer expiry / reminder worker.
 *
 * Responsibility split (deliberate):
 * - the JobCard lifecycle owns the offer truth (producers, accept, decline,
 *   release, withdraw) and the server rejects a late answer on every request
 *   against `acceptance_due_at`; this worker is not what blocks a late accept;
 * - this worker only closes an OPEN offer whose deadline passed (clock-only)
 *   and sends the once-per-offer automatic notifications.
 *
 * Concurrency: the per-candidate JobCard row lock serializes competing
 * workers, and the UNIQUE (offer, kind) delivery identity absorbs the residual
 * race — losers converge instead of duplicating activities, realtime events or
 * notifications. A live ACCEPT_ASSIGNMENT / DECLINE_ASSIGNMENT reservation
 * that was reserved before the deadline wins over expiry (049 ordering, as in
 * OVR-3); once it expires the deadline is a real one.
 *
 * Clock discipline: `scanTime` is the single injected clock. It anchors
 * due-ness, `closed_at`, `sent_at`, activity metadata, realtime `occurredAt`
 * and notification `created_at` alike. No `new Date()` / `NOW()` decides
 * domain time.
 */

import {
  NOOP_REALTIME_EVENT_PUBLISHER,
  type RealtimeEventPublisher,
} from '../realtime/event-bus.js';
import { mapJobCardActivityToRealtime } from '../realtime/event-mapper.js';
import type { RealtimeEventRecord } from '../realtime/types.js';
import type { NotificationDraft } from '../notifications/types.js';
import type {
  AssignmentOfferNotificationKind,
  JobCardRepository,
  JobCardTransaction,
  OverdueScanCandidate,
} from './repository.js';
import type { JobCardActivityEvent } from './types.js';

/** Result of processing one discovered candidate job. */
export type AssignmentOfferExpiryCandidateOutcome =
  | { kind: 'expired' }
  | { kind: 'reminded' }
  | { kind: 'converged' }
  | { kind: 'skipped-not-due' }
  | { kind: 'skipped-no-open-offer' }
  | { kind: 'skipped-state-changed' }
  | { kind: 'skipped-recipient-unprovable' }
  | { kind: 'skipped-in-flight-request' };

/** Bounded operational visibility for one worker iteration. */
export type AssignmentOfferExpiryIterationReport = {
  scanTime: string;
  candidates: number;
  expired: number;
  reminded: number;
  converged: number;
  skippedNotDue: number;
  skippedNoOpenOffer: number;
  skippedStateChanged: number;
  skippedRecipientUnprovable: number;
  skippedInFlightRequest: number;
  failed: number;
  byKind: Readonly<Record<AssignmentOfferNotificationKind, number>>;
};

export interface AssignmentOfferExpiryRepository {
  listCandidates(input: {
    scanTime: Date;
    limit: number;
  }): Promise<readonly OverdueScanCandidate[]>;
  processCandidate(input: {
    candidate: OverdueScanCandidate;
    scanTime: Date;
  }): Promise<{
    outcome: AssignmentOfferExpiryCandidateOutcome;
    realtimeEvents: readonly RealtimeEventRecord[];
  }>;
}

/** The two answers that may still be in flight against an offer. */
const ANSWER_COMMANDS = ['ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT'] as const;

const REMINDER_HALF = 2;

export class PostgresAssignmentOfferExpiryRepository
implements AssignmentOfferExpiryRepository {
  constructor(
    private readonly repository: JobCardRepository,
    private readonly webPushEnabled: boolean = false,
  ) {}

  listCandidates(input: { scanTime: Date; limit: number }) {
    return this.repository.listDueAssignmentOfferCandidates(input);
  }

  async processCandidate(input: {
    candidate: OverdueScanCandidate;
    scanTime: Date;
  }): Promise<{
    outcome: AssignmentOfferExpiryCandidateOutcome;
    realtimeEvents: readonly RealtimeEventRecord[];
  }> {
    const { organizationId, jobCardId } = input.candidate;
    return this.repository.executeTransaction(async (tx) => {
      const job = await tx.getJobForUpdate(organizationId, jobCardId);
      // An offer only ever exists while the job is NEW and the assignment is
      // still live. Anything else was answered or closed elsewhere.
      if (job === null || job.status !== 'NEW') {
        return { outcome: { kind: 'skipped-state-changed' }, realtimeEvents: [] };
      }
      const offer = await tx.getLatestAssignmentOffer(organizationId, jobCardId);
      if (offer === null || offer.state !== 'OPEN') {
        return { outcome: { kind: 'skipped-no-open-offer' }, realtimeEvents: [] };
      }
      if (input.scanTime.valueOf() >= offer.acceptanceDueAt.valueOf()) {
        return this.expire(tx, input.scanTime, {
          organizationId,
          jobCardId,
          offerId: offer.id,
          openedReason: offer.openedReason,
          acceptanceDueAt: offer.acceptanceDueAt,
          urgentReason: offer.urgentReason,
          assignedTo: job.assignedTo,
        });
      }
      const reminderAt = offer.openedAt.valueOf()
        + (offer.acceptanceDueAt.valueOf() - offer.openedAt.valueOf()) / REMINDER_HALF;
      if (input.scanTime.valueOf() < reminderAt) {
        return { outcome: { kind: 'skipped-not-due' }, realtimeEvents: [] };
      }
      return this.remind(tx, input.scanTime, {
        organizationId,
        jobCardId,
        offerId: offer.id,
        acceptanceDueAt: offer.acceptanceDueAt,
        urgentReason: offer.urgentReason,
        assigneeUserId: offer.assigneeUserId,
        assignedTo: job.assignedTo,
      });
    });
  }

  private async expire(
    tx: JobCardTransaction,
    scanTime: Date,
    input: {
      organizationId: string;
      jobCardId: string;
      offerId: string;
      openedReason: string;
      acceptanceDueAt: Date;
      urgentReason: string | null;
      assignedTo: string;
    },
  ): Promise<{
    outcome: AssignmentOfferExpiryCandidateOutcome;
    realtimeEvents: readonly RealtimeEventRecord[];
  }> {
    // 049 ordering: a request reserved before the deadline that is still in
    // flight is authoritative over clock-only expiry.
    const inFlight = (await tx.listLiveLifecycleIntents(
      input.organizationId, input.jobCardId,
      { reservedBefore: input.acceptanceDueAt, atTime: scanTime },
    )).some((intent) => (ANSWER_COMMANDS as readonly string[]).includes(intent.command));
    if (inFlight) {
      return { outcome: { kind: 'skipped-in-flight-request' }, realtimeEvents: [] };
    }
    // Anchor the durable once-per-kind delivery fact FIRST; only the winner
    // proceeds to the offer close and its side effects.
    const delivery = await tx.insertAssignmentOfferNotification({
      organizationId: input.organizationId,
      offerId: input.offerId,
      kind: 'ACCEPTANCE_EXPIRED',
      sentAt: scanTime,
    });
    if (!delivery.created) {
      return { outcome: { kind: 'converged' }, realtimeEvents: [] };
    }
    const closed = await tx.closeAssignmentOffer({
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      offerId: input.offerId,
      expectedState: 'OPEN',
      state: 'EXPIRED',
      closedAt: scanTime,
      closedBy: null,
      closeReason: null,
      closeText: null,
    });
    if (!closed) {
      // The UNIQUE delivery row and the offer state cannot disagree inside
      // one transaction; a mismatch means another path already closed it.
      return { outcome: { kind: 'converged' }, realtimeEvents: [] };
    }
    const { realtimeEvent } = await this.appendFact(tx, scanTime, {
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      assignedTo: input.assignedTo,
      event: 'JOB_ASSIGNMENT_OFFER_EXPIRED',
      metadata: {
        offerId: input.offerId,
        openedReason: input.openedReason,
        acceptanceDueAt: input.acceptanceDueAt.toISOString(),
        urgentReason: input.urgentReason,
        closedAt: scanTime.toISOString(),
      },
      recipient: 'MANAGEMENT',
      notificationKind: 'job.acceptance_expired',
    });
    return {
      outcome: { kind: 'expired' },
      realtimeEvents: realtimeEvent ? [realtimeEvent] : [],
    };
  }

  private async remind(
    tx: JobCardTransaction,
    scanTime: Date,
    input: {
      organizationId: string;
      jobCardId: string;
      offerId: string;
      acceptanceDueAt: Date;
      urgentReason: string | null;
      assigneeUserId: string;
      assignedTo: string;
    },
  ): Promise<{
    outcome: AssignmentOfferExpiryCandidateOutcome;
    realtimeEvents: readonly RealtimeEventRecord[];
  }> {
    const assignee = await tx.getAssigneeForUpdate(input.organizationId, input.assigneeUserId);
    if (assignee === null || !assignee.isActive || assignee.role !== 'STAFF') {
      // Never notify a deactivated or non-Staff recipient; the offer still
      // expires on time through the deadline branch.
      return { outcome: { kind: 'skipped-recipient-unprovable' }, realtimeEvents: [] };
    }
    const delivery = await tx.insertAssignmentOfferNotification({
      organizationId: input.organizationId,
      offerId: input.offerId,
      kind: 'ACCEPTANCE_REMINDER',
      sentAt: scanTime,
    });
    if (!delivery.created) {
      return { outcome: { kind: 'converged' }, realtimeEvents: [] };
    }
    const { realtimeEvent } = await this.appendFact(tx, scanTime, {
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      assignedTo: input.assignedTo,
      event: 'JOB_ASSIGNMENT_REMINDER_SENT',
      metadata: {
        offerId: input.offerId,
        acceptanceDueAt: input.acceptanceDueAt.toISOString(),
        urgentReason: input.urgentReason,
        sentAt: scanTime.toISOString(),
      },
      recipient: 'ASSIGNEE',
      notificationKind: 'job.acceptance_reminder',
    });
    return {
      outcome: { kind: 'reminded' },
      realtimeEvents: realtimeEvent ? [realtimeEvent] : [],
    };
  }

  /**
   * Write one system-authored fact (activity + realtime + notification) in
   * the candidate's transaction. The actor is always null: a clock is not a
   * person.
   */
  private async appendFact(
    tx: JobCardTransaction,
    scanTime: Date,
    input: {
      organizationId: string;
      jobCardId: string;
      assignedTo: string;
      event: JobCardActivityEvent;
      metadata: Record<string, unknown>;
      recipient: 'MANAGEMENT' | 'ASSIGNEE';
      notificationKind: NotificationDraft['kind'];
    },
  ): Promise<{ realtimeEvent: RealtimeEventRecord | null }> {
    const activity = await tx.appendActivity({
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      actorId: null,
      event: input.event,
      metadata: input.metadata,
    });
    const mapped = mapJobCardActivityToRealtime({
      activityId: activity.id,
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      actorUserId: null,
      event: input.event,
      occurredAt: scanTime,
      beforeAssigneeId: null,
      afterAssigneeId: input.assignedTo,
    });
    if (!mapped) return { realtimeEvent: null };
    let drafts: NotificationDraft[];
    if (input.recipient === 'MANAGEMENT') {
      const managers = await tx.listActiveManagementRecipients(input.organizationId);
      drafts = managers.map((manager) => ({
        recipientUserId: manager.id,
        kind: input.notificationKind,
        entityType: 'job-card' as const,
        entityId: input.jobCardId,
      }));
    } else {
      drafts = [{
        recipientUserId: input.assignedTo,
        kind: input.notificationKind,
        entityType: 'job-card' as const,
        entityId: input.jobCardId,
      }];
    }
    const realtimeEvent = await tx.appendRealtimeEvent({
      ...mapped,
      resourceKeys: drafts.length > 0
        ? [...new Set([...mapped.resourceKeys, 'notifications'])].sort()
        : [...mapped.resourceKeys].sort(),
    });
    if (drafts.length > 0) {
      const notifications = await tx.appendNotifications({
        organizationId: input.organizationId,
        sourceRealtimeEventId: realtimeEvent.id,
        createdAt: scanTime,
        drafts,
      });
      if (this.webPushEnabled && notifications.length > 0) {
        await tx.appendWebPushDeliveries({
          organizationId: input.organizationId,
          notificationIds: notifications.map((notification) => notification.id),
          at: scanTime,
        });
      }
    }
    return { realtimeEvent };
  }
}

export type AssignmentOfferExpiryWorker = Readonly<{
  start(): void;
  stop(): Promise<void>;
  runOnce(scanTime: Date): Promise<AssignmentOfferExpiryIterationReport>;
}>;

/**
 * Bounded, non-overlapping worker loop following the OVR-3 / OVR-4
 * conventions. No distributed lease layer: the per-candidate JobCard row lock
 * plus the UNIQUE delivery identity already make concurrent workers converge
 * on one durable delivery per offer and kind.
 */
export function createAssignmentOfferExpiryWorker(
  repository: AssignmentOfferExpiryRepository,
  options: Readonly<{
    now?: () => Date;
    pollIntervalMs?: number;
    batchSize?: number;
    publisher?: RealtimeEventPublisher;
    onReport?: (report: AssignmentOfferExpiryIterationReport) => void;
    onError?: (error: unknown) => void;
  }> = {},
): AssignmentOfferExpiryWorker {
  const now = options.now ?? (() => new Date());
  const publisher = options.publisher ?? NOOP_REALTIME_EVENT_PUBLISHER;
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const batchSize = options.batchSize ?? 50;
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<AssignmentOfferExpiryIterationReport> | null = null;

  const report = (reportValue: AssignmentOfferExpiryIterationReport) => {
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

  const runOnce = async (scanTime: Date): Promise<AssignmentOfferExpiryIterationReport> => {
    const byKind: Record<AssignmentOfferNotificationKind, number> = {
      ACCEPTANCE_REMINDER: 0,
      ACCEPTANCE_EXPIRED: 0,
    };
    const counts = {
      candidates: 0,
      expired: 0,
      reminded: 0,
      converged: 0,
      skippedNotDue: 0,
      skippedNoOpenOffer: 0,
      skippedStateChanged: 0,
      skippedRecipientUnprovable: 0,
      skippedInFlightRequest: 0,
      failed: 0,
    };
    const candidates = await repository.listCandidates({ scanTime, limit: batchSize });
    for (const candidate of candidates) {
      counts.candidates += 1;
      try {
        const { outcome, realtimeEvents } = await repository.processCandidate({
          candidate,
          scanTime,
        });
        switch (outcome.kind) {
          case 'expired': counts.expired += 1; byKind.ACCEPTANCE_EXPIRED += 1; break;
          case 'reminded': counts.reminded += 1; byKind.ACCEPTANCE_REMINDER += 1; break;
          case 'converged': counts.converged += 1; break;
          case 'skipped-not-due': counts.skippedNotDue += 1; break;
          case 'skipped-no-open-offer': counts.skippedNoOpenOffer += 1; break;
          case 'skipped-state-changed': counts.skippedStateChanged += 1; break;
          case 'skipped-recipient-unprovable': counts.skippedRecipientUnprovable += 1; break;
          case 'skipped-in-flight-request': counts.skippedInFlightRequest += 1; break;
        }
        for (const event of realtimeEvents) publisher.publish(event);
      } catch (error) {
        // One failing candidate never stops the batch; it is retried later.
        counts.failed += 1;
        reportError(error);
      }
    }
    const result: AssignmentOfferExpiryIterationReport = {
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
function runOnceFailedReport(scanTime: Date): AssignmentOfferExpiryIterationReport {
  return {
    scanTime: scanTime.toISOString(),
    candidates: 0,
    expired: 0,
    reminded: 0,
    converged: 0,
    skippedNotDue: 0,
    skippedNoOpenOffer: 0,
    skippedStateChanged: 0,
    skippedRecipientUnprovable: 0,
    skippedInFlightRequest: 0,
    failed: 1,
    byKind: { ACCEPTANCE_REMINDER: 0, ACCEPTANCE_EXPIRED: 0 },
  };
}
