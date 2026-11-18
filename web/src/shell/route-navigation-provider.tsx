import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import type { CurrentUser } from '../services/api';
import { validateContextReturn, type ValidContextReturn } from './context-return';
import { useResolvedIdentity } from './resolved-identity';
import {
  buildBreadcrumb,
  resolveHierarchyParent,
  resolveReturnTarget,
  type AncestorLabels,
  type BreadcrumbItem,
  type HierarchyParent,
  type ReturnTarget,
} from './route-navigation';

export type RouteNavigationValue = {
  breadcrumb: BreadcrumbItem[];
  hierarchyParent: HierarchyParent | null;
  contextReturn: ValidContextReturn | null;
  returnTarget: ReturnTarget | null;
  showContextControl: boolean;
  desktopContextLabel: string | null;
};

const RouteNavigationContext = createContext<RouteNavigationValue | null>(null);
const AncestorLabelsContext = createContext<(labels: AncestorLabels) => void>(() => {});

/**
 * Central route-navigation owner (Slice 3B). Reads the single resolved
 * identity, validates entry context, and exposes hierarchy breadcrumb +
 * return target. Pages supply only plain-string ancestor labels; the layer
 * never fetches domain data. Ancestor labels reset on route/param scope
 * change (same stale-safety as resolved identity).
 */
export function RouteNavigationProvider({
  user,
  children,
}: {
  user: CurrentUser;
  children: ReactNode;
}) {
  const resolved = useResolvedIdentity();
  const location = useLocation();
  const scopeKey = resolved
    ? `${resolved.identity.id}:${JSON.stringify(resolved.params)}`
    : 'unknown';

  const [ancestorState, setAncestorState] = useState<{ scopeKey: string; labels: AncestorLabels }>({
    scopeKey,
  } as { scopeKey: string; labels: AncestorLabels });
  if (ancestorState.scopeKey !== scopeKey) {
    setAncestorState({ scopeKey, labels: {} });
  }
  const ancestorLabels = ancestorState.scopeKey === scopeKey ? (ancestorState.labels ?? {}) : {};

  // Stable per scope: pages call this from effects that list it as a
  // dependency, so its identity must not change when labels change (F-01).
  // An unchanged merge keeps the previous state object, so React bails out.
  const setAncestorLabels = useCallback(
    (labels: AncestorLabels) => {
      setAncestorState((previous) => {
        const base = previous.scopeKey === scopeKey ? (previous.labels ?? {}) : {};
        const merged: AncestorLabels = { ...base, ...labels };
        const unchanged = previous.scopeKey === scopeKey
          && previous.labels !== undefined
          && Object.keys(merged).length === Object.keys(base).length
          && (Object.keys(merged) as (keyof AncestorLabels)[]).every((key) => merged[key] === base[key]);
        return unchanged ? previous : { scopeKey, labels: merged };
      });
    },
    [scopeKey],
  );

  const value = useMemo<RouteNavigationValue>(() => {
    if (!resolved) {
      return {
        breadcrumb: [],
        hierarchyParent: null,
        contextReturn: null,
        returnTarget: null,
        showContextControl: false,
        desktopContextLabel: null,
      };
    }
    const match = { identity: resolved.identity, params: resolved.params };
    const breadcrumb = buildBreadcrumb(match, resolved.effectiveTitle, ancestorLabels, user.role);
    const hierarchyParent = resolveHierarchyParent(match, ancestorLabels, user.role);
    const contextReturn = validateContextReturn(location.state, user);
    const resolvedReturn = resolveReturnTarget(hierarchyParent, contextReturn, user.role);
    return {
      breadcrumb,
      hierarchyParent,
      contextReturn,
      returnTarget: resolvedReturn.returnTarget,
      showContextControl: resolvedReturn.showContextControl,
      desktopContextLabel: resolvedReturn.desktopContextLabel,
    };
  }, [resolved, ancestorLabels, location.state, user]);

  return (
    <RouteNavigationContext.Provider value={value}>
      <AncestorLabelsContext.Provider value={setAncestorLabels}>
        {children}
      </AncestorLabelsContext.Provider>
    </RouteNavigationContext.Provider>
  );
}

export function useRouteNavigation(): RouteNavigationValue {
  const context = useContext(RouteNavigationContext);
  if (!context) throw new Error('useRouteNavigation must be used inside RouteNavigationProvider');
  return context;
}

export function useOptionalRouteNavigation(): RouteNavigationValue | null {
  return useContext(RouteNavigationContext);
}

/**
 * Page-side ancestor-label contract: pages supply ONLY plain strings for
 * dynamic ancestors they already know (e.g. customer name on contact route).
 * Resets on navigation scope change; falls back to registry generic titles.
 */
export function useSetRouteAncestorLabels(): (labels: AncestorLabels) => void {
  return useContext(AncestorLabelsContext);
}
