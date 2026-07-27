import { useSyncExternalStore } from 'react';

/** SSR/JSDOM-safe reactive viewport width. */
export function useResponsiveViewport(): number {
  return useSyncExternalStore(
    (callback) => {
      if (typeof window === 'undefined') return () => {};
      window.addEventListener('resize', callback);
      return () => window.removeEventListener('resize', callback);
    },
    () => (typeof window !== 'undefined' ? window.innerWidth : 1024),
  );
}

/** Compact mode (mobile): viewport < 640px. Reactive across resize. */
export function useCompact(): boolean {
  return useResponsiveViewport() < 640;
}
