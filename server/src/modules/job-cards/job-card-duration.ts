import type { JobCardType } from './types.js';

const MINUTE_MS = 60_000;

const CANONICAL_JOB_DURATION_MS: Readonly<Partial<Record<JobCardType, number>>> = {
  SALES_MEETING: 60 * MINUTE_MS,
  PRODUCT_DELIVERY: 30 * MINUTE_MS,
};

export function canonicalScheduledDurationMs(type: JobCardType): number | null {
  return CANONICAL_JOB_DURATION_MS[type] ?? null;
}

export function canonicalScheduledEnd(type: JobCardType, scheduledAt: string): string | null {
  const durationMs = canonicalScheduledDurationMs(type);
  if (durationMs === null) return null;
  return new Date(Date.parse(scheduledAt) + durationMs).toISOString();
}

/**
 * JOB-007 calendar occupancy: SQL expression for the instant a `job_cards`
 * row aliased `j` stops occupying its assignee's calendar. A job waiting for
 * manager approval is released at the staff submission instant
 * (`staff_completed_at`), never later than its planned end; every other status
 * keeps the planned `scheduled_ends_at`. The planned interval itself is never
 * rewritten, so lateness, reports and history keep reading it unchanged.
 * Callers still require `j.scheduled_ends_at IS NOT NULL` (LEAST skips NULLs).
 */
export const JOB_CALENDAR_OCCUPIED_ENDS_AT_SQL = `(CASE
  WHEN j.status = 'WAITING_APPROVAL' AND j.staff_completed_at IS NOT NULL
    THEN LEAST(j.scheduled_ends_at, j.staff_completed_at)
  ELSE j.scheduled_ends_at END)`;

export function persistedScheduledDurationMs(
  scheduledAt: string | null,
  scheduledEndsAt: string | null,
): number | null {
  if (scheduledAt === null || scheduledEndsAt === null) return null;
  return Date.parse(scheduledEndsAt) - Date.parse(scheduledAt);
}

export function isPlannedIntervalJobType(type: JobCardType): boolean {
  return type === 'SALES_MEETING' || type === 'PRODUCT_DELIVERY';
}

/**
 * R3 START invariant: scheduled job types may start only with a valid
 * planned interval (both bounds present, finite, end strictly after start).
 * GENERAL_TASK is open-ended, so the requirement never applies to it.
 * Canonical durations are writer normalization only and are NOT compared here,
 * so valid noncanonical legacy intervals remain startable.
 */
export function hasValidPlannedInterval(
  type: JobCardType,
  scheduledAt: string | null,
  scheduledEndsAt: string | null,
): boolean {
  if (!isPlannedIntervalJobType(type)) return true;
  if (scheduledAt === null || scheduledEndsAt === null) return false;
  const startMs = Date.parse(scheduledAt);
  const endMs = Date.parse(scheduledEndsAt);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
}
