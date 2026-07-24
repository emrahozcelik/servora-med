import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { CurrentUser } from '../services/api';
import { ApiError } from '../services/api';
import { createRequestGate } from '../services/request-gate';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { LoadingSkeleton, ResultState } from '../ui/antd';
import { JobBoard } from './JobBoard';
import { JobFilters } from './JobFilters';
import { JobList, type JobListState } from './JobList';
import type { JobCommandIntent } from './JobRow';
import { getJobCardBoard, listJobCards, type JobCardBoard } from './jobs-api';
import { canonicalJobSearchParams, enterBoard, forceMobileList, parseJobSearch, selectStatus, updateJobSearch, type JobSearchState } from './job-search';
import { NewJobMenu } from './NewJobMenu';

const PAGE_SIZE = 25;

function filterHref(params: URLSearchParams, status: JobSearchState['status']) {
  return `?${selectStatus(params, status ?? 'active').toString()}`;
}

function closedFilterHref(params: URLSearchParams) {
  return `?${selectStatus(params, 'closed').toString()}`;
}

type BoardState =
  | { kind: 'loading' }
  | { kind: 'ready'; board: JobCardBoard }
  | { kind: 'error'; message: string };

export function JobWorkspace({ user, notice = '', onCreateDelivery, onCreateTask, onCreateMeeting, onCommand, load = listJobCards, loadBoard = getJobCardBoard }: {
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
  const filters = parseJobSearch(params);
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
  const showBoard = filters.view === 'board' && filters.status !== 'closed';

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
      const { view: _view, status: _status, offset: _offset, ...requestFilters } = filters;
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
    || filters.dueAfter || filters.dueBefore || filters.status !== 'active');

  const quickViews = [
    { key: 'active' as const, label: 'Aktif işler', href: filterHref(params, 'active'), current: filters.status === 'active' },
    ...(user.role !== 'STAFF'
      ? [{
          key: 'WAITING_APPROVAL' as const,
          label: 'Onay kuyruğu',
          href: filterHref(params, 'WAITING_APPROVAL'),
          current: filters.status === 'WAITING_APPROVAL',
        }]
      : []),
    {
      key: 'REVISION_REQUESTED' as const,
      label: 'Düzeltme istenenler',
      href: filterHref(params, 'REVISION_REQUESTED'),
      current: filters.status === 'REVISION_REQUESTED',
    },
    {
      key: 'closed' as const,
      label: 'Biten işler',
      href: closedFilterHref(params),
      current: filters.status === 'closed',
    },
  ];

  return <main className="workspace job-workspace">
    {notice && <div className="success-message" role="status">{notice}</div>}
    <div className="workspace-heading job-workspace-heading">
      <div>
        <p className="eyebrow">Çalışma alanı</p>
        <h1>{user.role === 'STAFF' ? 'İşlerim' : 'İşler'}</h1>
      </div>
      <div className="workspace-create-actions workspace-create-actions--toolbar">
        <NewJobMenu
          onCreateMeeting={onCreateMeeting}
          onCreateTask={onCreateTask}
          onCreateDelivery={onCreateDelivery}
        />
      </div>
    </div>
    <nav className="job-quick-views" aria-label="Hızlı iş görünümleri" data-job-quick-views="true">
      {quickViews.map((view) => (
        <Link
          key={view.key}
          className="job-quick-view"
          to={{ search: view.href }}
          aria-current={view.current ? 'page' : undefined}
          data-state={view.current ? 'current' : 'idle'}
        >
          <span className="job-quick-view-label">{view.label}</span>
        </Link>
      ))}
    </nav>
    {filters.status === 'WAITING_APPROVAL' && (
      <p className="job-order-note">En uzun süredir onay bekleyen işler önce gösterilir.</p>
    )}
    <JobFilters user={user} filters={filters}
      onApply={(changes) => {
        const next = updateJobSearch(params, changes);
        setParams(changes.status && changes.status !== 'active'
          ? selectStatus(next, changes.status)
          : next);
      }}
      onChange={(_name, value) => setParams(selectStatus(params, value))}
      onViewChange={(view) => setParams(view === 'board' ? enterBoard(params) : forceMobileList(params))}
      showViewControl={filters.status !== 'closed'} />
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
          : <JobBoard board={boardState.board} user={user} params={params} compact={!isDesktop} />)
      : (
          <JobList
            state={state}
            user={user}
            hasFilters={hasFilters}
            onRetry={() => setReload((value) => value + 1)}
            onOffsetChange={(offset) => {
              const next = updateJobSearch(params, {});
              if (offset > 0) next.set('offset', String(offset));
              setParams(next);
            }}
            onCommand={(intent) => onCommand?.(intent)}
          />
        )}
  </main>;
}
