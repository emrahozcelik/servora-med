import { useCallback, useEffect, useRef } from 'react';

import { getCurrentUser, type CurrentUser } from './services/api';

/** Minimum gap between two automatic (focus / visibility) revalidations. */
export const IDENTITY_REVALIDATION_MIN_INTERVAL_MS = 30_000;

export type IdentityRevalidationOptions = {
  /**
   * Stable key of the signed-in identity, or `null` while signed out / still
   * bootstrapping. Every change (logout, a new login, unmount) ends the
   * current revalidation session: its in-flight response is ignored.
   */
  sessionKey: string | null;
  /** Receives the fresh identity, or `null` when the server answered 401. */
  onIdentity: (identity: CurrentUser | null) => void;
  load?: () => Promise<CurrentUser | null>;
};

/**
 * Keeps the customer identity (notably module capabilities such as
 * `overviewDashboard`) current while a tab stays open (MOD-002 §8).
 *
 * - Triggers: window focus and `visibilitychange`, visible tab only, throttled.
 * - Single in-flight request; a forced call (after an Overview `404`) skips
 *   the throttle but never overlaps a running request.
 * - `401` reports `null` (logout); network and 5xx failures keep the identity.
 * - Responses that arrive after the session ended are dropped.
 *
 * Returns a stable function that requests one forced revalidation.
 */
export function useIdentityRevalidation({
  sessionKey,
  onIdentity,
  load = getCurrentUser,
}: IdentityRevalidationOptions): () => void {
  const onIdentityRef = useRef(onIdentity);
  const loadRef = useRef(load);
  const requestRef = useRef<((force: boolean) => void) | null>(null);

  useEffect(() => {
    onIdentityRef.current = onIdentity;
    loadRef.current = load;
  });

  useEffect(() => {
    if (sessionKey === null) return;
    let active = true;
    let inFlight = false;
    let lastStartedAt = Number.NEGATIVE_INFINITY;

    const run = (force: boolean) => {
      if (!active || inFlight) return;
      const now = Date.now();
      if (!force && now - lastStartedAt < IDENTITY_REVALIDATION_MIN_INTERVAL_MS) return;
      inFlight = true;
      lastStartedAt = now;
      Promise.resolve()
        .then(() => loadRef.current())
        .then((identity) => { if (active) onIdentityRef.current(identity); })
        .catch(() => { /* Network or 5xx: keep the current identity. */ })
        .finally(() => { inFlight = false; });
    };

    const onVisibility = () => { if (document.visibilityState === 'visible') run(false); };
    const onFocus = () => { if (document.visibilityState !== 'hidden') run(false); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    requestRef.current = run;

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      if (requestRef.current === run) requestRef.current = null;
    };
  }, [sessionKey]);

  return useCallback(() => { requestRef.current?.(true); }, []);
}

/** Field-for-field equality of two parsed identities (parser output has a stable key order). */
export function isSameIdentity(a: CurrentUser, b: CurrentUser): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
