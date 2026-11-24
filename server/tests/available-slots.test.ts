import { describe, expect, it } from 'vitest';

import {
  filterAvailableSlotCandidates,
  generateAvailableSlotCandidates,
} from '../src/modules/job-cards/available-slots.js';
import { localClockParts, localDateKey } from '../src/modules/job-cards/local-calendar.js';

describe('generateAvailableSlotCandidates', () => {
  it('offers same-day [08:00, 19:00] slots first, then preserves wall clock and exact duration across DST', () => {
    const startsAt = new Date('2026-03-07T15:00:00.000Z');
    const endsAt = new Date('2026-03-07T16:30:00.000Z');

    const candidates = generateAvailableSlotCandidates({
      startsAt,
      endsAt,
      timezone: 'America/New_York',
      horizonDays: 30,
    });

    const sameDayCandidates = candidates.filter(
      (candidate) => localDateKey(candidate.startsAt, 'America/New_York') === '2026-03-07',
    );
    const futureDayCandidates = candidates.filter(
      (candidate) => localDateKey(candidate.startsAt, 'America/New_York') !== '2026-03-07',
    );

    // Same-day 90m candidates strictly after 10:00 within [08:00, 19:00]: 10:30..17:30 (15 slots).
    expect(sameDayCandidates).toHaveLength(15);
    expect(localClockParts(sameDayCandidates[0]!.startsAt, 'America/New_York')).toEqual({ hour: 10, minute: 30 });
    expect(localClockParts(sameDayCandidates.at(-1)!.startsAt, 'America/New_York')).toEqual({ hour: 17, minute: 30 });
    expect(localClockParts(sameDayCandidates.at(-1)!.endsAt, 'America/New_York')).toEqual({ hour: 19, minute: 0 });
    expect(localDateKey(sameDayCandidates.at(-1)!.endsAt, 'America/New_York')).toBe('2026-03-07');

    // WORKING-DAY V1: the five Sundays in the window (03-08, 03-15, 03-22,
    // 03-29, 04-05) are never advertised, so 30 future days become 25.
    expect(futureDayCandidates).toHaveLength(25);
    expect(candidates).toHaveLength(40);
    expect(candidates.slice(0, sameDayCandidates.length)).toEqual(sameDayCandidates);
    expect(localDateKey(futureDayCandidates[0]!.startsAt, 'America/New_York')).toBe('2026-03-09');
    expect(localClockParts(futureDayCandidates[0]!.startsAt, 'America/New_York')).toEqual({ hour: 10, minute: 0 });
    expect(futureDayCandidates[0]!.startsAt.toISOString()).toBe('2026-03-09T14:00:00.000Z');
    expect(futureDayCandidates[0]!.endsAt.toISOString()).toBe('2026-03-09T15:30:00.000Z');

    for (const candidate of candidates) {
      expect(candidate.endsAt.valueOf() - candidate.startsAt.valueOf()).toBe(90 * 60 * 1000);
      expect(candidate.startsAt.valueOf()).toBeGreaterThan(startsAt.valueOf());
      expect(localDateKey(candidate.startsAt, 'America/New_York')).not.toBe('2026-03-08');
      expect(localDateKey(candidate.startsAt, 'America/New_York')).not.toBe('2026-04-05');
    }
  });

  it('starts same-day slots at 08:00 for early-morning requests and skips nonexistent spring-forward clocks', () => {
    const candidates = generateAvailableSlotCandidates({
      startsAt: new Date('2026-03-07T07:30:00.000Z'),
      endsAt: new Date('2026-03-07T08:30:00.000Z'),
      timezone: 'America/New_York',
      horizonDays: 3,
    });

    const sameDayCandidates = candidates.filter(
      (candidate) => localDateKey(candidate.startsAt, 'America/New_York') === '2026-03-07',
    );
    const futureDayCandidates = candidates.filter(
      (candidate) => localDateKey(candidate.startsAt, 'America/New_York') !== '2026-03-07',
    );

    // Same-day 60m candidates within [08:00, 19:00]: 08:00..18:00 (21 slots).
    expect(sameDayCandidates).toHaveLength(21);
    expect(localClockParts(sameDayCandidates[0]!.startsAt, 'America/New_York')).toEqual({ hour: 8, minute: 0 });
    expect(localClockParts(sameDayCandidates.at(-1)!.startsAt, 'America/New_York')).toEqual({ hour: 18, minute: 0 });

    expect(futureDayCandidates).toHaveLength(2);
    expect(candidates).toHaveLength(23);
    expect(localDateKey(futureDayCandidates[0]!.startsAt, 'America/New_York')).toBe('2026-03-09');
    expect(localClockParts(futureDayCandidates[0]!.startsAt, 'America/New_York')).toEqual({ hour: 2, minute: 30 });
  });

  it('uses half-open overlap semantics for assignee blockers', () => {
    const candidate = {
      startsAt: new Date('2026-08-16T10:00:00.000Z'),
      endsAt: new Date('2026-08-16T11:00:00.000Z'),
    };

    expect(filterAvailableSlotCandidates([candidate], [
      { startsAt: new Date('2026-08-16T09:00:00.000Z'), endsAt: candidate.startsAt },
    ])).toEqual([candidate]);
    expect(filterAvailableSlotCandidates([candidate], [
      { startsAt: candidate.startsAt, endsAt: new Date('2026-08-16T10:30:00.000Z') },
    ])).toEqual([]);
  });

  it('preserves second-level local clock precision when the request includes seconds', () => {
    const candidates = generateAvailableSlotCandidates({
      startsAt: new Date('2026-08-16T10:00:45.000Z'),
      endsAt: new Date('2026-08-16T11:15:45.000Z'),
      timezone: 'UTC',
      horizonDays: 1,
    });

    expect(candidates[0]!.startsAt.toISOString()).toBe('2026-08-17T10:00:45.000Z');
    expect(candidates[0]!.endsAt.toISOString()).toBe('2026-08-17T11:15:45.000Z');
  });
});
