import type { ReactNode } from 'react';

import type {
  JobWorkflowPresentation,
  RecordEditPresentation,
} from './job-workflow-presentation';
import type { LifecycleCommand } from './jobs-api';

const START_SCHEDULE_REASON_ID = 'start-schedule-reason';

export function JobDecisionPanel({
  primary,
  secondary,
  recordEditAction,
  pending,
  pendingLabel,
  startLocationCaptureEnabled,
  startScheduleBlockedReason,
  onCommand,
  onRecordEdit,
}: {
  primary: JobWorkflowPresentation['primaryTransition'];
  secondary: JobWorkflowPresentation['secondaryTransitions'];
  recordEditAction: JobWorkflowPresentation['recordEditAction'];
  pending: boolean;
  pendingLabel?: string;
  startLocationCaptureEnabled: boolean;
  /**
   * Advisory SCHED-3 reason shown when the assigned STAFF viewer's START
   * control is locally disabled because the SM/PD planned interval is
   * structurally incomplete. UX guidance only — the backend remains
   * authoritative and may still return SCHEDULED_INTERVAL_REQUIRED / 400.
   */
  startScheduleBlockedReason?: string | null;
  onCommand: (command: LifecycleCommand, trigger: HTMLButtonElement) => void;
  onRecordEdit?: (
    action: RecordEditPresentation['action'], trigger: HTMLButtonElement,
  ) => void;
}): ReactNode {
  if (!primary && secondary.length === 0 && !recordEditAction) return null;
  const hasStart = primary?.command === 'START'
    || secondary.some((transition) => transition.command === 'START');

  const destructiveTransitions = secondary.filter((t) => t.command === 'CANCEL');
  const secondaryTransitions = secondary.filter((t) => t.command !== 'CANCEL');

  return <section
    className="detail-action surface-flat"
    aria-label="İş işlemleri"
    data-job-decision-panel="true"
  >
    {startLocationCaptureEnabled && hasStart && <p className="start-location-notice">
      İşi başlattığınızda cihazınızdan bir kez yaklaşık konum alınmaya çalışılır.
      Konum, iş başlangıcını operasyonel olarak kayıt altına almak amacıyla yetkili
      kullanıcıların görebildiği iş geçmişinde saklanır. Konum alınamazsa iş yine başlar.
    </p>}
    {hasStart && startScheduleBlockedReason && (
      <p
        className="start-schedule-reason"
        id={START_SCHEDULE_REASON_ID}
        role="status"
        aria-live="polite"
      >
        {startScheduleBlockedReason}
      </p>
    )}
    <div className="review-buttons">
      {primary && <button
        className="primary-button compact-button"
        type="button"
        disabled={pending || Boolean(startScheduleBlockedReason && primary.command === 'START')}
        aria-describedby={startScheduleBlockedReason && primary.command === 'START'
          ? START_SCHEDULE_REASON_ID
          : undefined}
        onClick={(event) => onCommand(primary.command, event.currentTarget)}
      >
        {pending ? (pendingLabel ?? 'İşleniyor…') : primary.label}
      </button>}
      {secondaryTransitions.map((transition) => <button
        key={transition.command}
        className="secondary-button compact-button"
        type="button"
        disabled={pending
          || Boolean(startScheduleBlockedReason && transition.command === 'START')}
        onClick={(event) => onCommand(transition.command, event.currentTarget)}
      >
        {pending ? (pendingLabel ?? 'İşleniyor…') : transition.label}
      </button>)}
      {destructiveTransitions.map((transition) => <button
        key={transition.command}
        className="destructive-button compact-button"
        type="button"
        disabled={pending}
        onClick={(event) => onCommand(transition.command, event.currentTarget)}
      >
        {pending ? (pendingLabel ?? 'İşleniyor…') : transition.label}
      </button>)}
    </div>
    {recordEditAction && <div className="detail-action-record-edit">
      <hr className="detail-action-lifecycle-end" role="none" />
      <button
        className="secondary-button compact-button"
        type="button"
        disabled={pending}
        onClick={(event) => onRecordEdit?.(recordEditAction.action, event.currentTarget)}
      >
        {pending ? (pendingLabel ?? 'İşleniyor…') : recordEditAction.label}
      </button>
    </div>}
  </section>;
}
