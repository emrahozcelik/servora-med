import {
  addCalendarDaysToDateKey,
  localDateKey,
  weekdayOfDateKey,
} from '../job-cards/local-calendar.js';

/**
 * Canonical current reporting period for the weekly-report create screen.
 * The browser must not derive this from device-local calendar arithmetic:
 * the organization timezone is the single authority for what "this week"
 * means. This is the same Monday → Friday workweek + Friday due-date
 * (`max(periodEnd, requestDateKey)`) contract the create service enforces, so
 * the UI default and the server derivation cannot drift.
 */
export type WeeklyReportReference = {
  timezone: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
};

/**
 * Canonical server-only submission deadline for a Weekly Report: Friday of
 * the period (`periodEnd`), or `requestDateKey` when created after that Friday
 * so a late request is never born overdue. Both inputs are canonical
 * `YYYY-MM-DD` calendar date keys.
 */
export function weeklyReportDueDate(periodEnd: string, requestDateKey: string): string {
  return requestDateKey > periodEnd ? requestDateKey : periodEnd;
}

export function currentWeeklyReportPeriod(
  now: Date,
  timezone: string,
): WeeklyReportReference {
  const today = localDateKey(now, timezone);
  // weekdayOfDateKey: 0 = Sunday … 6 = Saturday, so Monday offset is 0.
  const mondayOffset = (weekdayOfDateKey(today) + 6) % 7;
  const periodStart = addCalendarDaysToDateKey(today, -mondayOffset);
  const periodEnd = addCalendarDaysToDateKey(periodStart, 4);
  return {
    timezone,
    periodStart,
    periodEnd,
    dueDate: weeklyReportDueDate(periodEnd, today),
  };
}
