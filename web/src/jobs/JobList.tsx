import type { CurrentUser } from '../services/api';
import type { JobCardListItem, Paginated } from './jobs-api';
import { JobRow, type JobCommandIntent } from './JobRow';

export type JobListState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: Paginated<JobCardListItem> }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

export function JobList({ state, user, hasFilters, onRetry, onOffsetChange, onCommand }: {
  state: JobListState;
  user: CurrentUser;
  hasFilters: boolean;
  onRetry: () => void;
  onOffsetChange: (offset: number) => void;
  onCommand: (intent: JobCommandIntent) => void;
}) {
  if (state.kind === 'loading') return <div className="job-results" aria-busy="true" aria-live="polite">
    <h2 className="sr-only">İşler yükleniyor</h2><div className="job-list-loading" aria-hidden="true"><span /><span /><span /></div>
  </div>;

  if (state.kind === 'error') {
    const forbidden = state.code === 'FORBIDDEN';
    return <div className="job-results"><div className="workspace-message" role="alert">
      <h2>{forbidden ? 'Bu alana erişim yetkiniz yok' : 'İşler yüklenemedi'}</h2><p>{state.message}</p>
      {state.retryable && !forbidden && <button className="secondary-button" type="button" onClick={onRetry}>Tekrar dene</button>}
    </div></div>;
  }

  const { page } = state;
  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = Math.min(page.offset + page.limit, page.total);
  return <div className="job-results">
    {page.items.length === 0 ? <div className="workspace-message">
      <h2>{hasFilters ? 'Filtrelere uygun iş bulunamadı' : 'Henüz iş kaydı yok'}</h2>
      <p>{hasFilters ? 'Arama metnini veya filtreleri değiştirin.' : 'İşler oluşturulduğunda burada görünecek.'}</p>
    </div> : <ul className="structured-job-list">{page.items.map((job) => <li key={job.id}>
      <JobRow job={job} user={user} onCommand={onCommand} />
    </li>)}</ul>}
    {page.total > page.limit && <nav className="job-pagination" aria-label="İş sayfaları">
      <button className="secondary-button" type="button" disabled={page.offset === 0}
        onClick={() => onOffsetChange(Math.max(0, page.offset - page.limit))}>Önceki</button>
      <span aria-live="polite">{first}–{last} / {page.total}</span>
      <button className="secondary-button" type="button" disabled={page.offset + page.limit >= page.total}
        onClick={() => onOffsetChange(page.offset + page.limit)}>Sonraki</button>
    </nav>}
  </div>;
}
