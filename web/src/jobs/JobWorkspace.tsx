import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { CurrentUser } from '../services/api';
import { ApiError } from '../services/api';
import { createRequestGate } from '../services/request-gate';
import { JobFilters } from './JobFilters';
import { JobList, type JobListState } from './JobList';
import type { JobCommandIntent } from './JobRow';
import { listJobCards } from './jobs-api';
import { canonicalJobSearchParams, forceMobileList, parseJobSearch, updateJobSearch, type JobSearchState } from './job-search';

const PAGE_SIZE = 25;

function filterHref(params: URLSearchParams, status: JobSearchState['status']) {
  return `?${updateJobSearch(params, { status }).toString()}`.replace(/^\?$/, '');
}

export function JobWorkspace({ user, notice = '', onCreate, onCommand, load = listJobCards }: {
  user: CurrentUser;
  notice?: string;
  onCreate?: () => void;
  onCommand?: (intent: JobCommandIntent) => void;
  load?: typeof listJobCards;
}) {
  const [params, setParams] = useSearchParams();
  const filters = parseJobSearch(params);
  const [state, setState] = useState<JobListState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const requestGate = useRef(createRequestGate());
  const queryKey = params.toString();
  const canonicalParams = canonicalJobSearchParams(params);
  const canonicalKey = canonicalParams.toString();

  useEffect(() => {
    if (queryKey !== canonicalKey) {
      requestGate.current.next();
      setParams(canonicalParams, { replace: true });
      return;
    }
    if (filters.view === 'board') {
      requestGate.current.next();
      return;
    }
    const generation = requestGate.current.next();
    setState({ kind: 'loading' });
    const { view: _view, ...requestFilters } = filters;
    if (user.role === 'STAFF') delete requestFilters.assignedTo;
    load({ ...requestFilters, limit: PAGE_SIZE }).then((page) => {
      if (!requestGate.current.isCurrent(generation)) return;
      if (page.total > 0 && page.items.length === 0 && page.offset >= page.total) {
        const lastOffset = Math.floor((page.total - 1) / page.limit) * page.limit;
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
  }, [canonicalKey, load, queryKey, reload, user.id, user.role]);

  if (filters.view === 'board') return <main className="workspace job-workspace">
    <p className="eyebrow">Çalışma alanı</p><div className="workspace-message">
      <h1>Kanban görünümü henüz kullanıma açık değil</h1>
      <p>Bu görünüm sonraki çalışma diliminde eklenecek. İş kayıtlarına liste görünümünden ulaşabilirsiniz.</p>
      <Link className="secondary-button" to={{ search: forceMobileList(params).toString() }}>Liste görünümüne dön</Link>
    </div>
  </main>;

  const hasFilters = Boolean(filters.q || filters.type || filters.assignedTo || filters.customerId || filters.priority
    || filters.dueAfter || filters.dueBefore || filters.status !== 'active');

  return <main className="workspace job-workspace">
    {notice && <div className="success-message" role="status">{notice}</div>}
    <div className="workspace-heading"><div><p className="eyebrow">Çalışma alanı</p><h1>{user.role === 'STAFF' ? 'İşlerim' : 'İşler'}</h1></div>
      {onCreate && <button className="primary-button compact-button" type="button" onClick={onCreate}>Yeni teslim</button>}</div>
    <nav className="job-quick-views" aria-label="Hızlı iş görünümleri">
      <Link to={{ search: filterHref(params, 'active') }} aria-current={filters.status === 'active' ? 'page' : undefined}>Aktif işler</Link>
      {user.role !== 'STAFF' && <Link to={{ search: filterHref(params, 'WAITING_APPROVAL') }}
        aria-current={filters.status === 'WAITING_APPROVAL' ? 'page' : undefined}>Onay kuyruğu</Link>}
      <Link to={{ search: filterHref(params, 'REVISION_REQUESTED') }}
        aria-current={filters.status === 'REVISION_REQUESTED' ? 'page' : undefined}>Düzeltme istenenler</Link>
    </nav>
    {filters.status === 'WAITING_APPROVAL' && <p className="job-order-note">En uzun süredir onay bekleyen işler önce gösterilir.</p>}
    <JobFilters user={user} filters={filters}
      onApply={(changes) => setParams(updateJobSearch(params, changes))}
      onChange={(name, value) => setParams(updateJobSearch(params, { [name]: value || undefined }))} />
    <JobList state={state} user={user} hasFilters={hasFilters} onRetry={() => setReload((value) => value + 1)}
      onOffsetChange={(offset) => { const next = updateJobSearch(params, {}); if (offset > 0) next.set('offset', String(offset)); setParams(next); }}
      onCommand={(intent) => onCommand?.(intent)} />
  </main>;
}
