import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
  type KeyboardEvent,
} from 'react';

import { restoreFocus, trapTabKey } from './overlay-focus';

export type ConfirmationActionProps = {
  open: boolean;
  title: string;
  description?: ReactNode;
  details?: readonly string[];
  confirmLabel: string;
  cancelLabel?: string;
  pending: boolean;
  pendingLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Owned modal confirmation dialog. Popconfirm is intentionally out of PR D.
 * Feature owns open/pending/commands; this adapter owns focus trap and restoration.
 */
export function ConfirmationAction({
  open,
  title,
  description,
  details = [],
  confirmLabel,
  cancelLabel = 'Vazgeç',
  pending,
  pendingLabel = 'İşleniyor…',
  destructive = false,
  onConfirm,
  onCancel,
  returnFocusRef,
}: ConfirmationActionProps): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
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

  function handleConfirm() {
    if (pending) return;
    onConfirm();
  }

  function handleCancel() {
    if (pending) return;
    onCancel();
  }

  return (
    <div className="product-dialog-backdrop dialog-backdrop">
      <div
        ref={dialogRef}
        className="product-dialog workflow-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        {description != null && description !== '' && (
          <p id={descriptionId}>{description}</p>
        )}
        {details.length > 0 && (
          <ul className="workflow-dialog-details">
            {details.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
        )}
        <div className="product-dialog-actions review-buttons">
          <button
            ref={cancelRef}
            className="secondary-button"
            type="button"
            onClick={handleCancel}
            disabled={pending}
          >
            {cancelLabel}
          </button>
          <button
            className={destructive ? 'destructive-button' : 'primary-button compact-button'}
            type="button"
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
