import {
  JOB_CARD_PRIORITIES,
  type JobCardCreateInput,
  type JobCardPriority,
  type NormalizedJobCardCreateInput,
} from './types.js';
import {
  boundedTrimmedString,
  isoDate,
  isoInstant,
  requireActionId,
  uuidString,
  validation,
} from './validation.js';

const COMMON_CREATE_FIELDS = [
  'clientActionId', 'type', 'title', 'description', 'customerId', 'contactId',
  'assignedTo', 'priority', 'dueDate', 'scheduledAt',
] as const;

const CREATE_FIELDS_BY_TYPE = {
  PRODUCT_DELIVERY: COMMON_CREATE_FIELDS,
  GENERAL_TASK: COMMON_CREATE_FIELDS,
  SALES_MEETING: COMMON_CREATE_FIELDS,
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
    return {
      ...common,
      type: input.type,
      customerId: uuidString(input.customerId, 'customerId'),
      scheduledAt: requiredScheduledAt(input.scheduledAt),
    };
  }
  if (input.type === 'SALES_MEETING') {
    return {
      ...common,
      type: input.type,
      customerId: uuidString(input.customerId, 'customerId'),
      dueDate: isoDate(input.dueDate, 'dueDate'),
      scheduledAt: requiredScheduledAt(input.scheduledAt),
    };
  }
  return {
    ...common,
    type: input.type,
    customerId: optionalUuid(input.customerId, 'customerId'),
    scheduledAt: optionalScheduledAt(input.scheduledAt),
  };
}

export type { JobCardCreateInput };
