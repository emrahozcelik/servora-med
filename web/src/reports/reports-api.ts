import {
  ApiError,
  boolean,
  nullableString,
  number,
  object,
  request,
  string,
} from '../services/api';
import {
  DELIVERY_PURPOSES,
  MEETING_OUTCOMES,
  parsePersistedJobCardListItem,
} from '../jobs/jobs-api';
import type {
  ApprovalItem,
  ApprovalReportResponse,
  DashboardReportResponse,
  DeliveryDayItem,
  DeliveryProductItem,
  DeliveryPurposeItem,
  DeliveryReportRequest,
  DeliveryReportResponse,
  DeliveryStaffItem,
  RequestedReportRange,
  ResolvedReportRange,
  StaffOperationalCounters,
  StaffReportResponse,
} from './report-types';

const DELIVERY_GROUPS = ['day', 'purpose', 'product', 'staff'] as const;
const PAGE_KEYS = ['groupBy', 'items', 'range', 'total', 'limit', 'offset'] as const;
const LIST_ITEM_KEYS = [
  'id', 'type', 'status', 'version', 'title', 'priority', 'dueDate', 'scheduledAt',
  'createdAt', 'updatedAt', 'staffCompletedAt', 'customer', 'contact', 'assignee',
  'deliveryItemCount', 'waitingMinutes',
] as const;

function invalid(field: string): never {
  throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
}

function exactObject(value: unknown, field: string, keys: readonly string[]) {
  const parsed = object(value);
  if (Object.keys(parsed).some((key) => !keys.includes(key))) invalid(field);
  return parsed;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) invalid(field);
  return value as T[number];
}

function nonNegativeInteger(value: unknown, field: string) {
  const parsed = number(value, field);
  if (!Number.isInteger(parsed) || parsed < 0) invalid(field);
  return parsed;
}

function positiveInteger(value: unknown, field: string) {
  const parsed = nonNegativeInteger(value, field);
  if (parsed === 0) invalid(field);
  return parsed;
}

function nullableNonNegativeInteger(value: unknown, field: string) {
  return value === null ? null : nonNegativeInteger(value, field);
}

function decimalQuantity(value: unknown, field: string) {
  const parsed = string(value, field);
  if (!/^(0|[1-9]\d*)\.\d{3}$/.test(parsed)) invalid(field);
  return parsed;
}

function parseResolvedRange(value: unknown): ResolvedReportRange {
  const row = exactObject(value, 'range', ['from', 'to', 'timezone']);
  return {
    from: string(row.from, 'range.from'),
    to: string(row.to, 'range.to'),
    timezone: string(row.timezone, 'range.timezone'),
  };
}

function parseStaffIdentity(value: unknown) {
  const row = exactObject(value, 'staff', ['userId', 'name', 'isActive']);
  return {
    userId: string(row.userId, 'staff.userId'),
    name: string(row.name, 'staff.name'),
    isActive: boolean(row.isActive, 'staff.isActive'),
  };
}

function parseStaffCounters(value: unknown): StaffOperationalCounters {
  const row = exactObject(value, 'counters', [
    'openJobCards', 'waitingApproval', 'revisionRequested', 'overdueJobCards',
    'completedInPeriod',
  ]);
  return {
    openJobCards: nonNegativeInteger(row.openJobCards, 'counters.openJobCards'),
    waitingApproval: nonNegativeInteger(row.waitingApproval, 'counters.waitingApproval'),
    revisionRequested: nonNegativeInteger(row.revisionRequested, 'counters.revisionRequested'),
    overdueJobCards: nonNegativeInteger(row.overdueJobCards, 'counters.overdueJobCards'),
    completedInPeriod: nonNegativeInteger(row.completedInPeriod, 'counters.completedInPeriod'),
  };
}

function parseMeetingsByOutcome(value: unknown) {
  const values = array(value, 'meetingsByOutcome');
  if (values.length !== MEETING_OUTCOMES.length) invalid('meetingsByOutcome');
  return values.map((value, index) => {
    const row = exactObject(value, 'meetingOutcomeItem', ['outcome', 'count']);
    const outcome = oneOf(row.outcome, 'outcome', MEETING_OUTCOMES);
    if (outcome !== MEETING_OUTCOMES[index]) invalid('meetingsByOutcome');
    return { outcome, count: nonNegativeInteger(row.count, 'count') };
  });
}

