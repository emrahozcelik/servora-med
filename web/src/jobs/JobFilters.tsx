import { useEffect, useState, type FormEvent } from 'react';

import type { CurrentUser } from '../services/api';
import type { JobCardStatusFilter } from './jobs-api';
import type { JobSearchState } from './job-search';

type FilterName = 'status';
type FilterChanges = Partial<Omit<JobSearchState, 'view' | 'offset'>>;

export function JobFilters({ user, filters, onApply, onChange }: {
  user: CurrentUser;
  filters: JobSearchState;
  onApply: (changes: FilterChanges) => void;
  onChange: (name: FilterName, value: JobCardStatusFilter) => void;
}) {
  const [search, setSearch] = useState(filters.q ?? '');
  const [advanced, setAdvanced] = useState({
    type: filters.type ?? '', assignedTo: filters.assignedTo ?? '', customerId: filters.customerId ?? '',
    priority: filters.priority ?? '', dueAfter: filters.dueAfter ?? '', dueBefore: filters.dueBefore ?? '',
  });
  useEffect(() => setSearch(filters.q ?? ''), [filters.q]);
  useEffect(() => setAdvanced({
    type: filters.type ?? '', assignedTo: filters.assignedTo ?? '', customerId: filters.customerId ?? '',
    priority: filters.priority ?? '', dueAfter: filters.dueAfter ?? '', dueBefore: filters.dueBefore ?? '',
  }), [filters.type, filters.assignedTo, filters.customerId, filters.priority, filters.dueAfter, filters.dueBefore]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onApply({
      q: search.trim() || undefined,
      type: advanced.type === 'PRODUCT_DELIVERY' ? advanced.type : undefined,
      assignedTo: advanced.assignedTo || undefined,
      customerId: advanced.customerId || undefined,
      priority: advanced.priority === 'low' || advanced.priority === 'normal' || advanced.priority === 'high' || advanced.priority === 'urgent' ? advanced.priority : undefined,
      dueAfter: advanced.dueAfter || undefined, dueBefore: advanced.dueBefore || undefined,
    });
  }

  return <form className="job-filters" role="search" onSubmit={submit}>
    <div className="job-filter-primary">
      <div className="field-group"><label htmlFor="job-search">İş ara</label>
        <input id="job-search" type="search" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      <div className="field-group"><label htmlFor="job-status">Durum</label>
        <select id="job-status" value={filters.status ?? 'active'} onChange={(event) => onChange('status', event.target.value as JobCardStatusFilter)}>
          <option value="active">Aktif</option><option value="WAITING_APPROVAL">Onay bekliyor</option>
          <option value="REVISION_REQUESTED">Düzeltme istendi</option><option value="closed">Kapalı</option><option value="all">Tümü</option>
          <option value="NEW">Yeni</option><option value="PLANNED">Planlandı</option><option value="IN_PROGRESS">Devam ediyor</option>
          <option value="COMPLETED">Tamamlandı</option><option value="CANCELLED">İptal edildi</option>
        </select></div>
      <button className="secondary-button job-search-submit" type="submit">Ara</button>
    </div>
    <details className="job-filter-disclosure">
      <summary>Diğer filtreler</summary>
      <div className="job-filter-secondary">
        <div className="field-group"><label htmlFor="job-priority">Öncelik</label>
          <select id="job-priority" value={advanced.priority} onChange={(event) => setAdvanced({ ...advanced, priority: event.target.value })}>
            <option value="">Tümü</option><option value="low">Düşük</option><option value="normal">Normal</option><option value="high">Yüksek</option><option value="urgent">Acil</option>
          </select></div>
        <div className="field-group"><label htmlFor="job-type">İş türü</label>
          <select id="job-type" value={advanced.type} onChange={(event) => setAdvanced({ ...advanced, type: event.target.value })}>
            <option value="">Tümü</option><option value="PRODUCT_DELIVERY">Ürün teslimi</option>
          </select></div>
        {user.role !== 'STAFF' && <div className="field-group"><label htmlFor="job-assignee">Sorumlu personel</label>
          <input id="job-assignee" maxLength={36} value={advanced.assignedTo} onChange={(event) => setAdvanced({ ...advanced, assignedTo: event.target.value.trim() })} /></div>}
        <div className="field-group"><label htmlFor="job-customer">Müşteri</label>
          <input id="job-customer" maxLength={36} value={advanced.customerId} onChange={(event) => setAdvanced({ ...advanced, customerId: event.target.value.trim() })} /></div>
        <div className="field-group"><label htmlFor="job-due-after">Başlangıç tarihi</label>
          <input id="job-due-after" type="date" value={advanced.dueAfter} onChange={(event) => setAdvanced({ ...advanced, dueAfter: event.target.value })} /></div>
        <div className="field-group"><label htmlFor="job-due-before">Bitiş tarihi</label>
          <input id="job-due-before" type="date" value={advanced.dueBefore} onChange={(event) => setAdvanced({ ...advanced, dueBefore: event.target.value })} /></div>
      </div>
    </details>
  </form>;
}
