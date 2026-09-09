import type { JobCardType } from './jobs-api';

/**
 * Frontend advisory mirror of the backend START interval invariant (R3).
 *
 * UX guidance ONLY — never authorization, never mutation authority.
 * The backend remains authoritative and still rejects invalid intervals with
 * SCHEDULED_INTERVAL_REQUIRED / 400.
 *
 * Deliberately minimal: type + both bounds + finite parse + end > start.
 * Canonical durations, lifecycle state, assignment, role, version,
 * geolocation, conflict checks and current time are all OUT of scope.
 */
export function isPlannedIntervalJobType(type: JobCardType): boolean {
  return type === 'SALES_MEETING' || type === 'PRODUCT_DELIVERY';
}

export function hasValidPlannedIntervalForStart(input: {
  type: JobCardType;
  scheduledAt: string | null | undefined;
  scheduledEndsAt: string | null | undefined;
}): boolean {
  if (!isPlannedIntervalJobType(input.type)) return true;
  const { scheduledAt, scheduledEndsAt } = input;
  if (scheduledAt == null || scheduledEndsAt == null) return false;
  const startMs = Date.parse(scheduledAt);
  const endMs = Date.parse(scheduledEndsAt);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
}

export type PlannedIntervalShape = 'VALID' | 'MISSING' | 'INCOMPLETE' | 'NOT_APPLICABLE';

/**
 * Advisory schedule shape for SM/PD planning signals.
 * - VALID: structurally complete interval (canonical duration NOT required).
 * - MISSING: no planned start at all (covers both-null and any start-less shape).
 * - INCOMPLETE: start present but end missing, unparseable or non-positive.
 * - NOT_APPLICABLE: GENERAL_TASK is open-ended by design.
 */
export function plannedIntervalShape(input: {
  type: JobCardType;
  scheduledAt: string | null | undefined;
  scheduledEndsAt: string | null | undefined;
}): PlannedIntervalShape {
  if (!isPlannedIntervalJobType(input.type)) return 'NOT_APPLICABLE';
  if (hasValidPlannedIntervalForStart(input)) return 'VALID';
  if (input.scheduledAt == null) return 'MISSING';
  return 'INCOMPLETE';
}
