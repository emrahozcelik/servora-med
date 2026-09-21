export const CANONICAL_DOCUMENT_TITLE = 'Dünya Dental | İş ve Operasyon Yönetimi';

type DisplayModeEnvironment = Pick<Window, 'matchMedia'>;

export function isStandaloneDisplayMode(environment?: DisplayModeEnvironment): boolean {
  if (!environment || typeof environment.matchMedia !== 'function') return false;
  return environment.matchMedia('(display-mode: standalone)').matches;
}

/**
 * Unified document title (Slice 3A, DESIGN.md normative):
 * `{resolved route title} · Dünya Dental` in BOTH browser and standalone
 * PWA modes. No browser-vs-PWA route-title fork. The input must be the
 * resolved identity's effective title — never a locally recomputed string.
 */
export function resolveDocumentTitle(resolvedTitle: string): string {
  return `${resolvedTitle} · Dünya Dental`;
}

/**
 * Applies the unified title; null/empty falls back to the canonical boot
 * title (unknown routes, pre-auth screens).
 */
export function setDocumentTitle(resolvedTitle: string | null): void {
  if (typeof document === 'undefined') return;
  document.title = resolvedTitle ? resolveDocumentTitle(resolvedTitle) : CANONICAL_DOCUMENT_TITLE;
}
