import { useState } from 'react';
import { Link } from 'react-router-dom';

import { paths } from '../paths';
import type { CurrentUser } from '../services/api';
import { PriorityChip } from '../ui/PriorityChip';
import { StatusChip } from '../ui/StatusChip';
import type { JobCardListItem } from './jobs-api';
import { jobTypeLabels } from './job-labels';

export type JobCommandIntent = {
  name: 'start' | 'submit' | 'resume' | 'approve' | 'revise';
  jobId: string;
  expectedVersion: number;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value));
}

export function permittedJobCommands(user: CurrentUser, job: JobCardListItem) {
  if (user.role === 'STAFF') {
    if (job.status === 'NEW' || job.status === 'PLANNED') return [{ name: 'start', label: 'İşi başlatmak için aç' }] as const;
    if (job.status === 'IN_PROGRESS') return [{ name: 'submit', label: 'Onaya göndermek için aç' }] as const;
    if (job.status === 'REVISION_REQUESTED') return [{ name: 'resume', label: 'Düzeltmeye devam etmek için aç' }] as const;
    return [];
  }
  return job.status === 'WAITING_APPROVAL'
    ? [{ name: 'revise', label: 'Düzeltme istemek için aç' }, { name: 'approve', label: 'Onaylamak için aç' }] as const
    : [];
}

export function JobRow({ job, user, onCommand }: {
  job: JobCardListItem;
  user: CurrentUser;
  onCommand: (intent: JobCommandIntent) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const summaryId = `job-summary-${job.id}`;
  const commands = permittedJobCommands(user, job);

  return <article className="structured-job-row" data-job-id={job.id}>
    <div className="job-row-primary">
      <div className="job-row-signals">
        <StatusChip status={job.status} />
        <PriorityChip priority={job.priority} longLabel />
        <span className="job-row-type">{jobTypeLabels[job.type]}</span>
      </div>
      <h2><Link to={paths.job(job.id)}>{job.title}</Link></h2>
      <dl className="job-row-relations">
        <div><dt>Müşteri</dt><dd>{job.customer?.name ?? 'Belirtilmedi'}</dd></div>
        {job.contact && <div><dt>İlgili kişi</dt><dd>{job.contact.name}</dd></div>}
      </dl>
    </div>
    <dl className="job-row-facts">
      <div><dt>Sorumlu</dt><dd>{job.assignee.name}</dd></div>
      <div><dt>{job.type === 'SALES_MEETING' ? 'Planlanan görüşme günü' : 'Termin'}</dt><dd>{job.dueDate ? formatDate(job.dueDate) : 'Belirtilmedi'}</dd></div>
      {job.type === 'PRODUCT_DELIVERY' && <div><dt>Teslim</dt><dd>{job.deliveryItemCount} ürün kalemi</dd></div>}
    </dl>
    <button className="secondary-button job-expand" type="button" aria-expanded={expanded} aria-controls={summaryId}
      onClick={() => setExpanded((value) => !value)}>
      {expanded ? 'Özeti kapat' : 'Özeti aç'}
    </button>
    {expanded && <div className="job-row-summary" id={summaryId}>
      <dl>
        <div><dt>İş türü</dt><dd>{jobTypeLabels[job.type]}</dd></div>
        <div><dt>Oluşturma</dt><dd>{formatDate(job.createdAt)}</dd></div>
        <div><dt>Son güncelleme</dt><dd>{formatDate(job.updatedAt)}</dd></div>
        {job.staffCompletedAt && <div><dt>Onaya gönderim</dt><dd>{formatDate(job.staffCompletedAt)}</dd></div>}
      </dl>
      <div className="job-row-commands">
        {commands.map((command) => <button key={command.name} className={command.name === 'approve' || command.name === 'submit' ? 'primary-button compact-button' : 'secondary-button'}
          type="button" onClick={() => onCommand({ name: command.name, jobId: job.id, expectedVersion: job.version })}>{command.label}</button>)}
        <Link className="secondary-button job-detail-link" to={paths.job(job.id)}>Tüm iş detaylarını aç</Link>
      </div>
    </div>}
  </article>;
}
