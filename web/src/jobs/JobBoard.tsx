import { Link } from 'react-router-dom';

import { paths } from '../paths';
import type { CurrentUser } from '../services/api';
import { PriorityChip } from '../ui/PriorityChip';
import { CompactWorkflowSummary } from './CompactWorkflowSummary';
import type { JobCardBoard, JobCardListItem } from './jobs-api';
import { jobEngagementLabel, jobTypeLabels } from './job-labels';
import { deriveCompactWorkflowSummary } from './job-workflow-presentation';
import { selectStatus } from './job-search';
import { cardScheduleFact } from './scheduling';
import { workflowLanesFor, type WorkflowLaneStatus } from './workflow-lanes';

/** Board cards preview at most four jobs per lane; count remains the backend total. */
const LANE_PREVIEW_LIMIT = 4;

function statusHref(
  params: URLSearchParams,
  status: WorkflowLaneStatus | 'COMPLETED' | 'CANCELLED',
) {
  return `?${selectStatus(params, status).toString()}`;
}

function BoardCard({ job, user }: { job: JobCardListItem; user: CurrentUser }) {
  const summary = deriveCompactWorkflowSummary({ job, user });
  const schedule = cardScheduleFact(job);
  return (
    <article className="job-board-card" data-board-card={job.id}>
      <Link to={paths.job(job.id)}>
        <strong className="job-board-card-title">{job.title}</strong>
        <span className="job-board-type">
          {job.type === 'SALES_MEETING'
            ? jobEngagementLabel(job.engagementKind)
            : jobTypeLabels[job.type]}
        </span>
        <PriorityChip priority={job.priority} longLabel />
        <dl className="job-board-card-facts">
          <div>
            <dt>Müşteri</dt>
            <dd>{job.customer?.name ?? 'Belirtilmedi'}</dd>
          </div>
          {job.contact && (
            <div>
              <dt>İlgili kişi</dt>
              <dd>{job.contact.name}</dd>
            </div>
          )}
          <div>
            <dt>Sorumlu</dt>
            <dd>{job.assignee.name}</dd>
          </div>
          <div>
            <dt>{schedule.label}</dt>
            <dd>
              {schedule.dateTime
                ? <time dateTime={schedule.dateTime}>{schedule.text}</time>
                : schedule.text}
            </dd>
          </div>
          {job.type === 'PRODUCT_DELIVERY' && (
            <div>
              <dt>Teslim</dt>
              <dd>{job.deliveryItemCount} ürün kalemi</dd>
            </div>
          )}
        </dl>
      </Link>
      <CompactWorkflowSummary summary={summary} assigneeName={job.assignee.name} />
    </article>
  );
}

export function JobBoard({ board, user, params, compact = false }: {
  board: JobCardBoard;
  user: CurrentUser;
  params: URLSearchParams;
  compact?: boolean;
}) {
  const lanes = workflowLanesFor(user.role, compact);

  return (
    <section
      className="job-board"
      aria-label="Aktif iş panosu"
      data-job-board="true"
      data-board-layout={compact ? 'compact' : 'wide'}
    >
      <nav className="job-board-closed" aria-label="Kapanmış işler">
        <Link to={{ search: statusHref(params, 'COMPLETED') }}>
          Tamamlandı<strong>{board.closedCounts.COMPLETED}</strong>
        </Link>
        <Link to={{ search: statusHref(params, 'CANCELLED') }}>
          İptal edildi<strong>{board.closedCounts.CANCELLED}</strong>
        </Link>
      </nav>
      <div className="workflow-board" data-workflow-board="true">
        {lanes.map(({ status, label }) => {
          const column = board.columns[status];
          const empty = column.items.length === 0;
          const headingId = `job-board-${status.toLowerCase()}`;
          const previews = column.items.slice(0, LANE_PREVIEW_LIMIT);
          return (
            <section
              className={empty ? 'workflow-lane workflow-lane--empty' : 'workflow-lane'}
              data-workflow-lane={status}
              data-board-column={status}
              data-lane-empty={empty ? 'true' : 'false'}
              aria-labelledby={headingId}
              key={status}
            >
              <header className="workflow-lane-heading">
                <h2 id={headingId} className={`job-status-${status.toLowerCase()}`}>
                  <span className="workflow-lane-label">
                    <span className="job-status-shape" aria-hidden="true" />
                    <span className="workflow-lane-status">{label}</span>
                  </span>
                  <strong className="workflow-lane-count">{column.count}</strong>
                </h2>
                <Link
                  className="workflow-lane-link"
                  to={{ search: statusHref(params, status) }}
                >
                  Tümünü gör
                </Link>
              </header>
              {previews.length > 0 ? (
                <ul className="workflow-lane-cards">
                  {previews.map((job) => (
                    <li key={job.id}>
                      <BoardCard job={job} user={user} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="workflow-lane-empty">Bu aşamada iş yok.</p>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
