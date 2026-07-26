import { describe, expect, it } from 'vitest';

import {
  intersectedLocalDates,
  intervalIntersectsLocalDay,
  localDayKey,
  startOfLocalDay,
} from '../src/calendar/calendar-date';

describe('localDayKey', () => {
  it('formats an ISO date key', () => {
    expect(localDayKey(new Date(2026, 6, 29))).toBe('2026-07-29');
  });
});

describe('startOfLocalDay', () => {
  it('returns midnight of the same local day', () => {
    const result = startOfLocalDay(new Date(2026, 6, 29, 14, 30));
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getDate()).toBe(29);
  });
});

describe('intersectedLocalDates (half-open)', () => {
  it('same-day duration: 29 July 09:00 → 29 July 10:00 = 29 July', () => {
    const dates = intersectedLocalDates('2026-07-29T06:00:00.000Z', '2026-07-29T07:00:00.000Z');
    expect(dates).toEqual(['2026-07-29']);
  });

  it('midnight ending: 29 July 09:00 → 30 July 00:00 = 29 July only', () => {
    const dates = intersectedLocalDates('2026-07-29T06:00:00.000Z', '2026-07-29T21:00:00.000Z');
    expect(dates).toEqual(['2026-07-29']);
  });

  it('full day: 29 July 00:00 → 30 July 00:00 = 29 July only', () => {
    // Both times are midnight UTC = 03:00 local, so end is 30 July 03:00, cursor = 30 July 00:00 < end → YES
    // This actually spans 29-30 July in UTC+3
    // Use local times for unambiguous testing
    const dates = intersectedLocalDates('2026-07-29T00:00:00+03:00', '2026-07-30T00:00:00+03:00');
    expect(dates).toEqual(['2026-07-29']);
  });

  it('multi-day partial ending: 29 July 12:00 → 31 July 12:00 = 29, 30, 31 July', () => {
    // 12:00Z = 15:00 in +3, clearly within July 31 local day
    const dates = intersectedLocalDates('2026-07-29T12:00:00+03:00', '2026-07-31T12:00:00+03:00');
    expect(dates).toEqual(['2026-07-29', '2026-07-30', '2026-07-31']);
  });

  it('multi-day midnight ending: 29 July 12:00 → 31 July 00:00 = 29, 30 July', () => {
    const dates = intersectedLocalDates('2026-07-29T12:00:00+03:00', '2026-07-31T00:00:00+03:00');
    expect(dates).toEqual(['2026-07-29', '2026-07-30']);
  });

  it('point Job event (endsAt null) = startsAt day only', () => {
    const dates = intersectedLocalDates('2026-07-28T14:00:00.000Z', null);
    expect(dates).toEqual(['2026-07-28']);
  });

  it('invalid duration (end before start) returns empty', () => {
    const dates = intersectedLocalDates('2026-07-29T14:00:00.000Z', '2026-07-29T10:00:00.000Z');
    expect(dates).toEqual([]);
  });
});

describe('intervalIntersectsLocalDay', () => {
  it('same-day event intersects its own day', () => {
    const dayStart = startOfLocalDay(new Date(2026, 6, 29));
    expect(intervalIntersectsLocalDay(
      '2026-07-29T06:00:00.000Z',
      '2026-07-29T07:00:00.000Z',
      dayStart,
    )).toBe(true);
  });

  it('midnight-ending event does not intersect the ending day (local)', () => {
    const dayStart = startOfLocalDay(new Date(2026, 6, 31));
    expect(intervalIntersectsLocalDay(
      '2026-07-29T12:00:00+03:00',
      '2026-07-31T00:00:00+03:00',
      dayStart,
    )).toBe(false);
  });

  it('multi-day event intersects middle day', () => {
    const dayStart = startOfLocalDay(new Date(2026, 6, 30));
    expect(intervalIntersectsLocalDay(
      '2026-07-29T12:00:00+03:00',
      '2026-07-31T12:00:00+03:00',
      dayStart,
    )).toBe(true);
  });

  it('point event intersects its own day', () => {
    const dayStart = startOfLocalDay(new Date(2026, 6, 28));
    expect(intervalIntersectsLocalDay(
      '2026-07-28T14:00:00.000Z',
      null,
      dayStart,
    )).toBe(true);
  });

  it('point event does not intersect other day', () => {
    const dayStart = startOfLocalDay(new Date(2026, 6, 29));
    expect(intervalIntersectsLocalDay(
      '2026-07-28T14:00:00.000Z',
      null,
      dayStart,
    )).toBe(false);
  });
});

describe('grid/agenda parity', () => {
  const cases: Array<{
    startsAt: string;
    endsAt: string | null;
    expected: string[];
  }> = [
    { startsAt: '2026-07-29T06:00:00.000Z', endsAt: '2026-07-29T07:00:00.000Z', expected: ['2026-07-29'] },
    { startsAt: '2026-07-29T06:00:00.000Z', endsAt: '2026-07-29T21:00:00.000Z', expected: ['2026-07-29'] },
    { startsAt: '2026-07-29T12:00:00+03:00', endsAt: '2026-07-31T12:00:00+03:00', expected: ['2026-07-29', '2026-07-30', '2026-07-31'] },
    { startsAt: '2026-07-29T12:00:00+03:00', endsAt: '2026-07-31T00:00:00+03:00', expected: ['2026-07-29', '2026-07-30'] },
    { startsAt: '2026-07-28T14:00:00.000Z', endsAt: null, expected: ['2026-07-28'] },
  ];

  for (const { startsAt, endsAt, expected } of cases) {
    it(`parity: ${startsAt} → ${endsAt ?? 'null'}`, () => {
      const dates = intersectedLocalDates(startsAt, endsAt);
      expect(dates).toEqual(expected);

      // Every date in intersectedLocalDates must pass intervalIntersectsLocalDay
      for (const d of dates) {
        const [y, m, day] = d.split('-').map(Number);
        const dayStart = new Date(y, m - 1, day);
        expect(intervalIntersectsLocalDay(startsAt, endsAt, dayStart)).toBe(true);
      }

      // Every day in the test range must agree
      for (let day = 28; day <= 31; day++) {
        const dayStart = new Date(2026, 6, day);
        const intersects = intervalIntersectsLocalDay(startsAt, endsAt, dayStart);
        const inDates = dates.includes(`2026-07-${String(day).padStart(2, '0')}`);
        expect(intersects).toBe(inDates);
      }
    });
  }
});
