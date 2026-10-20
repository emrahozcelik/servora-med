import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './services/api';

type DuplicateCooldown = { until: number; failure: ApiError; autoRetry: boolean };
const cooldowns = new Map<string, DuplicateCooldown>();

function activeCooldown(scope: string): DuplicateCooldown | null {
  const current = cooldowns.get(scope);
  if (!current) return null;
  if (Date.now() >= current.until) {
    cooldowns.delete(scope);
    return null;
  }
  return current;
}

function rememberCooldown(scope: string, cooldown: DuplicateCooldown) {
  const now = Date.now();
  for (const [key, entry] of cooldowns) if (entry.until <= now) cooldowns.delete(key);
  cooldowns.set(scope, cooldown);
}

/** One visible-page poll; coalesced focus/online refreshes never rebind pagination. */
export function useDuplicateRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>, autoRefresh = true, pauseScope: string) {
  const [state, setState] = useState<{ data: T | null; error: Error | null; busy: boolean; retryAt: number | null; retryAuto: boolean }>({ data: null, error: null, busy: true, retryAt: null, retryAuto: false });
  const loader = useRef(load); loader.current = load;
  const reloadRef = useRef<() => void>(() => {});
  const reload = useCallback(() => reloadRef.current(), []);
  useEffect(() => {
    let live = true; let pending = false; let lastStarted = 0; let retryTimer: number | undefined;
    const controller = new AbortController();
    const restored = activeCooldown(pauseScope);
    let pausedUntil = restored?.until ?? 0;
    setState(restored
      ? { data: null, error: restored.failure, busy: false, retryAt: restored.until, retryAuto: restored.autoRetry }
      : { data: null, error: null, busy: true, retryAt: null, retryAuto: false });

    function clearRetryTimer() {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    }

    function schedule(cooldown: DuplicateCooldown) {
      clearRetryTimer();
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        if (!live) return;
        const current = cooldowns.get(pauseScope);
        if (current && current.until > Date.now()) {
          schedule(current);
          return;
        }
        cooldowns.delete(pauseScope);
        pausedUntil = 0;
        setState((old) => ({ ...old, retryAt: null, retryAuto: false }));
        if (cooldown.autoRetry && !pending && document.visibilityState === 'visible' && navigator.onLine !== false) void run(false, true);
      }, Math.max(0, cooldown.until - Date.now()));
    }

    async function run(automatic = false, scheduled = false) {
      if (!live || pending || Date.now() < pausedUntil || (automatic && (!autoRefresh || document.visibilityState === 'hidden' || navigator.onLine === false || Date.now() - lastStarted < 1000))) return;
      pending = true; lastStarted = Date.now();
      setState((old) => ({ ...old, busy: true }));
      try {
        const data = await loader.current(controller.signal);
        if (!live) return;
        clearRetryTimer();
        cooldowns.delete(pauseScope);
        pausedUntil = 0;
        setState({ data, error: null, busy: false, retryAt: null, retryAuto: false });
      } catch (error) {
        if (!live) return;
        const failure = error instanceof Error ? error : new Error('Karşılaştırma yüklenemedi.');
        let retryAt: number | null = null;
        let retryAuto = false;
        if (error instanceof ApiError && error.status === 429) {
          const until = Date.now() + (error.retryAfterSeconds ?? 60) * 1000;
          const cooldown = { until, failure: error, autoRetry: !scheduled };
          rememberCooldown(pauseScope, cooldown);
          pausedUntil = until;
          retryAt = until;
          retryAuto = cooldown.autoRetry;
          schedule(cooldown);
        }
        const discard = error instanceof ApiError && [401, 403, 404].includes(error.status);
        setState((old) => ({ ...old, data: discard ? null : old.data, busy: false, error: failure, retryAt, retryAuto }));
      } finally { pending = false; }
    }

    reloadRef.current = () => { void run(); };
    const refresh = () => { void run(true); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh); document.addEventListener('visibilitychange', refresh);
    if (restored) schedule(restored); else void run();
    return () => { live = false; controller.abort(); clearInterval(timer); clearRetryTimer(); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [key, autoRefresh, pauseScope]);
  return { ...state, reload };
}
