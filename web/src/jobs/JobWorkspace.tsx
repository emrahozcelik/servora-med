import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { CurrentUser } from '../services/api';
import { ApiError } from '../services/api';
import { createRequestGate } from '../services/request-gate';
import { JobBoard } from './JobBoard';
import { JobFilters } from './JobFilters';
import { JobList, type JobListState } from './JobList';
import type { JobCommandIntent } from './JobRow';
import { getJobCardBoard, listJobCards, type JobCardBoard } from './jobs-api';
import { canonicalJobSearchParams, enterBoard, forceMobileList, parseJobSearch, selectQuickStatusPreservingContext, selectStatus, updateJobSearch, type JobSearchState } from './job-search';
import { NewJobMenu } from './NewJobMenu';

const PAGE_SIZE = 25;

function filterHref(params: URLSearchParams, status: JobSearchState['status']) {
  return `?${selectStatus(params, status ?? 'active').toString()}`;
}

function closedFilterHref(params: URLSearchParams) {
  return `?${selectQuickStatusPreservingContext(params, 'closed').toString()}`;
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
  const [isDesktop, setIsDesktop] = useState<boolean | null>(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 64rem)').matches : null
  ));
  const queryKey = params.toString();
  const canonicalParams = canonicalJobSearchParams(params);
  const canonicalKey = canonicalParams.toString();
  const showBoard = filters.view === 'board' && filters.status !== 'closed';

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 64rem)');
    const handleChange = (event: MediaQueryListEvent) => {
      if (!event.matches) requestGate.current.next();
      setIsDesktop(event.matches);
    };
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
      if (isDesktop === false) {
        requestGate.current.next();
        setParams(forceMobileList(params), { replace: true });
        return;
      }
      if (isDesktop !== true) {
        requestGate.current.next();
        return;
      }
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
  }, [canonicalKey, isDesktop, load, loadBoard, queryKey, reload, showBoard, user.id, user.role]);

  if (showBoard && isDesktop === null) return <main className="workspace job-workspace">
    <p className="eyebrow">Çalışma alanı</p><div className="workspace-message">
      <h1>Kanban görünümü henüz kullanıma açık değil</h1>
      <p>Bu görünüm sonraki çalışma diliminde eklenecek. İş kayıtlarına liste görünümünden ulaşabilirsiniz.</p>
      <Link className="secondary-button" to={{ search: forceMobileList(params).toString() }}>Liste görünümüne dön</Link>
    </div>
  </main>;

  if (showBoard && isDesktop === false) return <main className="workspace job-workspace" aria-busy="true">
    <h1 className="sr-only">Liste görünümüne geçiliyor</h1>
  </main>;

  const hasFilters = Boolean(filters.q || filters.type || filters.assignedTo || filters.customerId || filters.priority
    || filters.dueAfter || filters.dueBefore || filters.status !== 'active');

  return <main className="workspace job-workspace">
    {notice && <div className="success-message" role="status">{notice}</div>}
    <div className="workspace-heading"><div><p className="eyebrow">Çalışma alanı</p><h1>{user.role === 'STAFF' ? 'İşlerim' : 'İşler'}</h1></div>
      <div className="workspace-create-actions">
        <NewJobMenu
          onCreateMeeting={onCreateMeeting}
          onCreateTask={onCreateTask}
          onCreateDelivery={onCreateDelivery}
        />
      </div></div>
    <nav className="job-quick-views" aria-label="Hızlı iş görünümleri">
      <Link to={{ search: filterHref(params, 'active') }} aria-current={filters.status === 'active' ? 'page' : undefined}>Aktif işler</Link>
      {user.role !== 'STAFF' && <Link to={{ search: filterHref(params, 'WAITING_APPROVAL') }}
        aria-current={filters.status === 'WAITING_APPROVAL' ? 'page' : undefined}>Onay kuyruğu</Link>}
      <Link to={{ search: filterHref(params, 'REVISION_REQUESTED') }}
        aria-current={filters.status === 'REVISION_REQUESTED' ? 'page' : undefined}>Düzeltme istenenler</Link>
      <Link to={{ search: closedFilterHref(params) }}
        aria-current={filters.status === 'closed' ? 'page' : undefined}>Biten işler</Link>
    </nav>
    {filters.status === 'WAITING_APPROVAL' && <p className="job-order-note">En uzun süredir onay bekleyen işler önce gösterilir.</p>}
    <JobFilters user={user} filters={filters}
      onApply={(changes) => setParams(updateJobSearch(params, changes))}
      onChange={(_name, value) => setParams(selectStatus(params, value))}
      onViewChange={(view) => setParams(view === 'board' ? enterBoard(params) : forceMobileList(params))}
      showViewControl={isDesktop === true && filters.status !== 'closed'} />
    {showBoard ? (boardState.kind === 'loading'
      ? <div className="job-results" aria-busy="true" aria-live="polite"><h2 className="sr-only">İş panosu yükleniyor</h2></div>
      : boardState.kind === 'error'
        ? <div className="workspace-message" role="alert"><h2>İş panosu yüklenemedi</h2><p>{boardState.message}</p></div>
        : <JobBoard board={boardState.board} params={params} />)
      : <JobList state={state} user={user} hasFilters={hasFilters} onRetry={() => setReload((value) => value + 1)}
      onOffsetChange={(offset) => { const next = updateJobSearch(params, {}); if (offset > 0) next.set('offset', String(offset)); setParams(next); }}
      onCommand={(intent) => onCommand?.(intent)} />}
  </main>;
}
