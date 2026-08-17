import {
  JOB_CARD_ENGAGEMENT_KINDS,
  JOB_CARD_PRIORITIES,
  JOB_CARD_TYPES,
  type CustomerSchedulePreviewInput,
  type AvailableSlotsInput,
  type FollowUpCreateInput,
  type JobCardCreateInput,
  type JobCardEngagementKind,
  type JobCardPriority,
  type JobCardType,
  type NormalizedJobCardCreateInput,
} from './types.js';
import { AppError } from '../../errors/index.js';
import {
  boundedTrimmedString,
  isoDate,
  isoInstant,
  requireActionId,
  uuidString,
  validation,
} from './validation.js';
import { canonicalScheduledEnd } from './job-card-duration.js';

const COMMON_CREATE_FIELDS = [
  'clientActionId', 'type', 'title', 'description', 'customerId', 'contactId',
  'assignedTo', 'priority', 'dueDate', 'scheduledAt',
] as const;

const CREATE_FIELDS_BY_TYPE = {
  PRODUCT_DELIVERY: [...COMMON_CREATE_FIELDS, 'scheduledEndsAt', 'overrideReason'] as const,
  GENERAL_TASK: COMMON_CREATE_FIELDS,
  SALES_MEETING: [...COMMON_CREATE_FIELDS, 'scheduledEndsAt', 'engagementKind', 'overrideReason'] as const,
} as const;

type CreateType = keyof typeof CREATE_FIELDS_BY_TYPE;

function exactRecord(value: unknown): Record<string, unknown> & { type: CreateType } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (record.type !== 'PRODUCT_DELIVERY' && record.type !== 'GENERAL_TASK'
    && record.type !== 'SALES_MEETING') {
    throw validation('type');
  }
  const allowed = CREATE_FIELDS_BY_TYPE[record.type];
  if (Object.keys(record).some((key) => !allowed.includes(key as never))) {
    throw validation('body');
  }
  return record as Record<string, unknown> & { type: CreateType };
}

function nullableText(value: unknown, field: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw validation(field);
  return value.trim() || null;
}

function optionalUuid(value: unknown, field: string) {
  return value === undefined || value === null ? null : uuidString(value, field);
}

function priority(value: unknown): JobCardPriority {
  if (value === undefined) return 'normal';
  if (!JOB_CARD_PRIORITIES.includes(value as JobCardPriority)) throw validation('priority');
  return value as JobCardPriority;
}

function dueDate(value: unknown) {
  return value === undefined || value === null ? null : isoDate(value, 'dueDate');
}

function optionalScheduledAt(value: unknown) {
  if (value === undefined || value === null) return null;
  return isoInstant(value, 'scheduledAt');
}

function requiredScheduledAt(value: unknown) {
  if (value === undefined || value === null) throw validation('scheduledAt');
  return isoInstant(value, 'scheduledAt');
}

function canonicalScheduledEndsAt(
  type: 'PRODUCT_DELIVERY' | 'SALES_MEETING',
  value: unknown,
  scheduledAt: string,
) {
  const canonicalEnd = canonicalScheduledEnd(type, scheduledAt)!;
  if (value === undefined) return canonicalEnd;
  if (value === null) throw validation('scheduledEndsAt');
  const endsAt = isoInstant(value, 'scheduledEndsAt');
  if (endsAt !== canonicalEnd) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      'Planlanan bitiş zamanı bu iş türünün kanonik süresiyle eşleşmelidir.',
      { fieldErrors: { scheduledEndsAt: 'scheduledEndsAt geçersizdir.' } },
    );
  }
  return endsAt;
}

function optionalOverrideReason(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw validation('overrideReason');
  return value.trim() || null;
}

function parseEngagementKind(value: unknown): JobCardEngagementKind {
  if (value === undefined) return 'SALES_MEETING';
  if (!JOB_CARD_ENGAGEMENT_KINDS.includes(value as JobCardEngagementKind)) {
    throw validation('engagementKind');
  }
  return value as JobCardEngagementKind;
}

export function parseJobCardCreateInput(value: unknown): NormalizedJobCardCreateInput {
  const input = exactRecord(value);
  const common = {
    clientActionId: requireActionId(input.clientActionId),
    title: boundedTrimmedString(input.title, 'title', 1, 255),
    description: nullableText(input.description, 'description'),
    contactId: optionalUuid(input.contactId, 'contactId'),
    assignedTo: uuidString(input.assignedTo, 'assignedTo'),
    priority: priority(input.priority),
    dueDate: dueDate(input.dueDate),
  };
  if (input.type === 'PRODUCT_DELIVERY') {
    const scheduledAt = requiredScheduledAt(input.scheduledAt);
    return {
      ...common,
      type: input.type,
      customerId: uuidString(input.customerId, 'customerId'),
      scheduledAt,
      scheduledEndsAt: canonicalScheduledEndsAt(input.type, input.scheduledEndsAt, scheduledAt),
      overrideReason: optionalOverrideReason(input.overrideReason),
    };
  }
  if (input.type === 'SALES_MEETING') {
    // Active planning SSOT is scheduledAt + scheduledEndsAt; dueDate is not written on create.
    const scheduledAt = requiredScheduledAt(input.scheduledAt);
    return {
      ...common,
      type: input.type,
      customerId: uuidString(input.customerId, 'customerId'),
      dueDate: null,
      scheduledAt,
      scheduledEndsAt: canonicalScheduledEndsAt(input.type, input.scheduledEndsAt, scheduledAt),
      engagementKind: parseEngagementKind(input.engagementKind),
      overrideReason: optionalOverrideReason(input.overrideReason),
    };
  }
  return {
    ...common,
    type: input.type,
    customerId: optionalUuid(input.customerId, 'customerId'),
    scheduledAt: optionalScheduledAt(input.scheduledAt),
  };
}

