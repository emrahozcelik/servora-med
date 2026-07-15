import { AppError } from '../../errors/index.js';
import {
  MEETING_OUTCOMES,
  type MeetingDetailsCandidate,
  type MeetingOutcome,
  type PatchMeetingDetailsInput,
} from './types.js';
import {
  codePointLength,
  requireActionId,
  uuidString,
  validation,
} from './validation.js';

const PATCH_FIELDS = [
  'clientActionId', 'expectedVersion', 'meetingAt', 'outcome',
  'meetingSummary', 'nextFollowUpAt',
] as const;
const MUTATION_FIELDS = [
  'meetingAt', 'outcome', 'meetingSummary', 'nextFollowUpAt',
] as const;
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function exactRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !PATCH_FIELDS.includes(key as never))) {
    throw validation('body');
  }
  return record;
}

function expectedVersion(value: unknown) {
  if (!Number.isInteger(value) || (value as number) < 1) throw validation('expectedVersion');
  return value as number;
}

function instant(value: unknown, field: string) {
  if (value === null) return null;
  if (typeof value !== 'string') throw validation(field);
  const match = INSTANT_PATTERN.exec(value);
  if (!match) throw validation(field);
  const [, year, month, day, hour, minute, second, zone] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const daysInMonth = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
  const zoneHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > daysInMonth
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || zoneHour > 23 || zoneMinute > 59) {
    throw validation(field);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw validation(field);
  return parsed.toISOString();
}

function outcome(value: unknown) {
  if (value === null) return null;
  if (!MEETING_OUTCOMES.includes(value as MeetingOutcome)) throw validation('outcome');
  return value as MeetingOutcome;
}

function summary(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string') throw validation('meetingSummary');
  const normalized = value.trim();
  if (!normalized) return null;
  if (codePointLength(normalized) > 4_000) throw validation('meetingSummary');
  return normalized;
}

export function parseMeetingDetailsPatch(value: unknown): PatchMeetingDetailsInput {
  const record = exactRecord(value);
  if (!MUTATION_FIELDS.some((field) => Object.hasOwn(record, field))) {
    throw validation('body');
  }
  const parsed: PatchMeetingDetailsInput = {
    clientActionId: requireActionId(record.clientActionId),
    expectedVersion: expectedVersion(record.expectedVersion),
  };
  if (Object.hasOwn(record, 'meetingAt')) parsed.meetingAt = instant(record.meetingAt, 'meetingAt');
  if (Object.hasOwn(record, 'outcome')) parsed.outcome = outcome(record.outcome);
  if (Object.hasOwn(record, 'meetingSummary')) parsed.meetingSummary = summary(record.meetingSummary);
  if (Object.hasOwn(record, 'nextFollowUpAt')) {
    parsed.nextFollowUpAt = instant(record.nextFollowUpAt, 'nextFollowUpAt');
  }
  return parsed;
}

export function parseMeetingJobCardId(value: unknown) {
  try {
    return uuidString(value, 'jobCardId');
  } catch {
    throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
  }
}

export function validateMeetingDetailsCandidate(candidate: MeetingDetailsCandidate) {
  if (candidate.nextFollowUpAt !== null && (candidate.meetingAt === null
    || new Date(candidate.nextFollowUpAt) <= new Date(candidate.meetingAt))) {
    throw validation('nextFollowUpAt');
  }
}
