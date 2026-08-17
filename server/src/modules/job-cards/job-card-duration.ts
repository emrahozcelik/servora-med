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

export function persistedScheduledDurationMs(
  scheduledAt: string | null,
  scheduledEndsAt: string | null,
): number | null {
  if (scheduledAt === null || scheduledEndsAt === null) return null;
  return Date.parse(scheduledEndsAt) - Date.parse(scheduledAt);
}
