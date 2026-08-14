/**
 * Organization-local calendar helpers.
 *
 * Follow-up scheduling must add whole calendar days on the organization's own
 * calendar (IANA timezone), not on raw UTC instants: `+ 7 × 24h` drifts across
 * DST boundaries and near-midnight completions (a 22:30Z completion is already
 * the next local day in Europe/Istanbul). These helpers convert between UTC
 * instants and an organization's local wall clock using only Intl, so no
 * external timezone dependency is introduced.
 */

export type LocalDateParts = { year: number; month: number; day: number };
export type LocalClockParts = { hour: number; minute: number };

const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function partOf(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

/** Local calendar date components (year/month/day) for an instant in a timezone. */
export function localDateParts(instant: Date, timezone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  return {
    year: Number(partOf(parts, 'year')),
    month: Number(partOf(parts, 'month')),
    day: Number(partOf(parts, 'day')),
  };
}

/** Canonical org-local calendar date key ('YYYY-MM-DD'). */
export function localDateKey(instant: Date, timezone: string): string {
  const { year, month, day } = localDateParts(instant, timezone);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Local wall-clock hour/minute (0-23, 0-59) for an instant in a timezone. */
export function localClockParts(instant: Date, timezone: string): LocalClockParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  return { hour: Number(partOf(parts, 'hour')), minute: Number(partOf(parts, 'minute')) };
}

function parseDateKey(key: string): LocalDateParts {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

function partsToDateKey(parts: LocalDateParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** Add a whole number of calendar days to a 'YYYY-MM-DD' key (DST-independent). */
export function addCalendarDaysToDateKey(key: string, days: number): string {
  const { year, month, day } = parseDateKey(key);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return partsToDateKey({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/** Ordinal day number (days since Unix epoch) for a 'YYYY-MM-DD' key. */
export function dateKeyToOrdinal(key: string): number {
  const { year, month, day } = parseDateKey(key);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** Offset in ms between the local wall clock and UTC for an instant (positive = ahead of UTC). */
function timezoneOffsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const asUtc = Date.UTC(
    Number(partOf(parts, 'year')),
    Number(partOf(parts, 'month')) - 1,
    Number(partOf(parts, 'day')),
    Number(partOf(parts, 'hour')),
    Number(partOf(parts, 'minute')),
    Number(partOf(parts, 'second')),
  );
  return asUtc - instant.valueOf();
}

/**
 * Reconstruct the UTC instant for a local wall-clock date+time in a timezone.
 * Iteratively resolves the offset so DST transitions are honoured. When the
 * local time is ambiguous (fall-back), the first convergent instant is used.
 */
export function instantFromLocal(
  dateKey: string,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const { year, month, day } = parseDateKey(dateKey);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let result = naive;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = timezoneOffsetMs(new Date(result), timezone);
    const next = naive - offset;
    if (next === result) break;
    result = next;
  }
  return new Date(result);
}
