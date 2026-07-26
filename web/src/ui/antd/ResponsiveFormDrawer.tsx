import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

import { restoreFocus, trapTabKey } from './overlay-focus';

export type ResponsiveFormDrawerProps = {
  open: boolean;
  title: string;
  onDismiss: () => void;
  children: ReactNode;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Form-owning drawer for create/edit tasks.
 * Unlike ResponsiveDrawer, this has no Apply/Clear footer.
 * The form child owns its own form-actions (Vazgeç / Kaydet).
 */
export function ResponsiveFormDrawer({
  open,
  title,
  onDismiss,
  children,
  returnFocusRef,
}: ResponsiveFormDrawerProps): ReactNode {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = returnFocusRef?.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previous;
      restoreFocus(returnFocusRef, openerRef.current);
    };
  }, [open, returnFocusRef]);

  useEffect(() => {
    if (!open || !panelRef.current) return;
    const panel = panelRef.current;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
        return;
      }
      trapTabKey(event, panel);
    }
    panel.addEventListener('keydown', onKey);
    return () => panel.removeEventListener('keydown', onKey);
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <div className="form-drawer-root" data-servora-form-drawer="true">
      <button
        type="button"
        className="form-drawer-backdrop"
        aria-label="Formu kapat"
        onClick={onDismiss}
      />
      <div
        ref={panelRef}
        className="form-drawer surface-raised"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="form-drawer-header">
          <h2 id={titleId}>{title}</h2>
          <button
            ref={closeRef}
            type="button"
            className="secondary-button compact-button"
            onClick={onDismiss}
            aria-label="Formu kapat"
          >
            ✕
          </button>
        </div>
        <div className="form-drawer-body">{children}</div>
      </div>
    </div>
  );
}
