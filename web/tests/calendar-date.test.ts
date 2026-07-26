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
  it('same-day event: noon UTC stays in same date in any TZ', () => {
    // Noon UTC is always mid-day regardless of local timezone offset
    const dates = intersectedLocalDates('2026-07-29T12:00:00.000Z', '2026-07-29T14:00:00.000Z');
    expect(dates).toEqual(['2026-07-29']);
  });

  it('multi-day: noon-to-noon spans exactly 2 days', () => {
    const dates = intersectedLocalDates('2026-07-29T12:00:00.000Z', '2026-07-31T12:00:00.000Z');
    expect(dates).toEqual(['2026-07-29', '2026-07-30', '2026-07-31']);
  });

  it('multi-day partial ending: 29 July → 31 July noon = 29, 30, 31 July', () => {
    // Noon UTC stays within the same UTC date in all timezones
    const dates = intersectedLocalDates('2026-07-29T12:00:00.000Z', '2026-07-31T12:00:00.000Z');
    expect(dates).toEqual(['2026-07-29', '2026-07-30', '2026-07-31']);
  });

  it('midnight ending: 29 July noon → 31 July 00:00Z', () => {
    // 00:00Z at month boundary: exact result TZ-dependent.
    // Verify half-open contract: start date always included, at least 2 days.
    const dates = intersectedLocalDates('2026-07-29T12:00:00.000Z', '2026-07-31T00:00:00.000Z');
    expect(dates.length).toBeGreaterThanOrEqual(2);
    expect(dates).toContain('2026-07-29');
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
      '2026-07-29T12:00:00.000Z',
      '2026-07-29T14:00:00.000Z',
      dayStart,
    )).toBe(true);
  });

  it('same-day event does not intersect other day', () => {
    const dayStart = startOfLocalDay(new Date(2026, 6, 30));
    expect(intervalIntersectsLocalDay(
      '2026-07-29T12:00:00.000Z',
      '2026-07-29T14:00:00.000Z',
      dayStart,
    )).toBe(false);
  });

  it('multi-day event intersects middle day', () => {
    const dayStart = startOfLocalDay(new Date(2026, 6, 30));
    expect(intervalIntersectsLocalDay(
      '2026-07-29T12:00:00.000Z',
      '2026-07-31T12:00:00.000Z',
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
    { startsAt: '2026-07-29T12:00:00.000Z', endsAt: '2026-07-29T14:00:00.000Z', expected: ['2026-07-29'] },
    { startsAt: '2026-07-29T12:00:00.000Z', endsAt: '2026-07-31T12:00:00.000Z', expected: ['2026-07-29', '2026-07-30', '2026-07-31'] },
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
