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

import {
  ensureFocusInsideOverlay,
  focusOverlay,
  restoreFocus,
  trapTabKey,
} from './overlay-focus';
import { counterState } from '../counter-policy';
import { ProgressiveCounter } from '../ProgressiveCounter';

export type ReasonDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  /** Consequence list rendered under the description, like ConfirmationAction. */
  details?: readonly string[];
  reasonLabel: string;
  helperText?: ReactNode;
  requiredMessage?: string;
  confirmLabel: string;
  cancelLabel?: string;
  maxLength: number;
  required: boolean;
  pending: boolean;
  pendingLabel?: string;
  inputsDisabled?: boolean;
  destructive?: boolean;
  prelude?: ReactNode;
  validatePrelude?: () => string | null;
  confirmDisabled?: boolean;
  /** Optional focus target for content that is loaded after the dialog opens. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  initialFocusReady?: boolean;
  /**
   * Server/feature-owned error for the reason textarea. Rendered with the
   * textarea's own error slot and focused when it appears.
   */
  externalError?: string | null;
  onReasonChange?: (reason: string) => void;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusEnabledRef?: RefObject<boolean>;
};

/**
 * Owned modal for required (or optional) free-text reason capture.
 * Never uses Popconfirm. Feature owns open/pending/commands; adapter owns draft/error/focus.
 */
export function ReasonDialog({
  open,
  title,
  description,
  details = [],
  reasonLabel,
  helperText,
  requiredMessage = 'Neden alanı zorunludur.',
  confirmLabel,
  cancelLabel = 'Vazgeç',
  maxLength,
  required,
  pending,
  pendingLabel = 'İşleniyor…',
  inputsDisabled = false,
  destructive = false,
  prelude,
  validatePrelude,
  confirmDisabled = false,
  initialFocusRef,
  initialFocusReady = false,
  externalError = null,
  onReasonChange,
  onConfirm,
  onCancel,
  returnFocusRef,
  restoreFocusEnabledRef,
}: ReasonDialogProps): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  const detailsId = useId();
  const errorId = useId();
  const helpId = useId();
  const counterId = useId();
  const reasonId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
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
    focusOverlay(dialogRef.current, cancelRef.current);

    function keepFocusInside(event: FocusEvent) {
      if (dialogRef.current?.contains(event.target as Node)) return;
      focusOverlay(dialogRef.current, cancelRef.current);
    }
    document.addEventListener('focusin', keepFocusInside);
    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      if (restoreFocusEnabledRef?.current !== false) {
        restoreFocus(returnFocusRef, openerRef.current);
      }
    };
  }, [open, restoreFocusEnabledRef, returnFocusRef]);

  useEffect(() => {
    if (!open || !initialFocusReady) return;
    const target = initialFocusRef?.current;
    if (!target || ('disabled' in target && Boolean((target as HTMLButtonElement).disabled))) return;
    const active = document.activeElement;
    if (active !== cancelRef.current && active !== dialogRef.current) return;
    target.focus();
  }, [initialFocusReady, initialFocusRef, open]);

  // RESCUE-002: a server/feature field error appears after the submit. Drive
  // the focus from the settled response (`pending` false) so a repeated
  // identical error still refocuses the textarea once it is enabled again.
  useEffect(() => {
    if (!open || pending || !externalError) return;
    reasonRef.current?.focus();
  }, [open, pending, externalError]);

  useEffect(() => {
    if (!open || !pending) return;
    ensureFocusInsideOverlay(dialogRef.current, cancelRef.current);
  }, [open, pending]);

  if (!open) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pending && !inputsDisabled) {
      event.preventDefault();
      onCancel();
      return;
    }
    trapTabKey(event, dialogRef.current);
  }

  function handleCancel() {
    if (pending || inputsDisabled) return;
    onCancel();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || confirmDisabled) return;
    const preludeError = validatePrelude?.();
    if (preludeError) {
      setError('');
      return;
    }
    if (required) {
      const normalized = reason.trim();
      if (!normalized) {
        setError(requiredMessage);
        requestAnimationFrame(() => reasonRef.current?.focus());
        return;
      }
      if (Array.from(normalized).length > maxLength) {
        setError(`${reasonLabel} en fazla ${maxLength.toLocaleString('tr-TR')} karakter olmalıdır.`);
        requestAnimationFrame(() => reasonRef.current?.focus());
        return;
      }
      onConfirm(normalized);
      return;
    }
    const normalized = reason.trim();
    if (Array.from(normalized).length > maxLength) {
      setError(`${reasonLabel} en fazla ${maxLength.toLocaleString('tr-TR')} karakter olmalıdır.`);
      requestAnimationFrame(() => reasonRef.current?.focus());
      return;
    }
    onConfirm(normalized);
  }

  const descriptionParagraphs = typeof description === 'string' && description.includes('\n')
    ? description.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    : null;
  const shownError = error || externalError || '';

  return (
    <div className="dialog-backdrop product-dialog-backdrop">
      <div
        ref={dialogRef}
        className="workflow-dialog reason-dialog product-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={details.length > 0 ? `${descriptionId} ${detailsId}` : descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        {descriptionParagraphs ? (
          <div id={descriptionId} className="reason-dialog-description">
            {descriptionParagraphs.map((line, i) => <p key={i}>{line}</p>)}
          </div>
        ) : (
          <p id={descriptionId}>{description}</p>
        )}
        {details.length > 0 && (
          <ul id={detailsId} className="workflow-dialog-details">
            {details.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
        )}
        {prelude}
        <form onSubmit={submit} noValidate>
          <div className="field-group">
            <label htmlFor={reasonId}>{reasonLabel}</label>
            <textarea
              ref={reasonRef}
              id={reasonId}
              rows={4}
              value={reason}
              disabled={pending || inputsDisabled}
              required={required}
              aria-invalid={shownError ? 'true' : undefined}
              aria-describedby={[
                helperText ? helpId : null,
                counterState(maxLength - Array.from(reason.trim()).length) !== 'hidden' ? counterId : null,
                shownError ? errorId : null,
              ].filter(Boolean).join(' ')}
              onChange={(event) => {
                setReason(event.target.value);
                onReasonChange?.(event.target.value);
                setError(Array.from(event.target.value.trim()).length > maxLength
                  ? `${reasonLabel} en fazla ${maxLength.toLocaleString('tr-TR')} karakter olmalıdır.`
                  : '');
              }}
            />
          </div>
          {helperText && <p id={helpId} className="form-help">{helperText}</p>}
          <ProgressiveCounter
            remaining={maxLength - Array.from(reason.trim()).length}
            dataCounter="reason"
          >{Math.max(0, maxLength - Array.from(reason.trim()).length).toLocaleString('tr-TR')} karakter kaldı
          </ProgressiveCounter>
          {shownError && (
            <p id={errorId} className="field-error" role="alert">{shownError}</p>
          )}
          <div className="review-buttons product-dialog-actions">
            <button
              ref={cancelRef}
              className="secondary-button"
              type="button"
              disabled={pending || inputsDisabled}
              onClick={handleCancel}
            >
              {cancelLabel}
            </button>
            <button
              className={destructive ? 'destructive-button compact-button' : 'primary-button compact-button'}
              type="submit"
              disabled={pending || Boolean(confirmDisabled)}
            >
              {pending ? pendingLabel : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
