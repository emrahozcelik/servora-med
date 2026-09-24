import {
  addCalendarDaysToDateKey,
  localDateKey,
  weekdayOfDateKey,
} from '../job-cards/local-calendar.js';

/**
 * Canonical current reporting period for the weekly-report create screen.
 * The browser must not derive this from device-local calendar arithmetic:
 * the organization timezone is the single authority for what "this week"
 * means. This is the same Monday → Sunday + next-Monday default-due
 * contract the create service enforces, so the UI default and the server
 * derivation cannot drift.
 */
export type WeeklyReportReference = {
  timezone: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
};

export function currentWeeklyReportPeriod(
  now: Date,
  timezone: string,
): WeeklyReportReference {
  const today = localDateKey(now, timezone);
  // weekdayOfDateKey: 0 = Sunday … 6 = Saturday, so Monday offset is 0.
  const mondayOffset = (weekdayOfDateKey(today) + 6) % 7;
  const periodStart = addCalendarDaysToDateKey(today, -mondayOffset);
  const periodEnd = addCalendarDaysToDateKey(periodStart, 6);
  return {
    timezone,
    periodStart,
    periodEnd,
    dueDate: addCalendarDaysToDateKey(periodEnd, 1),
  };
}
