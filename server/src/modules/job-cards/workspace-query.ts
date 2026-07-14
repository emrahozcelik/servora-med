import {
  JOB_CARD_PRIORITIES,
  JOB_CARD_STATUSES,
  type JobCardBaseFilters,
  type JobCardBoardQuery,
  type JobCardListQuery,
  type JobCardPriority,
  type JobCardStatusFilter,
} from './types.js';
import { boundedTrimmedString, isoDate, validation } from './validation.js';

const LIST_KEYS = [
  'q', 'status', 'type', 'assignedTo', 'customerId', 'priority',
  'dueBefore', 'dueAfter', 'limit', 'offset',
] as const;
const BOARD_KEYS = [
  'q', 'type', 'assignedTo', 'customerId', 'priority', 'dueBefore', 'dueAfter', 'limit',
] as const;
const STATUS_FILTERS = ['active', 'closed', 'all', ...JOB_CARD_STATUSES] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function exactQuery(raw: unknown, allowed: readonly string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw validation('query');
  const value = raw as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.includes(key) || Array.isArray(entry)) throw validation(key);
  }
  return value;
}

function optionalQuery(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw validation('q');
  if (value.trim().length === 0) return null;
  return boundedTrimmedString(value, 'q', 1, 200);
}

function optionalUuid(value: unknown, field: string) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw validation(field);
  return value;
}

function optionalType(value: unknown) {
  if (value === undefined) return null;
  if (value !== 'PRODUCT_DELIVERY') throw validation('type');
  return value;
}

function optionalPriority(value: unknown) {
  if (value === undefined) return null;
  if (!JOB_CARD_PRIORITIES.includes(value as JobCardPriority)) throw validation('priority');
  return value as JobCardPriority;
}

function optionalDate(value: unknown, field: string) {
  return value === undefined ? null : isoDate(value, field);
}

function integerQuery(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum?: number,
) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw validation(field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum
    || (maximum !== undefined && parsed > maximum)) throw validation(field);
  return parsed;
}

function baseFilters(value: Record<string, unknown>): JobCardBaseFilters {
  const dueBefore = optionalDate(value.dueBefore, 'dueBefore');
  const dueAfter = optionalDate(value.dueAfter, 'dueAfter');
  if (dueAfter !== null && dueBefore !== null && dueAfter > dueBefore) {
    throw validation('dueAfter');
  }
  return {
    q: optionalQuery(value.q),
    type: optionalType(value.type),
    assignedTo: optionalUuid(value.assignedTo, 'assignedTo'),
    customerId: optionalUuid(value.customerId, 'customerId'),
    priority: optionalPriority(value.priority),
    dueBefore,
    dueAfter,
  };
}

function statusFilter(value: unknown): JobCardStatusFilter {
  if (value === undefined) return 'active';
  if (!STATUS_FILTERS.includes(value as JobCardStatusFilter)) throw validation('status');
  return value as JobCardStatusFilter;
}

export function parseJobCardListQuery(raw: unknown): JobCardListQuery {
  const value = exactQuery(raw, LIST_KEYS);
  return {
    ...baseFilters(value),
    status: statusFilter(value.status),
    limit: integerQuery(value.limit, 'limit', 25, 1, 100),
    offset: integerQuery(value.offset, 'offset', 0, 0),
  };
}

export function parseJobCardBoardQuery(raw: unknown): JobCardBoardQuery {
  const value = exactQuery(raw, BOARD_KEYS);
  return {
    ...baseFilters(value),
    limit: integerQuery(value.limit, 'limit', 25, 1, 100),
  };
}
