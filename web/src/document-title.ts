export const CANONICAL_DOCUMENT_TITLE = 'Dünya Dental | İş ve Operasyon Yönetimi';

type DisplayModeEnvironment = Pick<Window, 'matchMedia'>;

export function isStandaloneDisplayMode(environment?: DisplayModeEnvironment): boolean {
  if (!environment || typeof environment.matchMedia !== 'function') return false;
  return environment.matchMedia('(display-mode: standalone)').matches;
}

export function resolveDocumentTitle(
  routeTitle: string,
  standalone = isStandaloneDisplayMode(typeof window === 'undefined' ? undefined : window),
): string {
  return standalone ? routeTitle : CANONICAL_DOCUMENT_TITLE;
}

export function setDocumentTitle(routeTitle: string): void {
  if (typeof document === 'undefined') return;
  document.title = resolveDocumentTitle(routeTitle);
}
