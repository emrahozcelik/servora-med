import { describe, expect, it } from 'vitest';

import { instantFromLocal, weekdayOfDateKey } from '../src/modules/job-cards/local-calendar.js';
import {
  ALWAYS_OPEN_NOTIFICATION_WINDOW,
  DEFAULT_NOTIFICATION_WINDOW,
  NOTIFICATION_CLOSED_ISO_WEEKDAY,
  NOTIFICATION_WINDOW_END_MINUTE,
  NOTIFICATION_WINDOW_START_MINUTE,
  isWithinNotificationWindow,
} from '../src/modules/notifications/quiet-hours.js';

/**
 * OVR-6 Q1 — the quiet-hours predicate (pure, no database).
 *
 * Contract §3 and §10 Q1: automatic lateness notifications are sent only
 * Monday–Saturday, `08:00 ≤ local time < 21:00` (end exclusive), Sunday closed
 * all day. The predicate must read the organization-local wall clock (DST is
 * the timezone's job, never the host's) and `local-calendar.ts` maps Sunday to
 * weekday 0 while SQL `ISODOW` maps it to 7.
 *
 * `notification-quiet-hours-postgres.test.ts` proves the SQL renderer agrees
 * with this predicate on the same instants.
 */

const TZ = 'Europe/Istanbul';

function local(dateKey: string, hour: number, minute = 0, second = 0, tz = TZ): Date {
  return instantFromLocal(dateKey, hour, minute, tz, second);
}

function isOpen(dateKey: string, hour: number, minute = 0, second = 0, tz = TZ): boolean {
  return isWithinNotificationWindow(local(dateKey, hour, minute, second, tz), tz);
}

describe('OVR-6 quiet hours predicate', () => {
  it('Q1 owns the single window vocabulary and the Sunday weekday mapping', () => {
    expect(NOTIFICATION_WINDOW_START_MINUTE).toBe(8 * 60);
    expect(NOTIFICATION_WINDOW_END_MINUTE).toBe(21 * 60);
    // local-calendar.ts uses 0 = Sunday; SQL ISODOW uses 7 = Sunday.
    expect(NOTIFICATION_CLOSED_ISO_WEEKDAY).toBe(7);
    expect(weekdayOfDateKey('2026-11-22')).toBe(0); // Sunday
    expect(weekdayOfDateKey('2026-11-23')).toBe(1); // Monday
  });

  it('Q1 keeps the exact Europe/Istanbul boundaries and the exclusive end', () => {
    const monday = '2026-11-23';
    expect(isOpen(monday, 7, 59)).toBe(false);
    expect(isOpen(monday, 7, 59, 59)).toBe(false);
    expect(isOpen(monday, 8, 0)).toBe(true);
    expect(isOpen(monday, 20, 59, 59)).toBe(true);
    expect(isOpen(monday, 21, 0)).toBe(false);
    expect(isOpen(monday, 21, 0, 1)).toBe(false);
  });

  it('Q1 closes Sunday all day and keeps Monday/Saturday ownership', () => {
    const sunday = '2026-11-22';
    for (const hour of [0, 7, 8, 12, 20, 21, 23]) {
      expect(isOpen(sunday, hour)).toBe(false);
    }
    expect(isOpen('2026-11-23', 8)).toBe(true); // Monday 08:00 open
    expect(isOpen('2026-11-21', 20, 59, 59)).toBe(true); // Saturday 20:59 open
    expect(isOpen('2026-11-21', 21, 0)).toBe(false); // Saturday 21:00 closed
    expect(isOpen('2026-11-23', 8)).toBe(true); // Monday 08:00 after the closed Sunday
  });

  it('Q1 keeps local boundaries across DST transitions', () => {
    // Europe/Berlin observes DST; both transitions keep the wall-clock window.
    for (const dateKey of ['2026-03-29', '2026-10-25']) {
      expect(isOpen(dateKey, 7, 59, 59, 'Europe/Berlin')).toBe(false);
      expect(isOpen(dateKey, 8, 0, 0, 'Europe/Berlin')).toBe(true);
      expect(isOpen(dateKey, 20, 59, 59, 'Europe/Berlin')).toBe(true);
      expect(isOpen(dateKey, 21, 0, 0, 'Europe/Berlin')).toBe(false);
    }
    // The same UTC instant can be open in one organization and closed in
    // another: 2026-11-23T18:00Z is 19:00 Berlin and 21:00 Istanbul.
    const instant = new Date('2026-11-23T18:00:00.000Z');
    expect(DEFAULT_NOTIFICATION_WINDOW.isOpen(instant, 'Europe/Berlin')).toBe(true);
    expect(DEFAULT_NOTIFICATION_WINDOW.isOpen(instant, 'Europe/Istanbul')).toBe(false);
  });

  it('Q1 exports the real rule as the default and a test-only always-open policy', () => {
    const sundayNoon = local('2026-11-22', 12);
    expect(DEFAULT_NOTIFICATION_WINDOW.isOpen(sundayNoon, TZ)).toBe(false);
    expect(isWithinNotificationWindow(sundayNoon, TZ)).toBe(false);
    expect(ALWAYS_OPEN_NOTIFICATION_WINDOW.isOpen(sundayNoon, TZ)).toBe(true);
    expect(ALWAYS_OPEN_NOTIFICATION_WINDOW.sql({
      instant: '$1::timestamptz',
      timezone: '$2::text',
    })).toBe('TRUE');
    expect(DEFAULT_NOTIFICATION_WINDOW.sql({
      instant: '$1::timestamptz',
      timezone: '$2::text',
    })).toContain('$1::timestamptz');
    expect(DEFAULT_NOTIFICATION_WINDOW.sql({
      instant: '$1::timestamptz',
      timezone: '$2::text',
    })).toContain('$2::text');
  });

  it('Q1 agrees between isWithinNotificationWindow and the default policy', () => {
    const instants = [
      local('2026-11-21', 7, 59),
      local('2026-11-21', 8, 0),
      local('2026-11-22', 8, 0),
      local('2026-11-23', 20, 59),
      local('2026-11-23', 21, 0),
      local('2026-03-29', 8, 0, 0, 'Europe/Berlin'),
      local('2026-10-25', 21, 0, 0, 'Europe/Berlin'),
    ];
    for (const instant of instants) {
      for (const timezone of [TZ, 'Europe/Berlin']) {
        expect(isWithinNotificationWindow(instant, timezone))
          .toBe(DEFAULT_NOTIFICATION_WINDOW.isOpen(instant, timezone));
      }
    }
  });
});
