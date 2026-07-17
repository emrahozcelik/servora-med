import { AppError } from '../../errors/index.js';

export function validation(field: string) {
  const message = `${field} geçersizdir.`;
  return new AppError('VALIDATION_ERROR', 400, message, {
    fieldErrors: { [field]: message },
  });
}

export const codePointLength = (value: string) => Array.from(value).length;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function boundedTrimmedString(
  value: unknown,
  field: string,
  min: number,
  max: number,
) {
  if (typeof value !== 'string') throw validation(field);
  const trimmed = value.trim();
  const length = codePointLength(trimmed);
  if (length < min || length > max) throw validation(field);
  return trimmed;
}

export function isoDate(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validation(field);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validation(field);
  }
  return value;
}

const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** Parse a UTC instant with explicit Z or offset; returns canonical ISO string. */
export function isoInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') throw validation(field);
  const match = INSTANT_PATTERN.exec(value);
  if (!match) throw validation(field);
  const [, year, month, day, hour, minute, second, zone] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const daysInMonth = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
  const zoneHour = zone === 'Z' ? 0 : Number(zone!.slice(1, 3));
  const zoneMinute = zone === 'Z' ? 0 : Number(zone!.slice(4, 6));
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > daysInMonth
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || zoneHour > 23 || zoneMinute > 59) {
    throw validation(field);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw validation(field);
  return parsed.toISOString();
}

export function uuidString(value: unknown, field: string) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw validation(field);
  return value;
}

export function requireActionId(value: unknown) {
  return boundedTrimmedString(value, 'clientActionId', 1, 255);
}

export function optionalLifecycleNote(value: unknown) {
  if (value === undefined) return null;
  const note = boundedTrimmedString(value, 'note', 0, 2_000);
  return note.length === 0 ? null : note;
}

export function requireLifecycleReason(value: unknown, field: string) {
  return boundedTrimmedString(value, field, 1, 2_000);
}
