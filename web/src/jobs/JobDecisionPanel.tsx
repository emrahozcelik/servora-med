import type { ReactNode } from 'react';

import { SignalGlyph, WorkflowCommandIcon } from '../ui/signal-icons';
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
  submitLocationCaptureEnabled = false,
  startScheduleBlockedReason,
  disabledCommands = [],
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
   * Slice 1: advisory SUBMIT snapshot. Shown only when a SUBMIT_FOR_APPROVAL
   * transition is offered, mirroring the START notice pattern. The capture
   * never blocks submission; there is no continuous tracking.
   */
  submitLocationCaptureEnabled?: boolean;
  /**
   * Advisory SCHED-3 reason shown when the assigned STAFF viewer's START
   * control is locally disabled because the SM/PD planned interval is
   * structurally incomplete. UX guidance only — the backend remains
   * authoritative and may still return SCHEDULED_INTERVAL_REQUIRED / 400.
   */
  startScheduleBlockedReason?: string | null;
  /**
   * Commands the owner surface has declared non-executable right now (for
   * example SUBMIT_FOR_APPROVAL while the draft is dirty, or every lifecycle
   * command while an ambiguous attempt awaits an exact replay). Presentation
   * only: the server stays authoritative.
   */
  disabledCommands?: readonly LifecycleCommand[];
  onCommand: (command: LifecycleCommand, trigger: HTMLButtonElement) => void;
  onRecordEdit?: (
    action: RecordEditPresentation['action'], trigger: HTMLButtonElement,
  ) => void;
}): ReactNode {
  if (!primary && secondary.length === 0 && !recordEditAction) return null;
  const hasStart = primary?.command === 'START'
    || secondary.some((transition) => transition.command === 'START');
  const hasSubmit = primary?.command === 'SUBMIT_FOR_APPROVAL'
    || secondary.some((transition) => transition.command === 'SUBMIT_FOR_APPROVAL');
  const commandBlocked = (command: LifecycleCommand) => pending
    || disabledCommands.includes(command)
    || Boolean(startScheduleBlockedReason && command === 'START');

  const destructiveTransitions = secondary.filter((t) => t.command === 'CANCEL');
  const secondaryTransitions = secondary.filter((t) => t.command !== 'CANCEL');

  return <section
    className="detail-action surface-flat"
    aria-label="İş işlemleri"
    data-job-decision-panel="true"
  >
    {startLocationCaptureEnabled && hasStart && <div className="start-location-notice">
      <p>İşi başlattığınızda cihazınızdan bir kez yaklaşık konum alınmaya çalışılır.</p>
      <details className="location-notice-more">
        <summary>Ayrıntı</summary>
        <span>
          Konum iş geçmişinde saklanır. Konum alınamazsa iş yine başlar ve yönetici
          onayına gönderirken tekrar denenir. Konum servislerinin açık olması önemlidir.
        </span>
      </details>
    </div>}
    {submitLocationCaptureEnabled && hasSubmit && <div className="submit-location-notice">
      <p>Onaya gönderdiğinizde cihazınızdan bir kez yaklaşık konum alınmaya çalışılır.</p>
      <details className="location-notice-more">
        <summary>Ayrıntı</summary>
        <span>
          Konum, yetkili kullanıcıların görebildiği iş geçmişinde saklanır.
          Konum alınamazsa gönderim engellenmez.
        </span>
      </details>
    </div>}
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
        disabled={commandBlocked(primary.command)}
        aria-describedby={startScheduleBlockedReason && primary.command === 'START'
          ? START_SCHEDULE_REASON_ID
          : undefined}
        onClick={(event) => onCommand(primary.command, event.currentTarget)}
      >
        {pending ? (pendingLabel ?? 'İşleniyor…') : (
          <>
            <WorkflowCommandIcon command={primary.command} />
            {primary.label}
          </>
        )}
      </button>}
      {secondaryTransitions.map((transition) => <button
        key={transition.command}
        className="secondary-button compact-button"
        type="button"
        disabled={commandBlocked(transition.command)}
        onClick={(event) => onCommand(transition.command, event.currentTarget)}
      >
        {pending ? (pendingLabel ?? 'İşleniyor…') : (
          <>
            <WorkflowCommandIcon command={transition.command} />
            {transition.label}
          </>
        )}
      </button>)}
      {(primary || secondaryTransitions.length > 0) && destructiveTransitions.length > 0 && (
        <span className="review-buttons-separator" aria-hidden="true" />
      )}
      {destructiveTransitions.map((transition) => <button
        key={transition.command}
        className="destructive-button compact-button"
        type="button"
        disabled={commandBlocked(transition.command)}
        onClick={(event) => onCommand(transition.command, event.currentTarget)}
      >
        {pending ? (pendingLabel ?? 'İşleniyor…') : (
          <>
            <WorkflowCommandIcon command={transition.command} />
            {transition.label}
          </>
        )}
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
        {pending ? (pendingLabel ?? 'İşleniyor…') : (
          <>
            <SignalGlyph name="edit" className="button-leading-icon" size={15} />
            {recordEditAction.label}
          </>
        )}
      </button>
    </div>}
  </section>;
}
