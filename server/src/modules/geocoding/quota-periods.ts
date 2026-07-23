/** Calendar period helpers for reverse-geocoding quota buckets. */

const ISTANBUL = 'Europe/Istanbul';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD calendar day in Europe/Istanbul for the given instant. */
export function istanbulDateString(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ISTANBUL,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** YYYY-MM-01 first day of the UTC calendar month. */
export function utcMonthStartString(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return `${year}-${pad2(month)}-01`;
}

/**
 * Instant of the next Istanbul midnight after the Istanbul calendar day that
 * contains `now` (i.e. exclusive end of the daily period).
 */
export function istanbulDayExclusiveEnd(now: Date): Date {
  const day = istanbulDateString(now);
  // Walk UTC hours until the Istanbul calendar day advances past `day`.
  // Istanbul offset is +03 without DST historically after 2016; still search
  // a bounded window so tests remain deterministic with injected clocks.
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  // Candidate around 21:00 UTC previous calendar day (00:00 Istanbul +03).
  let cursor = Date.UTC(year, month - 1, dayOfMonth, 0, 0, 0) - 12 * 60 * 60 * 1000;
  const limit = cursor + 48 * 60 * 60 * 1000;
  while (cursor < limit) {
    if (istanbulDateString(new Date(cursor)) === day) {
      cursor += 60 * 60 * 1000;
      continue;
    }
    // First hour whose Istanbul day is after `day` — step back to exact midnight.
    // Binary-search within the previous hour for the first ms of the next day.
    const hourStart = cursor - 60 * 60 * 1000;
    let lo = hourStart;
    let hi = cursor;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (istanbulDateString(new Date(mid)) === day) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return new Date(lo);
  }
  throw new Error('Unable to resolve Europe/Istanbul day boundary');
}

/** Exclusive end of the UTC calendar month containing `now`. */
export function utcMonthExclusiveEnd(now: Date): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Daily bucket expiry: at least 62 days after period end. */
export function dailyBucketExpiresAt(now: Date): Date {
  return new Date(istanbulDayExclusiveEnd(now).getTime() + 62 * DAY_MS);
}

/** Monthly bucket expiry: at least 400 days after period end. */
export function monthlyBucketExpiresAt(now: Date): Date {
  return new Date(utcMonthExclusiveEnd(now).getTime() + 400 * DAY_MS);
}

export function userDayScopeKey(organizationId: string, actorUserId: string): string {
  return `${organizationId}:${actorUserId}`;
}
