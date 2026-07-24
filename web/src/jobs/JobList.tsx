import type { CurrentUser } from '../services/api';
import { EmptyState, LoadingSkeleton, ResultState } from '../ui/antd';
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
  if (state.kind === 'loading') {
    return (
      <div className="job-results" data-job-results-state="loading">
        <LoadingSkeleton title="İşler yükleniyor" headingLevel={2} rows={3} />
      </div>
    );
  }

  if (state.kind === 'error') {
    const forbidden = state.code === 'FORBIDDEN';
    return (
      <div className="job-results" data-job-results-state={forbidden ? 'forbidden' : 'error'}>
        <ResultState
          status={forbidden ? '403' : 'error'}
          title={forbidden ? 'Bu alana erişim yetkiniz yok' : 'İşler yüklenemedi'}
          description={state.message}
          headingLevel={2}
          action={state.retryable && !forbidden ? (
            <button className="secondary-button" type="button" onClick={onRetry}>
              Tekrar dene
            </button>
          ) : undefined}
        />
      </div>
    );
  }

  const { page } = state;
  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = Math.min(page.offset + page.limit, page.total);
  return (
    <div className="job-results" data-job-results-state={page.items.length === 0 ? (hasFilters ? 'filtered-empty' : 'empty') : 'ready'}>
      {page.items.length === 0 ? (
        <EmptyState
          title={hasFilters ? 'Filtrelere uygun iş bulunamadı' : 'Henüz iş kaydı yok'}
          description={hasFilters
            ? 'Arama metnini veya filtreleri değiştirin.'
            : 'İşler oluşturulduğunda burada görünecek.'}
          headingLevel={2}
        />
      ) : (
        <ul className="structured-job-list">
          {page.items.map((job) => (
            <li key={job.id}>
              <JobRow job={job} user={user} onCommand={onCommand} />
            </li>
          ))}
        </ul>
      )}
      {page.total > page.limit && (
        <nav className="job-pagination" aria-label="İş sayfaları">
          <button
            className="secondary-button"
            type="button"
            disabled={page.offset === 0}
            onClick={() => onOffsetChange(Math.max(0, page.offset - page.limit))}
          >
            Önceki
          </button>
          <span aria-live="polite">{first}–{last} / {page.total}</span>
          <button
            className="secondary-button"
            type="button"
            disabled={page.offset + page.limit >= page.total}
            onClick={() => onOffsetChange(page.offset + page.limit)}
          >
            Sonraki
          </button>
        </nav>
      )}
    </div>
  );
}
