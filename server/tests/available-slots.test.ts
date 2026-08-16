import { describe, expect, it } from 'vitest';

import {
  filterAvailableSlotCandidates,
  generateAvailableSlotCandidates,
} from '../src/modules/job-cards/available-slots.js';
import { localClockParts, localDateKey } from '../src/modules/job-cards/local-calendar.js';

describe('generateAvailableSlotCandidates', () => {
  it('starts on the next local day, preserves the wall clock and exact duration across DST', () => {
    const startsAt = new Date('2026-03-07T15:00:00.000Z');
    const endsAt = new Date('2026-03-07T16:30:00.000Z');

    const candidates = generateAvailableSlotCandidates({
      startsAt,
      endsAt,
      timezone: 'America/New_York',
      horizonDays: 30,
    });

    expect(candidates).toHaveLength(30);
    expect(localDateKey(candidates[0]!.startsAt, 'America/New_York')).toBe('2026-03-08');
    expect(localClockParts(candidates[0]!.startsAt, 'America/New_York')).toEqual({ hour: 10, minute: 0 });
    expect(candidates[0]!.startsAt.toISOString()).toBe('2026-03-08T14:00:00.000Z');
    expect(candidates[0]!.endsAt.toISOString()).toBe('2026-03-08T15:30:00.000Z');

    for (const candidate of candidates) {
      expect(candidate.endsAt.valueOf() - candidate.startsAt.valueOf()).toBe(90 * 60 * 1000);
    }
  });

  it('skips a nonexistent spring-forward wall clock without silently shifting it', () => {
    const candidates = generateAvailableSlotCandidates({
      startsAt: new Date('2026-03-07T07:30:00.000Z'),
      endsAt: new Date('2026-03-07T08:30:00.000Z'),
      timezone: 'America/New_York',
      horizonDays: 3,
    });

    expect(candidates).toHaveLength(2);
    expect(localDateKey(candidates[0]!.startsAt, 'America/New_York')).toBe('2026-03-09');
    expect(localClockParts(candidates[0]!.startsAt, 'America/New_York')).toEqual({ hour: 2, minute: 30 });
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
