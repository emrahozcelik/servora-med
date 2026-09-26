/**
 * OVR-4: LATE_SUBMISSION reminder / escalation policy (single owner).
 *
 * The automatic thresholds live here and nowhere else: neither the worker,
 * nor the service, nor any SQL embeds its own copy of the +15 / +60 minute
 * delays. Callers inject overrides only through
 * {@link OverdueReminderTiming} (worker options / server config); the domain
 * defaults below stay the single named source of truth.
 *
 * Clock discipline: every comparison is `requestTime - breachedAt` with the
 * caller-supplied injected clock. No `new Date()` / `Date.now()` / `NOW()`.
 */

export const OVERDUE_SUBMISSION_STAFF_REMINDER_DELAY_MS = 15 * 60_000;
export const OVERDUE_SUBMISSION_MANAGEMENT_ESCALATION_DELAY_MS = 60 * 60_000;

export type OverdueReminderKind = 'STAFF_REMINDER' | 'MANAGEMENT_ESCALATION';

export const OVERDUE_REMINDER_KINDS: readonly OverdueReminderKind[] = [
  'STAFF_REMINDER',
  'MANAGEMENT_ESCALATION',
] as const;

/**
 * Effective timing for one worker/service instance. Missing fields fall back
 * to the domain defaults above; explicit non-negative values override them
 * (server config surface, never per-call magic numbers).
 */
export type OverdueReminderTiming = Readonly<{
  staffReminderDelayMs?: number;
  escalationDelayMs?: number;
}>;

export type ResolvedOverdueReminderTiming = Readonly<{
  staffReminderDelayMs: number;
  escalationDelayMs: number;
}>;

export function resolveOverdueReminderTiming(
  timing: OverdueReminderTiming = {},
): ResolvedOverdueReminderTiming {
  const staffReminderDelayMs = timing.staffReminderDelayMs
    ?? OVERDUE_SUBMISSION_STAFF_REMINDER_DELAY_MS;
  const escalationDelayMs = timing.escalationDelayMs
    ?? OVERDUE_SUBMISSION_MANAGEMENT_ESCALATION_DELAY_MS;
  if (!Number.isSafeInteger(staffReminderDelayMs) || staffReminderDelayMs < 0) {
    throw new Error('OVERDUE_REMINDER_TIMING_INVALID');
  }
  if (!Number.isSafeInteger(escalationDelayMs) || escalationDelayMs < 0) {
    throw new Error('OVERDUE_REMINDER_TIMING_INVALID');
  }
  return { staffReminderDelayMs, escalationDelayMs };
}

/** Whole milliseconds an open breach episode has been late, clamped at zero. */
export function openSubmissionLatenessMs(breachedAt: Date, requestTime: Date): number {
  return Math.max(0, requestTime.getTime() - breachedAt.getTime());
}

/** Whether the staff auto-reminder threshold has been reached. */
export function isStaffReminderDue(
  breachedAt: Date,
  requestTime: Date,
  timing: ResolvedOverdueReminderTiming,
): boolean {
  return openSubmissionLatenessMs(breachedAt, requestTime) >= timing.staffReminderDelayMs;
}

/** Whether the management escalation threshold has been reached. */
export function isManagementEscalationDue(
  breachedAt: Date,
  requestTime: Date,
  timing: ResolvedOverdueReminderTiming,
): boolean {
  return openSubmissionLatenessMs(breachedAt, requestTime) >= timing.escalationDelayMs;
}

/** Which automatic kinds are due for an open episode at `requestTime`. */
export function dueOverdueReminderKinds(
  breachedAt: Date,
  requestTime: Date,
  timing: ResolvedOverdueReminderTiming,
): readonly OverdueReminderKind[] {
  const kinds: OverdueReminderKind[] = [];
  if (isStaffReminderDue(breachedAt, requestTime, timing)) kinds.push('STAFF_REMINDER');
  if (isManagementEscalationDue(breachedAt, requestTime, timing)) kinds.push('MANAGEMENT_ESCALATION');
  return kinds;
}
