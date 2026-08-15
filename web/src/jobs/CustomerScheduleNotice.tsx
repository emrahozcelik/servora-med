import { jobTypeLabels } from './job-labels';
import type { CustomerScheduleEvaluation } from './jobs-api';

export type CustomerScheduleNoticeProps = {
  evaluation: CustomerScheduleEvaluation | null;
  mode: 'staff' | 'manager';
  overrideReason: string;
  onOverrideReasonChange: (value: string) => void;
  onUseSuggestedAlternative: () => void;
  /** Compact label for the conflict block when the form already shows a heading. */
  conflictHeading?: string;
};

function formatDay(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric', month: 'long',
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

/**
 * Shared presentation for Customer Scheduling Intelligence in normal
 * create/edit flows. Consumes the role-projected server evaluation only; it
 * never derives scheduling rules client-side.
 */
export function CustomerScheduleNotice({
  evaluation,
  mode,
  overrideReason,
  onOverrideReasonChange,
  onUseSuggestedAlternative,
  conflictHeading = 'Planlama çakışması',
}: CustomerScheduleNoticeProps) {
  if (evaluation === null || evaluation.level === 'CLEAR') return null;

  const frequencyExceeded = evaluation.level === 'FREQUENCY_EXCEEDED';

  if (evaluation.level === 'CONFLICT') {
    return (
      <div className="follow-up-conflict-list customer-schedule-notice" role="alert">
        <p className="follow-up-recent-visit-title">{conflictHeading}</p>
        <p className="field-error">
          {evaluation.safeMessage ?? 'Aynı müşteriye aynı gün başka bir saha işi planlanmış.'}
        </p>
        {mode === 'manager' && (
          <ul>
            {evaluation.conflicts.map((conflict) => (
              <li key={conflict.jobCardId}>
                <a href={conflict.jobPath}>{conflict.title}</a>
                {' — '}{conflict.assignee.name}
              </li>
            ))}
          </ul>
        )}
        {mode === 'manager' && (
          <p className="form-help">Aynı müşteriye aynı gün ikinci saha ziyareti planlanamaz.</p>
        )}
        {evaluation.suggestedAlternativeAt && (
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={onUseSuggestedAlternative}
          >
            Müşteri için önerilen alternatif zamanı kullan ({formatDateTime(evaluation.suggestedAlternativeAt)})
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="customer-schedule-notice">
      {mode === 'manager' && evaluation.recentVisit && (
        <div className="follow-up-recent-visit" role="status">
          <p className="follow-up-recent-visit-title">Yakın tarihli müşteri ziyareti</p>
          <p>
            <strong>{formatDay(evaluation.recentVisit.occurredAt)} — {jobTypeLabels[evaluation.recentVisit.jobType]}</strong>
            <br />
            {evaluation.recentVisit.staffName}
            {evaluation.recentVisit.resultSummary && (
              <>
                <br />
                <span className="form-help">{evaluation.recentVisit.resultSummary}</span>
              </>
            )}
          </p>
        </div>
      )}

      {mode === 'staff' && evaluation.safeMessage && !frequencyExceeded && (
        <div className="follow-up-frequency-warning" role="status">
          <p className="follow-up-recent-visit-title">Yakın tarihli müşteri ziyareti</p>
          <p className="form-help">{evaluation.safeMessage}</p>
        </div>
      )}

      {frequencyExceeded && mode === 'manager' && (
        <div className="follow-up-frequency-warning" role="alert">
          <p className="follow-up-recent-visit-title">Sık ziyaret uyarısı</p>
          <p className="form-help">Bu ziyaret, müşteri için 14 günlük bir dönemde
            ziyaret sıklığı sınırını aşıyor. Yeni ziyareti yine de planlamak için nedeni belirtin.</p>
          <div className="field-group">
            <label htmlFor="customer-visit-override-reason">Neden *</label>
            <textarea
              id="customer-visit-override-reason"
              rows={2}
              maxLength={2000}
              value={overrideReason}
              onChange={(event) => onOverrideReasonChange(event.target.value)}
            />
          </div>
        </div>
      )}

      {frequencyExceeded && mode === 'staff' && (
        <div className="follow-up-frequency-warning" role="status">
          <p className="follow-up-recent-visit-title">Sık ziyaret uyarısı</p>
          <p className="form-help">
            Bu müşteri için ziyaret sıklığı sınırı aşılıyor. Planlama için yönetici değerlendirmesi gerekiyor.
          </p>
        </div>
      )}
    </div>
  );
}
