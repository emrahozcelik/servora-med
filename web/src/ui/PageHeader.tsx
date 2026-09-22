import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useOptionalResolvedIdentity } from '../shell/resolved-identity';
import {
  buildBreadcrumb,
  resolveHierarchyParent,
  resolveReturnTarget,
} from '../shell/route-navigation';
import { useOptionalRouteNavigation } from '../shell/route-navigation-provider';

/**
 * Shared route-identity header (Slice 3A foundation, DESIGN.md normative).
 *
 * Owns identity presentation: optional section eyebrow, the single semantic
 * H1 (from the resolved identity — never recomputed here), optional
 * description, page-owned actions passthrough, and reserved dormant regions
 * for breadcrumb (Slice 3B) and return context (Slice 3B).
 *
 * Owns NO authorization, NO business commands, NO pending/loading business
 * state, NO tabs, NO filters, NO data fetching.
 */
export function PageHeader({
  eyebrow,
  description,
  actions,
  breadcrumb,
  returnSlot,
  fallbackTitle,
  fallbackEyebrow,
}: {
  /** Overrides the default section eyebrow; preserves a page's existing eyebrow copy. */
  eyebrow?: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Reserved dormant region; Slice 3B renders the hierarchy breadcrumb here. */
  breadcrumb?: ReactNode;
  /** Reserved dormant region; Slice 3B renders the return-context control here. */
  returnSlot?: ReactNode;
  /**
   * Isolated-rendering fallback (tests/stories without providers). In the app
   * the resolved identity is always present and owns the H1; this prop is
   * only read when no resolved identity exists.
   */
  fallbackTitle?: string;
  fallbackEyebrow?: string;
}) {
  // Optional hooks stay unconditional (before any early return) so hook
  // order never depends on provider presence.
  const resolved = useOptionalResolvedIdentity();
  const navigation = useOptionalRouteNavigation();
  if (!resolved) {
    const title = fallbackTitle ?? fallbackEyebrow ?? eyebrow ?? '';
    return (
      <header className="page-header" data-page-header="isolated">
        {(eyebrow ?? fallbackEyebrow) && (
          <p className="page-header-eyebrow">{eyebrow ?? fallbackEyebrow}</p>
        )}
        <div className="page-header-main">
          <h1 className="page-header-title">{title}</h1>
          {actions && <div className="page-header-actions">{actions}</div>}
        </div>
        {description && <p className="page-header-description">{description}</p>}
      </header>
    );
  }
  const crumbs = navigation?.breadcrumb
    ?? buildBreadcrumb(
      { identity: resolved.identity, params: resolved.params },
      resolved.effectiveTitle,
      {},
      // Role is already baked into effectiveTitle; ancestors use generic
      // titles here. Provider path supplies role-aware ancestor labels.
      'MANAGER',
    );
  const hierarchy = navigation?.hierarchyParent
    ?? resolveHierarchyParent(
      { identity: resolved.identity, params: resolved.params },
      {},
      'MANAGER',
    );
  const resolvedReturn = navigation
    ? {
      returnTarget: navigation.returnTarget,
      showContextControl: navigation.showContextControl,
      desktopContextLabel: navigation.desktopContextLabel,
    }
    : resolveReturnTarget(hierarchy, null, 'MANAGER');
  const returnTarget = resolvedReturn.returnTarget;
  const breadcrumbNode = breadcrumb ?? (crumbs.length > 0 ? (
    <nav aria-label="Sayfa yolu" className="route-breadcrumb">
      <ol>
        {crumbs.map((crumb) => (
          <li key={crumb.id}>
            {crumb.isCurrent || !crumb.to ? (
              <span aria-current="page">{crumb.label}</span>
            ) : (
              <Link to={crumb.to}>{crumb.label}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  ) : null);
  const returnNode = returnSlot ?? (returnTarget ? (
    <>
      <Link
        className="route-return-link"
        to={returnTarget.to}
        aria-label={`${returnTarget.label}'e dön`}
      >
        ‹ {returnTarget.label}
      </Link>
      {resolvedReturn.showContextControl && resolvedReturn.desktopContextLabel ? (
        <Link className="route-context-control" to={returnTarget.to}>
          {resolvedReturn.desktopContextLabel}
        </Link>
      ) : null}
    </>
  ) : null);
  const eyebrowText = eyebrow ?? resolved.identity.section;
  return (
    <header className="page-header" data-page-header={resolved.identity.id}>
      {breadcrumbNode}
      {returnNode}
      {eyebrowText && (
        <p className="page-header-eyebrow">{eyebrowText}</p>
      )}
      <div className="page-header-main">
        <h1 className="page-header-title">{resolved.effectiveTitle}</h1>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
      {description && <p className="page-header-description">{description}</p>}
    </header>
  );
}
