import {
  useEffect, useId, useRef, useState,
  type FormEvent, type KeyboardEvent, type ReactNode,
} from 'react';

import type {
  RecordEditPresentation,
  TransitionPresentation,
} from './job-workflow-presentation';

export type JobWorkflowDialogKind =
  | { kind: 'approve'; presentation: TransitionPresentation }
  | { kind: 'revision'; presentation: TransitionPresentation }
  | { kind: 'withdraw-edit'; presentation: RecordEditPresentation }
  | { kind: 'cancel'; presentation: TransitionPresentation };

function focusableControls(root: HTMLElement | null): HTMLElement[] {
  return Array.from(
    root?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled])') ?? [],
  );
}

export function JobWorkflowDialog(props: {
  dialog: JobWorkflowDialogKind;
  pending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}): ReactNode {
  const { dialog, pending, onClose, onConfirm } = props;
  const titleId = useId();
  const errorId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const needsReason = dialog.kind === 'revision' || dialog.kind === 'cancel';

  useEffect(() => { cancelRef.current?.focus(); }, []);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pending) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = focusableControls(dialogRef.current);
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (needsReason) {
      const normalized = reason.trim();
      if (!normalized) {
        setError('Neden alanı zorunludur.');
        return;
      }
      onConfirm(normalized);
      return;
    }
    onConfirm('');
  }

  const title = dialog.kind === 'approve'
    ? (dialog.presentation.confirmation?.title ?? dialog.presentation.label)
    : dialog.kind === 'withdraw-edit'
      ? (dialog.presentation.confirmation?.title ?? dialog.presentation.label)
      : dialog.presentation.label;

  const details = dialog.kind === 'approve' || dialog.kind === 'withdraw-edit'
    ? (dialog.presentation.confirmation?.details ?? [])
    : [];

  const confirmLabel = dialog.kind === 'approve'
    ? (dialog.presentation.confirmation?.confirmLabel ?? 'İşi tamamla')
    : dialog.kind === 'revision'
      ? 'Düzeltme için geri gönder'
      : dialog.kind === 'withdraw-edit'
        ? (dialog.presentation.confirmation?.confirmLabel ?? 'Kontrolden çıkar ve düzenle')
        : 'İşi iptal et';

  const description = dialog.kind === 'approve'
    ? dialog.presentation.consequence
    : dialog.kind === 'revision'
      ? 'Personelin neyi düzeltmesi gerektiğini açıklayın.'
      : dialog.kind === 'withdraw-edit'
        ? dialog.presentation.consequence
        : 'Bu işlem terminaldir; iptal edilen iş yeniden açılamaz. İptal nedenini iş geçmişine ekleyin.';

  const reasonLabel = dialog.kind === 'revision' ? 'Düzeltme nedeni' : 'İptal nedeni';
  const confirmDisabled = pending || (needsReason && !reason.trim());

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        className="workflow-dialog reason-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={keyDown}
      >
        <h2 id={titleId}>{title}</h2>
        <p>{description}</p>
        {details.length > 0 && (
          <ul className="workflow-dialog-details">
            {details.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
        )}
        <form onSubmit={submit} noValidate>
          {needsReason && (
            <div className="field-group">
              <label htmlFor={`${titleId}-reason`}>{reasonLabel}</label>
              <textarea
                id={`${titleId}-reason`}
                rows={4}
                maxLength={2000}
                value={reason}
                disabled={pending}
                required
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(event) => {
                  setReason(event.target.value);
                  setError('');
                }}
              />
            </div>
          )}
          {error && <p id={errorId} className="field-error" role="alert">{error}</p>}
          <div className="review-buttons">
            <button
              ref={cancelRef}
              className="secondary-button"
              type="button"
              disabled={pending}
              onClick={onClose}
            >
              Vazgeç
            </button>
            <button
              className={dialog.kind === 'cancel' ? 'destructive-button compact-button' : 'primary-button compact-button'}
              type="submit"
              disabled={confirmDisabled}
            >
              {pending ? 'İşleniyor…' : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
