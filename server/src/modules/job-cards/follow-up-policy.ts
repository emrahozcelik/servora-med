import type { JobCardType } from './types.js';
import {
  addCalendarDaysToDateKey,
  instantFromLocal,
  localClockParts,
  localDateKey,
} from './local-calendar.js';

/**
 * V1 mandatory follow-up policy constants.
 *
 * These are server-side constants for the first slice. Admin-configurable
 * per-job-type intervals are a future slice; the shape of the constants below
 * (a per-type record) deliberately leaves that door open.
 */
export const FOLLOW_UP_DEFAULT_INTERVAL_DAYS = 7;
export const FOLLOW_UP_SEARCH_HORIZON_DAYS = 30;
export const RECENT_VISIT_WARNING_DAYS = 7;
export const FREQUENT_VISIT_WINDOW_DAYS = 14;
export const FREQUENT_VISIT_MAX_COUNT = 3;

export type FollowUpProposalOrigin = 'SYSTEM' | 'STAFF_ADJUSTED';

const FOLLOW_UP_TYPE_DEFAULTS: Record<JobCardType, JobCardType> = {
  SALES_MEETING: 'SALES_MEETING',
  PRODUCT_DELIVERY: 'SALES_MEETING',
  GENERAL_TASK: 'GENERAL_TASK',
};

export function defaultFollowUpType(sourceType: JobCardType): JobCardType {
  return FOLLOW_UP_TYPE_DEFAULTS[sourceType];
}

/**
 * Base candidate instant: the organization-local completion/evaluation date
 * + 7 calendar days, preserving the preferred local clock time (source
 * scheduledAt when available, otherwise the evaluation clock). No
 * business-day/weekend rules exist in Servora; this deliberately does not
 * introduce any.
 */
export function suggestedFollowUpInstant(input: {
  evaluatedAt: Date;
  sourceScheduledAt: Date | null;
  timezone: string;
}): Date {
  const preferred = input.sourceScheduledAt ?? input.evaluatedAt;
  const clock = localClockParts(preferred, input.timezone);
  const baseDate = addCalendarDaysToDateKey(
    localDateKey(input.evaluatedAt, input.timezone),
    FOLLOW_UP_DEFAULT_INTERVAL_DAYS,
  );
  return instantFromLocal(baseDate, clock.hour, clock.minute, input.timezone);
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
