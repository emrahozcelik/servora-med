import { useEffect, useState, useSyncExternalStore } from 'react';

const DESKTOP_SHELL_MEDIA_QUERY = '(min-width: 64rem)';

/** SSR/JSDOM-safe reactive viewport width. */
export function useResponsiveViewport(): number {
  return useSyncExternalStore(
    (callback) => {
      if (typeof window === 'undefined') return () => {};
      window.addEventListener('resize', callback);
      return () => window.removeEventListener('resize', callback);
    },
    () => (typeof window !== 'undefined' ? window.innerWidth : 1024),
    () => 1024,
  );
}

/** Compact mode (mobile): viewport < 640px. Reactive across resize. */
export function useCompact(): boolean {
  return useResponsiveViewport() < 640;
}

/** Compact filter sheet when shell is below the desktop 64rem gate. */
export function useNarrowShell(): boolean {
  const [narrow, setNarrow] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? !window.matchMedia(DESKTOP_SHELL_MEDIA_QUERY).matches
      : false
  ));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(DESKTOP_SHELL_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setNarrow(!event.matches);
    media.addEventListener('change', onChange);
    setNarrow(!media.matches);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
