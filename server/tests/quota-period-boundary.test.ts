import { describe, expect, it } from 'vitest';

import {
  dailyBucketExpiresAt,
  istanbulDateString,
  istanbulDayExclusiveEnd,
  monthlyBucketExpiresAt,
  utcMonthExclusiveEnd,
} from '../src/modules/geocoding/quota-periods.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * The daily quota bucket is deleted by `DELETE … WHERE expires_at < NOW()`, so
 * the exclusive end of the daily period must be the NEXT Europe/Istanbul
 * midnight strictly after `now` — never an instant before `now`.
 *
 * These assertions are deliberately written without absolute calendar dates so
 * the contract cannot rot when the wall clock moves past a hardcoded fixture.
 */
function expectNextIstanbulMidnight(now: Date): void {
  const day = istanbulDateString(now);
  const end = istanbulDayExclusiveEnd(now);
  const label = `now=${now.toISOString()} (Istanbul day ${day})`;

  // 1. Strictly after `now`.
  expect(end.getTime(), `${label} -> end=${end.toISOString()}`).toBeGreaterThan(now.getTime());

  // 2. It lands on the following local day, not the preceding one.
  expect(istanbulDateString(end), label).not.toBe(day);

  // 3. It is the FIRST such instant: one millisecond earlier is still `day`.
  expect(istanbulDateString(new Date(end.getTime() - 1)), label).toBe(day);

  // 4. It is a local midnight (minute-aligned and local 00:00).
  expect(end.getTime() % MINUTE_MS, label).toBe(0);
  expect(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Istanbul',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(end),
    label,
  ).toBe('00:00');
}

describe('quota period boundaries', () => {
  it('daily exclusive end is the next Istanbul midnight for every hour of a UTC day', () => {
    // Sweep a full UTC day at 30-minute resolution. Istanbul is UTC+3, so the
    // local day boundary lands mid-UTC-day; a window that starts outside the
    // target day is exactly the regression this pins.
    const base = Date.UTC(2026, 6, 21, 0, 0, 0);
    for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
      expectNextIstanbulMidnight(new Date(base + minutes * MINUTE_MS));
    }
  });

  it('daily exclusive end is the next Istanbul midnight around the local day rollover', () => {
    // 2026-07-21T20:30Z is 2026-07-21 23:30 Istanbul; +1h is 2026-07-22 00:30.
    for (const iso of ['2026-07-21T20:30:00.000Z', '2026-07-21T21:30:00.000Z']) {
      expectNextIstanbulMidnight(new Date(iso));
    }
  });

  it('daily exclusive end holds for the live wall clock', () => {
    const now = new Date();
    expectNextIstanbulMidnight(now);
    // The instant the guard actually relies on must still be in the future.
    expect(dailyBucketExpiresAt(now).getTime()).toBeGreaterThan(now.getTime());
  });

  it('daily expiry is at least 62 days after the period end', () => {
    const base = Date.UTC(2026, 6, 21, 0, 0, 0);
    for (let minutes = 0; minutes < 24 * 60; minutes += 90) {
      const now = new Date(base + minutes * MINUTE_MS);
      const end = istanbulDayExclusiveEnd(now);
      expect(dailyBucketExpiresAt(now).getTime() - end.getTime()).toBe(62 * DAY_MS);
      expect(dailyBucketExpiresAt(now).getTime()).toBeGreaterThan(end.getTime());
    }
  });

  it('monthly exclusive end is the next UTC month start', () => {
    for (const iso of [
      '2026-07-21T12:00:00.000Z',
      '2026-07-31T23:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
      '2026-12-31T23:59:59.000Z',
    ]) {
      const now = new Date(iso);
      const end = utcMonthExclusiveEnd(now);
      expect(end.getTime(), iso).toBeGreaterThan(now.getTime());
      expect(end.getUTCDate(), iso).toBe(1);
      expect(end.getUTCHours(), iso).toBe(0);
      expect(end.getUTCMinutes(), iso).toBe(0);
      expect(new Date(end.getTime() - 1).getUTCMonth(), iso).toBe(now.getUTCMonth());
    }
  });

  it('monthly expiry is at least 400 days after the period end', () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    expect(monthlyBucketExpiresAt(now).getTime() - utcMonthExclusiveEnd(now).getTime())
      .toBe(400 * DAY_MS);
  });
});
