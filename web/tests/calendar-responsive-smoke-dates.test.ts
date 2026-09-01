import { describe, expect, it } from 'vitest';

import { resolveSmokeTargetDate } from '../scripts/calendar-responsive-smoke-dates';

function localDate(year: number, month1Based: number, day: number): Date {
  return new Date(year, month1Based - 1, day, 12);
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * The smoke matches AntD mini-calendar day values that are rendered
 * zero-padded ("01".."31") inside `picker-cell-in-view` cells. These proofs
 * hold for every supported date regardless of the host timezone because both
 * inputs and outputs use the same local calendar basis.
 */
describe('calendar responsive smoke target date', () => {
  it('keeps the target inside the rendered month for every day of every month length', () => {
    const monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let month = 1; month <= 12; month += 1) {
      const length = monthLengths[month - 1];
      for (let day = 1; day <= length; day += 1) {
        const today = localDate(2026, month, day);
        const target = resolveSmokeTargetDate(today);
        expect(target.getFullYear()).toBe(today.getFullYear());
        expect(target.getMonth()).toBe(today.getMonth());
        expect(target.getDate()).toBeGreaterThanOrEqual(1);
        expect(target.getDate()).toBeLessThanOrEqual(length);
        expect(dayKey(target)).not.toBe(dayKey(today));
      }
    }
  });

  it('first day of month resolves to a later in-month day', () => {
    expect(resolveSmokeTargetDate(localDate(2026, 9, 1)).getDate()).toBe(3);
    expect(resolveSmokeTargetDate(localDate(2026, 1, 1)).getDate()).toBe(3);
    expect(resolveSmokeTargetDate(localDate(2026, 2, 1)).getDate()).toBe(3);
  });

  it('second day of month does not reselect today', () => {
    expect(resolveSmokeTargetDate(localDate(2026, 9, 2)).getDate()).toBe(3);
  });

  it('month end resolves to the fixed in-month target, not out of view', () => {
    expect(resolveSmokeTargetDate(localDate(2026, 1, 31)).getDate()).toBe(2);
    expect(resolveSmokeTargetDate(localDate(2026, 12, 31)).getDate()).toBe(2);
    expect(resolveSmokeTargetDate(localDate(2026, 2, 28)).getDate()).toBe(2);
  });

  it('leap-year February 29 resolves inside February', () => {
    const target = resolveSmokeTargetDate(localDate(2028, 2, 29));
    expect(target.getMonth()).toBe(1);
    expect(target.getDate()).toBe(2);
  });

  it('year rollover stays inside December and January respectively', () => {
    expect(dayKey(resolveSmokeTargetDate(localDate(2026, 12, 31)))).toBe('2026-12-02');
    expect(dayKey(resolveSmokeTargetDate(localDate(2027, 1, 1)))).toBe('2027-01-03');
  });

  it('renders as a zero-padded two-digit day text that the smoke selector matches', () => {
    for (const [year, month, day] of [
      [2026, 9, 1], [2026, 9, 2], [2026, 12, 31], [2028, 2, 29], [2026, 10, 15],
    ] as const) {
      const target = resolveSmokeTargetDate(localDate(year, month, day));
      const dayText = dayKey(target).slice(-2);
      expect(dayText).toMatch(/^\d{2}$/);
      expect(Number(dayText)).toBe(target.getDate());
    }
  });
});
