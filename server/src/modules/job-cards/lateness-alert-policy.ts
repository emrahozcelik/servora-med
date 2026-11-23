/**
 * OVR-6: lateness alert policy (single owner of the defaults).
 *
 * Accepted contract: `DECISIONS.md` OVR-6 and
 * `docs/features/lateness-notifications-quiet-hours.md` (§4, §6, §7.4).
 *
 * The defaults below live here and nowhere else: neither the worker, the
 * server config surface, nor any SQL embeds its own copy of the 15-minute
 * start-reminder delay, the poll interval or the batch size. Callers inject
 * overrides only through {@link LatenessAlertTiming} (worker options / server
 * config).
 *
 * Clock discipline: every comparison is `scanTime - scheduledAt` with the
 * caller-supplied injected clock. No `new Date()` / `Date.now()` / `NOW()`.
 */

/** Worker tick interval while `LATENESS_ALERTS_ENABLED` is on. */
export const LATENESS_ALERT_POLL_INTERVAL_MS = 60_000;

/**
 * Per-kind candidates one tick may process. Three independent per-kind
 * discovery queries are each bounded by this value, so a full kind never
 * starves another.
 */
export const LATENESS_ALERT_BATCH_SIZE = 50;

/**
 * How long after the planned start the Staff start reminder becomes due
 * (contract §4.1). Acceptance after that instant makes it due at the next
 * tick; this is not lateness and creates no incident.
 */
export const START_REMINDER_DELAY_MS = 15 * 60_000;

/** Accepted bounds for the configurable delay (same shape as OVR-4). */
export const LATENESS_ALERT_START_REMINDER_DELAY_MIN_MS = 60_000;
export const LATENESS_ALERT_START_REMINDER_DELAY_MAX_MS = 86_400_000;

/** Accepted bounds for the configurable poll interval and batch size. */
export const LATENESS_ALERT_POLL_INTERVAL_MIN_MS = 1_000;
export const LATENESS_ALERT_POLL_INTERVAL_MAX_MS = 3_600_000;
export const LATENESS_ALERT_BATCH_MIN_SIZE = 1;
export const LATENESS_ALERT_BATCH_MAX_SIZE = 500;

/**
 * The three alert families one worker iteration processes. Each maps to one
 * delivery `kind` value in `job_card_lateness_alert_deliveries` and one
 * activity event / notification kind.
 */
export type LatenessAlertKind =
  | 'START_REMINDER'
  | 'APPROVAL_WAIT_ALERT'
  | 'PENDING_ACCEPTANCE_ALERT';

export const LATENESS_ALERT_KINDS: readonly LatenessAlertKind[] = [
  'START_REMINDER',
  'APPROVAL_WAIT_ALERT',
  'PENDING_ACCEPTANCE_ALERT',
] as const;

/**
 * Effective timing for one worker instance. Missing fields fall back to the
 * domain default above; explicit non-negative values override it (server
 * config surface, never per-call magic numbers).
 */
export type LatenessAlertTiming = Readonly<{ startReminderDelayMs?: number }>;

export type ResolvedLatenessAlertTiming = Readonly<{ startReminderDelayMs: number }>;

export function resolveLatenessAlertTiming(
  timing: LatenessAlertTiming = {},
): ResolvedLatenessAlertTiming {
  const startReminderDelayMs = timing.startReminderDelayMs ?? START_REMINDER_DELAY_MS;
  if (!Number.isSafeInteger(startReminderDelayMs) || startReminderDelayMs < 0) {
    throw new Error('LATENESS_ALERT_TIMING_INVALID');
  }
  return { startReminderDelayMs };
}

/**
 * Latest planned start that is due for the start reminder at `scanTime`.
 * This is the set-builder form of `scanTime >= scheduledAt + delay`; discovery
 * uses the cutoff and the worker still rechecks the same predicate under the
 * JobCard lock.
 */
export function startReminderDueCutoff(scanTime: Date, delayMs: number): Date {
  return new Date(scanTime.getTime() - delayMs);
}

/** Whether the Staff start reminder is due for a planned start at `scanTime`. */
export function isStartReminderDue(
  scheduledAt: Date,
  scanTime: Date,
  timing: ResolvedLatenessAlertTiming,
): boolean {
  return scanTime.getTime() - scheduledAt.getTime() >= timing.startReminderDelayMs;
}
