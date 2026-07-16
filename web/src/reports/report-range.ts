/** Calendar helpers for report presets in a resolved organization timezone. */

export type CalendarDay = { year: number; month: number; day: number };

function pad2(value: number) {
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

export type ReportDatePreset = 'today' | 'last7' | 'last30' | 'thisMonth';

export function resolveDatePreset(
  preset: ReportDatePreset,
  timeZone: string,
  now: Date = new Date(),
): { from: string; to: string } {
  const today = calendarDayInTimeZone(now, timeZone);
  if (preset === 'today') {
    const value = formatYmd(today);
    return { from: value, to: value };
  }
  if (preset === 'last7') {
    return { from: formatYmd(addCalendarDays(today, -6)), to: formatYmd(today) };
  }
  if (preset === 'last30') {
    return { from: formatYmd(addCalendarDays(today, -29)), to: formatYmd(today) };
  }
  // thisMonth: from 1st of current month in zone through today
  return {
    from: formatYmd({ year: today.year, month: today.month, day: 1 }),
    to: formatYmd(today),
  };
}

/** Yesterday in org timezone — useful for dueBefore overdue filters (due_date < today). */
export function yesterdayYmd(timeZone: string, now: Date = new Date()) {
  return formatYmd(addCalendarDays(calendarDayInTimeZone(now, timeZone), -1));
}

/** Clock time for "Son yenileme". Prefer org timezone when known; else browser local. */
export function formatRefreshTime(instant: Date, timeZone?: string | null) {
  return new Intl.DateTimeFormat('tr-TR', {
    ...(timeZone ? { timeZone } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}

export function formatWaitingDuration(minutes: number) {
  if (minutes < 60) return `${minutes} dakika`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (rem === 0) return `${hours} saat`;
  return `${hours} saat ${rem} dakika`;
}
