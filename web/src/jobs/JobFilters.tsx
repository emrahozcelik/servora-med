import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { CurrentUser } from '../services/api';
import { FilterSheet, countTruthy } from '../ui/FilterSheet';
import type { JobCardStatusFilter } from './jobs-api';
import { jobTypeLabels } from './job-labels';
import { isValidJobFilterUuid, type JobSearchState } from './job-search';

type FilterName = 'status';
type FilterChanges = Partial<Omit<JobSearchState, 'view' | 'offset'>>;
type DraftErrors = { assignedTo?: string; customerId?: string };
type AdvancedDraft = {
  type: string;
  assignedTo: string;
  customerId: string;
  priority: string;
  dueAfter: string;
  dueBefore: string;
};

function advancedFromFilters(filters: JobSearchState): AdvancedDraft {
  return {
    type: filters.type ?? '',
    assignedTo: filters.assignedTo ?? '',
    customerId: filters.customerId ?? '',
    priority: filters.priority ?? '',
    dueAfter: filters.dueAfter ?? '',
    dueBefore: filters.dueBefore ?? '',
  };
}

/** Compact filter sheet when shell is not desktop (same 64rem gate as AppShell). */
function useNarrow() {
  const desktopQuery = '(min-width: 64rem)';
  const [narrow, setNarrow] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? !window.matchMedia(desktopQuery).matches
      : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(desktopQuery);
    const onChange = (event: MediaQueryListEvent) => setNarrow(!event.matches);
    media.addEventListener('change', onChange);
    setNarrow(!media.matches);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export function countActiveJobFilters(filters: JobSearchState): number {
  return countTruthy([
    filters.q,
    filters.status && filters.status !== 'active' ? filters.status : '',
    filters.type,
    filters.assignedTo,
    filters.customerId,
    filters.priority,
    filters.dueAfter,
    filters.dueBefore,
  ]);
}

export function JobFilters({ user, filters, onApply, onChange, onViewChange, showViewControl }: {
  user: CurrentUser;
  filters: JobSearchState;
  onApply: (changes: FilterChanges) => void;
  onChange: (name: FilterName, value: JobCardStatusFilter) => void;
  onViewChange: (view: JobSearchState['view']) => void;
  showViewControl: boolean;
}) {
  const narrow = useNarrow();
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [search, setSearch] = useState(filters.q ?? '');
  const [advanced, setAdvanced] = useState(() => advancedFromFilters(filters));
  const [draftStatus, setDraftStatus] = useState(filters.status ?? 'active');
  const [errors, setErrors] = useState<DraftErrors>({});
  const activeCount = countActiveJobFilters(filters);

  useEffect(() => setSearch(filters.q ?? ''), [filters.q]);
  useEffect(() => {
    setAdvanced(advancedFromFilters(filters));
    setDraftStatus(filters.status ?? 'active');
    setErrors({});
  }, [filters.type, filters.assignedTo, filters.customerId, filters.priority, filters.dueAfter, filters.dueBefore, filters.status]);

  function syncDraftFromUrl() {
    setSearch(filters.q ?? '');
    setAdvanced(advancedFromFilters(filters));
    setDraftStatus(filters.status ?? 'active');
    setErrors({});
  }

  function openSheet() {
    syncDraftFromUrl();
    setSheetOpen(true);
  }

  function dismissSheet() {
    syncDraftFromUrl();
    setSheetOpen(false);
  }

  function buildChanges(nextSearch: string, nextAdvanced: AdvancedDraft): FilterChanges | null {
    const nextErrors: DraftErrors = {};
    if (user.role !== 'STAFF' && nextAdvanced.assignedTo && !isValidJobFilterUuid(nextAdvanced.assignedTo)) {
      nextErrors.assignedTo = 'Geçerli bir personel kimliği girin.';
    }
    if (nextAdvanced.customerId && !isValidJobFilterUuid(nextAdvanced.customerId)) {
      nextErrors.customerId = 'Geçerli bir müşteri kimliği girin.';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return null;
    return {
      q: nextSearch.trim() || undefined,
      type: nextAdvanced.type === 'PRODUCT_DELIVERY' || nextAdvanced.type === 'GENERAL_TASK'
        || nextAdvanced.type === 'SALES_MEETING'
        ? nextAdvanced.type : undefined,
      assignedTo: nextAdvanced.assignedTo || undefined,
      customerId: nextAdvanced.customerId || undefined,
      priority: nextAdvanced.priority === 'low' || nextAdvanced.priority === 'normal'
        || nextAdvanced.priority === 'high' || nextAdvanced.priority === 'urgent'
        ? nextAdvanced.priority : undefined,
      dueAfter: nextAdvanced.dueAfter || undefined,
      dueBefore: nextAdvanced.dueBefore || undefined,
    };
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const changes = buildChanges(search, advanced);
    if (!changes) return;
    onApply(changes);
  }

  function applySheet() {
    const changes = buildChanges(search, advanced);
    if (!changes) return;
    onApply({
      ...changes,
      status: draftStatus as JobCardStatusFilter,
    });
    setSheetOpen(false);
  }

  function clearSheet() {
    setSearch('');
    setAdvanced({
      type: '', assignedTo: '', customerId: '', priority: '', dueAfter: '', dueBefore: '',
    });
    setDraftStatus('active');
    setErrors({});
    onApply({
      q: undefined, type: undefined, assignedTo: undefined, customerId: undefined,
      priority: undefined, dueAfter: undefined, dueBefore: undefined,
      status: 'active',
    });
    setSheetOpen(false);
  }

  const advancedFields = (
    <div className="job-filter-secondary">
      <div className="field-group"><label htmlFor="job-priority">Öncelik</label>
        <select id="job-priority" value={advanced.priority} onChange={(event) => setAdvanced({ ...advanced, priority: event.target.value })}>
          <option value="">Tümü</option><option value="low">Düşük</option><option value="normal">Normal</option><option value="high">Yüksek</option><option value="urgent">Acil</option>
        </select></div>
      <div className="field-group"><label htmlFor="job-type">İş türü</label>
        <select id="job-type" value={advanced.type} onChange={(event) => setAdvanced({ ...advanced, type: event.target.value })}>
          <option value="">Tümü</option>
          {Object.entries(jobTypeLabels).map(([value, label]) =>
            <option key={value} value={value}>{label}</option>)}
        </select></div>
      {user.role !== 'STAFF' && <div className="field-group"><label htmlFor="job-assignee">Sorumlu personel</label>
        <input id="job-assignee" maxLength={36} value={advanced.assignedTo} aria-invalid={errors.assignedTo ? true : undefined}
          aria-describedby={errors.assignedTo ? 'job-assignee-error' : undefined}
          onChange={(event) => setAdvanced({ ...advanced, assignedTo: event.target.value.trim() })} />
        {errors.assignedTo && <p className="field-error" id="job-assignee-error" role="alert">{errors.assignedTo}</p>}</div>}
      <div className="field-group"><label htmlFor="job-customer">Müşteri</label>
        <input id="job-customer" maxLength={36} value={advanced.customerId} aria-invalid={errors.customerId ? true : undefined}
          aria-describedby={errors.customerId ? 'job-customer-error' : undefined}
          onChange={(event) => setAdvanced({ ...advanced, customerId: event.target.value.trim() })} />
        {errors.customerId && <p className="field-error" id="job-customer-error" role="alert">{errors.customerId}</p>}</div>
      <div className="field-group"><label htmlFor="job-due-after">Başlangıç tarihi</label>
        <input id="job-due-after" type="date" value={advanced.dueAfter} onChange={(event) => setAdvanced({ ...advanced, dueAfter: event.target.value })} /></div>
      <div className="field-group"><label htmlFor="job-due-before">Bitiş tarihi</label>
        <input id="job-due-before" type="date" value={advanced.dueBefore} onChange={(event) => setAdvanced({ ...advanced, dueBefore: event.target.value })} /></div>
    </div>
  );

  if (narrow) {
    return (
      <div className="filter-region">
      <div className="job-filters job-filters--compact surface">
        <form className="job-filter-compact-bar" role="search" onSubmit={submit}>
          <div className="field-group"><label htmlFor="job-search">İş ara</label>
            <input id="job-search" type="search" maxLength={200} value={search}
              onChange={(event) => setSearch(event.target.value)} /></div>
          <button className="secondary-button job-search-submit" type="submit">Ara</button>
          <button
            ref={filterTriggerRef}
            type="button"
            className="secondary-button filter-sheet-trigger"
            aria-expanded={sheetOpen}
            onClick={openSheet}
          >
            {activeCount > 0 ? `Filtreler ${activeCount}` : 'Filtreler'}
          </button>
        </form>
        <FilterSheet
          open={sheetOpen}
          title="İş filtreleri"
          onDismiss={dismissSheet}
          onApply={applySheet}
          onClear={clearSheet}
          returnFocusRef={filterTriggerRef}
        >
          {showViewControl && <div className="field-group"><label htmlFor="job-view-sheet">Görünüm</label>
            <select id="job-view-sheet" value={filters.view}
              onChange={(event) => onViewChange(event.target.value as JobSearchState['view'])}>
              <option value="list">Liste</option><option value="board">Pano</option>
            </select></div>}
          <div className="field-group"><label htmlFor="job-status-sheet">Durum</label>
            <select id="job-status-sheet" value={draftStatus}
              onChange={(event) => setDraftStatus(event.target.value as JobCardStatusFilter)}>
              <option value="active">Aktif</option><option value="WAITING_APPROVAL">Onay bekliyor</option>
              <option value="REVISION_REQUESTED">Düzeltme istendi</option><option value="closed">Kapalı</option><option value="all">Tümü</option>
              <option value="NEW">Yeni</option><option value="ACCEPTED">Kabul edildi</option><option value="IN_PROGRESS">Devam ediyor</option>
              <option value="COMPLETED">Tamamlandı</option><option value="CANCELLED">İptal edildi</option>
            </select></div>
          {advancedFields}
        </FilterSheet>
      </div>
      </div>
    );
  }

  return <div className="filter-region"><form className="job-filters surface" role="search" onSubmit={submit}>
    <div className="job-filter-primary">
      <div className="field-group"><label htmlFor="job-search">İş ara</label>
        <input id="job-search" type="search" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      {showViewControl && <div className="field-group"><label htmlFor="job-view">Görünüm</label>
        <select id="job-view" value={filters.view} onChange={(event) => onViewChange(event.target.value as JobSearchState['view'])}>
          <option value="list">Liste</option><option value="board">Pano</option>
        </select></div>}
      <div className="field-group"><label htmlFor="job-status">Durum</label>
        <select id="job-status" value={filters.status ?? 'active'} onChange={(event) => onChange('status', event.target.value as JobCardStatusFilter)}>
          <option value="active">Aktif</option><option value="WAITING_APPROVAL">Onay bekliyor</option>
          <option value="REVISION_REQUESTED">Düzeltme istendi</option><option value="closed">Kapalı</option><option value="all">Tümü</option>
          <option value="NEW">Yeni</option><option value="ACCEPTED">Kabul edildi</option><option value="IN_PROGRESS">Devam ediyor</option>
          <option value="COMPLETED">Tamamlandı</option><option value="CANCELLED">İptal edildi</option>
        </select></div>
      <button className="secondary-button job-search-submit" type="submit">Ara</button>
    </div>
    <details className="job-filter-disclosure">
      <summary>Diğer filtreler</summary>
      {advancedFields}
    </details>
  </form></div>;
}
