/**
 * Shared organization-local calendar helpers.
 *
 * Overdue and report day boundaries use the authenticated organization timezone,
 * never the browser timezone. Reports, overview, and jobs reuse these helpers.
 */

export type CalendarDay = { year: number; month: number; day: number };

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatYmd(day: CalendarDay) {
  return `${day.year}-${pad2(day.month)}-${pad2(day.day)}`;
}

/** Calendar Y-M-D for an instant in the given IANA timezone. */
export function calendarDayInTimeZone(instant: Date, timeZone: string): CalendarDay {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error(`Missing ${type} for timezone ${timeZone}`);
    return Number(value);
  };
  return { year: read('year'), month: read('month'), day: read('day') };
}

/** Add whole calendar days using UTC date arithmetic on Y-M-D components. */
export function addCalendarDays(day: CalendarDay, deltaDays: number): CalendarDay {
  const utc = new Date(Date.UTC(day.year, day.month - 1, day.day + deltaDays));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

/** Yesterday in org timezone — useful for dueBefore overdue filters (due_date < today). */
export function yesterdayYmd(timeZone: string, now: Date = new Date()) {
  return formatYmd(addCalendarDays(calendarDayInTimeZone(now, timeZone), -1));
}
