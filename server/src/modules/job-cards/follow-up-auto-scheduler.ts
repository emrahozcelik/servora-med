import type { AvailableSlotBlocker, AvailableSlotCandidate } from './available-slots.js';
import { filterAvailableSlotCandidates } from './available-slots.js';
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
  const durationMs = canonicalScheduledDurationMs(input.type);
  if (durationMs === null) return [];

  const firstDateKey = localDateKey(input.earliestAllowedAt, input.timezone);
  const firstClock = localClockParts(input.earliestAllowedAt, input.timezone);
  const firstMinuteOfDay = firstClock.hour * 60 + firstClock.minute;
  const firstGridMinute = Math.ceil(firstMinuteOfDay / AUTO_SCHEDULER_GRID_MINUTES)
    * AUTO_SCHEDULER_GRID_MINUTES;
  const horizonDateKey = addCalendarDaysToDateKey(
    firstDateKey,
    FOLLOW_UP_SEARCH_HORIZON_DAYS,
  );
  const horizonAt = instantFromLocal(
    horizonDateKey,
    firstClock.hour,
    firstClock.minute,
    input.timezone,
  );
  const candidates: AvailableSlotCandidate[] = [];

  for (let day = 0; day <= FOLLOW_UP_SEARCH_HORIZON_DAYS; day += 1) {
    const dateKey = addCalendarDaysToDateKey(firstDateKey, day);
    const startMinute = day === 0 ? firstGridMinute : 0;
    for (let minuteOfDay = startMinute; minuteOfDay < 24 * 60; minuteOfDay += AUTO_SCHEDULER_GRID_MINUTES) {
      const hour = Math.floor(minuteOfDay / 60);
      const minute = minuteOfDay % 60;
      const startsAt = instantFromLocal(dateKey, hour, minute, input.timezone);
      if (!representsWallClock(startsAt, dateKey, hour, minute, input.timezone)) continue;
      if (startsAt.valueOf() < input.earliestAllowedAt.valueOf()) continue;
      if (startsAt.valueOf() >= horizonAt.valueOf()) return candidates;

      candidates.push({
        startsAt,
        endsAt: new Date(startsAt.valueOf() + durationMs),
      });
    }
  }

  return candidates;
}

export function findEarliestFollowUpSlot(
  input: FindEarliestFollowUpSlotInput,
): AvailableSlotCandidate | null {
  return filterAvailableSlotCandidates(
    generateFollowUpSlotCandidates(input),
    input.blockers,
  )[0] ?? null;
}
