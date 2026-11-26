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
 * after the period (`max(periodEnd + 2, requestDateKey)`) contract the create
 * service enforces, so the UI default/preview and the server derivation
 * cannot drift.
 */
export type WeeklyReportReference = {
  timezone: string;
  today: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
};

export interface WeeklyReportTimezoneReader {
  getOrganizationTimezone(organizationId: string): Promise<string>;
}

export async function readWeeklyReportReference(
  timezones: WeeklyReportTimezoneReader,
  organizationId: string,
  now: () => Date = () => new Date(),
): Promise<WeeklyReportReference> {
  const timezone = await timezones.getOrganizationTimezone(organizationId);
  return currentWeeklyReportPeriod(now(), timezone);
}

/**
 * Canonical server-only submission deadline for a Weekly Report: the Monday
 * after the period (`periodEnd + 2`), or `requestDateKey` when created after
 * that Monday so a late request is never born overdue. Both inputs are
 * canonical `YYYY-MM-DD` calendar date keys.
 */
export function weeklyReportDueDate(periodEnd: string, requestDateKey: string): string {
  const mondayAfterPeriod = addCalendarDaysToDateKey(periodEnd, 2);
  return requestDateKey > mondayAfterPeriod ? requestDateKey : mondayAfterPeriod;
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
    dueDate: weeklyReportDueDate(periodEnd, today),
  };
}
