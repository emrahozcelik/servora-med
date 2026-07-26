import { AppError } from '../../errors/index.js';
import {
  boundedTrimmedString,
  isoInstant,
  requireActionId,
  uuidString,
  validation,
} from '../job-cards/validation.js';
import type {
  ManualEventCancelInput,
  ManualEventCreateInput,
  ManualEventPatchInput,
} from './types.js';

function timezone(value: unknown) {
  const zone = boundedTrimmedString(value, 'timezone', 1, 100);
  try {
    new Intl.DateTimeFormat('tr-TR', { timeZone: zone }).format(new Date());
  } catch {
    throw validation('timezone');
  }
  return zone;
}

function optionalDescription(value: unknown) {
  if (value === undefined || value === null) return null;
  const normalized = boundedTrimmedString(value, 'description', 0, 4_000);
  return normalized || null;
}

function interval(startsAt: string, endsAt: string) {
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      'Bitiş zamanı başlangıç zamanından sonra olmalıdır.',
    );
  }
}

function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validation('body');
  }
  return value as Record<string, unknown>;
}

function known(input: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(input).some((field) => !fields.includes(field))) {
    throw validation('body');
  }
}

export function parseManualEventCreate(value: unknown): ManualEventCreateInput {
  const input = object(value);
  known(input, [
    'clientActionId', 'assignedUserId', 'title', 'description',
    'startsAt', 'endsAt', 'timezone',
  ]);
  const startsAt = isoInstant(input.startsAt, 'startsAt');
  const endsAt = isoInstant(input.endsAt, 'endsAt');
  interval(startsAt, endsAt);
  return {
    clientActionId: requireActionId(input.clientActionId),
    assignedUserId: uuidString(input.assignedUserId, 'assignedUserId'),
    title: boundedTrimmedString(input.title, 'title', 1, 200),
    description: optionalDescription(input.description),
    startsAt,
    endsAt,
    timezone: timezone(input.timezone),
  };
}

export function parseManualEventPatch(value: unknown): ManualEventPatchInput {
  const input = object(value);
  known(input, [
    'clientActionId', 'expectedVersion', 'assignedUserId', 'title',
    'description', 'startsAt', 'endsAt', 'timezone',
  ]);
  if (!Number.isInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) {
    throw validation('expectedVersion');
  }
  const result: ManualEventPatchInput = {
    clientActionId: requireActionId(input.clientActionId),
    expectedVersion: Number(input.expectedVersion),
    ...(input.assignedUserId === undefined ? {} : {
      assignedUserId: uuidString(input.assignedUserId, 'assignedUserId'),
    }),
    ...(input.title === undefined ? {} : {
      title: boundedTrimmedString(input.title, 'title', 1, 200),
    }),
    ...(input.description === undefined ? {} : {
      description: optionalDescription(input.description),
    }),
    ...(input.startsAt === undefined ? {} : {
      startsAt: isoInstant(input.startsAt, 'startsAt'),
    }),
    ...(input.endsAt === undefined ? {} : {
      endsAt: isoInstant(input.endsAt, 'endsAt'),
    }),
    ...(input.timezone === undefined ? {} : { timezone: timezone(input.timezone) }),
  };
  if (Object.keys(result).length === 2) throw validation('body');
  if (result.startsAt && result.endsAt) interval(result.startsAt, result.endsAt);
  return result;
}

export function parseManualEventCancel(value: unknown): ManualEventCancelInput {
  const input = object(value);
  known(input, ['clientActionId', 'expectedVersion', 'cancelReason']);
  if (!Number.isInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) {
    throw validation('expectedVersion');
  }
  return {
    clientActionId: requireActionId(input.clientActionId),
    expectedVersion: Number(input.expectedVersion),
    cancelReason: boundedTrimmedString(input.cancelReason, 'cancelReason', 1, 2_000),
  };
}