function parseDeliveryDayItem(value: unknown): DeliveryDayItem {
  const row = exactObject(value, 'deliveryDayItem', ['date', 'unit', 'quantity']);
  return { date: string(row.date, 'date'), unit: nullableString(row.unit, 'unit'),
    quantity: decimalQuantity(row.quantity, 'quantity') };
}

export function parseDeliveryPurposeItem(value: unknown): DeliveryPurposeItem {
  const row = exactObject(value, 'deliveryPurposeItem', ['purpose', 'unit', 'quantity']);
  return { purpose: oneOf(row.purpose, 'purpose', DELIVERY_PURPOSES),
    unit: nullableString(row.unit, 'unit'), quantity: decimalQuantity(row.quantity, 'quantity') };
}

function parseDeliveryProductItem(value: unknown): DeliveryProductItem {
  const row = exactObject(value, 'deliveryProductItem', [
    'productId', 'productNameSnapshot', 'productSkuSnapshot', 'productModelSnapshot',
    'unit', 'quantity',
  ]);
  return {
    productId: string(row.productId, 'productId'),
    productNameSnapshot: string(row.productNameSnapshot, 'productNameSnapshot'),
    productSkuSnapshot: nullableString(row.productSkuSnapshot, 'productSkuSnapshot'),
    productModelSnapshot: nullableString(row.productModelSnapshot, 'productModelSnapshot'),
    unit: nullableString(row.unit, 'unit'),
    quantity: decimalQuantity(row.quantity, 'quantity'),
  };
}

function parseDeliveryStaffItem(value: unknown): DeliveryStaffItem {
  const row = exactObject(value, 'deliveryStaffItem', ['staff', 'unit', 'quantity']);
  return { staff: parseStaffIdentity(row.staff), unit: nullableString(row.unit, 'unit'),
    quantity: decimalQuantity(row.quantity, 'quantity') };
}

function parsePageAndRange(value: Record<string, unknown>) {
  const limit = positiveInteger(value.limit, 'limit');
  if (limit > 200) invalid('limit');
  return { range: parseResolvedRange(value.range), total: nonNegativeInteger(value.total, 'total'),
    limit, offset: nonNegativeInteger(value.offset, 'offset') };
}

export function parseDeliveryReport(value: unknown): DeliveryReportResponse {
  const candidate = object(value);
  const groupBy = oneOf(candidate.groupBy, 'groupBy', DELIVERY_GROUPS);
  const row = exactObject(value, `deliveryReport.${groupBy}`, PAGE_KEYS);
  const base = parsePageAndRange(row);
  const values = array(row.items, 'items');
  if (groupBy === 'day') return { groupBy, ...base, items: values.map(parseDeliveryDayItem) };
  if (groupBy === 'purpose') return { groupBy, ...base, items: values.map(parseDeliveryPurposeItem) };
  if (groupBy === 'product') return { groupBy, ...base, items: values.map(parseDeliveryProductItem) };
  return { groupBy, ...base, items: values.map(parseDeliveryStaffItem) };
}

export function parseDashboardReport(value: unknown): DashboardReportResponse {
  const row = exactObject(value, 'dashboardReport', ['range', 'counters', 'completedTrend']);
  const counters = exactObject(row.counters, 'counters', [
    'activeJobCards', 'overdueJobCards', 'waitingApproval', 'revisionRequested',
    'completedInPeriod', 'cancelledInPeriod',
  ]);
  return {
    range: parseResolvedRange(row.range),
    counters: {
      activeJobCards: nonNegativeInteger(counters.activeJobCards, 'counters.activeJobCards'),
      overdueJobCards: nonNegativeInteger(counters.overdueJobCards, 'counters.overdueJobCards'),
      waitingApproval: nonNegativeInteger(counters.waitingApproval, 'counters.waitingApproval'),
      revisionRequested: nonNegativeInteger(counters.revisionRequested, 'counters.revisionRequested'),
      completedInPeriod: nonNegativeInteger(counters.completedInPeriod, 'counters.completedInPeriod'),
      cancelledInPeriod: nonNegativeInteger(counters.cancelledInPeriod, 'counters.cancelledInPeriod'),
    },
    completedTrend: array(row.completedTrend, 'completedTrend').map((value) => {
      const point = exactObject(value, 'completedTrend', ['date', 'count']);
      return { date: string(point.date, 'completedTrend.date'),
        count: nonNegativeInteger(point.count, 'completedTrend.count') };
    }),
  };
}

