import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

import { restoreFocus, trapTabKey } from './overlay-focus';

export type ResponsiveDrawerProps = {
  open: boolean;
  title: string;
  onDismiss: () => void;
  onApply: () => void;
  onClear: () => void;
  children: ReactNode;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Mobile filter sheet parity drawer. AppShell navigation drawer is intentionally
 * not migrated. Callers keep the desktop vs sheet gate.
 */
export function ResponsiveDrawer({
  open,
  title,
  onDismiss,
  onApply,
  onClear,
  children,
  returnFocusRef,
}: ResponsiveDrawerProps): ReactNode {
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
    <div className="filter-sheet-root" data-servora-responsive-drawer="true">
      <button
        type="button"
        className="filter-sheet-backdrop"
        aria-label="Filtreleri kapat"
        onClick={onDismiss}
      />
      <div
        ref={panelRef}
        className="filter-sheet surface-raised"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="filter-sheet-header">
          <h2 id={titleId}>{title}</h2>
          <button
            ref={closeRef}
            type="button"
            className="secondary-button compact-button"
            onClick={onDismiss}
          >
            Vazgeç
          </button>
        </div>
        <div className="filter-sheet-body">{children}</div>
        <div className="filter-sheet-actions">
          <button type="button" className="secondary-button" onClick={onClear}>Temizle</button>
          <button type="button" className="primary-button compact-button" onClick={onApply}>
            Uygula
          </button>
        </div>
      </div>
    </div>
  );
}
