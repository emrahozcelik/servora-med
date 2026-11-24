/**
 * Shared device-local scheduling helpers for JobCard create forms.
 * Uses local getters/setters — never derive datetime-local values from toISOString().
 */

import { plannedIntervalShape } from './job-schedule-integrity';
import type { JobCardType } from './jobs-api';

export const CANONICAL_DURATION_MINUTES: Readonly<Partial<Record<JobCardType, number>>> = {
  SALES_MEETING: 60,
  PRODUCT_DELIVERY: 30,
};

const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Format a Date as device-local `YYYY-MM-DDTHH:mm` for datetime-local inputs. */
function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Convert a UTC ISO instant to device-local `YYYY-MM-DDTHH:mm` for datetime-local inputs. */
export function isoInstantToLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO instant: ${value}`);
  }
  return formatLocalDateTime(date);
}

/** Format the current device-local time for a convenience-only execution input default. */
export function defaultDeliveredAtLocalValue(now = new Date()): string {
  return formatLocalDateTime(now);
}

/**
 * OVR-5: default correction deadline for a revision request: now + 24 hours,
 * device-local, matching the server's materialized default.
 */
export function defaultCorrectionDueLocalValue(now = new Date()): string {
  return formatLocalDateTime(new Date(now.getTime() + 24 * 60 * 60 * 1000));
}

/**
 * Default planned time: now + 1 hour, rounded up to the next 30-minute boundary.
 * Exact 30-minute boundaries (with zero seconds/ms after +1h) are kept.
 */
export function defaultScheduledLocalValue(now: Date): string {
  const target = new Date(now.getTime() + 60 * 60 * 1000);
  let year = target.getFullYear();
  let month = target.getMonth();
  let day = target.getDate();
  let hours = target.getHours();
  let minutes = target.getMinutes();
  const seconds = target.getSeconds();
  const milliseconds = target.getMilliseconds();

  if (seconds > 0 || milliseconds > 0) {
    minutes += 1;
  }

  if (minutes % 30 !== 0) {
    minutes = Math.ceil(minutes / 30) * 30;
  }

  if (minutes >= 60) {
    hours += Math.floor(minutes / 60);
    minutes %= 60;
  }

  // Let the Date constructor handle hour/day/month/year rollover in local time.
  const rounded = new Date(year, month, day, hours, minutes, 0, 0);
  return formatLocalDateTime(rounded);
}

/**
 * Convert a device-local `YYYY-MM-DDTHH:mm` (or with seconds) value to a UTC ISO instant.
 */
export function localDateTimeToIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid local datetime value: ${value}`);
  }
  const local = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    match[6] ? Number(match[6]) : 0,
    0,
  );
  if (Number.isNaN(local.getTime())) {
    throw new Error(`Invalid local datetime value: ${value}`);
  }
  return local.toISOString();
}

/** Device-local `YYYY-MM-DDTHH:mm` plus a local calendar duration. */
export function addMinutesLocal(value: string, minutes: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]),
  );
  date.setMinutes(date.getMinutes() + minutes);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Shift a device-local interval so that it starts at `newStartLocal`,
 * preserving the original duration exactly. Used by the "use suggested
 * alternative" CTA so the whole interval moves, never just the start.
 */
export function shiftInterval(
  startLocal: string,
  endLocal: string,
  newStartLocal: string,
): [string, string] {
  const parse = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match) throw new Error(`Invalid local datetime value: ${value}`);
    return new Date(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]),
    );
  };
  const delta = parse(newStartLocal).getTime() - parse(startLocal).getTime();
  const shiftedEnd = new Date(parse(endLocal).getTime() + delta);
  const pad = (part: number) => String(part).padStart(2, '0');
  const format = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return [newStartLocal, format(shiftedEnd)];
}

function parseLocalDateTime(value: string): Date | null {
  const match = LOCAL_DATETIME_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = match[6] ? Number(match[6]) : 0;
  const date = new Date(year, monthIndex, day, hours, minutes, seconds, 0);
  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== monthIndex
    || date.getDate() !== day
    || date.getHours() !== hours
    || date.getMinutes() !== minutes
  ) {
    return null;
  }
  return date;
}

/** Format a live canonical planned interval preview as `HH:mm – HH:mm (N dk)`. */
export function formatPlannedDurationPreview(
  localStart: string,
  durationMinutes: number,
): string | null {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  const parsed = parseLocalDateTime(localStart);
  if (!parsed) return null;
  const canonicalStart = formatLocalDateTime(parsed);
  const endLocal = addMinutesLocal(canonicalStart, durationMinutes);
  return `${canonicalStart.slice(11, 16)} – ${endLocal.slice(11, 16)} (${durationMinutes} dk)`;
}

/** True when a device-local datetime string falls on a local Sunday. */
export function isLocalSunday(localValue: string): boolean {
  const date = parseLocalDateTime(localValue);
  return date !== null && date.getDay() === 0;
}

