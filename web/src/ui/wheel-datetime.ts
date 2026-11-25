/**
 * Pure value helpers for `WheelDateTimeField`.
 *
 * The picker keeps the native input value contract used across Servora-Med
 * controlled forms, so adopting it never changes what a page stores:
 * - `datetime` → `YYYY-MM-DDTHH:mm`
 * - `date` → `YYYY-MM-DD`
 * - `time` → `HH:mm`
 *
 * Values are device-local strings, exactly like `<input type="datetime-local">`.
 * Nothing here converts to or from UTC instants; pages keep owning that step.
 */

import { addCalendarDays, isValidDateKey } from './calendar-date';

export type WheelMode = 'datetime' | 'date' | 'time';

export type WheelColumnKey = 'day' | 'month' | 'year' | 'hour' | 'minute';

export type WheelSelection = {
  /** `YYYY-MM-DD`; empty for `time` mode, which has no calendar day. */
  date: string;
  hour: number;
  minute: number;
};

export type WheelOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type WheelColumnModel = {
  key: WheelColumnKey;
  /** Accessible column name, e.g. `Saat`. */
  label: string;
  /** Currently selected option value. */
  value: string;
  options: WheelOption[];
};

export type WheelContext = {
  now: Date;
  /** Same value contract as the field, or empty. */
  min?: string;
  max?: string;
  minuteStep?: number;
};

export type WheelBounds = {
  min: WheelSelection | null;
  max: WheelSelection | null;
};

export const DEFAULT_MINUTE_STEP = 5;

/** Days offered before/after today when the field has no explicit min/max. */
export const DEFAULT_DAYS_BACK = 30;
export const DEFAULT_DAYS_FORWARD = 365;

const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

