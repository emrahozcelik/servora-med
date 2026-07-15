import type { JobCardPriority, JobCardStatusFilter, JobCardType } from './jobs-api';

export type JobSearchState = {
  q?: string;
  status?: JobCardStatusFilter;
  type?: JobCardType;
  assignedTo?: string;
  customerId?: string;
  priority?: JobCardPriority;
  dueBefore?: string;
  dueAfter?: string;
  view: 'list' | 'board';
  offset: number;
};

const ALLOWED_KEYS = [
  'q', 'status', 'type', 'assignedTo', 'customerId', 'priority',
  'dueBefore', 'dueAfter', 'view', 'offset',
] as const;
const STATUSES = [
  'active', 'closed', 'all', 'NEW', 'PLANNED', 'IN_PROGRESS',
  'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED',
] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const TYPES = ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidJobFilterUuid(value: string) {
  return UUID.test(value);
}

function scalar(params: URLSearchParams, key: string) {
  const values = params.getAll(key);
  return values.length === 1 ? values[0]! : undefined;
}

function date(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? value : undefined;
}

export function parseJobSearch(params: URLSearchParams): JobSearchState {
  const view = scalar(params, 'view') === 'board' ? 'board' : 'list';
  const state: JobSearchState = { view, offset: 0 };
  const q = scalar(params, 'q')?.trim();
  if (q && Array.from(q).length <= 200) state.q = q;
  const type = scalar(params, 'type');
  if (TYPES.includes(type as JobCardType)) state.type = type as JobCardType;
  const assignedTo = scalar(params, 'assignedTo');
  if (assignedTo && isValidJobFilterUuid(assignedTo)) state.assignedTo = assignedTo;
  const customerId = scalar(params, 'customerId');
  if (customerId && isValidJobFilterUuid(customerId)) state.customerId = customerId;
  const priority = scalar(params, 'priority');
  if (PRIORITIES.includes(priority as JobCardPriority)) state.priority = priority as JobCardPriority;
  const dueAfter = date(scalar(params, 'dueAfter'));
  const dueBefore = date(scalar(params, 'dueBefore'));
  if (dueAfter && dueBefore && dueAfter > dueBefore) {
    // Invalid ranges canonicalize by dropping both bounds.
  } else {
    if (dueAfter) state.dueAfter = dueAfter;
    if (dueBefore) state.dueBefore = dueBefore;
  }
  if (view === 'list') {
    const status = scalar(params, 'status');
    state.status = STATUSES.includes(status as JobCardStatusFilter)
      ? status as JobCardStatusFilter : 'active';
    const offset = scalar(params, 'offset');
    if (offset && /^\d+$/.test(offset) && Number.isSafeInteger(Number(offset))) {
      state.offset = Number(offset);
    }
  }
  return state;
}

export function canonicalJobSearchParams(current: URLSearchParams) {
  const state = parseJobSearch(current);
  const next = new URLSearchParams();
  for (const key of ALLOWED_KEYS) {
    const value = state[key as keyof JobSearchState];
    if (value === undefined || value === '' || (key === 'status' && value === 'active')
      || (key === 'view' && value === 'list') || (key === 'offset' && value === 0)) continue;
    next.set(key, String(value));
  }
  return next;
}

function orderedParams(current: URLSearchParams) {
  const next = new URLSearchParams();
  for (const key of ALLOWED_KEYS) {
    const value = current.get(key);
    if (value !== null) next.set(key, value);
  }
  return next;
}

export function updateJobSearch(
  current: URLSearchParams,
  changes: Partial<Omit<JobSearchState, 'view' | 'offset'>>,
) {
  const next = canonicalJobSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || value === '' || (key === 'status' && value === 'active')) next.delete(key);
    else next.set(key, String(value));
  }
  next.delete('offset');
  return canonicalJobSearchParams(next);
}

export function enterBoard(current: URLSearchParams) {
  const next = canonicalJobSearchParams(current);
  next.delete('status');
  next.delete('offset');
  next.set('view', 'board');
  return next;
}

export function selectStatus(current: URLSearchParams, status: JobCardStatusFilter) {
  const next = canonicalJobSearchParams(current);
  next.set('status', status);
  next.set('view', 'list');
  next.set('offset', '0');
  return orderedParams(next);
}

export function forceMobileList(current: URLSearchParams) {
  const next = canonicalJobSearchParams(current);
  next.set('view', 'list');
  return next;
}
