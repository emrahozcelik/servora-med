import type { ReactNode } from 'react';

import type { JobWorkflowPresentation } from './job-workflow-presentation';
import type { SubmissionRequirement } from './jobs-api';

const REQUIREMENT_STATE_TEXT: Record<SubmissionRequirement['state'], string> = {
  met: 'Tamam',
  missing: 'Eksik',
  invalid: 'Geçersiz',
};

const REQUIREMENT_STATE_ICON: Record<SubmissionRequirement['state'], string> = {
  met: '✓',
  missing: '○',
  invalid: '!',
};

function formatInstant(value: string | null): string {
  if (value === null) return 'Bilgi kaydedilmemiş';
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function CurrentResponsibilityPanel(props: {
  presentation: JobWorkflowPresentation;
  assigneeName: string;
}): ReactNode {
  const { presentation, assigneeName } = props;
  const { responsibility } = presentation;
  return (
    <section className="workflow-responsibility surface" aria-labelledby="workflow-responsibility-title">
      <h2 id="workflow-responsibility-title">{responsibility.title}</h2>
      <p>{responsibility.description}</p>
      {responsibility.role === 'STAFF' && (
        <p className="workflow-responsibility-assignee">
          Sorumlu personel: <strong>{assigneeName}</strong>
        </p>
      )}
      {responsibility.submission && (
        <dl className="workflow-responsibility-submission">
          <div>
            <dt>Kontrole gönderen</dt>
            <dd>{responsibility.submission.actorName ?? 'Bilgi kaydedilmemiş'}</dd>
          </div>
          <div>
            <dt>Gönderim zamanı</dt>
            <dd>{formatInstant(responsibility.submission.at)}</dd>
          </div>
        </dl>
      )}
      {responsibility.consequence && (
        <p className="workflow-responsibility-consequence">{responsibility.consequence}</p>
      )}
    </section>
  );
}

export function RequirementsChecklist(props: {
  requirements: JobWorkflowPresentation['requirements'];
}): ReactNode {
  const { requirements } = props;
  if (requirements.length === 0) return null;
  return (
    <section className="workflow-requirements surface-flat" aria-labelledby="workflow-requirements-title">
      <h2 id="workflow-requirements-title">Kontrole hazırlık</h2>
      <ul className="workflow-requirements-list">
        {requirements.map((item) => (
          <li
            key={item.code}
            className={`workflow-requirement workflow-requirement-${item.state}`}
          >
            <span className="workflow-requirement-icon" aria-hidden="true">
              {REQUIREMENT_STATE_ICON[item.state]}
            </span>
            <span className="workflow-requirement-label">{item.label}</span>
            <span className="workflow-requirement-state">{REQUIREMENT_STATE_TEXT[item.state]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RevisionLoopPanel(props: {
  loop: NonNullable<JobWorkflowPresentation['revisionLoop']>;
}): ReactNode {
  const { loop } = props;
  return (
    <section className="revision-loop surface" aria-labelledby="revision-loop-title">
      <h2 id="revision-loop-title">Düzeltme gerekiyor</h2>
      <p>Yönetici kontrolünden uygulamaya geri gönderildi. Önce düzeltmeye başlayın; tamamladığınızda yeniden kontrole gönderin.</p>
      <p className="revision-loop-reason">
        <span className="revision-loop-reason-label">Düzeltme nedeni</span>
        <span>{loop.reason?.trim() ? loop.reason : 'Bilgi kaydedilmemiş'}</span>
      </p>
      <dl className="revision-loop-facts">
        <div><dt>Düzeltme isteyen</dt><dd>{loop.actorName ?? 'Bilgi kaydedilmemiş'}</dd></div>
        <div><dt>İstek zamanı</dt><dd>{loop.at
          ? <time dateTime={loop.at}>{formatInstant(loop.at)}</time>
          : 'Bilgi kaydedilmemiş'}</dd></div>
      </dl>
    </section>
  );
}

export function TerminalJobBanner(props: {
  details: NonNullable<JobWorkflowPresentation['terminalDetails']>;
}): ReactNode {
  const { details } = props;
  if (details.kind === 'COMPLETED') {
    return <section
      className="completed-job-banner surface"
      role="status"
      aria-labelledby="completed-job-title"
      data-terminal-state="COMPLETED"
    >
      <h2 id="completed-job-title">Tamamlandı</h2>
      <p>İş yönetici kontrolünden geçerek tamamlandı.</p>
      <dl className="completed-job-facts">
        <div><dt>Kontrolü tamamlayan</dt><dd>{details.actorName ?? 'Bilgi kaydedilmemiş'}</dd></div>
        <div><dt>Tamamlanma zamanı</dt><dd>{details.at
          ? <time dateTime={details.at}>{formatInstant(details.at)}</time>
          : 'Bilgi kaydedilmemiş'}</dd></div>
      </dl>
    </section>;
  }

  return (
    <section className="cancelled-job-banner surface" role="status" aria-labelledby="cancelled-job-title"
      data-terminal-state="CANCELLED">
      <h2 id="cancelled-job-title">İptal edildi</h2>
      <p>İş iptal edildi ve yeniden açılamaz.</p>
      <dl className="cancelled-job-facts">
        <div>
          <dt>İptal öncesi aşama</dt>
          <dd>{details.sourceLabel ?? 'Bilgi kaydedilmemiş'}</dd>
        </div>
        <div>
          <dt>İptal eden</dt>
          <dd>{details.actorName ?? 'Bilgi kaydedilmemiş'}</dd>
        </div>
        <div>
          <dt>İptal zamanı</dt>
          <dd>{details.at ? <time dateTime={details.at}>{formatInstant(details.at)}</time> : 'Bilgi kaydedilmemiş'}</dd>
        </div>
        <div className="cancelled-job-reason">
          <dt>İptal nedeni</dt>
          <dd>{details.reason ?? 'Bilgi kaydedilmemiş'}</dd>
        </div>
      </dl>
    </section>
  );
}