const shortWeekday = new Intl.DateTimeFormat('tr-TR', {
  weekday: 'short',
  timeZone: 'UTC',
});
const longWeekday = new Intl.DateTimeFormat('tr-TR', {
  weekday: 'long',
  timeZone: 'UTC',
});
const shortMonth = new Intl.DateTimeFormat('tr-TR', {
  month: 'short',
  timeZone: 'UTC',
});
const longMonth = new Intl.DateTimeFormat('tr-TR', {
  month: 'long',
  timeZone: 'UTC',
});

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function utcDateFromKey(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function dateKeyYear(key: string): number {
  return Number(key.slice(0, 4));
}

function dateKeyMonth(key: string): number {
  return Number(key.slice(5, 7));
}

function dateKeyDay(key: string): number {
  return Number(key.slice(8, 10));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function normalizeMinuteStep(step: number | undefined): number {
  if (!Number.isFinite(step)) return DEFAULT_MINUTE_STEP;
  const rounded = Math.trunc(step as number);
  if (rounded < 1) return 1;
  if (rounded > 60) return 60;
  return rounded;
}

/** Minute values `0, step, 2·step …` below 60, plus `extraMinute` when off-grid. */
export function minuteGrid(step: number, extraMinute?: number): number[] {
  const minutes: number[] = [];
  for (let minute = 0; minute < 60; minute += step) {
    minutes.push(minute);
  }
  if (extraMinute !== undefined && !minutes.includes(extraMinute)) {
    minutes.push(extraMinute);
    minutes.sort((a, b) => a - b);
  }
  return minutes;
}

/** Rounds a minute-of-day up to the next minute-grid value inside its hour. */
export function roundUpMinutes(minutes: number, step: number): number {
  if (minutes <= 0) return 0;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const roundedMinute = Math.ceil(minute / step) * step;
  return roundedMinute >= 60 ? (hour + 1) * 60 : hour * 60 + roundedMinute;
}

/** Parses any supported local value into calendar/time components. */
export function parseWheelValue(mode: WheelMode, value: string): WheelSelection | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (mode === 'date') {
    const match = DATE_PATTERN.exec(trimmed);
    if (!match) return null;
    const date = match[0];
    if (!isValidDateKey(date)) return null;
    return { date, hour: 0, minute: 0 };
  }
  if (mode === 'time') {
    const match = TIME_PATTERN.exec(trimmed);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return { date: '', hour, minute };
  }
  const match = DATETIME_PATTERN.exec(trimmed);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (!isValidDateKey(date)) return null;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;
  return { date, hour, minute };
}

/** Formats components back into the native input value contract. */
export function formatWheelValue(mode: WheelMode, selection: WheelSelection): string {
  if (mode === 'time') {
    return `${pad2(selection.hour)}:${pad2(selection.minute)}`;
  }
  if (mode === 'date') {
    return selection.date;
  }
  return `${selection.date}T${pad2(selection.hour)}:${pad2(selection.minute)}`;
}

/**
 * Human display for the closed mobile field: `Çar 26 Kas · 10:30`,
 * `Çar 26 Kas 2026` or `10:30`. Returns `''` for an empty/invalid value.
 */
export function formatWheelDisplay(mode: WheelMode, value: string): string {
  const selection = parseWheelValue(mode, value);
  if (!selection) return '';
  if (mode === 'time') {
    return `${pad2(selection.hour)}:${pad2(selection.minute)}`;
  }
  const date = utcDateFromKey(selection.date);
  const weekday = shortWeekday.format(date);
  const dayMonth = `${dateKeyDay(selection.date)} ${shortMonth.format(date)}`;
  if (mode === 'date') {
    return `${weekday} ${dayMonth} ${dateKeyYear(selection.date)}`;
  }
  return `${weekday} ${dayMonth} · ${pad2(selection.hour)}:${pad2(selection.minute)}`;
}

export function parseWheelBounds(
  mode: WheelMode,
  min?: string,
  max?: string,
): WheelBounds {
  return {
    min: min ? parseWheelValue(mode, min) : null,
    max: max ? parseWheelValue(mode, max) : null,
  };
}

/** ISO date keys and hours are lexicographic; time mode compares clock time only. */
export function compareWheelSelections(a: WheelSelection, b: WheelSelection): number {
  if (a.date && b.date && a.date !== b.date) {
    return a.date < b.date ? -1 : 1;
  }
  return (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute);
}

/**
 * A time-only range with `max` before `min` wraps across midnight
 * (`22:00–02:00`), matching the native time input's validity rule.
 */
function hasInvertedTimeRange(bounds: WheelBounds): boolean {
  const min = bounds.min;
  const max = bounds.max;
  return min !== null
    && max !== null
    && min.date === ''
    && max.date === ''
    && compareWheelSelections(min, max) > 0;
}

export function isWithinWheelBounds(selection: WheelSelection, bounds: WheelBounds): boolean {
  const min = bounds.min;
  const max = bounds.max;
  if (hasInvertedTimeRange(bounds)) {
    return compareWheelSelections(selection, min!) >= 0
      || compareWheelSelections(selection, max!) <= 0;
  }
  if (min && compareWheelSelections(selection, min) < 0) return false;
  if (max && compareWheelSelections(selection, max) > 0) return false;
  return true;
}

export function clampWheelSelection(
  selection: WheelSelection,
  bounds: WheelBounds,
): WheelSelection {
  if (hasInvertedTimeRange(bounds)) {
    if (isWithinWheelBounds(selection, bounds)) return selection;
    // Outside a midnight-wrapping window the next usable value is its start.
    return { ...bounds.min! };
  }
  if (bounds.min && compareWheelSelections(selection, bounds.min) < 0) {
    return { ...bounds.min };
  }
  if (bounds.max && compareWheelSelections(selection, bounds.max) > 0) {
    return { ...bounds.max };
  }
  return selection;
}

/**
 * Final value for a confirmed wheel interaction. The raw column parts are
 * clamped once here, so a boundary clamp (for example a day switch that moves
 * the time to `min`) can never be overwritten by another wheel's stale value.
 */
export function composeWheelValue(
  mode: WheelMode,
  parts: WheelSelection,
  min?: string,
  max?: string,
): string {
  const bounds = parseWheelBounds(mode, min, max);
  return formatWheelValue(mode, clampWheelSelection(parts, bounds));
}

/** "Now" as a wheel selection; clock modes round the minute up to `step`. */
export function nowWheelSelection(
  mode: WheelMode,
  now: Date,
  minuteStep: number,
): WheelSelection {
  if (mode === 'time') {
    const rounded = roundUpMinutes(
      now.getHours() * 60 + now.getMinutes()
        + (now.getSeconds() > 0 || now.getMilliseconds() > 0 ? 1 : 0),
      minuteStep,
    );
    return {
      date: '',
      hour: Math.floor((rounded % (24 * 60)) / 60),
      minute: rounded % 60,
    };
  }
  const date = localDateKey(now);
  if (mode === 'date') {
    return { date, hour: 0, minute: 0 };
  }
  let hour = now.getHours();
  let minute = now.getMinutes();
  const hasSeconds = now.getSeconds() > 0 || now.getMilliseconds() > 0;
  const rounded = roundUpMinutes(hour * 60 + minute + (hasSeconds ? 1 : 0), minuteStep);
  if (rounded >= 24 * 60) {
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, rounded, 0, 0);
    hour = nextDay.getHours();
    minute = nextDay.getMinutes();
    return { date: localDateKey(nextDay), hour, minute };
  }
  hour = Math.floor(rounded / 60);
  minute = rounded % 60;
  return { date, hour, minute };
}

