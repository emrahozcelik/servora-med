const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELIVERY_GROUPS = ['day', 'purpose', 'product', 'staff'] as const;

export type DashboardUrlState = {
  from: string | null;
  to: string | null;
  canonical: boolean;
};
export type DeliveryUrlState = {
  from: string | null;
  to: string | null;
  groupBy: (typeof DELIVERY_GROUPS)[number];
  staffUserId: string | null;
  offset: number;
  canonical: boolean;
};
export type ApprovalUrlState = { offset: number; canonical: boolean };

function strictDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year!, month! - 1, day!);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month! - 1
    && date.getUTCDate() === day;
}

export function validateRequestedRange(from: string, to: string):
  | { ok: true; value: { from: string; to: string } }
  | { ok: false; errors: Array<{ field: 'from' | 'to'; message: string }> } {
  const errors: Array<{ field: 'from' | 'to'; message: string }> = [];
  if (!strictDate(from)) errors.push({ field: 'from', message: 'Geçerli bir başlangıç tarihi girin.' });
  if (!strictDate(to)) errors.push({ field: 'to', message: 'Geçerli bir bitiş tarihi girin.' });
  if (errors.length === 0) {
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (days < 0 || days > 365) errors.push({
      field: 'to', message: 'Tarih aralığı en fazla 366 gün olmalı ve başlangıçtan önce olmamalıdır.',
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { from, to } };
}

function once(search: URLSearchParams, key: string) {
  const values = search.getAll(key);
  return values.length === 1 ? values[0]! : null;
}

function readRange(search: URLSearchParams) {
  const from = once(search, 'from');
  const to = once(search, 'to');
  if (from === null && to === null && !search.has('from') && !search.has('to')) {
    return { from: null, to: null };
  }
  if (from === null || to === null) return { from: null, to: null };
  const result = validateRequestedRange(from, to);
  return result.ok ? result.value : { from: null, to: null };
}

function nonNegativeOffset(search: URLSearchParams) {
  if (!search.has('offset')) return 0;
  const value = once(search, 'offset');
  if (value === null || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function same(search: URLSearchParams, canonical: URLSearchParams) {
  const actual = new URLSearchParams(search);
  const expected = new URLSearchParams(canonical);
  actual.sort();
  expected.sort();
  return actual.toString() === expected.toString();
}

export function dashboardSearch(state: DashboardUrlState) {
  const search = new URLSearchParams();
  if (state.from !== null && state.to !== null) {
    search.set('from', state.from);
    search.set('to', state.to);
  }
  return search;
}

export function deliverySearch(state: DeliveryUrlState) {
  const search = dashboardSearch(state);
  if (state.groupBy !== 'day') search.set('groupBy', state.groupBy);
  if (state.staffUserId !== null) search.set('staffUserId', state.staffUserId);
  if (state.offset !== 0) search.set('offset', String(state.offset));
  return search;
}

export function approvalSearch(state: ApprovalUrlState) {
  const search = new URLSearchParams();
  if (state.offset !== 0) search.set('offset', String(state.offset));
  return search;
}

export function readDashboardSearch(search: URLSearchParams): DashboardUrlState {
  const range = readRange(search);
  const state = { ...range, canonical: true };
  return { ...state, canonical: same(search, dashboardSearch(state)) };
}

export function readDeliverySearch(search: URLSearchParams): DeliveryUrlState {
  const range = readRange(search);
  const rawGroup = search.has('groupBy') ? once(search, 'groupBy') : 'day';
  const groupBy = rawGroup !== null && (DELIVERY_GROUPS as readonly string[]).includes(rawGroup)
    ? rawGroup as DeliveryUrlState['groupBy'] : 'day';
  const rawStaff = search.has('staffUserId') ? once(search, 'staffUserId') : null;
  const staffUserId = rawStaff !== null && UUID_PATTERN.test(rawStaff) ? rawStaff : null;
  const state = { ...range, groupBy, staffUserId, offset: nonNegativeOffset(search), canonical: true };
  return { ...state, canonical: same(search, deliverySearch(state)) };
}

export function readApprovalSearch(search: URLSearchParams): ApprovalUrlState {
  const state = { offset: nonNegativeOffset(search), canonical: true };
  return { ...state, canonical: same(search, approvalSearch(state)) };
}
