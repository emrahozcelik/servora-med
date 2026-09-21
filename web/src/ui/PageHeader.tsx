import type { ReactNode } from 'react';

import { useResolvedIdentity } from '../shell/resolved-identity';

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
}: {
  /** Overrides the default section eyebrow; preserves a page's existing eyebrow copy. */
  eyebrow?: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Reserved dormant region; Slice 3B renders the hierarchy breadcrumb here. */
  breadcrumb?: ReactNode;
  /** Reserved dormant region; Slice 3B renders the return-context control here. */
  returnSlot?: ReactNode;
}) {
  const resolved = useResolvedIdentity();
  if (!resolved) {
    throw new Error('PageHeader requires a resolved route identity (unknown path cannot render identity chrome)');
  }
  const eyebrowText = eyebrow ?? resolved.identity.section;
  return (
    <header className="page-header" data-page-header={resolved.identity.id}>
      {breadcrumb ?? null}
      {returnSlot ?? null}
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
