import type { ReactNode } from 'react';

import { jobEngagementLabel, jobTypeLabels } from './job-labels';
import type { JobWorkflowPresentation } from './job-workflow-presentation';
import type { JobCard, JobLifecycleFacts, SubmissionRequirement } from './jobs-api';

const REQUIREMENT_STATE_TEXT: Record<SubmissionRequirement['state'], string> = {
  met: 'Tamam',
  missing: 'Eksik',
  invalid: 'Geçersiz',
};

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function typeAwareSummary(job: JobCard): string {
  switch (job.type) {
    case 'PRODUCT_DELIVERY':
      return 'Ürün teslim kalemlerini ve miktarları kontrol edin.';
    case 'SALES_MEETING':
      return 'Görüşme sonucu, özet ve takip bilgilerini kontrol edin.';
    case 'GENERAL_TASK':
      return 'Görev kaydını ve tamamlanma notlarını kontrol edin.';
  }
}

export function JobApprovalReviewPanel(props: {
  job: JobCard;
  lifecycle: JobLifecycleFacts;
  requirements: JobWorkflowPresentation['requirements'];
}): ReactNode {
  const { job, lifecycle, requirements } = props;
  const submittedBy = lifecycle.submittedBy?.name?.trim() || null;
  const submittedAt = lifecycle.submittedAt;

  return (
    <section className="approval-review surface" aria-labelledby="approval-review-title">
      <h2 id="approval-review-title">Yönetici kontrolü</h2>
      <p className="approval-review-submitter">
        {submittedBy && submittedAt ? (
          <>
            <strong>{submittedBy}</strong>
            {` ${formatInstant(submittedAt)} tarihinde yönetici kontrolüne gönderdi.`}
          </>
        ) : submittedBy ? (
          <>
            <strong>{submittedBy}</strong>
            {' yönetici kontrolüne gönderdi.'}
          </>
        ) : (
          'Gönderim bilgisi kaydedilmemiş.'
        )}
      </p>
      <div className="approval-review-summary">
        <p>
          <span className="approval-review-type">{
            job.type === 'SALES_MEETING' ? jobEngagementLabel(job.engagementKind) : jobTypeLabels[job.type]
          }</span>
          {' · '}
          {typeAwareSummary(job)}
        </p>
        {requirements.length > 0 && (
          <ul className="approval-review-requirements">
            {requirements.map((item) => (
              <li key={item.code}>
                <span>{item.label}</span>
                <span>{REQUIREMENT_STATE_TEXT[item.state]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="approval-review-instruction">İş kayıtlarını inceleyerek karar verin.</p>
    </section>
  );
}
