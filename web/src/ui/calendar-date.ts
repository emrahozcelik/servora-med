const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const monthFormatter = new Intl.DateTimeFormat('tr-TR', {
  month: 'long',
  timeZone: 'UTC',
});

const dayMonthFormatter = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

const dayMonthYearFormatter = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const dayMonthWeekdayFormatter = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  weekday: 'long',
  timeZone: 'UTC',
});

const dayMonthYearWeekdayFormatter = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  weekday: 'long',
  timeZone: 'UTC',
});

type ParsedDateKey = {
  year: number;
  month: number;
  day: number;
  utcDate: Date;
};

function parseDateKey(value: string): ParsedDateKey | null {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(utcDate.getTime())
    || utcDate.getUTCFullYear() !== year
    || utcDate.getUTCMonth() !== month - 1
    || utcDate.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, utcDate };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Returns true when `value` is a valid `YYYY-MM-DD` calendar date key. */
export function isValidDateKey(value: string): boolean {
  return parseDateKey(value) !== null;
}

/** Returns true when `value` is a valid `YYYY-MM-DD` key falling on Monday (UTC calendar). */
export function isMondayDateKey(value: string): boolean {
  const parsed = parseDateKey(value);
  return parsed !== null && parsed.utcDate.getUTCDay() === 1;
}

/** Adds `days` calendar days to a `YYYY-MM-DD` key using UTC calendar arithmetic. */
export function addCalendarDays(value: string, days: number): string {
  const parsed = parseDateKey(value);
  if (!parsed) return value;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/**
 * Returns true when `[periodStart, periodEnd]` represents a Monday–Saturday
 * working week (`periodEnd = periodStart + 5`). Legacy 7-day periods (`+ 6`) return false.
 */
export function isWorkweekPeriod(periodStart: string, periodEnd: string): boolean {
  return isValidDateKey(periodStart)
    && isValidDateKey(periodEnd)
    && addCalendarDays(periodStart, 5) === periodEnd;
}

/** Formats a `YYYY-MM-DD` key in Turkish (e.g. `"23 Kasım 2026"` or `"23 Kasım"`). */
export function formatCalendarDay(
  value: string,
  options: { includeYear?: boolean } = {},
): string {
  const parsed = parseDateKey(value);
  if (!parsed) return value;
  const { includeYear = true } = options;
  return includeYear
    ? dayMonthYearFormatter.format(parsed.utcDate)
    : dayMonthFormatter.format(parsed.utcDate);
}

/** Formats a `YYYY-MM-DD` key with Turkish weekday (e.g. `"23 Kasım Pazartesi"` or `"23 Kasım 2026 Pazartesi"`). */
export function formatCalendarDayWithWeekday(
  value: string,
  options: { includeYear?: boolean } = {},
): string {
  const parsed = parseDateKey(value);
  if (!parsed) return value;
  const { includeYear = false } = options;
  return includeYear
    ? dayMonthYearWeekdayFormatter.format(parsed.utcDate)
    : dayMonthWeekdayFormatter.format(parsed.utcDate);
}

/**
 * Formats an inclusive `[startKey, endKey]` calendar range in Turkish:
 * - Same month & year: `"16–21 Kasım 2026"` (or `"16–21 Kasım"` when `includeYear: false`)
 * - Different month, same year: `"31 Ağustos – 5 Eylül 2026"` (or `"31 Ağustos – 5 Eylül"`)
 * - Different years: `"28 Aralık 2026 – 2 Ocak 2027"`
 */
export function formatCalendarRange(
  startKey: string,
  endKey: string,
  options: { includeYear?: boolean } = {},
): string {
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  if (!start || !end) return `${startKey} – ${endKey}`;
  const { includeYear = true } = options;
  if (startKey === endKey) {
    return formatCalendarDay(startKey, { includeYear });
  }
  if (start.year !== end.year) {
    return `${dayMonthYearFormatter.format(start.utcDate)} – ${dayMonthYearFormatter.format(end.utcDate)}`;
  }
  if (start.month === end.month) {
    const monthName = monthFormatter.format(start.utcDate);
    return includeYear
      ? `${start.day}–${end.day} ${monthName} ${start.year}`
      : `${start.day}–${end.day} ${monthName}`;
  }
  return `${dayMonthFormatter.format(start.utcDate)} – ${formatCalendarDay(endKey, { includeYear })}`;
}
