import { type ReactNode, type RefObject } from 'react';

import { FOLLOW_UP_CYCLE_END_REASONS, type FollowUpCycleEndReason } from './jobs-api';
import { followUpCycleEndReasonLabels } from './job-workflow-presentation';
import { WheelDateTimeField } from '../ui/WheelDateTimeField';

/** JOB-009 cancel draft for a follow-up visit; validated in JobDetail. */
export type FollowUpCancelContinuityDraft = {
  decision: 'RESCHEDULE' | 'END_CYCLE' | null;
  /** Device-local `YYYY-MM-DDTHH:mm` from the datetime-local input. */
  scheduledLocal: string;
  endReason: FollowUpCycleEndReason | '';
};

export const EMPTY_FOLLOW_UP_CANCEL_CONTINUITY: FollowUpCancelContinuityDraft = {
  decision: null,
  scheduledLocal: '',
  endReason: '',
};

export type FollowUpCancelContinuitySectionProps = {
  draft: FollowUpCancelContinuityDraft;
  inlineError: string | null;
  onChange: (patch: Partial<FollowUpCancelContinuityDraft>) => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Cancelling a follow-up visit must keep the customer's visit cycle with a
 * replacement visit or end it with a structured reason (JOB-009).
 */
export function FollowUpCancelContinuitySection(props: FollowUpCancelContinuitySectionProps): ReactNode {
  const { draft, inlineError, onChange, initialFocusRef } = props;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const errorId = inlineError ? 'follow-up-cancel-continuity-error' : undefined;
  return (
    <fieldset className="follow-up-cancel-continuity" aria-describedby={errorId}>
      <legend>Takip döngüsü</legend>
      <p className="form-help">
        Bu ziyaret müşterinin takip döngüsünün parçası. Yeni bir ziyaret planlayın ya da döngüyü neden sonlandırdığınızı seçin.
      </p>
      <div className="follow-up-cancel-choices">
        <label className="follow-up-cancel-choice">
          <input
            ref={initialFocusRef
              ? (node) => { initialFocusRef.current = node; }
              : undefined}
            type="radio"
            name="follow-up-cancel-decision"
            value="RESCHEDULE"
            checked={draft.decision === 'RESCHEDULE'}
            onChange={() => onChange({ decision: 'RESCHEDULE' })}
          />
          <span>Yeniden planla</span>
        </label>
        <label className="follow-up-cancel-choice">
          <input
            type="radio"
            name="follow-up-cancel-decision"
            value="END_CYCLE"
            checked={draft.decision === 'END_CYCLE'}
            onChange={() => onChange({ decision: 'END_CYCLE' })}
          />
          <span>Döngüyü sonlandır</span>
        </label>
      </div>
      {draft.decision === 'RESCHEDULE' && (
        <div className="field-group">
          <WheelDateTimeField
            mode="datetime"
            id="follow-up-cancel-scheduled-at"
            value={draft.scheduledLocal}
            onChange={(value) => onChange({ scheduledLocal: value })}
            required
            label="Yeni ziyaret tarihi ve saati"
          />
          <p className="form-help">
            Aynı müşteri, personel ve talimatla yeni bir takip ziyareti oluşturulur. Saat dilimi: {timeZone}
          </p>
        </div>
      )}
      {draft.decision === 'END_CYCLE' && (
        <div className="field-group">
          <label htmlFor="follow-up-cancel-end-reason">Sonlandırma nedeni</label>
          <select
            id="follow-up-cancel-end-reason"
            required
            value={draft.endReason}
            onChange={(event) => onChange({ endReason: event.target.value as FollowUpCycleEndReason | '' })}
          >
            <option value="">Seçin</option>
            {FOLLOW_UP_CYCLE_END_REASONS.map((reason) => (
              <option key={reason} value={reason}>{followUpCycleEndReasonLabels[reason]}</option>
            ))}
          </select>
          <p className="form-help">Açıklamayı aşağıdaki iptal nedeni alanına yazın.</p>
        </div>
      )}
      {inlineError && <p id={errorId} className="field-error" role="alert">{inlineError}</p>}
    </fieldset>
  );
}
