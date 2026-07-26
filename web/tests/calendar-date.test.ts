import { describe, expect, it } from 'vitest';

import {
  intersectedLocalDates,
  intervalIntersectsLocalDay,
  localDayKey,
  startOfLocalDay,
} from '../src/calendar/calendar-date';

/** Build an ISO string from local calendar components. */
function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
): string {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).toISOString();
}

/** Start of local day from calendar components. */
function localDayStart(year: number, monthIndex: number, day: number): Date {
  return new Date(year, monthIndex, day);
}

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
  it('same local day: 29 July 09:00 → 29 July 10:00 = 29 July', () => {
    const dates = intersectedLocalDates(localIso(2026, 6, 29, 9), localIso(2026, 6, 29, 10));
    expect(dates).toEqual(['2026-07-29']);
  });

  it('local midnight ending: 29 July 09:00 → 30 July 00:00 = 29 July only', () => {
    const dates = intersectedLocalDates(localIso(2026, 6, 29, 9), localIso(2026, 6, 30, 0));
    expect(dates).toEqual(['2026-07-29']);
  });

  it('full local day: 29 July 00:00 → 30 July 00:00 = 29 July only', () => {
    const dates = intersectedLocalDates(localIso(2026, 6, 29, 0), localIso(2026, 6, 30, 0));
    expect(dates).toEqual(['2026-07-29']);
  });

  it('partial final day: 29 July 12:00 → 31 July 12:00 = 29, 30, 31 July', () => {
    const dates = intersectedLocalDates(localIso(2026, 6, 29, 12), localIso(2026, 6, 31, 12));
    expect(dates).toEqual(['2026-07-29', '2026-07-30', '2026-07-31']);
  });

  it('multi-day midnight ending: 29 July 12:00 → 31 July 00:00 = 29, 30 July', () => {
    const dates = intersectedLocalDates(localIso(2026, 6, 29, 12), localIso(2026, 6, 31, 0));
    expect(dates).toEqual(['2026-07-29', '2026-07-30']);
  });

  it('point event at noon: startsAt day only', () => {
    const dates = intersectedLocalDates(localIso(2026, 6, 28, 12), null);
    expect(dates).toEqual(['2026-07-28']);
  });

  it('point event exactly at local midnight: startsAt day only', () => {
    const dates = intersectedLocalDates(localIso(2026, 6, 28, 0), null);
    expect(dates).toEqual(['2026-07-28']);
  });

  it('invalid duration (end before start) returns empty', () => {
    const dates = intersectedLocalDates(localIso(2026, 6, 29, 14), localIso(2026, 6, 29, 10));
    expect(dates).toEqual([]);
  });
});

describe('intervalIntersectsLocalDay', () => {
  it('same-day event intersects its own day', () => {
    const ds = localDayStart(2026, 6, 29);
    expect(intervalIntersectsLocalDay(localIso(2026, 6, 29, 9), localIso(2026, 6, 29, 10), ds)).toBe(true);
  });

  it('same-day event does not intersect other day', () => {
    const ds = localDayStart(2026, 6, 30);
    expect(intervalIntersectsLocalDay(localIso(2026, 6, 29, 9), localIso(2026, 6, 29, 10), ds)).toBe(false);
  });

  it('multi-day event intersects middle day', () => {
    const ds = localDayStart(2026, 6, 30);
    expect(intervalIntersectsLocalDay(localIso(2026, 6, 29, 12), localIso(2026, 6, 31, 12), ds)).toBe(true);
  });

  it('local midnight ending excluded from ending day', () => {
    const ds = localDayStart(2026, 6, 30);
    expect(intervalIntersectsLocalDay(localIso(2026, 6, 29, 9), localIso(2026, 6, 30, 0), ds)).toBe(false);
  });

  it('point event at noon intersects its own day', () => {
    const ds = localDayStart(2026, 6, 28);
    expect(intervalIntersectsLocalDay(localIso(2026, 6, 28, 12), null, ds)).toBe(true);
  });

  it('point event at noon does not intersect other day', () => {
    const ds = localDayStart(2026, 6, 29);
    expect(intervalIntersectsLocalDay(localIso(2026, 6, 28, 12), null, ds)).toBe(false);
  });

  it('point event exactly at local midnight intersects its own day', () => {
    const ds = localDayStart(2026, 6, 28);
    expect(intervalIntersectsLocalDay(localIso(2026, 6, 28, 0), null, ds)).toBe(true);
  });
});

describe('grid/agenda parity', () => {
  const cases: Array<{
    startsAt: string;
    endsAt: string | null;
  }> = [
    { startsAt: localIso(2026, 6, 29, 9), endsAt: localIso(2026, 6, 29, 10) },
    { startsAt: localIso(2026, 6, 29, 0), endsAt: localIso(2026, 6, 30, 0) },
    { startsAt: localIso(2026, 6, 29, 12), endsAt: localIso(2026, 6, 31, 12) },
    { startsAt: localIso(2026, 6, 29, 12), endsAt: localIso(2026, 6, 31, 0) },
    { startsAt: localIso(2026, 6, 28, 14), endsAt: null },
    { startsAt: localIso(2026, 6, 28, 0), endsAt: null },
    { startsAt: localIso(2026, 6, 28, 23), endsAt: localIso(2026, 6, 28, 10) },
  ];

  for (const { startsAt, endsAt } of cases) {
    it(`parity: ${startsAt} → ${endsAt ?? 'null'}`, () => {
      const dates = intersectedLocalDates(startsAt, endsAt);

      // Every date from intersectedLocalDates must pass intervalIntersectsLocalDay
      for (const d of dates) {
        const [y, m, day] = d.split('-').map(Number);
        const ds = localDayStart(y, m - 1, day);
        expect(
          intervalIntersectsLocalDay(startsAt, endsAt, ds),
          `grid date ${d} must be in agenda`,
        ).toBe(true);
      }

      // Every day in the test range must agree between grid and agenda
      for (let day = 28; day <= 31; day++) {
        const ds = localDayStart(2026, 6, day);
        const intersects = intervalIntersectsLocalDay(startsAt, endsAt, ds);
        const inDates = dates.includes(`2026-07-${String(day).padStart(2, '0')}`);
        expect(intersects, `day ${day} grid=${inDates} agenda=${intersects}`).toBe(inDates);
      }
    });
  }
});
