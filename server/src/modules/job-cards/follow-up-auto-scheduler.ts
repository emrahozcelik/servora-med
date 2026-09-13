import type { AvailableSlotBlocker, AvailableSlotCandidate } from './available-slots.js';
import {
  addCalendarDaysToDateKey,
  instantFromLocal,
  localClockParts,
  localDateKey,
} from './local-calendar.js';
import { canonicalScheduledDurationMs } from './job-card-duration.js';
import { FOLLOW_UP_SEARCH_HORIZON_DAYS } from './follow-up-policy.js';
import type { JobCardType } from './types.js';

export const AUTO_SCHEDULER_GRID_MINUTES = 15;

export type FindEarliestFollowUpSlotInput = Readonly<{
  earliestAllowedAt: Date;
  /**
   * Floor anchor for the bounded search horizon. Search starts at
   * earliestAllowedAt, but the +30-day envelope stays anchored here so a
   * target-first search never accidentally shifts the horizon forward.
   * Defaults to earliestAllowedAt, preserving prior caller semantics.
   */
  horizonAnchorAt?: Date;
  type: JobCardType;
  timezone: string;
  blockers: readonly AvailableSlotBlocker[];
}>;

function representsWallClock(
  instant: Date,
  dateKey: string,
  hour: number,
  minute: number,
  timezone: string,
): boolean {
  const clock = localClockParts(instant, timezone);
  return localDateKey(instant, timezone) === dateKey
    && clock.hour === hour
    && clock.minute === minute;
}

export function generateFollowUpSlotCandidates(
  input: Omit<FindEarliestFollowUpSlotInput, 'blockers'>,
): AvailableSlotCandidate[] {
  return Array.from(iterateFollowUpSlotCandidates(input));
}

/**
 * Floor-anchored search horizon instant for follow-up scheduling.
 *
 * This is the exact bound used by candidate generation (`startsAt <
 * horizonAt`), computed in constant time without enumerating candidates.
 * Callers needing snapshot/query bounds must use this envelope instead of
 * exhausting the candidate iterator to discover the last candidate.
 */
export function resolveFollowUpSearchHorizonAt(anchorAt: Date, timezone: string): Date {
  const horizonAnchorDateKey = localDateKey(anchorAt, timezone);
  const horizonAnchorClock = localClockParts(anchorAt, timezone);
  const horizonDateKey = addCalendarDaysToDateKey(
    horizonAnchorDateKey,
    FOLLOW_UP_SEARCH_HORIZON_DAYS,
  );
  return instantFromLocal(
    horizonDateKey,
    horizonAnchorClock.hour,
    horizonAnchorClock.minute,
    timezone,
  );
}

/**
 * Lazily yield follow-up slot candidates with exactly the same semantics as
 * {@link generateFollowUpSlotCandidates}: 15-minute organization-local grid,
 * starting at or after `earliestAllowedAt`, bounded by the floor-anchored
 * horizon (`startsAt < horizonAt`, end may extend beyond it).
 */
export function* iterateFollowUpSlotCandidates(
  input: Omit<FindEarliestFollowUpSlotInput, 'blockers'>,
): Generator<AvailableSlotCandidate, void, void> {
  const durationMs = canonicalScheduledDurationMs(input.type);
  if (durationMs === null) return;

  const firstDateKey = localDateKey(input.earliestAllowedAt, input.timezone);
  const firstClock = localClockParts(input.earliestAllowedAt, input.timezone);
  const firstMinuteOfDay = firstClock.hour * 60 + firstClock.minute;
  const firstGridMinute = Math.ceil(firstMinuteOfDay / AUTO_SCHEDULER_GRID_MINUTES)
    * AUTO_SCHEDULER_GRID_MINUTES;
  const horizonAnchorAt = input.horizonAnchorAt ?? input.earliestAllowedAt;
  const horizonAt = resolveFollowUpSearchHorizonAt(horizonAnchorAt, input.timezone);

  for (let day = 0; day <= FOLLOW_UP_SEARCH_HORIZON_DAYS; day += 1) {
    const dateKey = addCalendarDaysToDateKey(firstDateKey, day);
    const startMinute = day === 0 ? firstGridMinute : 0;
    for (let minuteOfDay = startMinute; minuteOfDay < 24 * 60; minuteOfDay += AUTO_SCHEDULER_GRID_MINUTES) {
      const hour = Math.floor(minuteOfDay / 60);
      const minute = minuteOfDay % 60;
      const startsAt = instantFromLocal(dateKey, hour, minute, input.timezone);
      if (!representsWallClock(startsAt, dateKey, hour, minute, input.timezone)) continue;
      if (startsAt.valueOf() < input.earliestAllowedAt.valueOf()) continue;
      if (startsAt.valueOf() >= horizonAt.valueOf()) return;

      yield {
        startsAt,
        endsAt: new Date(startsAt.valueOf() + durationMs),
      };
    }
  }
}

/**
 * Canonical half-open assignee overlap check shared by eager and lazy
 * candidate selection: back-to-back intervals remain allowed.
 */
export function isFollowUpSlotBlocked(
  candidate: AvailableSlotCandidate,
  blockers: readonly AvailableSlotBlocker[],
): boolean {
  return blockers.some((blocker) => (
    blocker.startsAt.valueOf() < candidate.endsAt.valueOf()
    && candidate.startsAt.valueOf() < blocker.endsAt.valueOf()
  ));
}

export function findEarliestFollowUpSlot(
  input: FindEarliestFollowUpSlotInput,
): AvailableSlotCandidate | null {
  for (const candidate of iterateFollowUpSlotCandidates(input)) {
    if (!isFollowUpSlotBlocked(candidate, input.blockers)) return candidate;
  }
  return null;
}
