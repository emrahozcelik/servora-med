import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './services/api';

/** One visible-page poll; coalesced focus/online refreshes never rebind pagination. */
export function useDuplicateRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>, autoRefresh = true) {
  const [state, setState] = useState<{ data: T | null; error: Error | null; busy: boolean; retryAt: number | null; retryAuto: boolean }>({ data: null, error: null, busy: true, retryAt: null, retryAuto: false });
  const loader = useRef(load); loader.current = load;
  const reloadRef = useRef<() => void>(() => {});
  const reload = useCallback(() => reloadRef.current(), []);
  useEffect(() => {
    let live = true; let pending = false; let pausedUntil = 0; let lastStarted = 0; let retryTimer: number | undefined;
    const controller = new AbortController();
    setState({ data: null, error: null, busy: true, retryAt: null, retryAuto: false });
    const run = async (automatic = false, scheduled = false) => {
      if (!live || pending || Date.now() < pausedUntil || (automatic && (!autoRefresh || document.visibilityState === 'hidden' || navigator.onLine === false || Date.now() - lastStarted < 1000))) return;
      pending = true; lastStarted = Date.now();
      setState((old) => ({ ...old, busy: true }));
      try { const data = await loader.current(controller.signal); if (live) setState({ data, error: null, busy: false, retryAt: null, retryAuto: false }); }
      catch (error) {
        if (!live) return;
        const failure = error instanceof Error ? error : new Error('Karşılaştırma yüklenemedi.');
        const paused = error instanceof ApiError && error.status === 429;
        if (paused) {
          const seconds = error.retryAfterSeconds ?? 60;
          pausedUntil = Date.now() + seconds * 1000;
          if (retryTimer !== undefined) window.clearTimeout(retryTimer);
          retryTimer = window.setTimeout(() => {
            retryTimer = undefined;
            if (!live) return;
            pausedUntil = 0;
            setState((old) => ({ ...old, retryAt: null, retryAuto: false }));
            if (!scheduled && document.visibilityState === 'visible' && navigator.onLine !== false) void run(false, true);
          }, seconds * 1000);
        }
        const discard = error instanceof ApiError && [401, 403, 404].includes(error.status);
        setState((old) => ({ ...old, data: discard ? null : old.data, busy: false, error: failure, retryAt: paused ? pausedUntil : null, retryAuto: paused ? !scheduled : false }));
      } finally { pending = false; }
    };
    reloadRef.current = () => { void run(); };
    const refresh = () => { void run(true); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh); document.addEventListener('visibilitychange', refresh);
    void run();
    return () => { live = false; controller.abort(); clearInterval(timer); if (retryTimer !== undefined) window.clearTimeout(retryTimer); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [key, autoRefresh]);
  return { ...state, reload };
}
