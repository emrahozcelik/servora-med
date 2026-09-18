import { jobTypeLabels } from './job-labels';
import type { CustomerScheduleEvaluation } from './jobs-api';

export type CustomerScheduleNoticeProps = {
  evaluation: CustomerScheduleEvaluation | null;
  mode: 'staff' | 'manager';
};

function formatDay(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric', month: 'long',
  }).format(new Date(value));
}

/**
 * Shared presentation for Customer Scheduling Intelligence in normal
 * create/edit flows. Advisory only: consumes the role-projected server
 * evaluation and never derives scheduling rules client-side. There is no
 * blocking conflict level; true duplicates surface as submit-time 409s.
 */
export function CustomerScheduleNotice({
  evaluation,
  mode,
}: CustomerScheduleNoticeProps) {
  if (evaluation === null || evaluation.level === 'CLEAR') return null;

  // Staff previews are always CLEAR server-side; frequency insight is
  // management information and never blocks the Staff flow.
  if (mode === 'staff') return null;

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

      {mode === 'manager' && evaluation.safeMessage && (
        <div className="follow-up-frequency-warning" role="status">
          <p className="follow-up-recent-visit-title">Yakın dönem müşteri teması</p>
          <p className="form-help">{evaluation.safeMessage}</p>
        </div>
      )}
    </div>
  );
}
