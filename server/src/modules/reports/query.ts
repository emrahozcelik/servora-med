import { AppError } from '../../errors/index.js';
import type {
  ApprovalReportQuery,
  DeliveryReportQuery,
  ReportRangeQuery,
  RequestedReportRange,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_KEYS = ['from', 'to'] as const;
const DELIVERY_KEYS = ['from', 'to', 'groupBy', 'staffUserId', 'limit', 'offset'] as const;
const APPROVAL_KEYS = ['limit', 'offset'] as const;
const DELIVERY_GROUPS = ['day', 'purpose', 'product', 'staff'] as const;

function validation(field: string) {
  return new AppError(
    'VALIDATION_ERROR',
    400,
    'Geçersiz rapor sorgusu.',
    { field },
  );
}

function staffProfileNotFound() {
  return new AppError(
    'STAFF_PROFILE_NOT_FOUND',
    404,
    'Personel profili bulunamadı.',
  );
}

function exactScalarQuery(raw: unknown, allowed: readonly string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw validation('query');
  const value = raw as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.includes(key) || Array.isArray(entry)) throw validation(key);
  }
  return value;
}

function strictDate(value: string, field: string) {
  if (!DATE_PATTERN.test(value)) throw validation(field);
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year!, month! - 1, day!);
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month! - 1
    || date.getUTCDate() !== day) throw validation(field);
  return value;
}

function requestedRange(value: Record<string, unknown>): RequestedReportRange {
  if (value.from === undefined && value.to === undefined) return null;
  if (typeof value.from !== 'string' || typeof value.to !== 'string') {
    throw validation(value.from === undefined ? 'from' : 'to');
  }
  const from = strictDate(value.from, 'from');
  const to = strictDate(value.to, 'to');
  const days = (
    Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  ) / 86_400_000;
  if (days < 0 || days > 365) throw validation('to');
  return { from, to };
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
  if (!Number.isSafeInteger(parsed)
    || parsed < minimum
    || (maximum !== undefined && parsed > maximum)) throw validation(field);
  return parsed;
}

function deliveryGroup(value: unknown): DeliveryReportQuery['groupBy'] {
  if (typeof value !== 'string'
    || !(DELIVERY_GROUPS as readonly string[]).includes(value)) throw validation('groupBy');
  return value as DeliveryReportQuery['groupBy'];
}

function optionalStaffUserId(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw validation('staffUserId');
  }
  return value;
}

export function parseDashboardReportQuery(raw: unknown): ReportRangeQuery {
  const value = exactScalarQuery(raw, RANGE_KEYS);
  return { requestedRange: requestedRange(value) };
}

export function parseStaffReportQuery(raw: unknown): ReportRangeQuery {
  const value = exactScalarQuery(raw, RANGE_KEYS);
  return { requestedRange: requestedRange(value) };
}

export function parseDeliveryReportQuery(raw: unknown): DeliveryReportQuery {
  const value = exactScalarQuery(raw, DELIVERY_KEYS);
  return {
    requestedRange: requestedRange(value),
    groupBy: deliveryGroup(value.groupBy),
    staffUserId: optionalStaffUserId(value.staffUserId),
    limit: integerQuery(value.limit, 'limit', 50, 1, 200),
    offset: integerQuery(value.offset, 'offset', 0, 0),
  };
}

export function parseApprovalReportQuery(raw: unknown): ApprovalReportQuery {
  const value = exactScalarQuery(raw, APPROVAL_KEYS);
  return {
    limit: integerQuery(value.limit, 'limit', 50, 1, 200),
    offset: integerQuery(value.offset, 'offset', 0, 0),
  };
}

export function parseStaffReportPathId(raw: unknown) {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) throw staffProfileNotFound();
  return raw;
}