/** True when a device-local datetime string is strictly before `now`. */
export function isLocalPast(localValue: string, now = new Date()): boolean {
  const date = parseLocalDateTime(localValue);
  return date !== null && date.getTime() < now.getTime();
}

/** Sunday-skipping quick schedule presets for create/follow-up forms. */
export function buildQuickSchedulePresets(
  now = new Date(),
): Array<{ label: string; value: string }> {
  const presets: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  const push = (label: string, value: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    presets.push({ label, value });
  };

  if (now.getDay() !== 0) {
    const plusOne = defaultScheduledLocalValue(now);
    if (!isLocalSunday(plusOne)) {
      push('Bugün +1s', plusOne);
    }
  }

  const nextWorkday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  let nextWorkdayPrefix = 'Yarın';
  if (nextWorkday.getDay() === 0) {
    nextWorkday.setDate(nextWorkday.getDate() + 1);
    nextWorkdayPrefix = 'Pazartesi';
  }
  push(
    `${nextWorkdayPrefix} 10:00`,
    formatLocalDateTime(new Date(
      nextWorkday.getFullYear(), nextWorkday.getMonth(), nextWorkday.getDate(), 10, 0, 0, 0,
    )),
  );
  push(
    `${nextWorkdayPrefix} 14:00`,
    formatLocalDateTime(new Date(
      nextWorkday.getFullYear(), nextWorkday.getMonth(), nextWorkday.getDate(), 14, 0, 0, 0,
    )),
  );

  const daysUntilNextMonday = ((1 - now.getDay() + 7) % 7) || 7;
  const nextMonday = new Date(
    now.getFullYear(), now.getMonth(), now.getDate() + daysUntilNextMonday, 9, 0, 0, 0,
  );
  push('Pazartesi 09:00', formatLocalDateTime(nextMonday));

  return presets;
}

export type CardScheduleFact = {
  label: string;
  text: string;
  dateTime: string | null;
  /**
   * Advisory R3 planning signal for SM/PD intervals.
   * 'ok' covers valid intervals (any duration), GT open-ended rows,
   * and every pre-existing presentation case.
   */
  signal: 'ok' | 'missing' | 'incomplete';
};

function formatCardDate(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(value));
}

function formatCardDateTime(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function sameLocalCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function formatLocalTime(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

/**
 * List/board schedule presentation: prefer scheduledAt, fall back to dueDate.
 * Same local calendar day → "Bugün HH:mm" for delivery/task (not sales meeting).
 * Labels stay scheduling facts — never lifecycle status language.
 */
export function cardScheduleFact(job: {
  type: JobCardType;
  scheduledAt: string | null;
  scheduledEndsAt?: string | null;
  dueDate: string | null;
}, now: Date = new Date()): CardScheduleFact {
  const shape = plannedIntervalShape({
    type: job.type,
    scheduledAt: job.scheduledAt,
    scheduledEndsAt: job.scheduledEndsAt ?? null,
  });
  const signal = shape === 'MISSING' ? 'missing'
    : shape === 'INCOMPLETE' ? 'incomplete'
      : 'ok';
  const fact = (label: string, text: string, dateTime: string | null): CardScheduleFact => ({
    label, text, dateTime, signal,
  });
  if (job.scheduledAt) {
    const scheduled = new Date(job.scheduledAt);
    const endsAt = job.scheduledEndsAt ? new Date(job.scheduledEndsAt) : null;
    const endSuffix = endsAt !== null
      && !Number.isNaN(scheduled.getTime())
      && !Number.isNaN(endsAt.getTime())
      && endsAt.getTime() > scheduled.getTime()
      && sameLocalCalendarDay(scheduled, endsAt)
      ? `–${formatLocalTime(job.scheduledEndsAt!)}`
      : '';
    if (job.type !== 'SALES_MEETING' && !Number.isNaN(scheduled.getTime())
      && sameLocalCalendarDay(scheduled, now)) {
      return fact('Bugün', `${formatLocalTime(job.scheduledAt)}${endSuffix}`, job.scheduledAt);
    }
    const label = job.type === 'SALES_MEETING'
      ? 'Planlanan görüşme'
      : job.type === 'PRODUCT_DELIVERY'
        ? 'Planlanan teslim'
        : 'Planlanan zaman';
    return fact(label, `${formatCardDateTime(job.scheduledAt)}${endSuffix}`, job.scheduledAt);
  }
  // Historical fallback only — new SM/PD writes use scheduledAt.
  if (job.type === 'SALES_MEETING') {
    return fact('Planlanan görüşme günü',
      job.dueDate ? formatCardDate(job.dueDate) : 'Belirtilmedi', job.dueDate);
  }
  return fact('Termin', job.dueDate ? formatCardDate(job.dueDate) : 'Belirtilmedi', job.dueDate);
}
