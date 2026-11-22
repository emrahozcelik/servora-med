/**
 * OVR-6: automatic lateness-notification sending window (single owner).
 *
 * Accepted contract: `DECISIONS.md` OVR-6 and
 * `docs/features/lateness-notifications-quiet-hours.md` §3.
 *
 * The window is a **due-gate**, never a lateness clock: it decides only
 * *whether an already-due automatic lateness alert may be sent at this
 * instant*. Incidents, deadlines, `breached_at`, thresholds and reports are
 * never moved by it. Outside the window a due notification waits; the first
 * tick inside the next window sends it if it is still due and eligible.
 *
 * Rule: Monday–Saturday, `08:00 ≤ local time < 21:00` (end exclusive) in the
 * organization's own timezone. Sunday is closed all day. The zone rules
 * (including DST) come from `Intl` on the TypeScript side and from PostgreSQL
 * `AT TIME ZONE` on the SQL side, so both always resolve the same wall clock.
 *
 * Weekday mapping is explicit and deliberately not shared with the follow-up
 * slot window: `local-calendar.ts` uses 0 = Sunday, SQL `ISODOW` uses
 * 7 = Sunday. `FOLLOW_UP_AUTO_WINDOW_*` is a different policy (inclusive end,
 * different hours) and is never reused here.
 *
 * Clock discipline: the caller supplies the instant. Nothing in this module
 * reads `new Date()` / `Date.now()` / `NOW()`.
 */

import {
  isSundayDateKey,
  localClockParts,
  localDateKey,
} from '../job-cards/local-calendar.js';

/** Local minute-of-day at which sending starts (08:00 local). */
export const NOTIFICATION_WINDOW_START_MINUTE = 8 * 60;
/** Local minute-of-day at which sending stops (21:00 local, exclusive). */
export const NOTIFICATION_WINDOW_END_MINUTE = 21 * 60;
/** Sunday expressed as SQL `ISODOW` (1 = Monday … 7 = Sunday). */
export const NOTIFICATION_CLOSED_ISO_WEEKDAY = 7;

/**
 * Injected sending-window policy. Both workers (OVR-4 reminder and OVR-6
 * lateness alerts) take one; production always gets
 * {@link DEFAULT_NOTIFICATION_WINDOW} unless a caller explicitly overrides it.
 */
export type NotificationWindowPolicy = {
  /** Whether an automatic lateness notification may be sent at `instant`. */
  isOpen(instant: Date, timezone: string): boolean;
  /**
   * The same rule as a SQL boolean expression. `refs.instant` is a SQL
   * expression producing a `timestamptz`, `refs.timezone` one producing the
   * organization timezone text. Both are caller-owned SQL fragments, never
   * user input.
   */
  sql(refs: { instant: string; timezone: string }): string;
};

/** The real rule: Monday–Saturday, 08:00 ≤ local time < 21:00. */
export const DEFAULT_NOTIFICATION_WINDOW: NotificationWindowPolicy = {
  isOpen(instant: Date, timezone: string): boolean {
    const dateKey = localDateKey(instant, timezone);
    if (isSundayDateKey(dateKey)) return false;
    const { hour, minute } = localClockParts(instant, timezone);
    const minuteOfDay = hour * 60 + minute;
    return minuteOfDay >= NOTIFICATION_WINDOW_START_MINUTE
      && minuteOfDay < NOTIFICATION_WINDOW_END_MINUTE;
  },

  sql({ instant, timezone }: { instant: string; timezone: string }): string {
    // `timestamptz AT TIME ZONE <zone>` yields that zone's wall clock as a
    // `timestamp` without time zone, so ISODOW/HOUR/MINUTE read local parts
    // and PostgreSQL applies the DST rules of the same zone `Intl` uses.
    const local = `((${instant}) AT TIME ZONE (${timezone}))`;
    const minuteOfDay = `(EXTRACT(HOUR FROM ${local}) * 60 + EXTRACT(MINUTE FROM ${local}))`;
    return `(EXTRACT(ISODOW FROM ${local}) <> ${NOTIFICATION_CLOSED_ISO_WEEKDAY}`
      + ` AND ${minuteOfDay} >= ${NOTIFICATION_WINDOW_START_MINUTE}`
      + ` AND ${minuteOfDay} < ${NOTIFICATION_WINDOW_END_MINUTE})`;
  },
};

/**
 * Test-only policy: the window is always open. Existing OVR-4 / OVR-5
 * reminder suites scan at 00:15 / 01:00 local and therefore inject this to keep
 * their own intent (thresholds, identity, recipients) under test.
 */
export const ALWAYS_OPEN_NOTIFICATION_WINDOW: NotificationWindowPolicy = {
  isOpen(): boolean {
    return true;
  },
  sql(): string {
    return 'TRUE';
  },
};

/** Whether an automatic lateness notification may be sent at `instant`. */
export function isWithinNotificationWindow(instant: Date, timezone: string): boolean {
  return DEFAULT_NOTIFICATION_WINDOW.isOpen(instant, timezone);
}
