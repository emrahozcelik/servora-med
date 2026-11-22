import { describe, expect, it } from 'vitest';

import {
  ALWAYS_OPEN_NOTIFICATION_WINDOW,
  DEFAULT_NOTIFICATION_WINDOW,
  isWithinNotificationWindow,
  NOTIFICATION_CLOSED_ISO_WEEKDAY,
  NOTIFICATION_WINDOW_END_MINUTE,
  NOTIFICATION_WINDOW_START_MINUTE,
} from '../src/modules/notifications/quiet-hours.js';
import {
  instantFromLocal,
  weekdayOfDateKey,
} from '../src/modules/job-cards/local-calendar.js';

const ISTANBUL = 'Europe/Istanbul';
const BERLIN = 'Europe/Berlin';

/** Local wall clock → UTC instant, so every case is stated in local time. */
function local(
  dateKey: string,
  hour: number,
  minute: number,
  timezone: string,
  second = 0,
): Date {
  return instantFromLocal(dateKey, hour, minute, timezone, second);
}

// 2026-11-22 is a Sunday, 2026-11-23 the following Monday, 2026-11-28 a
// Saturday. Asserted below so a mistyped date can never silently test the
// wrong branch.
const SUNDAY = '2026-11-22';
const MONDAY = '2026-11-23';
const SATURDAY = '2026-11-28';

describe('OVR-6 notification window constants', () => {
  it('is 08:00 local (inclusive) to 21:00 local (exclusive), Sunday closed', () => {
    expect(NOTIFICATION_WINDOW_START_MINUTE).toBe(8 * 60);
    expect(NOTIFICATION_WINDOW_END_MINUTE).toBe(21 * 60);
    // SQL ISODOW, not local-calendar's 0 = Sunday.
    expect(NOTIFICATION_CLOSED_ISO_WEEKDAY).toBe(7);
  });
});

describe('DEFAULT_NOTIFICATION_WINDOW boundaries', () => {
  it('uses the expected weekday dates', () => {
    expect(weekdayOfDateKey(SUNDAY)).toBe(0);
    expect(weekdayOfDateKey(MONDAY)).toBe(1);
    expect(weekdayOfDateKey(SATURDAY)).toBe(6);
  });

  it('Europe/Istanbul: 07:59 closed, 08:00 open, 20:59 open, 21:00 closed', () => {
    expect(isWithinNotificationWindow(local(MONDAY, 7, 59, ISTANBUL), ISTANBUL)).toBe(false);
    expect(isWithinNotificationWindow(local(MONDAY, 8, 0, ISTANBUL), ISTANBUL)).toBe(true);
    expect(isWithinNotificationWindow(local(MONDAY, 20, 59, ISTANBUL), ISTANBUL)).toBe(true);
    expect(isWithinNotificationWindow(local(MONDAY, 21, 0, ISTANBUL), ISTANBUL)).toBe(false);
    // The window is not open at all in the closed night hours.
    expect(isWithinNotificationWindow(local(MONDAY, 0, 15, ISTANBUL), ISTANBUL)).toBe(false);
    expect(isWithinNotificationWindow(local(MONDAY, 1, 0, ISTANBUL), ISTANBUL)).toBe(false);
  });

  it('Sunday is closed all day and Monday 08:00 reopens', () => {
    expect(isWithinNotificationWindow(local(SUNDAY, 8, 0, ISTANBUL), ISTANBUL)).toBe(false);
    expect(isWithinNotificationWindow(local(SUNDAY, 12, 0, ISTANBUL), ISTANBUL)).toBe(false);
    expect(isWithinNotificationWindow(local(SUNDAY, 20, 59, ISTANBUL), ISTANBUL)).toBe(false);
    expect(isWithinNotificationWindow(local(MONDAY, 8, 0, ISTANBUL), ISTANBUL)).toBe(true);
  });

  it('Saturday is open; the Saturday 21:00 item waits for Monday 08:00', () => {
    expect(isWithinNotificationWindow(local(SATURDAY, 12, 0, ISTANBUL), ISTANBUL)).toBe(true);
    expect(isWithinNotificationWindow(local(SATURDAY, 21, 0, ISTANBUL), ISTANBUL)).toBe(false);
    expect(isWithinNotificationWindow(local('2026-11-29', 20, 59, ISTANBUL), ISTANBUL)).toBe(false);
  });

  it('keeps the local boundaries across the spring-forward DST date', () => {
    // Europe/Berlin springs forward on 2026-03-29 (02:00 → 03:00) and falls
    // back on 2026-10-25. The wall-clock window never moves.
    expect(weekdayOfDateKey('2026-03-29')).toBe(0);
    expect(weekdayOfDateKey('2026-03-30')).toBe(1);
    expect(weekdayOfDateKey('2026-10-26')).toBe(1);
    for (const dateKey of ['2026-03-30', '2026-10-26']) {
      expect(isWithinNotificationWindow(local(dateKey, 7, 59, BERLIN), BERLIN)).toBe(false);
      expect(isWithinNotificationWindow(local(dateKey, 8, 0, BERLIN), BERLIN)).toBe(true);
      expect(isWithinNotificationWindow(local(dateKey, 20, 59, BERLIN), BERLIN)).toBe(true);
      expect(isWithinNotificationWindow(local(dateKey, 21, 0, BERLIN), BERLIN)).toBe(false);
    }
  });

  it('isWithinNotificationWindow is the default policy', () => {
    const instant = local(MONDAY, 9, 30, ISTANBUL);
    expect(isWithinNotificationWindow(instant, ISTANBUL))
      .toBe(DEFAULT_NOTIFICATION_WINDOW.isOpen(instant, ISTANBUL));
  });
});

describe('notification window SQL renderer', () => {
  it('renders the same rule as the TypeScript predicate', () => {
    const expression = DEFAULT_NOTIFICATION_WINDOW.sql({
      instant: '$2::timestamptz',
      timezone: 'org.timezone',
    });
    expect(expression).toContain('AT TIME ZONE (org.timezone)');
    expect(expression).toContain(`ISODOW FROM`);
    expect(expression).toContain(`<> ${NOTIFICATION_CLOSED_ISO_WEEKDAY}`);
    expect(expression).toContain(`>= ${NOTIFICATION_WINDOW_START_MINUTE}`);
    expect(expression).toContain(`< ${NOTIFICATION_WINDOW_END_MINUTE}`);
    expect(expression).toMatch(/^\(/);
    expect(expression).toMatch(/\)$/);
    // The caller owns the fragments; nothing is interpolated from user input.
    expect(expression).toContain('$2::timestamptz');
  });

  it('always-open policy renders TRUE and opens every instant', () => {
    expect(ALWAYS_OPEN_NOTIFICATION_WINDOW.sql({ instant: '$1', timezone: '$2' })).toBe('TRUE');
    expect(ALWAYS_OPEN_NOTIFICATION_WINDOW.isOpen(
      local(SUNDAY, 3, 0, ISTANBUL), ISTANBUL,
    )).toBe(true);
  });
});
