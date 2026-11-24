import {
  addCalendarDaysToDateKey,
  instantFromLocal,
  localClockParts,
  localClockSecond,
  localDateKey,
} from './local-calendar.js';
import { occupiesNonWorkingDay } from './working-day-policy.js';

export type AvailableSlotCandidate = Readonly<{
  startsAt: Date;
  endsAt: Date;
}>;

export type GenerateAvailableSlotCandidatesInput = Readonly<{
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  horizonDays: number;
  /**
   * Server request time. A suggestion must be bookable now: no candidate may
   * start at or before it, even when the requested start is already past.
   * Optional so pure generation tests stay clock-free.
   */
  notBefore?: Date;
}>;

export type AvailableSlotBlocker = Readonly<{
  startsAt: Date;
  endsAt: Date;
}>;

function representsRequestedWallClock(
  instant: Date,
  dateKey: string,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): boolean {
  return localDateKey(instant, timezone) === dateKey
    && localClockParts(instant, timezone).hour === hour
    && localClockParts(instant, timezone).minute === minute
    && localClockSecond(instant, timezone) === second;
}

/**
 * Generate same-day candidates strictly after `input.startsAt` within
 * organization-local working hours [08:00, 19:00], followed by the
 * same-wall-clock candidates for the following `horizonDays` local days.
 *
 * WORKING-DAY V1: a candidate whose occupied interval touches the
 * organization-local Sunday is never advertised (skipped at generation time,
 * not filtered later). This preserves the existing all-results semantics —
 * every remaining valid day is still returned — and adds no per-slot reads.
 */
export function generateAvailableSlotCandidates(
  input: GenerateAvailableSlotCandidatesInput,
): AvailableSlotCandidate[] {
  const durationMs = input.endsAt.valueOf() - input.startsAt.valueOf();
  const clock = localClockParts(input.startsAt, input.timezone);
  const second = localClockSecond(input.startsAt, input.timezone);
  const requestedDate = localDateKey(input.startsAt, input.timezone);
  const candidates: AvailableSlotCandidate[] = [];

  const firstSameDayMinute = Math.max(
    480,
    Math.floor((clock.hour * 60 + clock.minute) / 30) * 30 + 30,
  );
  for (let m = firstSameDayMinute; m < 1140; m += 30) {
    const hour = Math.floor(m / 60);
    const minute = m % 60;
    const candidateStart = instantFromLocal(requestedDate, hour, minute, input.timezone, 0);
    if (!representsRequestedWallClock(candidateStart, requestedDate, hour, minute, 0, input.timezone)) {
      continue;
    }
    if (candidateStart.valueOf() <= input.startsAt.valueOf()) {
      continue;
    }
    if (input.notBefore !== undefined && candidateStart.valueOf() <= input.notBefore.valueOf()) {
      continue;
    }
    const candidateEnd = new Date(candidateStart.valueOf() + durationMs);
    const endClock = localClockParts(candidateEnd, input.timezone);
    const endSec = localClockSecond(candidateEnd, input.timezone);
    const endMinuteOfDay = endClock.hour * 60 + endClock.minute;
    if (
      localDateKey(candidateEnd, input.timezone) !== requestedDate
      || !(endMinuteOfDay < 1140 || (endMinuteOfDay === 1140 && endSec === 0))
    ) {
      continue;
    }
    if (occupiesNonWorkingDay({
      startsAt: candidateStart,
      endsAt: candidateEnd,
      timezone: input.timezone,
    })) {
      continue;
    }
    candidates.push({ startsAt: candidateStart, endsAt: candidateEnd });
  }

  for (let day = 1; day <= input.horizonDays; day += 1) {
    const dateKey = addCalendarDaysToDateKey(requestedDate, day);
    const candidateStart = instantFromLocal(
      dateKey,
      clock.hour,
      clock.minute,
      input.timezone,
      second,
    );
    // A spring-forward wall clock may not exist. Do not silently shift it.
    if (!representsRequestedWallClock(
      candidateStart,
      dateKey,
      clock.hour,
      clock.minute,
      second,
      input.timezone,
    )) continue;
    if (input.notBefore !== undefined && candidateStart.valueOf() <= input.notBefore.valueOf()) continue;
    const candidateEnd = new Date(candidateStart.valueOf() + durationMs);
    // Skip a whole-Sunday date and any late Saturday start whose duration
    // spills past local midnight into Sunday.
    if (occupiesNonWorkingDay({
      startsAt: candidateStart,
      endsAt: candidateEnd,
      timezone: input.timezone,
    })) continue;
    candidates.push({ startsAt: candidateStart, endsAt: candidateEnd });
  }

  return candidates;
}

export function filterAvailableSlotCandidates(
  candidates: readonly AvailableSlotCandidate[],
  blockers: readonly AvailableSlotBlocker[],
): AvailableSlotCandidate[] {
  return candidates.filter((candidate) => !blockers.some((blocker) => (
    blocker.startsAt.valueOf() < candidate.endsAt.valueOf()
      && candidate.startsAt.valueOf() < blocker.endsAt.valueOf()
  )));
}
