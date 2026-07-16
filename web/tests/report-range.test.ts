import { describe, expect, it } from 'vitest';

import {
  addCalendarDays,
  calendarDayInTimeZone,
  formatYmd,
  resolveDatePreset,
  yesterdayYmd,
} from '../src/reports/report-range';

describe('report-range timezone presets', () => {
  it('resolves calendar day in Europe/Istanbul across UTC midnight', () => {
    // 2026-07-15 22:30 UTC = 2026-07-16 01:30 in Istanbul (UTC+3)
    const instant = new Date('2026-07-15T22:30:00.000Z');
    expect(formatYmd(calendarDayInTimeZone(instant, 'Europe/Istanbul'))).toBe('2026-07-16');
    expect(formatYmd(calendarDayInTimeZone(instant, 'UTC'))).toBe('2026-07-15');
  });

  it('builds inclusive last-7 and this-month presets in org timezone', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    expect(resolveDatePreset('today', 'Europe/Istanbul', now)).toEqual({
      from: '2026-07-15', to: '2026-07-15',
    });
    expect(resolveDatePreset('last7', 'Europe/Istanbul', now)).toEqual({
      from: '2026-07-09', to: '2026-07-15',
    });
    expect(resolveDatePreset('last30', 'Europe/Istanbul', now)).toEqual({
      from: '2026-06-16', to: '2026-07-15',
    });
    expect(resolveDatePreset('thisMonth', 'Europe/Istanbul', now)).toEqual({
      from: '2026-07-01', to: '2026-07-15',
    });
  });

  it('computes yesterday for overdue dueBefore links', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    expect(yesterdayYmd('Europe/Istanbul', now)).toBe('2026-07-14');
  });

  it('adds calendar days across month boundaries', () => {
    expect(formatYmd(addCalendarDays({ year: 2026, month: 7, day: 1 }, -1))).toBe('2026-06-30');
  });
});
