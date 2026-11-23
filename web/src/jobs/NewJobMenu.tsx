import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useInRouterContext, useLocation } from 'react-router-dom';

export type NewJobMenuProps = {
  onCreateMeeting?: () => void;
  onCreateTask?: () => void;
  onCreateSale?: () => void;
  onCreateDelivery?: () => void;
  onCreateWeeklyReport?: () => void;
  /** Decorative leading glyph for compact mobile triggers (bottom navigation). */
  triggerIcon?: ReactNode;
  /** When true, hide this control (e.g. mobile create is shown elsewhere). */
  hidden?: boolean;
  /**
   * Explicit presentation. The bottom-navigation create must use `sheet` for all
   * <64rem. Toolbar desktop uses `popover`. Do not guess from viewport alone.
   */
  presentation?: 'popover' | 'sheet';
};

/**
 * Closes an open layer when the location changes (Back/Forward or programmatic
 * navigation). Focus is intentionally not pushed back to the trigger: the new
 * route owns the page, so the stale trigger must not steal it.
 */
function RouteChangeCloser({ onRouteChange }: { onRouteChange: () => void }) {
  const { pathname, search } = useLocation();
  const routeKey = `${pathname}${search}`;
  const initialKey = useRef(routeKey);
  const callbackRef = useRef(onRouteChange);
  callbackRef.current = onRouteChange;
  useEffect(() => {
    if (routeKey === initialKey.current) return;
    callbackRef.current();
  }, [routeKey]);
  return null;
}

export function NewJobMenu({
  onCreateMeeting, onCreateTask, onCreateSale, onCreateDelivery, onCreateWeeklyReport, triggerIcon, hidden = false, presentation = 'popover',
}: NewJobMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const menuId = useId();
  const isSheet = presentation === 'sheet';
  const inRouter = useInRouterContext();
  const options = [
    onCreateMeeting ? { key: 'meeting', label: 'Görüşme / ziyaret planla', run: onCreateMeeting } : null,
    onCreateTask ? { key: 'task', label: 'Yeni görev', run: onCreateTask } : null,
    onCreateDelivery ? { key: 'delivery', label: 'Yeni teslim', run: onCreateDelivery } : null,
    onCreateSale ? { key: 'sale', label: 'Satış kaydı', run: onCreateSale } : null,
    onCreateWeeklyReport ? { key: 'weekly-report', label: 'Haftalık Rapor', run: onCreateWeeklyReport } : null,
  ].filter((item): item is { key: string; label: string; run: () => void } => item !== null);

  /**
   * `restoreFocus` is false for dismissals that leave focus where the user put
   * it (outside taps, route changes). Keyboard dismissals and the backdrop
   * restore focus to the trigger.
   */
  const requestClose = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) restoreFocusRef.current = true;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (open || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      // The sheet backdrop owns its own click so it can close with focus
      // restoration; ignore it here to avoid unmounting before that click.
      if (backdropRef.current?.contains(target)) return;
      requestClose(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose(true);
      }
    }
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, requestClose]);

  useEffect(() => {
    if (!open || !isSheet) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open, isSheet]);

  useEffect(() => {
    if (!open || !isSheet || !panelRef.current) return;
    const panel = panelRef.current;
    const focusables = () => Array.from(
      panel.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
    );
    focusables()[0]?.focus();
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
    // Same containment contract as the shell menu panel: focus may not leave
    // the modal sheet by any means, not only by Tab.
    function containFocus(event: FocusEvent) {
      if (event.target instanceof Node && !panel.contains(event.target)) {
        focusables()[0]?.focus();
      }
    }
    panel.addEventListener('keydown', onTab);
    document.addEventListener('focusin', containFocus);
    return () => {
      panel.removeEventListener('keydown', onTab);
      document.removeEventListener('focusin', containFocus);
    };
  }, [open, isSheet]);

  if (hidden || options.length === 0) return null;

  function choose(run: () => void) {
    requestClose(true);
    run();
  }

  function onTriggerKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen((value) => !value);
    }
  }

  const backdrop = open && isSheet ? (
    <button
      ref={backdropRef}
      type="button"
      className="new-job-menu-backdrop"
      aria-label="Menüyü kapat"
      onClick={() => requestClose(true)}
    />
  ) : null;

  const panel = open ? (
    <div
      ref={panelRef}
      id={menuId}
      className={`new-job-menu-panel surface-raised${isSheet ? ' new-job-menu-panel--sheet' : ''}`}
      role={isSheet ? 'dialog' : undefined}
      aria-modal={isSheet ? true : undefined}
      aria-label="Yeni iş oluştur"
    >
      {isSheet && <p className="new-job-menu-sheet-title">Yeni iş</p>}
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className="new-job-menu-item"
          onClick={() => choose(option.run)}
        >
          {option.label}
        </button>
      ))}
      {isSheet && (
        <button type="button" className="secondary-button btn-full" onClick={() => requestClose(true)}>
          Vazgeç
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className={`new-job-menu${open && isSheet ? ' new-job-menu--sheet-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="primary-button compact-button new-job-menu-trigger"
        aria-haspopup={isSheet ? 'dialog' : undefined}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKey}
      >
        {triggerIcon ? <span className="new-job-menu-trigger-icon" aria-hidden="true">{triggerIcon}</span> : null}
        <span className="new-job-menu-trigger-label">Yeni iş</span>
      </button>
      {/*
        The sheet is a global modal layer: it must not live inside the fixed
        bottom navigation, whose own stacking context would trap the backdrop
        (z 45) and panel (z 50) below the shell drawer, notification and dialog
        layers. The desktop disclosure stays inline and unchanged.
      */}
      {isSheet && typeof document !== 'undefined'
        ? createPortal(<>{backdrop}{panel}</>, document.body)
        : <>{backdrop}{panel}</>}
      {open && inRouter && <RouteChangeCloser onRouteChange={() => requestClose(false)} />}
    </div>
  );
}
