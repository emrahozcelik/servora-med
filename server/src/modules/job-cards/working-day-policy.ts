import { AppError } from '../../errors/index.js';
import {
  addCalendarDaysToDateKey,
  dateKeyToOrdinal,
  instantFromLocal,
  localClockParts,
  localDateKey,
  weekdayOfDateKey,
} from './local-calendar.js';

/**
 * WORKING-DAY V1 — organization-local Sunday is a non-working day.
 *
 * Canonical rule: `WORKING_DAY_INTERVAL_RULE = NO_SUNDAY_OVERLAP`. A scheduled
 * item is invalid when any occupied part of it falls inside the
 * organization-local Sunday day. The occupied set is:
 *
 *   - `[startsAt, endsAt)` for a proper planned interval
 *   - `{ startsAt }`       for a degenerate point (GENERAL_TASK, or any row
 *                          without a valid positive-length end)
 *
 * This mirrors the existing F4 half-open interval contract exactly; it does not
 * change collision semantics. Working-day eligibility is a separate invariant.
 *
 * V1 scope is Sunday only: no public holidays, no configurable working weeks,
 * no Saturday closure, no per-user calendars, no working hours.
 *
 * TIMEZONE AUTHORITY (non-negotiable): callers MUST pass the ORGANIZATION
 * timezone (`organizations.timezone`). A client-supplied timezone — notably a
 * manual calendar event's own `timezone` column — must never decide working-day
 * eligibility, otherwise a client could shift the day boundary and bypass the
 * rule.
 */

export const NON_WORKING_DAY = 'NON_WORKING_DAY';
export const NON_WORKING_DAY_SAFE_MESSAGE =
  'Pazar günleri planlama yapılamaz. Lütfen Cumartesi veya Pazartesi seçin.';

/** Upper bound for forward working-day search; matches the follow-up horizon. */
export const WORKING_DAY_MAX_ADVANCE_DAYS = 30;

export type OccupiedInterval = Readonly<{
  startsAt: Date;
  /**
   * `null` — or any end not strictly after the start — is a degenerate
   * occupied point rather than an interval.
   */
  endsAt: Date | null;
  timezone: string;
}>;

export type WorkingDayInterval = Readonly<{
  startsAt: Date;
  endsAt: Date | null;
}>;

/** A missing or non-positive end means the item occupies a single instant. */
export function isDegeneratePoint(startsAt: Date, endsAt: Date | null): boolean {
  return endsAt === null || endsAt.valueOf() <= startsAt.valueOf();
}

/**
 * True when the occupied set of the item contains any organization-local
 * Sunday. Constant time: the occupied local-date range is resolved to its first
 * and last date key and tested arithmetically, so arbitrarily long manual
 * calendar events never require a per-day scan.
 */
export function occupiesNonWorkingDay(input: OccupiedInterval): boolean {
  const { startsAt, endsAt, timezone } = input;
  if (Number.isNaN(startsAt.valueOf())) return false;

  if (isDegeneratePoint(startsAt, endsAt)) {
    // Point semantics: the instant's own organization-local date is Sunday.
    return weekdayOfDateKey(localDateKey(startsAt, timezone)) === 0;
  }

  // Proper half-open interval [startsAt, endsAt). The last occupied local date
  // is the date of (endsAt - 1ms), so an interval ending exactly at local
  // midnight does not occupy the following day.
  const lastOccupiedAt = new Date(endsAt!.valueOf() - 1);
  if (Number.isNaN(lastOccupiedAt.valueOf())) return false;

  const firstKey = localDateKey(startsAt, timezone);
  const lastKey = localDateKey(lastOccupiedAt, timezone);
  const span = dateKeyToOrdinal(lastKey) - dateKeyToOrdinal(firstKey);
  if (span < 0) return false;

  // The first Sunday at or after `firstKey` sits this many days ahead; the
  // occupied local-date range contains a Sunday exactly when it falls inside
  // the span. Sunday is weekday 0.
  const daysUntilSunday = (7 - weekdayOfDateKey(firstKey)) % 7;
  return daysUntilSunday <= span;
}

/** Throws `NON_WORKING_DAY` / 400 when the occupied interval touches Sunday. */
export function assertWorkingDay(input: OccupiedInterval): void {
  if (occupiesNonWorkingDay(input)) {
    throw new AppError(NON_WORKING_DAY, 400, NON_WORKING_DAY_SAFE_MESSAGE);
  }
}

/**
 * Advance an organization-local wall clock forward one calendar day at a time
 * until the occupied interval no longer touches Sunday. Preserves the local
 * clock time (DST-correct via `instantFromLocal`) and the interval duration.
 *
 * Returns the input unchanged when it is already valid, so callers may invoke
 * it unconditionally on a computed target. Returns `null` when no valid date is
 * found within `maxDays`.
 */
export function advanceToWorkingDay(
  input: OccupiedInterval & { maxDays?: number },
): WorkingDayInterval | null {
  const { startsAt, endsAt, timezone } = input;
  if (Number.isNaN(startsAt.valueOf())) return null;
  const maxDays = input.maxDays ?? WORKING_DAY_MAX_ADVANCE_DAYS;
  const durationMs = isDegeneratePoint(startsAt, endsAt)
    ? null
    : endsAt!.valueOf() - startsAt.valueOf();

  let current = startsAt;
  for (let step = 0; step <= maxDays; step += 1) {
    const currentEnd = durationMs === null ? null : new Date(current.valueOf() + durationMs);
    if (!occupiesNonWorkingDay({ startsAt: current, endsAt: currentEnd, timezone })) {
      return { startsAt: current, endsAt: currentEnd };
    }
    const clock = localClockParts(current, timezone);
    const nextDateKey = addCalendarDaysToDateKey(localDateKey(current, timezone), 1);
    current = instantFromLocal(nextDateKey, clock.hour, clock.minute, timezone);
  }
  return null;
}
