import type { JobCardPriority, JobCardStatusFilter, JobCardType } from './jobs-api';
import { activeWorkflowStatuses, type ActiveWorkflowStatus } from './job-status-presentation';

export type JobViewMode = 'list' | 'board';

export type JobSearchState = {
  q?: string;
  status?: JobCardStatusFilter;
  type?: JobCardType;
  assignedTo?: string;
  customerId?: string;
  priority?: JobCardPriority;
  dueBefore?: string;
  dueAfter?: string;
  /** Server-owned overdue query state; only `true` is representable. */
  overdue?: true;
  /** Follow-up workspace filter; only `only` is representable. */
  followUp?: 'only';
  view: JobViewMode;
  offset: number;
};

/**
 * Membership = WHICH jobs the surface shows (quick-view semantics), independent
 * of view mode and of narrowing filters. View mode = HOW those jobs are
 * presented; narrowing filters reduce the membership set in place.
 *
 * Board lanes are exactly the five active workflow statuses. The board API
 * accepts no `status`/`overdue` key: active status membership is represented by
 * selecting its returned lane, while terminal and overdue membership is list-only.
 */
export type JobMembership =
  | { kind: 'active' }
  | { kind: 'followUp' }
  | { kind: 'overdue' }
  | { kind: 'approval' }
  | { kind: 'revision' }
  | { kind: 'closed' }
  | { kind: 'unscoped' };

const ALLOWED_KEYS = [
  'q', 'status', 'type', 'assignedTo', 'customerId', 'priority',
  'dueBefore', 'dueAfter', 'overdue', 'followUp', 'view', 'offset',
] as const;
const STATUSES = [
  'active', 'closed', 'all', 'NEW', 'ACCEPTED', 'IN_PROGRESS',
  'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED', 'INVALIDATED',
] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const TYPES = ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidJobFilterUuid(value: string) {
  return UUID.test(value);
}

export function jobMembership(state: JobSearchState): JobMembership {
  if (state.overdue === true) return { kind: 'overdue' };
  if (state.followUp === 'only') return { kind: 'followUp' };
  const status = state.status ?? 'active';
  if (status === 'WAITING_APPROVAL') return { kind: 'approval' };
  if (status === 'REVISION_REQUESTED') return { kind: 'revision' };
  if (status === 'closed' || status === 'COMPLETED' || status === 'CANCELLED'
    || status === 'INVALIDATED') return { kind: 'closed' };
  if (status === 'all') return { kind: 'unscoped' };
  return { kind: 'active' };
}

/**
 * The board can represent active workflow statuses because its payload already
 * contains one lane per active status. Terminal aggregates and overdue remain
 * list-only; the server API is deliberately unchanged.
 */
export function supportsBoard(state: JobSearchState): boolean {
  if (state.overdue === true) return false;
  const status = state.status ?? 'active';
  return status === 'active' || activeWorkflowStatuses.includes(status as ActiveWorkflowStatus);
}

/** Restricts an active-status board quick view to its truthful lane. */
export function boardLaneStatus(state: JobSearchState): ActiveWorkflowStatus | undefined {
  const status = state.status ?? 'active';
  return activeWorkflowStatuses.includes(status as ActiveWorkflowStatus)
    ? status as ActiveWorkflowStatus
    : undefined;
}

/**
 * Membership transitions (quick views, status changes, explicit mode switches)
 * keep the current effective board mode or the remembered preference when the
 * target membership supports board; list-only memberships coerce to list.
 */
export function resolveMembershipTransitionView(
  target: JobSearchState,
  currentView: JobViewMode,
  preferred: JobViewMode,
): JobViewMode {
  if (!supportsBoard(target)) return 'list';
  if (currentView === 'board' || preferred === 'board') return 'board';
  return 'list';
}

/**
 * Narrowing (search/filter apply) never changes the effective mode: it keeps the
 * current one, coercing to list only when the membership cannot support board.
 */
