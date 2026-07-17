import { Link } from 'react-router-dom';

import { paths } from '../paths';
import type { CurrentUser } from '../services/api';
import { PriorityChip } from '../ui/PriorityChip';
import { StatusChip } from '../ui/StatusChip';
import { CompactWorkflowSummary } from './CompactWorkflowSummary';
import type { JobCardListItem, LifecycleCommand } from './jobs-api';
import { jobTypeLabels } from './job-labels';
import {
  deriveCompactWorkflowSummary,
  expectedRoleForStatus,
} from './job-workflow-presentation';

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

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value));
}

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

function isPrimaryStyle(command: LifecycleCommand) {
  return command === 'APPROVE' || command === 'SUBMIT_FOR_APPROVAL';
}

export function JobRow({ job, user, onCommand }: {
  job: JobCardListItem;
  user: CurrentUser;
  onCommand: (intent: JobCommandIntent) => void;
}) {
  const summary = deriveCompactWorkflowSummary({ job, user });
  const primaryCommand = listPrimaryOpenCommand(user, job);
  const openCommands = listOpenCommands(user, job);

  return <article className="structured-job-row job-list-card" data-job-id={job.id}>
    <div className="job-row-primary">
      <div className="job-row-signals">
        <StatusChip status={job.status} />
        <PriorityChip priority={job.priority} longLabel />
        <span className="job-row-type">{jobTypeLabels[job.type]}</span>
      </div>
      <h2>
        <Link className="job-row-title-link" to={paths.job(job.id)}>{job.title}</Link>
      </h2>
      <dl className="job-row-relations">
        <div><dt>Müşteri</dt><dd>{job.customer?.name ?? 'Belirtilmedi'}</dd></div>
        {job.contact && <div><dt>İlgili kişi</dt><dd>{job.contact.name}</dd></div>}
      </dl>
      <CompactWorkflowSummary summary={summary} assigneeName={job.assignee.name} />
    </div>
    <dl className="job-row-facts">
      <div><dt>Sorumlu</dt><dd>{job.assignee.name}</dd></div>
      <div><dt>{job.type === 'SALES_MEETING' ? 'Planlanan görüşme günü' : 'Termin'}</dt><dd>{job.dueDate ? formatDate(job.dueDate) : 'Belirtilmedi'}</dd></div>
      {job.type === 'PRODUCT_DELIVERY' && <div><dt>Teslim</dt><dd>{job.deliveryItemCount} ürün kalemi</dd></div>}
    </dl>
    {primaryCommand && (
      <div className="job-row-mobile-primary">
        <button
          className={isPrimaryStyle(primaryCommand)
            ? 'primary-button btn-full'
            : 'secondary-button btn-full'}
          type="button"
          onClick={() => onCommand({ name: primaryCommand, jobId: job.id, expectedVersion: job.version })}
        >
          {openLabels[primaryCommand]}
        </button>
      </div>
    )}
    <div className="job-row-commands">
      {openCommands.map((command) => (
        <button
          key={command}
          className={[
            isPrimaryStyle(command) ? 'primary-button' : 'secondary-button',
            command === primaryCommand ? 'job-row-command-primary' : '',
          ].filter(Boolean).join(' ')}
          type="button"
          onClick={() => onCommand({ name: command, jobId: job.id, expectedVersion: job.version })}
        >
          {openLabels[command]}
        </button>
      ))}
    </div>
  </article>;
}
