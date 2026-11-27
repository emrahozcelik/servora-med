/**
 * Reference-counted body scroll lock shared by every overlay layer. Nested
 * overlays (for example a wheel sheet over a filter drawer) release in any
 * order and the last release restores the page's original overflow value.
 */
let lockCount = 0;
let previousOverflow = '';

export function lockBodyScroll(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (lockCount === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) document.body.style.overflow = previousOverflow;
  };
}
