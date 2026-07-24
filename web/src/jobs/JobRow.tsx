import { Link } from 'react-router-dom';

import { paths } from '../paths';
import type { CurrentUser } from '../services/api';
import { PriorityChip } from '../ui/PriorityChip';
import { StatusChip } from '../ui/StatusChip';
import { CompactWorkflowSummary } from './CompactWorkflowSummary';
import type { JobCardListItem, LifecycleCommand } from './jobs-api';
import { jobEngagementLabel, jobTypeLabels } from './job-labels';
import {
  deriveCompactWorkflowSummary,
  expectedRoleForStatus,
} from './job-workflow-presentation';
import { cardScheduleFact } from './scheduling';

export type JobCommandIntent = {
  name: LifecycleCommand;
  jobId: string;
  expectedVersion: number;
};

const openLabels: Partial<Record<LifecycleCommand, string>> = {
  START: 'İşi başlatmak için aç',
  SUBMIT_FOR_APPROVAL: 'Kontrole göndermek için aç',
  RESUME: 'Düzeltmeye başlamak için aç',
  APPROVE: 'Yönetici kontrolünü aç',
  REQUEST_REVISION: 'Düzeltme kararını aç',
};

const OPEN_COMMAND_ORDER = [
  'START',
  'SUBMIT_FOR_APPROVAL',
  'RESUME',
  'APPROVE',
  'REQUEST_REVISION',
] as const satisfies readonly LifecycleCommand[];

function preferredPrimaryCommand(status: JobCardListItem['status']): LifecycleCommand | null {
  switch (status) {
    case 'NEW':
      return null;
    case 'ACCEPTED':
      return 'START';
    case 'IN_PROGRESS':
      return 'SUBMIT_FOR_APPROVAL';
    case 'REVISION_REQUESTED':
      return 'RESUME';
    case 'WAITING_APPROVAL':
      return 'APPROVE';
    default:
      return null;
  }
}

function viewerOwnsPrimary(user: CurrentUser, job: JobCardListItem): boolean {
  const expected = expectedRoleForStatus(job.status);
  if (expected === 'STAFF') {
    return user.role === 'STAFF' && job.assignee.id === user.id;
  }
  if (expected === 'MANAGEMENT') {
    return user.role === 'MANAGER' || user.role === 'ADMIN';
  }
  return false;
}

function listPrimaryOpenCommand(user: CurrentUser, job: JobCardListItem): LifecycleCommand | null {
  if (!viewerOwnsPrimary(user, job)) return null;
  const preferred = preferredPrimaryCommand(job.status);
  if (!preferred || openLabels[preferred] == null) return null;
  if (!job.allowedCommands.includes(preferred)) return null;
  return preferred;
}

function listOpenCommands(user: CurrentUser, job: JobCardListItem): LifecycleCommand[] {
  const primary = listPrimaryOpenCommand(user, job);
  const presentable = OPEN_COMMAND_ORDER.filter((command) => job.allowedCommands.includes(command));
  if (!primary) return [...presentable];
  return [primary, ...presentable.filter((command) => command !== primary)];
}

function typeLabel(job: JobCardListItem): string {
  return job.type === 'SALES_MEETING'
    ? jobEngagementLabel(job.engagementKind)
    : jobTypeLabels[job.type];
}

export function JobRow({ job, user, onCommand }: {
  job: JobCardListItem;
  user: CurrentUser;
  onCommand: (intent: JobCommandIntent) => void;
}) {
  const summary = deriveCompactWorkflowSummary({ job, user });
  const primaryCommand = listPrimaryOpenCommand(user, job);
  const openCommands = listOpenCommands(user, job);
  const schedule = cardScheduleFact(job);

  return (
    <article
      className="structured-job-row job-list-card"
      data-job-id={job.id}
      data-job-list-card="true"
    >
      <div className="job-row-primary">
        <h2>
          <Link className="job-row-title-link" to={paths.job(job.id)}>{job.title}</Link>
        </h2>
        <p className="job-row-type">{typeLabel(job)}</p>
        <dl className="job-row-relations">
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
        </dl>
        <CompactWorkflowSummary summary={summary} assigneeName={job.assignee.name} />
        <div className="job-row-signals" data-job-row-signals="true">
          <StatusChip status={job.status} />
          <PriorityChip priority={job.priority} longLabel />
        </div>
      </div>
      <dl className="job-row-facts">
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
      {primaryCommand && (
        <div className="job-row-mobile-primary">
          <button
            className="primary-button btn-full job-row-command-primary"
            type="button"
            data-job-command={primaryCommand}
            data-job-command-priority="primary"
            onClick={() => onCommand({
              name: primaryCommand,
              jobId: job.id,
              expectedVersion: job.version,
            })}
          >
            {openLabels[primaryCommand]}
          </button>
        </div>
      )}
      <div className="job-row-commands" data-job-row-commands="true">
        {openCommands.map((command) => {
          const isPrimary = command === primaryCommand;
          return (
            <button
              key={command}
              className={[
                isPrimary ? 'primary-button' : 'secondary-button',
                isPrimary ? 'job-row-command-primary' : 'job-row-command-secondary',
              ].filter(Boolean).join(' ')}
              type="button"
              data-job-command={command}
              data-job-command-priority={isPrimary ? 'primary' : 'secondary'}
              onClick={() => onCommand({
                name: command,
                jobId: job.id,
                expectedVersion: job.version,
              })}
            >
              {openLabels[command]}
            </button>
          );
        })}
      </div>
    </article>
  );
}
