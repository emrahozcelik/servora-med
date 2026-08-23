import type { BackupRetentionClass } from './types.js';

export type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const UTC_WEEKDAY_BY_LABEL: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function createFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
}

function formatPartsWithFormatter(
  instant: Date,
  formatter: Intl.DateTimeFormat,
): LocalDateTimeParts {
  const values = Object.fromEntries(
    formatter.formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const weekday = UTC_WEEKDAY_BY_LABEL[values.weekday ?? ''];
  if (weekday === undefined) throw new Error('unsupported timezone weekday');
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday,
  };
}

function formatParts(instant: Date, timezone: string): LocalDateTimeParts {
  return formatPartsWithFormatter(instant, createFormatter(timezone));
}

export function getLocalDateParts(instant: Date, timezone: string): LocalDateTimeParts {
  if (!Number.isFinite(instant.getTime())) throw new Error('invalid instant');
  return formatParts(instant, timezone);
}

function parseLocalDateTime(localDate: string, scheduleTimeLocal: string) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(scheduleTimeLocal);
  if (!dateMatch || !timeMatch) throw new Error('invalid local schedule');
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
    || hour > 23
    || minute > 59
  ) throw new Error('invalid local schedule');
  return { year, month, day, hour, minute, date };
}

function sameLocalDate(parts: LocalDateTimeParts, year: number, month: number, day: number) {
  return parts.year === year && parts.month === month && parts.day === day;
}

function localPartsAsUtcMs(parts: LocalDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/**
 * Resolve a wall-clock slot through the runtime's IANA timezone database.
 * The search deliberately compares `Intl`-formatted local fields rather than
 * applying a fixed UTC offset. The earliest matching instant wins during a
 * fall-back repeat; when a spring-forward gap removes the requested minute,
 * the first valid later minute on that local date is selected.
 */
export function resolveLocalDateTime(
  localDate: string,
  scheduleTimeLocal: string,
  timezone: string,
): Date {
  const desired = parseLocalDateTime(localDate, scheduleTimeLocal);
  // Constructing the formatter validates the IANA zone before scanning.
  const formatter = createFormatter(timezone);
  formatPartsWithFormatter(desired.date, formatter);
  const desiredMinutes = desired.hour * 60 + desired.minute;
  // Estimate the UTC instant from the zone offset at a nearby instant, then
  // scan only a bounded DST window. The earlier implementation scanned ±36h
  // and rebuilt Intl formatters thousands of times on every scheduler tick;
  // this keeps normal resolution to a few hundred bounded comparisons.
  const nearby = formatPartsWithFormatter(desired.date, formatter);
  const offsetMs = localPartsAsUtcMs(nearby) - desired.date.getTime();
  const estimate = desired.date.getTime() - offsetMs;
  const scanStart = estimate - 3 * 60 * 60 * 1_000;
  const scanEnd = estimate + 3 * 60 * 60 * 1_000;
  for (let millis = scanStart; millis <= scanEnd; millis += 60_000) {
    const candidate = new Date(millis);
    const parts = formatPartsWithFormatter(candidate, formatter);
    if (!sameLocalDate(parts, desired.year, desired.month, desired.day)) continue;
    const candidateMinutes = parts.hour * 60 + parts.minute;
    if (candidateMinutes === desiredMinutes && parts.second === 0) return candidate;
    if (candidateMinutes > desiredMinutes) return candidate;
  }
  throw new Error('local schedule cannot be resolved on the requested date');
}

export function classifyScheduledRetention(
  instant: Date,
  timezone: string,
): BackupRetentionClass {
  const local = formatParts(instant, timezone);
  if (local.day === 1) return 'MONTHLY';
  if (local.weekday === 0) return 'WEEKLY';
  return 'DAILY';
}

export type DueScheduledSlot = {
  localDate: string;
  slotKey: string;
  scheduledFor: Date;
  retentionClass: BackupRetentionClass;
};

export type NextScheduledSlot = Pick<DueScheduledSlot, 'scheduledFor'>;

function localDateString(parts: LocalDateTimeParts): string {
  return [parts.year, String(parts.month).padStart(2, '0'), String(parts.day).padStart(2, '0')].join('-');
}

export function getDueScheduledSlot(
  now: Date,
  scheduleTimeLocal: string,
  timezone: string,
): DueScheduledSlot | null {
  const local = formatParts(now, timezone);
  const date = localDateString(local);
  const scheduledFor = resolveLocalDateTime(date, scheduleTimeLocal, timezone);
  if (now.getTime() < scheduledFor.getTime()) return null;
  return {
    localDate: date,
    slotKey: `${timezone}|${date}|${scheduleTimeLocal}`,
    scheduledFor,
    retentionClass: classifyScheduledRetention(now, timezone),
  };
}

/**
 * Resolve the next wall-clock schedule without duplicating the scheduler's
 * IANA/DST rules in a presentation client. This is a read-only projection for
 * admin surfaces; it does not claim or enqueue a run.
 */
export function getNextScheduledSlot(
  now: Date,
  scheduleTimeLocal: string,
  timezone: string,
): NextScheduledSlot {
  const local = getLocalDateParts(now, timezone);
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  for (let offset = 0; offset <= 2; offset += 1) {
    const candidateDate = new Date(localDate.getTime() + offset * 86_400_000);
    const date = [
      candidateDate.getUTCFullYear(),
      String(candidateDate.getUTCMonth() + 1).padStart(2, '0'),
      String(candidateDate.getUTCDate()).padStart(2, '0'),
    ].join('-');
    const scheduledFor = resolveLocalDateTime(date, scheduleTimeLocal, timezone);
    if (scheduledFor.getTime() > now.getTime()) return { scheduledFor };
  }
  throw new Error('next local schedule cannot be resolved');
}
