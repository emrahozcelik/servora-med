import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './services/api';

/** One visible-page poll; coalesced focus/online refreshes never rebind pagination. */
export function useDuplicateRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>, autoRefresh = true) {
  const [state, setState] = useState<{ data: T | null; error: Error | null; busy: boolean }>({ data: null, error: null, busy: true });
  const loader = useRef(load); loader.current = load;
  const reloadRef = useRef<() => void>(() => {});
  const reload = useCallback(() => reloadRef.current(), []);
  useEffect(() => {
    let live = true; let pending = false; let pausedUntil = 0; let lastStarted = 0;
    const controller = new AbortController();
    setState({ data: null, error: null, busy: true });
    const run = async (automatic = false) => {
      if (!live || pending || Date.now() < pausedUntil || (automatic && (!autoRefresh || document.visibilityState === 'hidden' || navigator.onLine === false || Date.now() - lastStarted < 1000))) return;
      pending = true; lastStarted = Date.now();
      setState((old) => ({ ...old, busy: true }));
      try { const data = await loader.current(controller.signal); if (live) setState({ data, error: null, busy: false }); }
      catch (error) {
        if (!live) return;
        const failure = error instanceof Error ? error : new Error('Karşılaştırma yüklenemedi.');
        if (error instanceof ApiError && error.status === 429) pausedUntil = Date.now() + (error.retryAfterSeconds ?? 60) * 1000;
        const discard = error instanceof ApiError && [401, 403, 404].includes(error.status);
        setState((old) => ({ ...old, data: discard ? null : old.data, busy: false, error: failure }));
      } finally { pending = false; }
    };
    reloadRef.current = () => { void run(); };
    const refresh = () => { void run(true); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh); document.addEventListener('visibilitychange', refresh);
    void run();
    return () => { live = false; controller.abort(); clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [key, autoRefresh]);
  return { ...state, reload };
}