/**
 * Opening selection: the stored value when valid, otherwise now rounded up and
 * then clamped into `min`/`max`.
 */
export function initialWheelSelection(
  mode: WheelMode,
  value: string,
  context: WheelContext,
): WheelSelection {
  const step = normalizeMinuteStep(context.minuteStep);
  const bounds = parseWheelBounds(mode, context.min, context.max);
  const parsed = value ? parseWheelValue(mode, value) : null;
  const base = parsed ?? nowWheelSelection(mode, context.now, step);
  return clampWheelSelection(base, bounds);
}

function nearestValidMinute(
  date: string,
  hour: number,
  minute: number,
  bounds: WheelBounds,
  step: number,
): number {
  const enabled = minuteGrid(step, minute).filter((candidate) => (
    isWithinWheelBounds({ date, hour, minute: candidate }, bounds)
  ));
  if (enabled.length === 0) return minute;
  let best = enabled[0]!;
  for (const candidate of enabled) {
    if (Math.abs(candidate - minute) < Math.abs(best - minute)) best = candidate;
  }
  return best;
}

function dayKeyRange(selection: WheelSelection, context: WheelContext): { low: string; high: string } {
  const bounds = parseWheelBounds('datetime', context.min, context.max);
  const today = localDateKey(context.now);
  let low = bounds.min ? bounds.min.date : addCalendarDays(today, -DEFAULT_DAYS_BACK);
  let high = bounds.max ? bounds.max.date : addCalendarDays(today, DEFAULT_DAYS_FORWARD);
  if (low > high) {
    low = high;
  }
  // Keep a stored value visible even when it sits outside the default window.
  if (selection.date && selection.date < low) low = selection.date;
  if (selection.date && selection.date > high) high = selection.date;
  return { low, high };
}

function formatDayOptionLabel(date: string, today: string, tomorrow: string): string {
  if (date === today) return 'Bugün';
  if (date === tomorrow) return 'Yarın';
  const value = utcDateFromKey(date);
  const year = dateKeyYear(date);
  const label = `${longWeekday.format(value)} ${dateKeyDay(date)} ${shortMonth.format(value)}`;
  return year === dateKeyYear(today) ? label : `${label} ${year}`;
}

function buildDatetimeDayOptions(
  selection: WheelSelection,
  context: WheelContext,
): WheelOption[] {
  const { low, high } = dayKeyRange(selection, context);
  const today = localDateKey(context.now);
  const tomorrow = addCalendarDays(today, 1);
  const options: WheelOption[] = [];
  let key = low;
  while (key <= high) {
    options.push({ value: key, label: formatDayOptionLabel(key, today, tomorrow) });
    key = addCalendarDays(key, 1);
  }
  return options;
}

function buildHourOptions(
  selection: WheelSelection,
  bounds: WheelBounds,
  step: number,
): WheelOption[] {
  const options: WheelOption[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const enabled = minuteGrid(step, selection.minute).some((minute) => (
      isWithinWheelBounds({ date: selection.date, hour, minute }, bounds)
    ));
    options.push({ value: String(hour), label: pad2(hour), disabled: !enabled });
  }
  return options;
}

function buildMinuteOptions(
  selection: WheelSelection,
  bounds: WheelBounds,
  step: number,
): WheelOption[] {
  return minuteGrid(step, selection.minute).map((minute) => {
    const candidate = { date: selection.date, hour: selection.hour, minute };
    return {
      value: String(minute),
      label: pad2(minute),
      disabled: !isWithinWheelBounds(candidate, bounds),
    };
  });
}

function buildDateDayOptions(
  selection: WheelSelection,
  bounds: WheelBounds,
): WheelOption[] {
  const year = dateKeyYear(selection.date);
  const month = dateKeyMonth(selection.date);
  const total = daysInMonth(year, month);
  const options: WheelOption[] = [];
  for (let day = 1; day <= total; day += 1) {
    const date = `${year}-${pad2(month)}-${pad2(day)}`;
    options.push({
      value: String(day),
      label: String(day),
      disabled: !isWithinWheelBounds({ date, hour: 0, minute: 0 }, bounds),
    });
  }
  return options;
}

