/**
 * JOB-010 release 2b: assignment acceptance window rules.
 *
 * One server-owned truth for "who may be asked to take this job, by when, and
 * whether the planned window can still fit an on-time answer". Both the
 * JobCardService producers and the Staff offboarding transfer call these pure
 * functions, so the direct (management request) and compound (system producer)
 * paths cannot drift apart.
 *
 * Clock discipline: every instant is either a persisted fact (`scheduledAt`,
 * `scheduledEndsAt`) or the caller's injected request clock. No `new Date()`.
 *
 * All of this stays inert while `JOB_ASSIGNMENT_WINDOW_ENABLED` is false: the
 * callers never invoke these functions in that case.
 */

import type {
  JobAssignmentOfferState,
  JobAssignmentOfferUrgentReason,
  JobCard,
  PastStartAcknowledgementInput,
} from './types.js';
import {
  canonicalScheduledDurationMs,
  persistedScheduledDurationMs,
} from './job-card-duration.js';

/** Q1: the minimum response window every producer can guarantee. */
export const ASSIGNMENT_OFFER_MINIMUM_WINDOW_MS = 10 * 60 * 1000;

/** JOB-010 §4: acceptance is asked for this long before the planned start. */
export const ASSIGNMENT_ACCEPTANCE_LEAD_MS = 60 * 60 * 1000;

/** The JobCard types an offer can exist for (Q8: GENERAL_TASK is excluded). */
export function isAssignmentOfferJobType(type: JobCard['type']): boolean {
  return type === 'PRODUCT_DELIVERY' || type === 'SALES_MEETING';
}

/**
 * A job may be offered only when it is `NEW`, has a planned start, and the
 * actor opening the offer is not the assignee (a self-assignment never needs
 * an acceptance question).
 */
export function isAssignmentOfferEligible(
  job: Pick<JobCard, 'type' | 'status' | 'scheduledAt' | 'assignedTo'>,
  actorId: string,
): boolean {
  return isAssignmentOfferJobType(job.type)
    && job.status === 'NEW'
    && job.scheduledAt !== null
    && job.assignedTo !== actorId;
}

/**
 * JOB-010 §4: `acceptance_due_at = max(scheduledAt − 60 min, opened_at + 10 min)`.
 * The minimum window keeps every deadline answerable, including system
 * producers that cannot ask anyone for a value and late re-offers.
 */
export function computeAcceptanceDueAt(openedAt: Date, scheduledAt: Date): Date {
  const leadBoundary = scheduledAt.valueOf() - ASSIGNMENT_ACCEPTANCE_LEAD_MS;
  const minimumBoundary = openedAt.valueOf() + ASSIGNMENT_OFFER_MINIMUM_WINDOW_MS;
  return new Date(Math.max(leadBoundary, minimumBoundary));
}

/**
 * JOB-010 §4: why the offer is urgent. `START_PASSED` when the planned start
 * has already passed at open; `SHORT_NOTICE` when the deadline is later than
 * the planned start − 60 min (the minimum window displaced it); else null.
 */
export function resolveAssignmentUrgentReason(
  openedAt: Date,
  scheduledAt: Date,
  acceptanceDueAt: Date,
): JobAssignmentOfferUrgentReason | null {
  if (openedAt.valueOf() >= scheduledAt.valueOf()) return 'START_PASSED';
  if (acceptanceDueAt.valueOf() > scheduledAt.valueOf() - ASSIGNMENT_ACCEPTANCE_LEAD_MS) {
    return 'SHORT_NOTICE';
  }
  return null;
}

/**
 * JOB-010 §3: a producer may open an offer only when
 * `opened_at + minimum window < scheduled_ends_at`, so every on-time
 * acceptance lands before the OVR-2 `LATE_START` boundary.
 */
export function isPlannedWindowTooShort(
  openedAt: Date,
  scheduledEndsAt: Date | null,
): boolean {
  if (scheduledEndsAt === null) return true;
  return openedAt.valueOf() + ASSIGNMENT_OFFER_MINIMUM_WINDOW_MS >= scheduledEndsAt.valueOf();
}

/**
 * JOB-010 §4 boundary: `reserved_at < acceptance_due_at` is on time. The same
 * equality rule as `LATE_START`.
 */
export function isAcceptanceOnTime(requestTime: Date, acceptanceDueAt: Date): boolean {
  return requestTime.valueOf() < acceptanceDueAt.valueOf();
}