export function resolveNarrowingView(target: JobSearchState, currentView: JobViewMode): JobViewMode {
  return supportsBoard(target) ? currentView : 'list';
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
  const overdue = scalar(params, 'overdue') === 'true';
  const statusParam = scalar(params, 'status');
  const state: JobSearchState = { view: 'list', offset: 0 };
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
  const followUp = scalar(params, 'followUp');
  if (followUp === 'only') state.followUp = 'only';
  if (overdue) {
    // Overdue is a list-only server-owned view: active status, no manual date bounds.
    state.overdue = true;
    state.status = 'active';
    delete state.followUp;
  } else {
    const dueAfter = date(scalar(params, 'dueAfter'));
    const dueBefore = date(scalar(params, 'dueBefore'));
    if (dueAfter && dueBefore && dueAfter > dueBefore) {
      // Invalid ranges canonicalize by dropping both bounds.
    } else {
      if (dueAfter) state.dueAfter = dueAfter;
      if (dueBefore) state.dueBefore = dueBefore;
    }
    // The membership status is preserved for every view: a deep link that
    // combines `view=board` with a status narrowing must not silently slide
    // into the unfiltered active membership.
    state.status = STATUSES.includes(statusParam as JobCardStatusFilter)
      ? statusParam as JobCardStatusFilter : 'active';
  }
  state.view = scalar(params, 'view') === 'board' && supportsBoard(state)
    ? 'board' : 'list';
  if (state.view === 'list') {
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

/** Narrowing-only filter fields; membership and mode are handled explicitly. */
export type JobNarrowingChanges = Partial<Pick<JobSearchState,
  'q' | 'type' | 'assignedTo' | 'customerId' | 'priority' | 'dueAfter' | 'dueBefore'>>;

/** FilterSheet/search changes: narrowing fields plus optional membership changes. */
export type JobFilterChanges = JobNarrowingChanges & {
  status?: JobCardStatusFilter;
  followUp?: 'only';
  /** Only `undefined` is meaningful: it clears the overdue membership (sheet clear). */
  overdue?: true;
};

const NARROWING_KEYS = ['q', 'type', 'assignedTo', 'customerId', 'priority', 'dueAfter', 'dueBefore'] as const;

function membershipKey(membership: JobMembership): string {
  return membership.kind;
}

/**
 * Applies search/filter changes. Narrowing always narrows WITHIN the current
 * membership (overdue/followUp/status survive), pagination resets, and the
 * effective view mode is preserved. When the changes actually move the
 * membership, the current/preferred view applies and list-only memberships
 * coerce to list (announced by the caller).
 */
export function applyJobFilterChanges(
  current: URLSearchParams,
  changes: JobFilterChanges,
  preferred: JobViewMode,
): URLSearchParams {
  const before = parseJobSearch(current);
  const next = canonicalJobSearchParams(current);
  next.delete('offset');
  for (const key of NARROWING_KEYS) {
    if (!(key in changes)) continue;
    const value = changes[key];
    if (value === undefined || value === '') next.delete(key);
    else next.set(key, String(value));
  }
  // Filter-sheet status/follow-up controls may narrow a quick-view membership.
  // They only change membership when their value actually changes; this keeps
  // Geciken + ordinary filter apply inside Geciken.
  if (changes.status !== undefined && changes.status !== before.status) {
    next.delete('overdue');
    if (changes.status === 'active') next.delete('status');
    else next.set('status', changes.status);
  }
  if ('followUp' in changes && changes.followUp !== before.followUp) {
    if (changes.followUp === 'only') {
      next.delete('overdue');
      next.set('followUp', 'only');
    } else {
      next.delete('followUp');
    }
  }
  if ('overdue' in changes && changes.overdue === undefined) {
    next.delete('overdue');
  }
  const after = parseJobSearch(next);
  const view = membershipKey(jobMembership(after)) !== membershipKey(jobMembership(before))
    ? resolveMembershipTransitionView(after, before.view, preferred)
    : resolveNarrowingView(after, before.view);
  if (view === 'board') next.set('view', 'board');
  else next.delete('view');
  return canonicalJobSearchParams(next);
}

/** Explicit board selection (mode control on a board-capable membership). */
export function enterBoard(current: URLSearchParams) {
  const next = canonicalJobSearchParams(current);
  next.delete('offset');
  next.delete('view');
  if (!supportsBoard(parseJobSearch(next))) return canonicalJobSearchParams(next);
  next.set('view', 'board');
  return next;
}

/**
 * Opens the full LIST for a status (board lane "Tümünü gör" and closed-count
 * links). These links deliberately leave the board: the list owns
 * status-filtered memberships.
 */
export function listJobsByStatus(current: URLSearchParams, status: JobCardStatusFilter) {
  const next = canonicalJobSearchParams(current);
  next.delete('offset');
  next.delete('view');
  next.delete('overdue');
  if (status === 'active') next.delete('status');
  else next.set('status', status);
  return canonicalJobSearchParams(next);
}

/** Explicit list selection (mode control); preserves the membership. */
export function selectListMode(current: URLSearchParams) {
  const next = canonicalJobSearchParams(current);
  next.delete('view');
  return next;
}

/**
 * Status membership change from the desktop "Durum" select (and the filter
 * sheet). Preserves the current/preferred view when the target supports board.
 */
export function applyStatusFilter(
  current: URLSearchParams,
  status: JobCardStatusFilter,
  preferred: JobViewMode,
): URLSearchParams {
  const next = canonicalJobSearchParams(current);
  const before = parseJobSearch(current);
  next.delete('offset');
  next.delete('overdue');
  if (status === 'active') next.delete('status');
  else next.set('status', status);
  const after = parseJobSearch(next);
  const view = resolveMembershipTransitionView(
    after, before.view, preferred,
  );
  if (view === 'board') next.set('view', 'board');
  else next.delete('view');
  return canonicalJobSearchParams(next);
}

/**
 * Quick-view membership change for an explicit status shortcut. Drops the
 * date-range narrowing a status shortcut cannot carry while preserving the
 * ordinary narrowing filters and the effective/preferred mode where valid.
 */
export function statusQuickSearch(
  current: URLSearchParams,
  status: JobCardStatusFilter,
  preferred: JobViewMode,
): URLSearchParams {
  const before = parseJobSearch(current);
  const next = canonicalJobSearchParams(current);
  next.delete('offset');
  next.delete('overdue');
  next.delete('followUp');
  next.delete('dueBefore');
  next.delete('dueAfter');
  if (status === 'active') next.delete('status');
  else next.set('status', status);
  const after = parseJobSearch(next);
  const view = resolveMembershipTransitionView(after, before.view, preferred);
  if (view === 'board') next.set('view', 'board');
  else next.delete('view');
  return canonicalJobSearchParams(next);
}

/** Canonical overdue query: server-owned overdue=true with no date-range filters. */
export function overdueJobsSearch(current: URLSearchParams) {
  const next = canonicalJobSearchParams(current);
  next.delete('status');
  next.delete('offset');
  next.delete('dueBefore');
  next.delete('dueAfter');
  next.delete('view');
  next.delete('followUp');
  next.set('overdue', 'true');
  return canonicalJobSearchParams(next);
}

/**
 * Canonical follow-up jobs query: active follow-up JobCards. Clears
 * shortcut-specific state (overdue, date bounds, explicit status) while
 * preserving ordinary narrowing filters and the preferred view mode.
 */
export function followUpJobsSearch(current: URLSearchParams, preferred: JobViewMode) {
  const before = parseJobSearch(current);
  const next = canonicalJobSearchParams(current);
  next.delete('status');
  next.delete('offset');
  next.delete('dueBefore');
  next.delete('dueAfter');
  next.delete('overdue');
  next.set('followUp', 'only');
  const after = parseJobSearch(next);
  const view = resolveMembershipTransitionView(
    after, before.view, preferred,
  );
  if (view === 'board') next.set('view', 'board');
  else next.delete('view');
  return canonicalJobSearchParams(next);
}
