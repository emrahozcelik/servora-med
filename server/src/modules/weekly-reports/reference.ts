import {
  addCalendarDaysToDateKey,
  localDateKey,
  weekdayOfDateKey,
} from '../job-cards/local-calendar.js';

/**
 * Canonical current reporting period for the weekly-report create screen.
 * The browser must not derive this from device-local calendar arithmetic:
 * the organization timezone is the single authority for what "this week" and
 * `today` mean. This is the same Monday → Saturday working week + Monday
 * after the period (`periodEnd + 2`) contract the create service enforces, so
 * the UI default/preview (including the overdue-on-open warning) and the
 * server derivation cannot drift.
 */
export type WeeklyReportReference = {
  timezone: string;
  today: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
};

/**
 * Canonical server-only submission deadline for a Weekly Report: always the
 * Monday after the period (`periodEnd + 2`); a request created after that
 * Monday opens overdue. `periodEnd` is a canonical `YYYY-MM-DD` calendar date
 * key.
 */
export function weeklyReportDueDate(periodEnd: string): string {
  return addCalendarDaysToDateKey(periodEnd, 2);
}

export function currentWeeklyReportPeriod(
  now: Date,
  timezone: string,
): WeeklyReportReference {
  const today = localDateKey(now, timezone);
  // weekdayOfDateKey: 0 = Sunday … 6 = Saturday, so Monday offset is 0.
  const mondayOffset = (weekdayOfDateKey(today) + 6) % 7;
  const periodStart = addCalendarDaysToDateKey(today, -mondayOffset);
  const periodEnd = addCalendarDaysToDateKey(periodStart, 5);
  return {
    timezone,
    today,
    periodStart,
    periodEnd,
    dueDate: weeklyReportDueDate(periodEnd),
  };
}