function buildMonthOptions(
  selection: WheelSelection,
  bounds: WheelBounds,
): WheelOption[] {
  const year = dateKeyYear(selection.date);
  const options: WheelOption[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const first = { date: `${year}-${pad2(month)}-01`, hour: 0, minute: 0 };
    const last = { date: `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`, hour: 0, minute: 0 };
    // A month stays selectable while any day inside it is inside the bounds.
    const disabled = (bounds.min !== null && compareWheelSelections(last, bounds.min) < 0)
      || (bounds.max !== null && compareWheelSelections(first, bounds.max) > 0);
    const label = longMonth.format(new Date(Date.UTC(2020, month - 1, 1)));
    options.push({ value: String(month), label, disabled });
  }
  return options;
}

function buildYearOptions(selection: WheelSelection, context: WheelContext): WheelOption[] {
  const bounds = parseWheelBounds('date', context.min, context.max);
  const currentYear = dateKeyYear(selection.date);
  const fallbackYear = context.now.getFullYear();
  const low = bounds.min ? dateKeyYear(bounds.min.date) : fallbackYear - 1;
  const high = bounds.max ? dateKeyYear(bounds.max.date) : fallbackYear + 5;
  const start = Math.min(low, currentYear);
  const end = Math.max(high, currentYear);
  const options: WheelOption[] = [];
  for (let year = start; year <= end; year += 1) {
    options.push({ value: String(year), label: String(year) });
  }
  return options;
}

/** Builds the ordered wheel columns for the current selection and mode. */
export function buildWheelColumns(
  mode: WheelMode,
  selection: WheelSelection,
  context: WheelContext,
): WheelColumnModel[] {
  const step = normalizeMinuteStep(context.minuteStep);
  const bounds = parseWheelBounds(mode, context.min, context.max);
  if (mode === 'time') {
    return [
      {
        key: 'hour',
        label: 'Saat',
        value: String(selection.hour),
        options: buildHourOptions(selection, bounds, step),
      },
      {
        key: 'minute',
        label: 'Dakika',
        value: String(selection.minute),
        options: buildMinuteOptions(selection, bounds, step),
      },
    ];
  }
  if (mode === 'date') {
    return [
      {
        key: 'day',
        label: 'Gün',
        value: String(dateKeyDay(selection.date)),
        options: buildDateDayOptions(selection, bounds),
      },
      {
        key: 'month',
        label: 'Ay',
        value: String(dateKeyMonth(selection.date)),
        options: buildMonthOptions(selection, bounds),
      },
      {
        key: 'year',
        label: 'Yıl',
        value: String(dateKeyYear(selection.date)),
        options: buildYearOptions(selection, context),
      },
    ];
  }
  return [
    {
      key: 'day',
      label: 'Gün',
      value: selection.date,
      options: buildDatetimeDayOptions(selection, context),
    },
    {
      key: 'hour',
      label: 'Saat',
      value: String(selection.hour),
      options: buildHourOptions(selection, bounds, step),
    },
    {
      key: 'minute',
      label: 'Dakika',
      value: String(selection.minute),
      options: buildMinuteOptions(selection, bounds, step),
    },
  ];
}

/** Applies one column change and returns a valid, in-range selection. */
export function applyWheelColumnChange(
  mode: WheelMode,
  selection: WheelSelection,
  key: WheelColumnKey,
  optionValue: string,
  context: WheelContext,
): WheelSelection {
  const step = normalizeMinuteStep(context.minuteStep);
  const bounds = parseWheelBounds(mode, context.min, context.max);

  if (mode === 'time') {
    const next = { ...selection };
    if (key === 'hour') next.hour = Number(optionValue);
    if (key === 'minute') next.minute = Number(optionValue);
    next.minute = nearestValidMinute(next.date, next.hour, next.minute, bounds, step);
    return clampWheelSelection(next, bounds);
  }

  if (mode === 'date') {
    let year = dateKeyYear(selection.date);
    let month = dateKeyMonth(selection.date);
    let day = dateKeyDay(selection.date);
    if (key === 'day') day = Number(optionValue);
    if (key === 'month') month = Number(optionValue);
    if (key === 'year') year = Number(optionValue);
    day = Math.min(day, daysInMonth(year, month));
    const date = `${year}-${pad2(month)}-${pad2(day)}`;
    return clampWheelSelection({ date, hour: 0, minute: 0 }, bounds);
  }

  const next = { ...selection };
  if (key === 'day') next.date = optionValue;
  if (key === 'hour') next.hour = Number(optionValue);
  if (key === 'minute') next.minute = Number(optionValue);
  const clamped = clampWheelSelection(next, bounds);
  if (clamped.date === next.date && clamped.hour === next.hour) {
    clamped.minute = nearestValidMinute(clamped.date, clamped.hour, clamped.minute, bounds, step);
  }
  return clampWheelSelection(clamped, bounds);
}
