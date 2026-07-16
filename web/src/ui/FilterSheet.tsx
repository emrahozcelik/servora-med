import { useEffect, useId, useRef, type ReactNode } from 'react';

export function FilterSheet({
  open,
  title,
  onDismiss,
  onApply,
  onClear,
  children,
}: {
  open: boolean;
  title: string;
  onDismiss: () => void;
  onApply: () => void;
  onClear: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  useEffect(() => {
    if (!open || !panelRef.current) return;
    const panel = panelRef.current;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      );
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    panel.addEventListener('keydown', onKey);
    return () => panel.removeEventListener('keydown', onKey);
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <div className="filter-sheet-root">
      <button type="button" className="filter-sheet-backdrop" aria-label="Filtreleri kapat" onClick={onDismiss} />
      <div
        ref={panelRef}
        className="filter-sheet surface-raised"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="filter-sheet-header">
          <h2 id={titleId}>{title}</h2>
          <button ref={closeRef} type="button" className="secondary-button compact-button" onClick={onDismiss}>
            Vazgeç
          </button>
        </div>
        <div className="filter-sheet-body">{children}</div>
        <div className="filter-sheet-actions">
          <button type="button" className="secondary-button" onClick={onClear}>Temizle</button>
          <button type="button" className="primary-button compact-button" onClick={onApply}>Uygula</button>
        </div>
      </div>
    </div>
  );
}

export function useIsNarrowFilters(maxWidth = '56rem') {
  const query = `(max-width: ${maxWidth})`;
  // lazy import pattern avoided — inline hook in consumers via matchMedia
  return query;
}

export function countTruthy(values: Array<string | boolean | undefined | null>): number {
  return values.filter((value) => {
    if (value === undefined || value === null || value === false || value === '') return false;
    return true;
  }).length;
}
