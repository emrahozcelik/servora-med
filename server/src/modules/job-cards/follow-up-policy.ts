import type {
  JobCardEngagementKind,
  JobCardType,
  MeetingOutcome,
  UnsuccessfulVisitReasonCode,
} from './types.js';
import {
  addCalendarDaysToDateKey,
  instantFromLocal,
  localClockParts,
  localDateKey,
} from './local-calendar.js';
import { advanceToWorkingDay } from './working-day-policy.js';

/**
 * V1 mandatory follow-up policy constants.
 *
 * These are server-side constants for the first slice. Admin-configurable
 * per-job-type intervals are a future slice; the shape of the constants below
 * (a per-type record) deliberately leaves that door open.
 */
export const FOLLOW_UP_DEFAULT_INTERVAL_DAYS = 7;
/** JOB-008: a POSITIVE Customer Visit returns two weeks later. */
export const FOLLOW_UP_POSITIVE_INTERVAL_DAYS = 14;
/**
 * JOB-008: automatically selected (SYSTEM) follow-up slots stay inside the
 * organization-local working window [08:00, 19:00]. Human-chosen schedules are
 * not restricted by this window.
 */
export const FOLLOW_UP_AUTO_WINDOW_START_MINUTE = 8 * 60;
export const FOLLOW_UP_AUTO_WINDOW_END_MINUTE = 19 * 60;
export const FOLLOW_UP_MIN_LEAD_MINUTES = 15;
export const FOLLOW_UP_SEARCH_HORIZON_DAYS = 30;
export const RECENT_VISIT_WARNING_DAYS = 7;
export const FREQUENT_VISIT_WINDOW_DAYS = 14;
/** Informational trigger only; never a write limit. */
export const FREQUENT_VISIT_ADVISORY_THRESHOLD = 3;

/**
 * Follow-up proposals must leave a short operational buffer after the
 * canonical reference instant. This policy intentionally works on UTC
 * instants; callers choose the reference (meeting/completion/request time)
 * before invoking it.
 */
export function isFollowUpMinimumLeadSatisfied(input: {
  referenceAt: Date;
  scheduledAt: Date;
}): boolean {
  return input.scheduledAt.valueOf()
    >= input.referenceAt.valueOf() + FOLLOW_UP_MIN_LEAD_MINUTES * 60_000;
}

/**
 * A follow-up cannot be scheduled before the request has been made, even when
 * the recorded meeting happened earlier. A future-dated meeting therefore
 * becomes the reference, while an already elapsed meeting falls back to the
 * request instant.
 */
export function followUpLeadReferenceAt(input: {
  meetingAt: Date | null;
  requestAt: Date;
}): Date {
  if (input.meetingAt === null || Number.isNaN(input.meetingAt.valueOf())) {
    return input.requestAt;
  }
  return input.meetingAt.valueOf() > input.requestAt.valueOf()
    ? input.meetingAt
    : input.requestAt;
}

export function earliestFollowUpAllowedAt(input: {
  meetingAt: Date | null;
  requestAt: Date;
}): Date {
  return new Date(
    followUpLeadReferenceAt(input).valueOf() + FOLLOW_UP_MIN_LEAD_MINUTES * 60_000,
  );
}

export type FollowUpProposalOrigin = 'SYSTEM' | 'STAFF_ADJUSTED';

const FOLLOW_UP_TYPE_DEFAULTS: Record<JobCardType, JobCardType> = {
  SALES_MEETING: 'SALES_MEETING',
  PRODUCT_DELIVERY: 'SALES_MEETING',
  GENERAL_TASK: 'GENERAL_TASK',
  // WEEKLY_REPORT has no public creation path yet (Slice 1 keeps it closed);
  // the open-ended GENERAL_TASK default keeps this exhaustive map total
  // without granting weekly reports any follow-up semantics.
  WEEKLY_REPORT: 'GENERAL_TASK',
  // SALE has no public follow-up semantics in V1.
  SALE: 'GENERAL_TASK',
};

export function defaultFollowUpType(sourceType: JobCardType): JobCardType {
  return FOLLOW_UP_TYPE_DEFAULTS[sourceType];
}

const LOOP_ENGAGEMENT_KINDS: readonly JobCardEngagementKind[] = ['CUSTOMER_VISIT', 'FOLLOW_UP'];

/**
 * JOB-008: Customer Visits and the follow-ups they generate keep the customer
 * in a continuous cycle. POSITIVE always continues the cycle; FOLLOW_UP_REQUIRED
 * continues it once its structured unsuccessful reason is present.
 */
export function requiresMandatoryFollowUpProposal(input: {
  type: JobCardType;
  engagementKind: JobCardEngagementKind | null;
  outcome?: MeetingOutcome | null;
  unsuccessfulReason?: UnsuccessfulVisitReasonCode | null;
}): boolean {
  if (input.type !== 'SALES_MEETING'
    || input.engagementKind === null
    || !LOOP_ENGAGEMENT_KINDS.includes(input.engagementKind)) return false;
  if (input.outcome === 'POSITIVE') return true;
  return input.outcome === 'FOLLOW_UP_REQUIRED'
    && input.unsuccessfulReason !== null
    && input.unsuccessfulReason !== undefined;
}

