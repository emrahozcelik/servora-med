import {
  addCalendarDays,
  calendarDayInTimeZone,
  formatYmd,
  yesterdayYmd,
} from '../shared/org-calendar';

export type { CalendarDay } from '../shared/org-calendar';
export { addCalendarDays, calendarDayInTimeZone, formatYmd, yesterdayYmd };

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

export type ReportDatePreset = 'today' | 'last7' | 'last30' | 'thisMonth';

export function resolveDatePreset(
  preset: ReportDatePreset,
  timeZone: string,
  now: Date = new Date(),
): { from: string; to: string } {
  const today = calendarDayInTimeZone(now, timeZone);
  if (preset === 'today') {
    return { from: formatYmd(today), to: formatYmd(today) };
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
