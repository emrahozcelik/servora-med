/**
 * OVR-2: immutable overdue breach / accountability facts (domain policy).
 *
 * OVR-1 answers "which currently overdue job first, and how late" as a
 * derived current condition. This module owns the *historical* counterpart:
 * did a defined operational deadline get breached, who was accountable at
 * that breach instant, and was the incident later recovered.
 *
 * Locked product decisions (do not reopen here):
 * - Deadline model C: `due_date DATE` stays the contractual overdue clock;
 *   phase deadlines reuse LATE_START / LATE_SUBMISSION / APPROVAL_WAIT.
 * - A job without `scheduled_ends_at` is never attributable as LATE_START.
 * - APPROVAL_WAIT threshold is 24 hours, responsibility MANAGEMENT.
 * - A deadline/schedule revision after a breach must not erase, mutate or
 *   close the prior incident; only a real lifecycle recovery closes one.
 *
 * Clock discipline: every domain instant below is either a persisted fact or
 * derived from the injected request clock. No `new Date()` / `Date.now()` /
 * `NOW()` for breach or recovery decisions (`recorded_at` keeps its DB
 * default as non-domain persistence metadata).
 *
 * First-late boundary vs actual breach time: `deadline_at` is the first
 * representable instant at which the delay type is late:
 * - LATE_START: scheduled_ends_at, because equality is late;
 * - LATE_SUBMISSION: effective submission deadline + 1ms, because equality
 *   at the effective deadline is on time;
 * - APPROVAL_WAIT: submitted_at + 24h, because equality is late.
 * `breached_at` is the first instant the specific delay episode is BOTH
 * eligible under lifecycle/revision state AND late under that boundary rule.
 * An episode activated after its first-late boundary must never backdate
 * before it existed: breached_at = max(first-late boundary, eligible_from_at,
 * revision_effective_at). Producers also require breached_at <= requestTime,
 * and the DB enforces breached_at >= deadline_at.
 */

import { overdueSinceFor } from './overdue-contract.js';
import type { JobCardType } from './types.js';

/** Approval-wait breach threshold: one named server-side constant. */
export const APPROVAL_WAIT_BREACH_HOURS = 24;

export const OVERDUE_INCIDENT_DELAY_TYPES = [
  'LATE_START',
  'LATE_SUBMISSION',
  'APPROVAL_WAIT',
] as const;
export type OverdueIncidentDelayType = (typeof OVERDUE_INCIDENT_DELAY_TYPES)[number];

/**
 * How the incident row was materialized. TRANSITION covers request-driven
 * lifecycle transitions; MUTATION covers request-driven reassignment and
 * schedule-revision edits. OVR-3 scanner materialization is intentionally
 * not part of this migration or source contract.
 */
export type OverdueIncidentSource = 'TRANSITION' | 'MUTATION';

export type OverdueAccountableRole = 'STAFF' | 'MANAGEMENT';
export type OverdueAccountableSource =
  | 'ASSIGNMENT_AT_BREACH'
  | 'ROLE_POLICY'
  | 'UNKNOWN';

export type OverdueIncidentIdentity = {
  organizationId: string;
  jobCardId: string;
  delayType: OverdueIncidentDelayType;
  scheduleRevisionNo: number;
  episodeNo: number;
};

/**
 * LATE_START deadline: `scheduled_ends_at` itself. At exactly
 * `scheduled_ends_at`, START is late (`requestTime >= deadline`).
 * Absent end => not attributable (Decision 2), never derived from due_date.
 */
export function lateStartDeadlineAt(scheduledEndsAt: string | null): Date | null {
  if (scheduledEndsAt === null) return null;
  return new Date(scheduledEndsAt);
}

/**
 * LATE_SUBMISSION effective deadline: the shipped report contract
 * (`scheduled_ends_at`, else `scheduled_at` except SALES_MEETING which is
 * ineligible), with the specified fallback to the timezone-safe due_date
 * local-end boundary when the phase deadline is absent. Returns null only
 * when no deadline of any kind can be established.
 */
