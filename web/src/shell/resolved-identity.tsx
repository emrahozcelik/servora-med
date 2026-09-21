import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import type { CurrentUser } from '../services/api';
import { resolveIdentityTitle } from './navigation-model';
import type { RouteMatch } from './route-identity';

export type ResolvedRouteIdentity = {
  identity: RouteMatch['identity'];
  params: RouteMatch['params'];
  /** Plain presentation label supplied by the loaded page; undefined until then. */
  runtimeLabel?: string;
  /**
   * The single effective title every consumer reads (PageHeader H1,
   * MobileTopBar title, breadcrumb current item, document.title).
   */
  effectiveTitle: string;
};

type ResolvedIdentityContextValue = {
  /** Null on unknown paths; shell falls back to the canonical boot title. */
  resolved: ResolvedRouteIdentity | null;
  setRuntimeLabel: (label: string | undefined) => void;
};

const ResolvedIdentityContext = createContext<ResolvedIdentityContextValue | null>(null);

/**
 * THE single fallback-combination point (Slice 3A, DESIGN.md normative).
 * `runtimeLabel ?? displayTitle` must not be reproduced in consumers;
 * they read ResolvedRouteIdentity.effectiveTitle instead.
 */
export function combineResolvedTitle(displayTitle: string, runtimeLabel: string | undefined): string {
  return runtimeLabel ?? displayTitle;
}

export function ResolvedIdentityProvider({
  match,
  role,
  scopeKey = `${match?.identity.id ?? 'unknown'}:${JSON.stringify(match?.params ?? {})}`,
  children,
}: {
  /** Null match yields null resolved (unknown path fallback); never fabricated. */
  match: RouteMatch | null;
  role: CurrentUser['role'];
  /** Changes when the matched identity or its params change. */
  scopeKey?: string;
  children: ReactNode;
}) {
  // Stale-label safety without remounting AppShell: reset only the identity
  // state during render when the matched identity/params scope changes. Shell
  // state (drawer opener/focus restoration) remains mounted across navigation.
  const resolvedScopeKey = scopeKey ?? `${match?.identity.id ?? 'unknown'}:${JSON.stringify(match?.params ?? {})}`;
  const [runtimeState, setRuntimeState] = useState<{ scopeKey: string; label?: string }>({ scopeKey: resolvedScopeKey });
  if (runtimeState.scopeKey !== resolvedScopeKey) {
    setRuntimeState({ scopeKey: resolvedScopeKey });
  }
  const runtimeLabel = runtimeState.scopeKey === resolvedScopeKey ? runtimeState.label : undefined;
  const setRuntimeLabel = useCallback(
    (label: string | undefined) => setRuntimeState({ scopeKey: resolvedScopeKey, label }),
    [resolvedScopeKey],
  );
  const value = useMemo<ResolvedIdentityContextValue>(() => {
    if (!match) return { resolved: null, setRuntimeLabel };
    const displayTitle = resolveIdentityTitle(match.identity, role);
    return {
      resolved: {
        identity: match.identity,
        params: match.params,
        runtimeLabel,
        effectiveTitle: combineResolvedTitle(displayTitle, runtimeLabel),
      },
      setRuntimeLabel,
    };
  }, [match, role, runtimeLabel, resolvedScopeKey, setRuntimeLabel]);
  return <ResolvedIdentityContext.Provider value={value}>{children}</ResolvedIdentityContext.Provider>;
}

/**
 * Reads the single resolved identity; null on unknown paths (shell uses the
 * canonical fallback). Pages rendering PageHeader always have an identity.
 */
export function useResolvedIdentity(): ResolvedRouteIdentity | null {
  const context = useContext(ResolvedIdentityContext);
  if (!context) throw new Error('useResolvedIdentity must be used inside ResolvedIdentityProvider');
  return context.resolved;
}

/** Optional form for page-level direct rendering tests and isolated stories. */
export function useOptionalResolvedIdentity(): ResolvedRouteIdentity | null {
  return useContext(ResolvedIdentityContext)?.resolved ?? null;
}

/**
 * Page-side runtime-label contract: pages supply ONLY a plain string after
 * domain data loads. The layer never fetches and never imports domain types.
 */
export function useSetRouteRuntimeLabel(): (label: string | undefined) => void {
  const context = useContext(ResolvedIdentityContext);
  if (!context) throw new Error('useSetRouteRuntimeLabel must be used inside ResolvedIdentityProvider');
  return useCallback(
    (label: string | undefined) => context.setRuntimeLabel(label),
    [context],
  );
}
