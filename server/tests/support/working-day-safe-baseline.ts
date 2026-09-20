import { advanceToWorkingDay } from '../../src/modules/job-cards/working-day-policy.js';

/**
 * Working-day-safe fixture slot derivations (test-only).
 *
 * Fixtures derive scheduled slots from the DB arbitration clock so business
 * time stays the production time source. On weekend runs those derivations
 * can land inside the organization-local Sunday, which the production
 * working-day policy (correctly) refuses with NON_WORKING_DAY — e.g. a
 * "baseline − 1h" elapsed parent slot when the DB baseline maps into local
 * Sunday (2026-09-19 21:30Z → 2026-09-20 00:30 +03).
 *
 * The baseline itself must stay anchored to the real DB clock: lifecycle
 * commands reserve on the real clock while create/patch paths use the
 * injected suite clock, so moving the baseline across days breaks the
 * lifecycle ordering the fixtures rely on. Only scheduled-slot derivations
 * are adjusted, by whole days so wall-clock relationships survive:
 * - past (elapsed) slots shift BACKWARD until working-day safe;
 * - future instants advance FORWARD through the canonical policy helper.
 *
 * The canonical `advanceToWorkingDay` policy helper is the single source of
 * truth for what counts as a working day; production behavior is untouched.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** True when [start, end] (or the point `start`) is already working-day safe. */
function isWorkingDaySlot(start: Date, end: Date | null, timezone: string): boolean {
  const advanced = advanceToWorkingDay({
    startsAt: start,
    endsAt: end ?? start,
    timezone,
    maxDays: 0,
  });
  return advanced !== null && advanced.startsAt.getTime() === start.getTime();
}

/**
 * Smallest whole-day backward shift (0..3) that moves the fixture slot
 * envelope [base + earliestOffsetMs, base + latestOffsetMs] out of the
 * organization-local Sunday while preserving every instant's wall-clock
 * time. Callers apply the returned shift to scheduled-slot derivations only.
 */
export function sundayAvoidingShiftDays(
  base: Date,
  timezone: string,
  earliestOffsetMs: number,
  latestOffsetMs: number,
): number {
  for (let days = 0; days <= 3; days += 1) {
    const start = new Date(base.getTime() + earliestOffsetMs - days * DAY_MS);
    const end = new Date(base.getTime() + latestOffsetMs - days * DAY_MS);
    if (isWorkingDaySlot(start, end, timezone)) return days;
  }
  throw new Error('no working-day-safe slot envelope within three days back');
}

/**
 * True when the fixture straddle envelope [start, end] avoids the
 * organization-local Sunday. Straddling-slot scenarios (the reservation
 * instant must fall INSIDE the slot) are unsatisfiable whenever the real DB
 * clock sits inside that envelope on a Sunday-adjacent calendar window;
 * callers report SKIPPED for those windows (repo test contract).
 */
export function isWorkingDaySafeEnvelope(start: Date, end: Date, timezone: string): boolean {
  return isWorkingDaySlot(start, end, timezone);
}

/**
 * Forward-advance a future fixture instant to the next working-day moment
 * with the same wall-clock time (point semantics, canonical policy); returns
 * the input unchanged when it is already working-day safe.
 */
export function advanceInstantToWorkingDay(instant: Date, timezone: string): Date {
  if (isWorkingDaySlot(instant, null, timezone)) return instant;
  const advanced = advanceToWorkingDay({ startsAt: instant, endsAt: instant, timezone });
  if (advanced === null) {
    throw new Error('no working-day-safe instant within the policy advance horizon');
  }
  return advanced.startsAt;
}
