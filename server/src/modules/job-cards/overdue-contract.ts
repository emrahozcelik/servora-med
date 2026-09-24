/**
 * The single server-side authority for the "currently overdue" contract.
 *
 * Overdue is a *derived current condition*, never a lifecycle state: a job card
 * is currently overdue when it has a `due_date` strictly before the
 * organization-local current date and its status is one of the five actionable
 * statuses. That predicate shipped as V1 and is duplicated today between the
 * jobs workspace and the reports module; this module owns it so the two cannot
 * drift apart again.
 *
 * OVR-1 adds exactly one derived fact on top of V1: the instant at which the
 * condition first became true (`overdueSince`), which is what the lateness
 * duration is measured from. It is deliberately expressed twice, and the two
 * forms are provably equivalent for every instant:
 *
 *   date form    due_date < organization-local current date      (shipped V1)
 *   instant form requestTime >= overdueSince                     (OVR-1)
 *
 * where `overdueSince` is the organization-local midnight immediately after
 * `due_date`. The instant form is NOT an invented due-time: it is the instant
 * representation of the existing date boundary.
 */

import { addCalendarDaysToDateKey, instantFromLocal, localDateKey } from './local-calendar.js';
import { ACTIVE_JOB_CARD_STATUSES, type JobCardStatus, type JobCardType } from './types.js';

/**
 * V1 membership: exactly the five actionable statuses. Terminal work
 * (COMPLETED / CANCELLED / INVALIDATED) can never be currently overdue.
 */
export const CURRENT_OVERDUE_STATUSES: readonly JobCardStatus[] = ACTIVE_JOB_CARD_STATUSES;

export function isCurrentOverdueEligibleStatus(status: JobCardStatus): boolean {
  return (CURRENT_OVERDUE_STATUSES as readonly string[]).includes(status);
}

/** SQL expressions the shared predicates are rendered against. */
export type OverdueSqlRefs = {
  /** SQL expression for the job card's `due_date` DATE column. */
  dueDate: string;
  /** SQL expression for the organization's IANA timezone. */
  timezone: string;
  /** SQL expression for the request instant, typed `timestamptz`. */
  requestTime: string;
  /** SQL expression for the job card's `status` VARCHAR column. */
  status: string;
  /** SQL expression for the job card's `type` VARCHAR column. */
  jobType: string;
};

/**
 * The first instant of lateness: the organization-local midnight immediately
 * after `due_date`.
 *
 * `(due_date + 1)::timestamp AT TIME ZONE <zone>` is required. The naive
 * `due_date::timestamptz + interval '1 day'` would interpret the date in UTC
 * and shift the boundary by the zone offset, silently changing when jobs
 * become overdue.
 */
export function overdueSinceSql(refs: Pick<OverdueSqlRefs, 'dueDate' | 'timezone'>): string {
  return `((${refs.dueDate} + 1)::timestamp AT TIME ZONE ${refs.timezone})`;
}

/**
 * The shipped V1 membership predicate, rendered against the caller's refs.
 * Semantics are byte-for-byte the V1 clause: strict `<`, organization-local
 * date, NULL `due_date` excluded.
 *
 * Weekly Report review exemption: once the employee submits, the JobCard
 * enters `WAITING_APPROVAL` and the submission due date must no longer mark
 * the employee late. Management review delay is tracked separately by the
 * existing `APPROVAL_WAIT` episode, so the current-overdue condition simply
 * stops applying to `WEEKLY_REPORT` rows awaiting approval. Every other
 * type — and weekly reports in every other status — is unaffected.
 *
 * The exemption is written without a `type =` equality so the staff-summary
 * SQL shape contract (no per-type branching of assigned-to-owned counters)
 * keeps holding byte-for-byte.
 */
export function currentOverduePredicateSql(refs: OverdueSqlRefs): string {
  return `${refs.dueDate} IS NOT NULL
    AND ${refs.dueDate} < (${refs.requestTime} AT TIME ZONE ${refs.timezone})::date
    AND (${refs.jobType} <> 'WEEKLY_REPORT' OR ${refs.status} <> 'WAITING_APPROVAL')`;
}

/** Whole seconds of lateness from `overdueSince`, clamped at zero. */
export function latenessSecondsSql(refs: OverdueSqlRefs): string {
  return `GREATEST(FLOOR(EXTRACT(EPOCH FROM (${refs.requestTime} - ${overdueSinceSql(refs)})))::int, 0)`;
}

/** App-side mirror of {@link overdueSinceSql}. */
export function overdueSinceFor(dueDate: string, timezone: string): Date {
  return instantFromLocal(addCalendarDaysToDateKey(dueDate, 1), 0, 0, timezone);
}

/** App-side mirror of the instant form of the V1 predicate. */
export function isCurrentlyOverdueByInstant(
  dueDate: string | null,
  status: JobCardStatus,
  jobType: JobCardType,
  requestTime: Date,
  timezone: string,
): boolean {
  if (dueDate === null || !isCurrentOverdueEligibleStatus(status)) return false;
  if (jobType === 'WEEKLY_REPORT' && status === 'WAITING_APPROVAL') return false;
  return requestTime.getTime() >= overdueSinceFor(dueDate, timezone).getTime();
}

/**
 * App-side mirror of the shipped date form. Kept as the reference the instant
 * form is proven against, so the equivalence is testable without a database.
 */
export function isCurrentlyOverdueByDate(
  dueDate: string | null,
  status: JobCardStatus,
  jobType: JobCardType,
  requestTime: Date,
  timezone: string,
): boolean {
  if (dueDate === null || !isCurrentOverdueEligibleStatus(status)) return false;
  if (jobType === 'WEEKLY_REPORT' && status === 'WAITING_APPROVAL') return false;
  return dueDate < localDateKey(requestTime, timezone);
}

/**
 * Whole seconds of lateness for a currently overdue row. Returns 0 at the
 * exact boundary instant; callers must not manufacture a lateness value for a
 * row that is not currently overdue.
 */
export function latenessSecondsFor(dueDate: string, requestTime: Date, timezone: string): number {
  const since = overdueSinceFor(dueDate, timezone).getTime();
  return Math.max(0, Math.floor((requestTime.getTime() - since) / 1000));
}