/** JOB-008 calendar-day interval for the automatic follow-up target. */
export function followUpIntervalDays(outcome: MeetingOutcome | null | undefined): number {
  return outcome === 'POSITIVE'
    ? FOLLOW_UP_POSITIVE_INTERVAL_DAYS
    : FOLLOW_UP_DEFAULT_INTERVAL_DAYS;
}

/**
 * Base candidate instant: the organization-local completion/evaluation date
 * + 7 **calendar** days, preserving the preferred local clock time (source
 * scheduledAt when available, otherwise the evaluation clock).
 *
 * WORKING-DAY V1 (§17): the +7 *calendar day* meaning is unchanged — this is
 * still not "+7 working days". The only new behaviour is that when the
 * resulting occupied interval is invalid because it touches the
 * organization-local Sunday, it advances forward one local calendar day at a
 * time to the first valid working date (an ordinary Sunday target becomes the
 * Monday; a late Saturday start whose duration spills into Sunday also moves to
 * Monday). The local wall clock and the interval duration are preserved, and
 * the advance is DST-correct. Saturday remains a working day.
 */
export function suggestedFollowUpInstant(input: {
  evaluatedAt: Date;
  sourceScheduledAt: Date | null;
  timezone: string;
  /**
   * Canonical duration of the resulting follow-up, used for the Sunday-spill
   * check. Omit for a degenerate occupied point (GENERAL_TASK).
   */
  durationMs?: number | null;
  /** Calendar-day interval; defaults to FOLLOW_UP_DEFAULT_INTERVAL_DAYS. */
  intervalDays?: number;
}): Date {
  const preferred = input.sourceScheduledAt ?? input.evaluatedAt;
  const clock = localClockParts(preferred, input.timezone);
  const baseDate = addCalendarDaysToDateKey(
    localDateKey(input.evaluatedAt, input.timezone),
    input.intervalDays ?? FOLLOW_UP_DEFAULT_INTERVAL_DAYS,
  );
  const base = instantFromLocal(baseDate, clock.hour, clock.minute, input.timezone);
  const durationMs = input.durationMs ?? null;
  const advanced = advanceToWorkingDay({
    startsAt: base,
    endsAt: durationMs === null ? null : new Date(base.valueOf() + durationMs),
    timezone: input.timezone,
  });
  return advanced?.startsAt ?? base;
}

/**
 * JOB-008 automatic target: a valid Staff-recorded `nextFollowUpAt` wins;
 * otherwise the outcome interval (7 or 14 calendar days) is applied by
 * {@link suggestedFollowUpInstant}. Slot search later enforces the lead floor,
 * the working window and Sunday.
 */
export function followUpTargetInstant(input: {
  evaluatedAt: Date;
  sourceScheduledAt: Date | null;
  timezone: string;
  durationMs?: number | null;
  outcome?: MeetingOutcome | null;
  nextFollowUpAt?: string | null;
}): Date {
  if (input.nextFollowUpAt !== null && input.nextFollowUpAt !== undefined) {
    const requested = new Date(input.nextFollowUpAt);
    if (!Number.isNaN(requested.valueOf())) return requested;
  }
  return suggestedFollowUpInstant({
    evaluatedAt: input.evaluatedAt,
    sourceScheduledAt: input.sourceScheduledAt,
    timezone: input.timezone,
    durationMs: input.durationMs,
    intervalDays: followUpIntervalDays(input.outcome),
  });
}

/** Advance a candidate by one organization-local calendar day, preserving the clock time. */
export function advanceByOneDay(instant: Date, timezone: string): Date {
  const clock = localClockParts(instant, timezone);
  const nextDate = addCalendarDaysToDateKey(localDateKey(instant, timezone), 1);
  return instantFromLocal(nextDate, clock.hour, clock.minute, timezone);
}

/**
 * Default follow-up scope instructions. System-generated so that Staff never
 * has to author free text merely to satisfy the mandatory proposal contract.
 */
export function defaultFollowUpInstructions(sourceTitle: string): string {
  const title = sourceTitle.trim().slice(0, 160);
  return `Takip: ${title}`;
}

export type FollowUpProposalFields = {
  scheduledAt: Date;
  type: JobCardType;
  assignedTo: string;
  followUpInstructions: string;
};

/**
 * Origin is derived server-side, never trusted from the client: a proposal
 * that still equals the freshly computed system suggestion is SYSTEM; any
 * Staff deviation (date/time/instructions) marks it STAFF_ADJUSTED.
 */
export function deriveProposalOrigin(
  proposal: FollowUpProposalFields,
  suggestion: FollowUpProposalFields,
): FollowUpProposalOrigin {
  const equal = proposal.type === suggestion.type
    && proposal.assignedTo === suggestion.assignedTo
    && proposal.followUpInstructions === suggestion.followUpInstructions
    && proposal.scheduledAt.valueOf() === suggestion.scheduledAt.valueOf();
  return equal ? 'SYSTEM' : 'STAFF_ADJUSTED';
}