export function effectiveSubmissionDeadlineAt(input: {
  scheduledEndsAt: string | null;
  scheduledAt: string | null;
  type: JobCardType;
  dueDate: string | null;
  timezone: string;
}): Date | null {
  const phase = input.scheduledEndsAt
    ?? (input.type === 'SALES_MEETING' ? null : input.scheduledAt);
  if (phase !== null) return new Date(phase);
  if (input.dueDate === null) return null;
  return overdueSinceFor(input.dueDate, input.timezone);
}

/**
 * First instant at which a submission is late. The shipped boundary is
 * inclusive on-time (`completed_at <= effective_deadline`), so the breach
 * starts one step after the effective instant.
 *
 * CLOCK RESOLUTION: MILLISECOND-PROVEN. Every producer of the compared
 * instants is millisecond-quantized end-to-end:
 * - scheduled_at / scheduled_ends_at pass `isoInstant`, whose pattern caps
 *   fractional seconds at three digits (validation.ts INSTANT_PATTERN);
 * - the due_date fallback (`overdueSinceFor`) resolves to a whole-minute
 *   local-midnight instant;
 * - requestTime is `new Date()` (ECMA-262 millisecond resolution) in
 *   production and millisecond Date values in tests;
 * - persisted occurred_at values round-trip through TIMESTAMPTZ exactly,
 *   and +1ms / +24h derivations preserve millisecond quantization.
 * The only sub-millisecond-capable source in the chain is the DB statement
 * clock behind schedule-revision `created_at`, which OVR-2 uses solely as a
 * lower bound inside max() below (never as an equality claim).
 * Therefore +1ms is the next representable domain instant strictly after
 * the boundary and preserves exactly-at => ON TIME for every observable
 * input.
 */
export function submissionBreachInstant(effectiveDeadlineAt: Date): Date {
  return new Date(effectiveDeadlineAt.getTime() + 1);
}

/** Latest of the given instants (all callers pass at least one). */
export function maxInstant(...instants: Date[]): Date {
  let latest = instants[0]!;
  for (const instant of instants.slice(1)) {
    if (instant.getTime() > latest.getTime()) latest = instant;
  }
  return latest;
}

/**
 * LATE_START actual breach time. The first-late boundary is `scheduled_ends_at`
 * itself (starting exactly at the end is late), but the episode is eligible
 * no earlier than acceptance, nor before its governing revision took effect.
 */
export function lateStartBreachAt(input: {
  deadlineAt: Date;
  acceptedAt: Date;
  revisionEffectiveAt: Date;
}): Date {
  return maxInstant(input.deadlineAt, input.acceptedAt, input.revisionEffectiveAt);
}

/**
 * LATE_SUBMISSION actual breach time. First-late is the effective
 * deadline + 1ms; the episode must additionally have started (START for the
 * first episode, otherwise a provable lower bound of the re-arming resume /
 * withdraw instant) under an effective revision.
 */
export function submissionBreachAt(input: {
  nominalFirstLateAt: Date;
  episodeActivationAt: Date;
  revisionEffectiveAt: Date;
}): Date {
  return maxInstant(
    input.nominalFirstLateAt, input.episodeActivationAt, input.revisionEffectiveAt,
  );
}

/**
 * APPROVAL_WAIT actual breach time. Eligibility starts at the SUBMITTED fact
 * itself and the governing revision predates it, so the maximum collapses
 * to the first-late boundary; computed uniformly so the invariant holds even if
 * a future caller passes a later eligibility bound.
 */
export function approvalWaitBreachAt(input: {
  deadlineAt: Date;
  submittedAt: Date;
  revisionEffectiveAt: Date;
}): Date {
  return maxInstant(input.deadlineAt, input.submittedAt, input.revisionEffectiveAt);
}

/** APPROVAL_WAIT deadline: latest reliable submission fact + 24 hours. */
export function approvalWaitDeadlineAt(submittedAt: Date): Date {
  return new Date(submittedAt.getTime() + APPROVAL_WAIT_BREACH_HOURS * 3_600_000);
}

/** Breach test shared by all three delay types: `requestTime >= deadline`. */
export function isInstantBreached(deadlineAt: Date, requestTime: Date): boolean {
  return requestTime.getTime() >= deadlineAt.getTime();
}
