import type { ResolvedReportRange } from './types.js';

type CalendarDate = Readonly<{ year: number; month: number; day: number }>;

function parseCalendarDate(value: string): CalendarDate {
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('Resolved report range contains an invalid calendar date.');
  }
  return { year, month, day };
}

function formatCalendarDate(value: CalendarDate) {
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}`
    + `-${String(value.day).padStart(2, '0')}`;
}

function addCalendarDays(value: string, delta: number) {
  const day = parseCalendarDate(value);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(day.year, day.month - 1, day.day + delta);
  return formatCalendarDate({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

function inclusiveCalendarDays(from: string, to: string) {
  let cursor = from;
  let days = 1;
  while (cursor !== to) {
    cursor = addCalendarDays(cursor, 1);
    days += 1;
    if (days > 366) throw new Error('Resolved report range exceeds the supported limit.');
  }
  return days;
}

export function precedingEqualLengthRange(
  range: ResolvedReportRange,
): ResolvedReportRange {
  const length = inclusiveCalendarDays(range.from, range.to);
  const to = addCalendarDays(range.from, -1);
  return {
    from: addCalendarDays(to, -(length - 1)),
    to,
    timezone: range.timezone,
  };
}

export function staffExistedDuringPriorRange(
  createdAt: string,
  priorRange: ResolvedReportRange,
) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: priorRange.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(createdAt));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  const localCreationDate = `${part('year')}-${part('month')}-${part('day')}`;
  return localCreationDate <= priorRange.to;
}
