/**
 * Shared Calendar date helpers.
 * Every consumer (grid, agenda) uses these for consistency.
 *
 * All operations use the browser-local calendar basis.
 * The server already enforces valid intervals;
 * these helpers fail safely for invalid inputs.
 */

/** ISO date key for a local Date (e.g. "2026-07-29"). */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Midnight start of the local day containing `date`. */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Midnight start of the next local day after `dayStart`. */
export function nextLocalDay(dayStart: Date): Date {
  const next = new Date(dayStart);
  next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Check whether an event interval intersects a local day.
 * Uses half-open semantics: event on [start, end) intersects
 * the day interval [dayStart, dayEnd).
 *
 * Point events (endsAt null) intersect only the startsAt day.
 */
export function intervalIntersectsLocalDay(
  startsAt: string,
  endsAt: string | null,
  dayStart: Date,
): boolean {
  const start = new Date(startsAt);

  if (Number.isNaN(start.valueOf())) {
    return false;
  }

  // Point event → only the startsAt local day
  if (endsAt === null) {
    return localDayKey(start) === localDayKey(dayStart);
  }

  // Duration event → half-open [start, end) intersection with [dayStart, dayEnd)
  const end = new Date(endsAt);

  if (Number.isNaN(end.valueOf()) || end <= start) {
    return false;
  }

  const normalizedDayStart = startOfLocalDay(dayStart);
  const dayEnd = nextLocalDay(normalizedDayStart);

  return start < dayEnd && end > normalizedDayStart;
}

/**
 * Collect every local date intersected by an event.
 *
 * - Point event (endsAt null) → startsAt date only
 * - Duration event → every date from startsAt's day up to (but not including) endsAt's day when endsAt falls at midnight
 * - Invalid/non-positive duration → returns empty array
 */
export function intersectedLocalDates(
  startsAt: string,
  endsAt: string | null,
): string[] {
  const start = new Date(startsAt);
  const end = endsAt ? new Date(endsAt) : start;

  // Point event
  if (!endsAt) {
    return [localDayKey(startOfLocalDay(start))];
  }

  // Invalid or non-positive duration
  if (end <= start) return [];

  const dates: string[] = [];
  const cursor = startOfLocalDay(start);

  // Half-open: cursor < end (not <=)
  while (cursor < end) {
    dates.push(localDayKey(cursor));
    const next = new Date(cursor);
    next.setDate(next.getDate() + 1);
    cursor.setTime(next.getTime());
  }

  return dates;
}
