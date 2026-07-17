import { Link } from 'react-router-dom';

import { paths } from '../paths';
import type { CurrentUser } from '../services/api';
import { PriorityChip } from '../ui/PriorityChip';
import { CompactWorkflowSummary } from './CompactWorkflowSummary';
import type { JobCardBoard, JobCardListItem } from './jobs-api';
import { jobStatusLabels, jobTypeLabels } from './job-labels';
import { deriveCompactWorkflowSummary } from './job-workflow-presentation';
import { selectStatus } from './job-search';

const columns = [
  'NEW',
  'PLANNED',
  'IN_PROGRESS',
  'WAITING_APPROVAL',
  'REVISION_REQUESTED',
] as const satisfies readonly (keyof JobCardBoard['columns'])[];

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(value));
}

function statusHref(params: URLSearchParams, status: 'COMPLETED' | 'CANCELLED') {
  return `?${selectStatus(params, status).toString()}`;
}

function BoardCard({ job, user }: { job: JobCardListItem; user: CurrentUser }) {
  const summary = deriveCompactWorkflowSummary({ job, user });
  return <article className="job-board-card" data-board-card={job.id}>
    <Link to={paths.job(job.id)}>
      <strong>{job.title}</strong>
      <span className="job-board-type">{jobTypeLabels[job.type]}</span>
      <PriorityChip priority={job.priority} longLabel />
      <dl>
        <div><dt>Müşteri</dt><dd>{job.customer?.name ?? 'Belirtilmedi'}</dd></div>
        {job.contact && <div><dt>İlgili kişi</dt><dd>{job.contact.name}</dd></div>}
        <div><dt>Sorumlu</dt><dd>{job.assignee.name}</dd></div>
        <div><dt>{job.type === 'SALES_MEETING' ? 'Planlanan görüşme günü' : 'Termin'}</dt><dd>{job.dueDate ? <time dateTime={job.dueDate}>{formatDate(job.dueDate)}</time> : 'Belirtilmedi'}</dd></div>
        {job.type === 'PRODUCT_DELIVERY' && <div><dt>Teslim</dt><dd>{job.deliveryItemCount} ürün kalemi</dd></div>}
      </dl>
    </Link>
    <CompactWorkflowSummary summary={summary} assigneeName={job.assignee.name} />
  </article>;
}

export function JobBoard({ board, user, params }: {
  board: JobCardBoard;
  user: CurrentUser;
  params: URLSearchParams;
}) {
  return <section className="job-board" aria-label="Aktif iş panosu">
    <nav className="job-board-closed" aria-label="Kapanmış işler">
      <Link to={{ search: statusHref(params, 'COMPLETED') }}>Tamamlandı<strong>{board.closedCounts.COMPLETED}</strong></Link>
      <Link to={{ search: statusHref(params, 'CANCELLED') }}>İptal edildi<strong>{board.closedCounts.CANCELLED}</strong></Link>
    </nav>
    <div className="job-board-columns">
      {columns.map((status) => {
        const column = board.columns[status];
        const headingId = `job-board-${status.toLowerCase()}`;
        return <section className="job-board-column" data-board-column={status} aria-labelledby={headingId} key={status}>
          <h2 id={headingId} className={`job-status-${status.toLowerCase()}`}>
            <span><span className="job-status-shape" aria-hidden="true" />{jobStatusLabels[status]}</span>
            <strong>{column.count}</strong>
          </h2>
          <ul className="job-board-items">
            {column.items.map((job) => <li key={job.id}><BoardCard job={job} user={user} /></li>)}
          </ul>
        </section>;
      })}
    </div>
  </section>;
}