export function parseStaffReport(value: unknown): StaffReportResponse {
  const row = exactObject(value, 'staffReport', [
    'staff', 'range', 'counters', 'deliveriesByPurpose', 'meetingsByOutcome',
  ]);
  return { staff: parseStaffIdentity(row.staff), range: parseResolvedRange(row.range),
    counters: parseStaffCounters(row.counters), deliveriesByPurpose: array(
      row.deliveriesByPurpose, 'deliveriesByPurpose',
    ).map(parseDeliveryPurposeItem), meetingsByOutcome: parseMeetingsByOutcome(
      row.meetingsByOutcome,
    ) };
}

function parseApprovalItem(value: unknown): ApprovalItem {
  const row = exactObject(value, 'approvalItem', LIST_ITEM_KEYS);
  return {
    ...parsePersistedJobCardListItem(row),
    waitingMinutes: nonNegativeInteger(row.waitingMinutes, 'waitingMinutes'),
  };
}

export function parseApprovalReport(value: unknown): ApprovalReportResponse {
  const row = exactObject(value, 'approvalReport', ['summary', 'items', 'total', 'limit', 'offset']);
  const summary = exactObject(row.summary, 'summary', [
    'pendingCount', 'oldestWaitingMinutes', 'averageWaitingMinutes', 'under2Hours',
    'between2And8Hours', 'between8And24Hours', 'over24Hours',
  ]);
  const limit = positiveInteger(row.limit, 'limit');
  if (limit > 200) invalid('limit');
  return {
    summary: {
      pendingCount: nonNegativeInteger(summary.pendingCount, 'summary.pendingCount'),
      oldestWaitingMinutes: nullableNonNegativeInteger(summary.oldestWaitingMinutes, 'summary.oldestWaitingMinutes'),
      averageWaitingMinutes: nullableNonNegativeInteger(summary.averageWaitingMinutes, 'summary.averageWaitingMinutes'),
      under2Hours: nonNegativeInteger(summary.under2Hours, 'summary.under2Hours'),
      between2And8Hours: nonNegativeInteger(summary.between2And8Hours, 'summary.between2And8Hours'),
      between8And24Hours: nonNegativeInteger(summary.between8And24Hours, 'summary.between8And24Hours'),
      over24Hours: nonNegativeInteger(summary.over24Hours, 'summary.over24Hours'),
    },
    items: array(row.items, 'items').map(parseApprovalItem),
    total: nonNegativeInteger(row.total, 'total'), limit,
    offset: nonNegativeInteger(row.offset, 'offset'),
  };
}

function query(entries: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  Object.entries(entries).forEach(([key, value]) => {
    if (value !== null && value !== undefined) search.set(key, String(value));
  });
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

function rangeQuery(requestedRange: RequestedReportRange) {
  return { from: requestedRange?.from, to: requestedRange?.to };
}

export const getDashboardReport = async (requestedRange: RequestedReportRange) =>
  parseDashboardReport(await request(`/api/reports/dashboard${query(rangeQuery(requestedRange))}`));
export const getOwnStaffReport = async (requestedRange: RequestedReportRange) =>
  parseStaffReport(await request(`/api/reports/staff/me${query(rangeQuery(requestedRange))}`));
export const getStaffReport = async (staffUserId: string, requestedRange: RequestedReportRange) =>
  parseStaffReport(await request(`/api/reports/staff/${encodeURIComponent(staffUserId)}${query(rangeQuery(requestedRange))}`));
export const getDeliveryReport = async (input: DeliveryReportRequest) => parseDeliveryReport(
  await request(`/api/reports/deliveries${query({
    ...rangeQuery(input.requestedRange), groupBy: input.groupBy,
    staffUserId: input.staffUserId, limit: input.limit, offset: input.offset,
  })}`),
);
export const getApprovalReport = async (page: { limit?: number; offset?: number } = {}) =>
  parseApprovalReport(await request(`/api/reports/approvals${query(page)}`));
