import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type CurrentUser } from './services/api';

type DuplicateCooldown = { until: number; failure: ApiError; autoRetry: boolean };
const cooldowns = new Map<string, DuplicateCooldown>();
const listeners = new Map<string, Set<(cooldown: DuplicateCooldown) => void>>();

export const duplicateReadPauseScope = (kind: 'LIST' | 'DETAIL', user: Pick<CurrentUser, 'organizationId' | 'id'>) =>
  `CRM_DUPLICATE_${kind}:v1:${user.organizationId}:${user.id}`;

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
  const current = activeCooldown(scope);
  const next = { ...(current && current.until > cooldown.until ? current : cooldown), autoRetry: cooldown.autoRetry && (current?.autoRetry ?? true) };
  cooldowns.set(scope, next);
  listeners.get(scope)?.forEach((notify) => notify(next));
  return next;
}

/** One visible-page poll; coalesced focus/online refreshes never rebind pagination. */
export function useDuplicateRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>, autoRefresh = true, pauseScope: string) {
  const [state, setState] = useState<{ data: T | null; error: Error | null; busy: boolean; retryAt: number | null; retryAuto: boolean }>({ data: null, error: null, busy: true, retryAt: null, retryAuto: false });
  const loader = useRef(load); loader.current = load;
  const reloadRef = useRef<() => Promise<boolean>>(async () => false);
  const generation = useRef(0);
  const reload = useCallback(() => reloadRef.current(), []);
  useEffect(() => {
    const ownGeneration = ++generation.current;
    let live = true; let pending = false; let started = false; let lastStarted = 0;
    let retryTimer: number | undefined; let pollTimer: number | undefined;
    const controller = new AbortController();
    const restored = activeCooldown(pauseScope);
    let lastCooldown: DuplicateCooldown | null = restored;
    const currentGeneration = () => live && generation.current === ownGeneration;
    const visibleOnline = () => document.visibilityState === 'visible' && navigator.onLine !== false;
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
      if (!visibleOnline()) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        if (!currentGeneration()) return;
        const current = activeCooldown(pauseScope);
        if (current) {
          observeCooldown(current);
          return;
        }
        lastCooldown = null;
        setState((old) => ({ ...old, retryAt: null, retryAuto: false }));
        if (cooldown.autoRetry && !pending && visibleOnline()) void run(false, true);
      }, Math.max(0, cooldown.until - Date.now()));
    }

    function observeCooldown(cooldown: DuplicateCooldown) {
      if (!currentGeneration()) return;
      lastCooldown = cooldown;
      setState((old) => ({ ...old, error: old.error instanceof ApiError && [401, 403, 404].includes(old.error.status) ? old.error : cooldown.failure, retryAt: cooldown.until, retryAuto: cooldown.autoRetry }));
      schedule(cooldown);
    }

    async function run(automatic = false, scheduled = false) {
      if (!currentGeneration() || pending || !visibleOnline()) return false;
      const paused = activeCooldown(pauseScope);
      if (paused) { observeCooldown(paused); return false; }
      if (automatic && (!autoRefresh || Date.now() - lastStarted < 1000)) return false;
      pending = true; started = true; lastStarted = Date.now();
      setState((old) => ({ ...old, busy: true }));
      try {
        const data = await loader.current(controller.signal);
        if (!currentGeneration()) return false;
        const active = activeCooldown(pauseScope);
        if (active) {
          setState({ data, error: active.failure, busy: false, retryAt: active.until, retryAuto: active.autoRetry });
          observeCooldown(active);
        } else {
          clearRetryTimer(); lastCooldown = null;
          setState({ data, error: null, busy: false, retryAt: null, retryAuto: false });
        }
        return true;
      } catch (error) {
        if (!currentGeneration()) return false;
        const failure = error instanceof Error ? error : new Error('Karşılaştırma yüklenemedi.');
        let cooldown = activeCooldown(pauseScope);
        if (error instanceof ApiError && error.status === 429) {
          const until = Date.now() + (error.retryAfterSeconds ?? 60) * 1000;
          cooldown = rememberCooldown(pauseScope, { until, failure: error, autoRetry: !scheduled });
        }
        const discard = error instanceof ApiError && [401, 403, 404].includes(error.status);
        setState((old) => ({ ...old, data: discard ? null : old.data, busy: false, error: failure, retryAt: cooldown?.until ?? null, retryAuto: cooldown?.autoRetry ?? false }));
        if (cooldown) observeCooldown(cooldown);
        return false;
      } finally { pending = false; }
    }

    reloadRef.current = () => run();
    const subscribers = listeners.get(pauseScope) ?? new Set();
    subscribers.add(observeCooldown); listeners.set(pauseScope, subscribers);
    const refresh = () => {
      if (!visibleOnline()) {
        clearRetryTimer(); window.clearInterval(pollTimer); pollTimer = undefined;
        return;
      }
      if (autoRefresh && pollTimer === undefined) pollTimer = window.setInterval(() => void run(true), 60_000);
      const active = activeCooldown(pauseScope);
      if (active) { observeCooldown(active); return; }
      const retry = lastCooldown;
      if (retry) {
        lastCooldown = null; clearRetryTimer();
        setState((old) => ({ ...old, retryAt: null, retryAuto: false }));
      }
      if (retry?.autoRetry) void run(false, true);
      else if (!started) void run();
      else void run(true);
    };
    if (autoRefresh && visibleOnline()) pollTimer = window.setInterval(() => void run(true), 60_000);
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh); window.addEventListener('offline', refresh); document.addEventListener('visibilitychange', refresh);
    if (restored) schedule(restored); else void run();
    return () => {
      live = false; controller.abort(); window.clearInterval(pollTimer); clearRetryTimer();
      reloadRef.current = async () => false;
      subscribers.delete(observeCooldown); if (!subscribers.size) listeners.delete(pauseScope);
      window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh); document.removeEventListener('visibilitychange', refresh);
    };
  }, [key, autoRefresh, pauseScope]);
  return { ...state, reload };
}
