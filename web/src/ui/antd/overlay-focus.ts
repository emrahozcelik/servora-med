import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableElements(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
}

export function trapTabKey(
  event: ReactKeyboardEvent<HTMLElement> | KeyboardEvent,
  root: HTMLElement | null,
): void {
  if (event.key !== 'Tab' || !root) return;
  const focusable = focusableElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (focusable.length === 1) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (!root.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

export function restoreFocus(
  returnFocusRef?: RefObject<HTMLElement | null>,
  fallback?: HTMLElement | null,
): void {
  const target = returnFocusRef?.current ?? fallback ?? null;
  queueMicrotask(() => target?.focus());
}

/** Focus preferred control when enabled; otherwise keep focus on the dialog root. */
export function focusOverlay(
  dialog: HTMLElement | null,
  preferred: HTMLButtonElement | null | undefined,
): void {
  if (preferred && !preferred.disabled) {
    preferred.focus();
    return;
  }
  dialog?.focus();
}

/** When pending disables controls, ensure active focus stays inside the dialog. */
export function ensureFocusInsideOverlay(
  dialog: HTMLElement | null,
  preferred?: HTMLButtonElement | null,
): void {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement
    && dialog?.contains(active)
    && !(active instanceof HTMLButtonElement && active.disabled)
    && !(active instanceof HTMLTextAreaElement && active.disabled)
    && !(active instanceof HTMLInputElement && active.disabled)
  ) {
    return;
  }
  focusOverlay(dialog, preferred ?? null);
}
