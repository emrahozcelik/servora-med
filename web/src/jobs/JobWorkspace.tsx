import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import type { CurrentUser } from '../services/api';
import { ApiError } from '../services/api';
import { createRequestGate } from '../services/request-gate';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { LoadingSkeleton, ResultState } from '../ui/antd';
import { JobBoard } from './JobBoard';
import { JobFilters } from './JobFilters';
import { JobList, type JobListState } from './JobList';
import { PageHeader } from '../ui/PageHeader';
import { ResolvedIdentityProvider, useOptionalResolvedIdentity } from '../shell/resolved-identity';
import { matchRouteIdentity } from '../shell/route-identity';
import type { JobCommandIntent } from './JobRow';
import { getJobCardBoard, listJobCards, type JobCardBoard } from './jobs-api';
import {
  applyJobFilterChanges, applyStatusFilter, boardLaneStatus, canonicalJobSearchParams,
  enterBoard, followUpJobsSearch, jobMembership, overdueJobsSearch, parseJobSearch,
  selectListMode, statusQuickSearch, supportsBoard,
  type JobFilterChanges, type JobMembership, type JobSearchState, type JobViewMode,
} from './job-search';
import { readJobViewPreference, writeJobViewPreference } from './job-view-preference';
import { NewJobMenu } from './NewJobMenu';
import { activeWorkflowStatusOptions } from './job-status-presentation';

const PAGE_SIZE = 25;

const STATUS_LABELS: Record<string, string> = {
  closed: 'Biten işler',
  all: 'Tümü',
  COMPLETED: 'Tamamlandı',
  CANCELLED: 'İptal edildi',
  INVALIDATED: 'Geçersiz',
  ...Object.fromEntries(activeWorkflowStatusOptions.map(({ value, label }) => [value, label])),
};

/** Page-owned, non-blocking announcement for a user-triggered list-only coercion. */
function listOnlyNotice(state: JobSearchState): string {
  if (state.overdue) return 'Geciken işler yalnızca liste görünümünde gösterilir.';
  if (state.status === 'closed') return 'Biten işler yalnızca liste görünümünde gösterilir.';
  if (state.status && state.status !== 'active') {
    const label = STATUS_LABELS[state.status] ?? 'Seçilen görünüm';
    return `${label} yalnızca liste görünümünde gösterilir.`;
  }
  return 'Bu görünüm yalnızca liste olarak desteklenir.';
}

function filterHref(params: URLSearchParams, status: JobSearchState['status'], preferred: JobViewMode) {
  return `?${statusQuickSearch(params, status ?? 'active', preferred).toString()}`;
}

function closedFilterHref(params: URLSearchParams, preferred: JobViewMode) {
  return `?${statusQuickSearch(params, 'closed', preferred).toString()}`;
}

function overdueFilterHref(params: URLSearchParams) {
  return `?${overdueJobsSearch(params).toString()}`;
}

function followUpFilterHref(params: URLSearchParams, preferred: JobViewMode) {
  return `?${followUpJobsSearch(params, preferred).toString()}`;
}

type BoardState =
  | { kind: 'loading' }
  | { kind: 'ready'; board: JobCardBoard }
  | { kind: 'error'; message: string };

export function JobWorkspace(props: {
  user: CurrentUser;
  notice?: string;
  onCreateDelivery?: () => void;
  onCreateTask?: () => void;
  onCreateMeeting?: () => void;
  onCommand?: (intent: JobCommandIntent) => void;
  load?: typeof listJobCards;
  loadBoard?: typeof getJobCardBoard;
}) {
  const location = useLocation();
  const resolved = useOptionalResolvedIdentity();
  if (!resolved) {
    const match = matchRouteIdentity(location.pathname);
    if (!match) return null;
    return <ResolvedIdentityProvider match={match} role={props.user.role}>
      <JobWorkspaceContent {...props} />
    </ResolvedIdentityProvider>;
  }
  return <JobWorkspaceContent {...props} />;
}

