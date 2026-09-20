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
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  const step = 60 * 60 * 1000;

  // Istanbul is UTC+03, so a local day straddles two UTC dates. Search a window
  // that is wide enough to contain the whole local day for any offset within
  // ±24h, and — critically — START BEFORE the target local day. A cursor that
  // begins outside the day cannot distinguish "the day has not started yet"
  // from "the day is over", which resolved the boundary one local day early.
  let cursor = Date.UTC(year, month - 1, dayOfMonth, 0, 0, 0) - 24 * step;
  const limit = cursor + 96 * step;

  // Phase 1: advance until the cursor is inside the target local day.
  while (cursor < limit && istanbulDateString(new Date(cursor)) !== day) {
    cursor += step;
  }
  // Phase 2: advance until it leaves the day.
  while (cursor < limit && istanbulDateString(new Date(cursor)) === day) {
    cursor += step;
  }
  if (cursor >= limit) {
    throw new Error('Unable to resolve Europe/Istanbul day boundary');
  }

  // The boundary lies in the hour ending at `cursor`. Binary-search that hour
  // for the first millisecond whose Istanbul calendar day is no longer `day`.
  let lo = cursor - step;
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
