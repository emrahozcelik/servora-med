import { useEffect, useRef, useState } from 'react';

/**
 * Tracks whether a horizontally scrollable strip still has content beyond its
 * right edge, so a clipped strip can always show an overflow affordance
 * (DECISIONS.md UI-005). `resetKey` re-measures after content changes.
 */
export function useHorizontalOverflow<T extends HTMLElement>(resetKey: unknown) {
  const ref = useRef<T | null>(null);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      setOverflow(element.scrollLeft + element.clientWidth < element.scrollWidth - 2);
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      element.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [resetKey]);

  return { ref, overflow };
}
