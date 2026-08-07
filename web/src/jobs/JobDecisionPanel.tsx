import type { ReactNode } from 'react';

import type {
  JobWorkflowPresentation,
  RecordEditPresentation,
} from './job-workflow-presentation';
import type { LifecycleCommand } from './jobs-api';

export function JobDecisionPanel({
  primary,
  secondary,
  recordEditAction,
  pending,
  pendingLabel,
  startLocationCaptureEnabled,
  onCommand,
  onRecordEdit,
}: {
  primary: JobWorkflowPresentation['primaryTransition'];
  secondary: JobWorkflowPresentation['secondaryTransitions'];
  recordEditAction: JobWorkflowPresentation['recordEditAction'];
  pending: boolean;
  pendingLabel?: string;
  startLocationCaptureEnabled: boolean;
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
    <div className="review-buttons">
      {primary && <button
        className="primary-button compact-button"
        type="button"
        disabled={pending}
        onClick={(event) => onCommand(primary.command, event.currentTarget)}
      >
        {pending ? (pendingLabel ?? 'İşleniyor…') : primary.label}
      </button>}
      {secondaryTransitions.map((transition) => <button
        key={transition.command}
        className="secondary-button compact-button"
        type="button"
        disabled={pending}
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