/** A direct producer needs an explicit acknowledgement once the start passed. */
export function requiresPastStartAcknowledgement(
  urgentReason: JobAssignmentOfferUrgentReason | null,
): boolean {
  return urgentReason === 'START_PASSED';
}

/**
 * JOB-012: the only answer reason a time proposal may accompany. Every other
 * reason says the assignment cannot be done, not that another time would work.
 */
export function assignmentProposalRequiresReason(
  reasonCode: string,
): reasonCode is 'SCHEDULE_CONFLICT' {
  return reasonCode === 'SCHEDULE_CONFLICT';
}

/**
 * JOB-012: the proposed interval `[proposed, proposed + D)`, derived and never
 * stored. `D` is the job's persisted planned duration (`scheduledEndsAt -
 * scheduledAt`), or the canonical duration of the type (60 min SALES_MEETING,
 * 30 min PRODUCT_DELIVERY) when either bound is null. Returns null for a job
 * type that has no canonical duration and no persisted one — the same jobs no
 * offer can exist for.
 */
export function assignmentProposedInterval(
  job: Pick<JobCard, 'type' | 'scheduledAt' | 'scheduledEndsAt'>,
  proposedScheduledAt: string,
): { startsAt: Date; endsAt: Date } | null {
  const startMs = Date.parse(proposedScheduledAt);
  if (!Number.isFinite(startMs)) return null;
  const persisted = persistedScheduledDurationMs(job.scheduledAt, job.scheduledEndsAt);
  const durationMs = persisted !== null && persisted > 0
    ? persisted
    : canonicalScheduledDurationMs(job.type);
  if (durationMs === null || durationMs <= 0) return null;
  return { startsAt: new Date(startMs), endsAt: new Date(startMs + durationMs) };
}

/**
 * The offer state a lifecycle command requires before it may answer:
 * accept/decline need the offer `OPEN`; release needs it `ACCEPTED` by the
 * actor. A mismatch is a stale view (409).
 */
export function assignmentOfferRequiredState(
  command: 'ACCEPT_ASSIGNMENT' | 'DECLINE_ASSIGNMENT' | 'RELEASE_ASSIGNMENT',
): Extract<JobAssignmentOfferState, 'OPEN' | 'ACCEPTED'> {
  return command === 'RELEASE_ASSIGNMENT' ? 'ACCEPTED' : 'OPEN';
}

export type AssignmentOfferOpenDecision =
  | {
      kind: 'open';
      acceptanceDueAt: Date;
      urgentReason: JobAssignmentOfferUrgentReason | null;
      acknowledgement: PastStartAcknowledgementInput | null;
    }
  | {
      kind: 'planned-window-passed';
      acceptanceDueAt: Date;
      urgentReason: JobAssignmentOfferUrgentReason | null;
    };

/**
 * The complete open decision shared by both producer classes. Direct
 * producers reject a too-short window and demand an acknowledgement for a
 * passed start; compound producers cannot ask anyone, so they record the
 * offer and close it at once as `PLANNED_WINDOW_PASSED`.
 */
export function decideAssignmentOfferOpen(input: {
  openedAt: Date;
  scheduledAt: Date;
  scheduledEndsAt: Date | null;
  direct: boolean;
  acknowledgement: PastStartAcknowledgementInput | null;
}):
  | { kind: 'window-too-short' }
  | { kind: 'acknowledgement-required' }
  | AssignmentOfferOpenDecision {
  if (isPlannedWindowTooShort(input.openedAt, input.scheduledEndsAt)) {
    if (input.direct) return { kind: 'window-too-short' };
    const acceptanceDueAt = computeAcceptanceDueAt(input.openedAt, input.scheduledAt);
    return {
      kind: 'planned-window-passed',
      acceptanceDueAt,
      urgentReason: resolveAssignmentUrgentReason(
        input.openedAt, input.scheduledAt, acceptanceDueAt,
      ),
    };
  }
  const acceptanceDueAt = computeAcceptanceDueAt(input.openedAt, input.scheduledAt);
  const urgentReason = resolveAssignmentUrgentReason(
    input.openedAt, input.scheduledAt, acceptanceDueAt,
  );
  if (input.direct && requiresPastStartAcknowledgement(urgentReason)
    && input.acknowledgement === null) {
    return { kind: 'acknowledgement-required' };
  }
  return { kind: 'open', acceptanceDueAt, urgentReason, acknowledgement: input.acknowledgement };
}
