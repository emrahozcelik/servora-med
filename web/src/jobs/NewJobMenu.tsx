import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export type NewJobMenuProps = {
  onCreateMeeting?: () => void;
  onCreateTask?: () => void;
  onCreateDelivery?: () => void;
  /** When true, hide this control (e.g. sticky mobile create is shown elsewhere). */
  hidden?: boolean;
};

function useIsNarrowSheet() {
  const [narrow, setNarrow] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 40rem)').matches
      : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 40rem)');
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    media.addEventListener('change', onChange);
    setNarrow(media.matches);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export function NewJobMenu({
  onCreateMeeting, onCreateTask, onCreateDelivery, hidden = false,
}: NewJobMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const isSheet = useIsNarrowSheet();
  const options = [
    onCreateMeeting ? { key: 'meeting', label: 'Yeni görüşme', run: onCreateMeeting } : null,
    onCreateTask ? { key: 'task', label: 'Yeni görev', run: onCreateTask } : null,
    onCreateDelivery ? { key: 'delivery', label: 'Yeni teslim', run: onCreateDelivery } : null,
  ].filter((item): item is { key: string; label: string; run: () => void } => item !== null);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !isSheet || !panelRef.current) return;
    const panel = panelRef.current;
    const focusables = () => Array.from(
      panel.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
    );
    const items = focusables();
    items[0]?.focus();
    function onTab(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    panel.addEventListener('keydown', onTab);
    return () => panel.removeEventListener('keydown', onTab);
  }, [open, isSheet]);

  if (hidden || options.length === 0) return null;

  function choose(run: () => void) {
    setOpen(false);
    triggerRef.current?.focus();
    run();
  }

  function onTriggerKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  }

  return (
    <div className={`new-job-menu${open && isSheet ? ' new-job-menu--sheet-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="primary-button compact-button new-job-menu-trigger"
        aria-haspopup={isSheet ? 'dialog' : 'menu'}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKey}
      >
        Yeni iş
      </button>
      {open && isSheet && (
        <button
          type="button"
          className="new-job-menu-backdrop"
          aria-label="Menüyü kapat"
          onClick={() => { setOpen(false); triggerRef.current?.focus(); }}
        />
      )}
      {open && (
        <div
          ref={panelRef}
          id={menuId}
          className={`new-job-menu-panel surface-raised${isSheet ? ' new-job-menu-panel--sheet' : ''}`}
          role={isSheet ? 'dialog' : 'menu'}
          aria-modal={isSheet ? true : undefined}
          aria-label="Yeni iş oluştur"
        >
          {isSheet && <p className="new-job-menu-sheet-title">Yeni iş</p>}
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              className="new-job-menu-item"
              role={isSheet ? undefined : 'menuitem'}
              onClick={() => choose(option.run)}
            >
              {option.label}
            </button>
          ))}
          {isSheet && (
            <button
              type="button"
              className="secondary-button btn-full"
              onClick={() => { setOpen(false); triggerRef.current?.focus(); }}
            >
              Vazgeç
            </button>
          )}
        </div>
      )}
    </div>
  );
}