function JobWorkspaceContent({ user, notice = '', onCreateDelivery, onCreateTask, onCreateMeeting, onCommand, load = listJobCards, loadBoard = getJobCardBoard }: {
  user: CurrentUser;
  notice?: string;
  onCreateDelivery?: () => void;
  onCreateTask?: () => void;
  onCreateMeeting?: () => void;
  onCommand?: (intent: JobCommandIntent) => void;
  load?: typeof listJobCards;
  loadBoard?: typeof getJobCardBoard;
}) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const filters = parseJobSearch(params);
  const membership = jobMembership(filters);
  const boardSupported = supportsBoard(filters);
  const [preferredView, setPreferredView] = useState<JobViewMode>(() => readJobViewPreference());
  const [modeNotice, setModeNotice] = useState('');
  const modeNoticeSearch = useRef<string | null>(null);
  const [state, setState] = useState<JobListState>({ kind: 'loading' });
  const [boardState, setBoardState] = useState<BoardState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const requestGate = useRef(createRequestGate());
  const [isDesktop, setIsDesktop] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 64rem)').matches : false
  ));
  const queryKey = params.toString();
  const canonicalParams = canonicalJobSearchParams(params);
  const canonicalKey = canonicalParams.toString();
  // Membership already canonicalizes the mode for list-only views (Biten,
  // Geciken and unsupported terminal/unscoped statuses), so board is only ever
  // effective when valid. Active status memberships may select one board lane.
  const showBoard = filters.view === 'board' && boardSupported;

  // Consume a one-shot list-only coercion announcement carried by the
  // transition that caused it (quick-view link / status change). Router state
  // is cleared immediately so re-renders and back/forward cannot replay it.
  const incomingViewNotice = (location.state as { jobsViewNotice?: unknown } | null)?.jobsViewNotice;
  useEffect(() => {
    if (typeof incomingViewNotice === 'string' && incomingViewNotice) {
      modeNoticeSearch.current = location.search;
      setModeNotice(incomingViewNotice);
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
      return;
    }
    if (modeNoticeSearch.current !== null && modeNoticeSearch.current !== location.search) {
      modeNoticeSearch.current = null;
      setModeNotice('');
    }
  }, [incomingViewNotice, location.pathname, location.search, navigate]);

  /** Membership transition that announces a user-triggered board → list coercion. */
  function applyMembershipTransition(next: URLSearchParams) {
    const nextState = parseJobSearch(next);
    const changed = filters.view === 'board' && nextState.view === 'list';
    const nextSearch = next.toString();
    modeNoticeSearch.current = changed ? (nextSearch ? `?${nextSearch}` : '') : null;
    setModeNotice(changed ? listOnlyNotice(nextState) : '');
    setParams(next);
  }

  function clearFilters() {
    const next = applyJobFilterChanges(params, {
      q: undefined, type: undefined, assignedTo: undefined, customerId: undefined,
      priority: undefined, dueAfter: undefined, dueBefore: undefined, followUp: undefined,
      overdue: undefined, status: 'active',
    }, preferredView);
    const resetMembership = membership.kind !== 'active';
    const nextSearch = next.toString();
    modeNoticeSearch.current = resetMembership ? (nextSearch ? `?${nextSearch}` : '') : null;
    setModeNotice(resetMembership ? 'Filtreler temizlendi; Aktif işler görünümüne dönüldü.' : '');
    setParams(next);
  }

  // Keep the current membership visible inside the horizontally scrolling
  // quick-view strip without ever scrolling the page itself.
  const quickViewsRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const strip = quickViewsRef.current;
    const current = strip?.querySelector<HTMLElement>('[data-state="current"]');
    if (!strip || !current) return;
    const target = current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
    strip.scrollLeft = Math.max(0, target);
  }, [canonicalKey]);

  useRealtimeInvalidation(['job-list', 'job-board'], () => {
    setReload((value) => value + 1);
  });

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 64rem)');
    const handleChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
    setIsDesktop(media.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (queryKey !== canonicalKey) {
      requestGate.current.next();
      setParams(canonicalParams, { replace: true });
      return;
    }
    if (showBoard) {
      const generation = requestGate.current.next();
      setBoardState({ kind: 'loading' });
      const { view: _view, status: _status, offset: _offset, overdue: _overdue, ...requestFilters } = filters;
      if (user.role === 'STAFF') delete requestFilters.assignedTo;
      loadBoard(requestFilters).then((board) => {
        if (requestGate.current.isCurrent(generation)) setBoardState({ kind: 'ready', board });
      }).catch((caught) => {
        if (!requestGate.current.isCurrent(generation)) return;
        const error = caught instanceof ApiError ? caught : new ApiError(0, 'UNKNOWN_ERROR', 'İş panosu yüklenemedi.', true);
        setBoardState({ kind: 'error', message: error.message });
      });
      return () => { requestGate.current.next(); };
    }
    const generation = requestGate.current.next();
    setState({ kind: 'loading' });
    const { view: _view, ...requestFilters } = filters;
    if (user.role === 'STAFF') delete requestFilters.assignedTo;
    load({ ...requestFilters, limit: PAGE_SIZE }).then((page) => {
      if (!requestGate.current.isCurrent(generation)) return;
      const emptyTotalPastStart = page.total === 0 && page.items.length === 0 && filters.offset > 0;
      const pastPositiveTotal = page.total > 0 && page.items.length === 0 && page.offset >= page.total;
      if (emptyTotalPastStart || pastPositiveTotal) {
        const lastOffset = page.total === 0 ? 0 : Math.floor((page.total - 1) / page.limit) * page.limit;
        const next = canonicalJobSearchParams(new URLSearchParams(queryKey));
        if (lastOffset > 0) next.set('offset', String(lastOffset));
        else next.delete('offset');
        setParams(next, { replace: true });
        return;
      }
      setState({ kind: 'ready', page });
    }).catch((caught) => {
      if (!requestGate.current.isCurrent(generation)) return;
      const error = caught instanceof ApiError ? caught : new ApiError(0, 'UNKNOWN_ERROR', 'İşler yüklenemedi.', true);
      setState({ kind: 'error', code: error.code, message: error.message, retryable: error.retryable });
    });
    return () => { requestGate.current.next(); };
  // queryKey owns filter identity; parsed filters are reconstructed from it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonicalKey, load, loadBoard, queryKey, reload, showBoard, user.id, user.role]);

  const hasFilters = Boolean(filters.q || filters.type || filters.assignedTo || filters.customerId || filters.priority
    || filters.dueAfter || filters.dueBefore || filters.status !== 'active' || filters.overdue || filters.followUp === 'only');

  const quickViews: Array<{
    key: string;
    label: string;
    href: string;
    membership: JobMembership;
    current: boolean;
  }> = [
    {
      key: 'active',
      label: 'Aktif işler',
      href: filterHref(params, 'active', preferredView),
      membership: { kind: 'active' },
      current: membership.kind === 'active',
    },
    {
      key: 'followUp',
      label: 'Takip işleri',
      href: followUpFilterHref(params, preferredView),
      membership: { kind: 'followUp' },
      current: membership.kind === 'followUp',
    },
    ...(user.role !== 'STAFF'
      ? [{
          key: 'WAITING_APPROVAL',
          label: 'Onay kuyruğu',
          href: filterHref(params, 'WAITING_APPROVAL', preferredView),
          membership: { kind: 'approval' } as JobMembership,
          current: membership.kind === 'approval',
        }]
      : []),
    {
      key: 'REVISION_REQUESTED',
      label: 'Düzeltme istenenler',
      href: filterHref(params, 'REVISION_REQUESTED', preferredView),
      membership: { kind: 'revision' },
      current: membership.kind === 'revision',
    },
    {
      key: 'closed',
      label: 'Biten işler',
      href: closedFilterHref(params, preferredView),
      membership: { kind: 'closed' },
      current: membership.kind === 'closed',
    },
    {
      key: 'overdue',
      label: 'Geciken',
      href: overdueFilterHref(params),
      membership: { kind: 'overdue' },
      current: membership.kind === 'overdue',
    },
  ];

  return <main className="workspace job-workspace">
    {notice && <div className="success-message" role="status">{notice}</div>}
    <PageHeader
      eyebrow="Çalışma alanı"
      actions={<div className="workspace-create-actions workspace-create-actions--toolbar">
        <NewJobMenu
          onCreateMeeting={onCreateMeeting}
          onCreateTask={onCreateTask}
          onCreateDelivery={onCreateDelivery}
        />
      </div>}
    />
    <nav ref={quickViewsRef} className="job-quick-views" aria-label="Hızlı iş görünümleri" data-job-quick-views="true">
      {quickViews.map((view) => {
        // Entering a list-only membership while the board was effective is a
        // user-triggered coercion: the destination announces it once.
        const target = parseJobSearch(new URLSearchParams(view.href));
        const coerces = filters.view === 'board' && !supportsBoard(target);
        return (
          <Link
            key={view.key}
            className="job-quick-view"
            to={{ search: view.href }}
            state={coerces ? { jobsViewNotice: listOnlyNotice(target) } : undefined}
            aria-current={view.current ? 'page' : undefined}
            data-state={view.current ? 'current' : 'idle'}
          >
            <span className="job-quick-view-label">{view.label}</span>
          </Link>
        );
      })}
    </nav>
    {filters.status === 'WAITING_APPROVAL' && (
      <p className="job-order-note">En uzun süredir onay bekleyen işler önce gösterilir.</p>
    )}
    <JobFilters user={user} filters={filters}
      onApply={(changes: JobFilterChanges) => {
        applyMembershipTransition(applyJobFilterChanges(params, changes, preferredView));
      }}
      onClear={clearFilters}
      onChange={(_name, value) => {
        applyMembershipTransition(applyStatusFilter(params, value, preferredView));
      }}
      onViewChange={(view) => {
        setPreferredView(view);
        writeJobViewPreference(view);
        modeNoticeSearch.current = null;
        setModeNotice('');
        setParams(view === 'board' ? enterBoard(params) : selectListMode(params));
      }}
      boardSupported={boardSupported} />
    {modeNotice && (
      <p className="sr-only" role="status" aria-live="polite" data-job-view-mode-notice="true">
        {modeNotice}
      </p>
    )}
    {showBoard
      ? (boardState.kind === 'loading'
        ? (
            <div className="job-results" data-job-results-state="board-loading">
              <LoadingSkeleton title="İş panosu yükleniyor" headingLevel={2} rows={3} />
            </div>
          )
        : boardState.kind === 'error'
          ? (
              <div className="job-results" data-job-results-state="board-error">
                <ResultState
                  status="error"
                  title="İş panosu yüklenemedi"
                  description={boardState.message}
                  headingLevel={2}
                />
              </div>
            )
          : <JobBoard board={boardState.board} user={user} params={params}
              visibleStatus={boardLaneStatus(filters)} compact={!isDesktop} />)
      : (
          <JobList
            state={state}
            user={user}
            hasFilters={hasFilters}
            onRetry={() => setReload((value) => value + 1)}
            onOffsetChange={(offset) => {
              const next = applyJobFilterChanges(params, {}, preferredView);
              if (offset > 0) next.set('offset', String(offset));
              setParams(next);
            }}
            onCommand={(intent) => onCommand?.(intent)}
          />
        )}
  </main>;
}