const FOLLOW_UP_COMMON_FIELDS = [
  'clientActionId', 'type', 'title', 'followUpInstructions', 'scheduledAt',
  'assignedTo', 'priority', 'dueDate', 'contactId', 'overrideReason',
] as const;

const FOLLOW_UP_FIELDS_BY_TYPE = {
  PRODUCT_DELIVERY: FOLLOW_UP_COMMON_FIELDS,
  GENERAL_TASK: FOLLOW_UP_COMMON_FIELDS,
  SALES_MEETING: [...FOLLOW_UP_COMMON_FIELDS, 'engagementKind'] as const,
} as const;

function exactFollowUpRecord(value: unknown): Record<string, unknown> & { type: CreateType } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (record.type !== 'PRODUCT_DELIVERY' && record.type !== 'GENERAL_TASK'
    && record.type !== 'SALES_MEETING') {
    throw validation('type');
  }
  const allowed = FOLLOW_UP_FIELDS_BY_TYPE[record.type];
  if (Object.keys(record).some((key) => !allowed.includes(key as never))) {
    throw validation('body');
  }
  return record as Record<string, unknown> & { type: CreateType };
}

function followUpInstructions(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(
      'FOLLOW_UP_INSTRUCTIONS_REQUIRED',
      400,
      'Takip talimatları zorunludur.',
    );
  }
  return boundedTrimmedString(value, 'followUpInstructions', 1, 4_000);
}

function requiredEngagementKind(value: unknown): JobCardEngagementKind {
  if (!JOB_CARD_ENGAGEMENT_KINDS.includes(value as JobCardEngagementKind)) {
    throw validation('engagementKind');
  }
  return value as JobCardEngagementKind;
}

export function parseFollowUpCreateInput(value: unknown): FollowUpCreateInput {
  const input = exactFollowUpRecord(value);
  const common = {
    clientActionId: requireActionId(input.clientActionId),
    type: input.type,
    title: boundedTrimmedString(input.title, 'title', 1, 255),
    followUpInstructions: followUpInstructions(input.followUpInstructions),
    assignedTo: uuidString(input.assignedTo, 'assignedTo'),
    priority: priority(input.priority),
    dueDate: dueDate(input.dueDate),
    contactId: optionalUuid(input.contactId, 'contactId'),
    overrideReason: optionalOverrideReason(input.overrideReason),
  };
  if (input.type === 'PRODUCT_DELIVERY') {
    return {
      ...common,
      type: input.type,
      scheduledAt: requiredScheduledAt(input.scheduledAt),
      engagementKind: null,
    };
  }
  if (input.type === 'SALES_MEETING') {
    if (input.dueDate !== undefined && input.dueDate !== null) throw validation('dueDate');
    return {
      ...common,
      type: input.type,
      dueDate: null,
      scheduledAt: requiredScheduledAt(input.scheduledAt),
      engagementKind: requiredEngagementKind(input.engagementKind),
    };
  }
  return {
    ...common,
    type: input.type,
    scheduledAt: optionalScheduledAt(input.scheduledAt),
    engagementKind: null,
  };
}

export type { JobCardCreateInput };

const PREVIEW_FIELDS = ['type', 'customerId', 'scheduledAt', 'jobCardId'] as const;

/** Parse the generic customer-schedule preview body. jobCardId is optional (edit preview). */
export function parseCustomerSchedulePreviewInput(value: unknown): CustomerSchedulePreviewInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !PREVIEW_FIELDS.includes(key as never))) {
    throw validation('body');
  }
  if (!JOB_CARD_TYPES.includes(record.type as JobCardType)) throw validation('type');
  return {
    type: record.type as JobCardType,
    customerId: optionalUuid(record.customerId, 'customerId'),
    scheduledAt: requiredScheduledAt(record.scheduledAt),
    jobCardId: record.jobCardId === undefined || record.jobCardId === null
      ? null
      : uuidString(record.jobCardId, 'jobCardId'),
  };
}

const AVAILABLE_SLOTS_FIELDS = [
  'type', 'customerId', 'assignedTo', 'scheduledAt', 'scheduledEndsAt', 'jobCardId',
] as const;

export function parseAvailableSlotsInput(value: unknown): AvailableSlotsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !AVAILABLE_SLOTS_FIELDS.includes(key as never))) {
    throw validation('body');
  }
  if (record.type !== 'SALES_MEETING' && record.type !== 'PRODUCT_DELIVERY') {
    throw validation('type');
  }
  const scheduledAt = requiredScheduledAt(record.scheduledAt);
  const scheduledEndsAt = record.scheduledEndsAt === undefined
    ? undefined
    : isoInstant(record.scheduledEndsAt, 'scheduledEndsAt');
  if (scheduledEndsAt !== undefined && Date.parse(scheduledEndsAt) <= Date.parse(scheduledAt)) {
    throw validation('scheduledEndsAt');
  }
  return {
    type: record.type,
    customerId: uuidString(record.customerId, 'customerId'),
    assignedTo: uuidString(record.assignedTo, 'assignedTo'),
    scheduledAt,
    scheduledEndsAt,
    jobCardId: record.jobCardId === undefined || record.jobCardId === null
      ? null
      : uuidString(record.jobCardId, 'jobCardId'),
  };
}
