import type { CurrentUser } from '../services/api';
import { resolveIdentityTitle } from './navigation-model';
import {
  getRouteIdentity,
  parentChain,
  resolveParentPath,
  routePathForIdentity,
  type RouteId,
  type RouteMatch,
} from './route-identity';
import { contextReturnHref, type ValidContextReturn } from './context-return';

export type BreadcrumbItem = {
  id: RouteId;
  label: string;
  to: string | null;
  isCurrent: boolean;
};

export type AncestorLabels = Partial<Record<RouteId, string>>;

export type HierarchyParent = {
  id: RouteId;
  to: string;
  label: string;
};

export type ReturnTarget = {
  to: string;
  label: string;
};

function ancestorLabel(
  id: RouteId,
  role: CurrentUser['role'],
  ancestorLabels: AncestorLabels,
): string {
  const override = ancestorLabels[id];
  if (typeof override === 'string' && override.trim() !== '') return override;
  return resolveIdentityTitle(getRouteIdentity(id), role);
}

/**
 * Hierarchy breadcrumb chain, root → current. Empty for roots (no decorative
 * crumbs) and unknown matches. Current item uses the resolved effective
 * title; ancestors use static titles unless the page supplied a plain-string
 * ancestor label. URLs derive from routePathForIdentity (param-aware).
 */
export function buildBreadcrumb(
  match: RouteMatch | null,
  effectiveTitle: string,
  ancestorLabels: AncestorLabels,
  role: CurrentUser['role'],
): BreadcrumbItem[] {
  if (!match) return [];
  const chain = parentChain(match.identity.id);
  if (chain.length <= 1) return [];
  const rootFirst = [...chain].reverse();
  return rootFirst.map((id) => {
    const isCurrent = id === match.identity.id;
    if (isCurrent) {
      return { id, label: effectiveTitle, to: null, isCurrent: true };
    }
    return {
      id,
      label: ancestorLabel(id, role, ancestorLabels),
      to: routePathForIdentity(id, match.params),
      isCurrent: false,
    };
  });
}

/**
 * Deterministic hierarchy parent for nested routes. Null on roots and when
 * the parent URL cannot be resolved from current params.
 */
export function resolveHierarchyParent(
  match: RouteMatch | null,
  ancestorLabels: AncestorLabels,
  role: CurrentUser['role'],
): HierarchyParent | null {
  if (!match || !match.identity.parentId) return null;
  const to = resolveParentPath(match.identity, match.params);
  if (!to) return null;
  return {
    id: match.identity.parentId,
    to,
    label: ancestorLabel(match.identity.parentId, role, ancestorLabels),
  };
}

/** Desktop contextual-return copy. Calendar is the canonical producer. */
export function desktopContextLabel(contextIdentityId: string, contextLabel: string): string {
  if (contextIdentityId === 'calendar') return 'Takvime dön';
  return `${contextLabel}'e dön`;
}

function contextLabelFor(
  context: ValidContextReturn,
  role: CurrentUser['role'],
): { id: RouteId; label: string } {
  // validateContextReturn guarantees a known identity id.
  const id = context.identityId as RouteId;
  return { id, label: resolveIdentityTitle(getRouteIdentity(id), role) };
}

export type ResolvedReturn = {
  returnTarget: ReturnTarget | null;
  showContextControl: boolean;
  desktopContextLabel: string | null;
};

/**
 * Final return-target resolution: valid context return when available,
 * otherwise hierarchy fallback. Desktop control appears only when context
 * pathname meaningfully differs from hierarchy pathname.
 */
export function resolveReturnTarget(
  hierarchy: HierarchyParent | null,
  context: ValidContextReturn | null,
  role: CurrentUser['role'],
): ResolvedReturn {
  if (!hierarchy && !context) {
    return { returnTarget: null, showContextControl: false, desktopContextLabel: null };
  }
  if (context && !hierarchy) {
    const { id, label } = contextLabelFor(context, role);
    return {
      returnTarget: { to: contextReturnHref(context), label },
      showContextControl: true,
      desktopContextLabel: desktopContextLabel(id, label),
    };
  }
  if (!context || !hierarchy) {
    // One side missing (hierarchy-only case handled above for both-null;
    // here exactly one exists but TS needs narrowing).
    if (hierarchy) {
      return { returnTarget: { to: hierarchy.to, label: hierarchy.label }, showContextControl: false, desktopContextLabel: null };
    }
    return { returnTarget: null, showContextControl: false, desktopContextLabel: null };
  }
  const hierarchyPathname = hierarchy.to.split(/[?#]/)[0] ?? hierarchy.to;
  if (context.pathname !== hierarchyPathname) {
    const { id, label } = contextLabelFor(context, role);
    return {
      returnTarget: { to: contextReturnHref(context), label },
      showContextControl: true,
      desktopContextLabel: desktopContextLabel(id, label),
    };
  }
  // Redundant context (same destination): preserve query for mobile return
  // but suppress the desktop control; label stays hierarchy.
  const contextHref = contextReturnHref(context);
  const to = contextHref !== hierarchy.to ? contextHref : hierarchy.to;
  return { returnTarget: { to, label: hierarchy.label }, showContextControl: false, desktopContextLabel: null };
}
