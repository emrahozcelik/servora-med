import {
  JOB_CARD_PRIORITIES,
  type JobCardCreateInput,
  type JobCardPriority,
  type NormalizedJobCardCreateInput,
} from './types.js';
import {
  boundedTrimmedString,
  isoDate,
  requireActionId,
  uuidString,
  validation,
} from './validation.js';

const CREATE_FIELDS = [
  'clientActionId', 'type', 'title', 'description', 'customerId', 'contactId',
  'assignedTo', 'priority', 'dueDate',
] as const;

function exactRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !CREATE_FIELDS.includes(key as never))) {
    throw validation('body');
  }
  return record;
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

export function parseJobCardCreateInput(value: unknown): NormalizedJobCardCreateInput {
  const input = exactRecord(value);
  if (input.type !== 'PRODUCT_DELIVERY' && input.type !== 'GENERAL_TASK') {
    throw validation('type');
  }
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
    return { ...common, type: input.type, customerId: uuidString(input.customerId, 'customerId') };
  }
  return { ...common, type: input.type, customerId: optionalUuid(input.customerId, 'customerId') };
}

export type { JobCardCreateInput };
