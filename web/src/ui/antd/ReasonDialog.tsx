import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { restoreFocus, trapTabKey } from './overlay-focus';

export type ReasonDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  reasonLabel: string;
  confirmLabel: string;
  cancelLabel?: string;
  maxLength: number;
  required: boolean;
  pending: boolean;
  pendingLabel?: string;
  destructive?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Owned modal for required (or optional) free-text reason capture.
 * Never uses Popconfirm. Feature owns open/pending/commands; adapter owns draft/error/focus.
 */
export function ReasonDialog({
  open,
  title,
  description,
  reasonLabel,
  confirmLabel,
  cancelLabel = 'Vazgeç',
  maxLength,
  required,
  pending,
  pendingLabel = 'İşleniyor…',
  destructive = false,
  onConfirm,
  onCancel,
  returnFocusRef,
}: ReasonDialogProps): ReactNode {
  const titleId = useId();
  const errorId = useId();
  const reasonId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setReason('');
      setError('');
      return;
    }
    setReason('');
    setError('');
    openerRef.current = returnFocusRef?.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    cancelRef.current?.focus();

    function keepFocusInside(event: FocusEvent) {
      if (dialogRef.current?.contains(event.target as Node)) return;
      (cancelRef.current ?? dialogRef.current)?.focus();
    }
    document.addEventListener('focusin', keepFocusInside);
    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      restoreFocus(returnFocusRef, openerRef.current);
    };
  }, [open, returnFocusRef]);

  if (!open) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pending) {
      event.preventDefault();
      onCancel();
      return;
    }
    trapTabKey(event, dialogRef.current);
  }

  function handleCancel() {
    if (pending) return;
    onCancel();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (required) {
      const normalized = reason.trim();
      if (!normalized) {
        setError('Neden alanı zorunludur.');
        return;
      }
      onConfirm(normalized);
      return;
    }
    onConfirm(reason.trim());
  }

  const confirmDisabled = pending || (required && !reason.trim());

  return (
    <div className="dialog-backdrop product-dialog-backdrop">
      <div
        ref={dialogRef}
        className="workflow-dialog reason-dialog product-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        <p>{description}</p>
        <form onSubmit={submit} noValidate>
          <div className="field-group">
            <label htmlFor={reasonId}>{reasonLabel}</label>
            <textarea
              id={reasonId}
              rows={4}
              maxLength={maxLength}
              value={reason}
              disabled={pending}
              required={required}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                setReason(event.target.value);
                setError('');
              }}
            />
          </div>
          {error && (
            <p id={errorId} className="field-error" role="alert">{error}</p>
          )}
          <div className="review-buttons product-dialog-actions">
            <button
              ref={cancelRef}
              className="secondary-button"
              type="button"
              disabled={pending}
              onClick={handleCancel}
            >
              {cancelLabel}
            </button>
            <button
              className={destructive ? 'destructive-button compact-button' : 'primary-button compact-button'}
              type="submit"
              disabled={confirmDisabled}
            >
              {pending ? pendingLabel : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
