import type { CurrentUser } from '../services/api';
import { matchRouteIdentity, type RouteParams } from './route-identity';
import { canAccessRoute } from './route-access';

/** Canonical internal context-return location shape stored in location.state.from. */
export type ContextReturnLocation = {
  pathname: string;
  search: string;
  hash: string;
};

export type ValidContextReturn = ContextReturnLocation & {
  identityId: string;
  params: RouteParams;
};

type RawFrom = {
  pathname?: unknown;
  search?: unknown;
  hash?: unknown;
};

const MAX_PATH_LENGTH = 2048;
const MAX_SEARCH_LENGTH = 2048;
const MAX_HASH_LENGTH = 1024;

function hasControlOrWhitespace(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0020\u007f]/.test(value);
}

function isSafePathname(pathname: string): boolean {
  if (!pathname.startsWith('/')) return false;
  if (pathname.startsWith('//')) return false;
  if (pathname.includes('\\')) return false;
  if (hasControlOrWhitespace(pathname)) return false;
  if (pathname.length > MAX_PATH_LENGTH) return false;
  // Reject scheme/host shapes: "://", or ":" before any "/" after leading "/".
  if (pathname.includes('://')) return false;
  const afterLeading = pathname.slice(1);
  const colonIndex = afterLeading.indexOf(':');
  const slashIndex = afterLeading.indexOf('/');
  if (colonIndex !== -1 && (slashIndex === -1 || colonIndex < slashIndex)) return false;
  const lower = pathname.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) return false;
  return true;
}

function normalizeSearch(raw: unknown): string | null {
  if (raw === undefined) return '';
  if (typeof raw !== 'string') return null;
  if (raw === '') return '';
  if (!raw.startsWith('?')) return null;
  if (raw.includes('#')) return null;
  if (raw.includes('\\')) return null;
  if (hasControlOrWhitespace(raw)) return null;
  if (raw.length > MAX_SEARCH_LENGTH) return null;
  return raw;
}

function normalizeHash(raw: unknown): string | null {
  if (raw === undefined) return '';
  if (typeof raw !== 'string') return null;
  if (raw === '') return '';
  if (!raw.startsWith('#')) return null;
  if (raw.includes('\\')) return null;
  if (hasControlOrWhitespace(raw)) return null;
  if (raw.length > MAX_HASH_LENGTH) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith('#javascript:') || lower.startsWith('#data:')) return null;
  return raw;
}

/**
 * Validates untrusted location.state as an internal context return.
 * Fail-closed: any malformed, external, unknown, or inaccessible input
 * returns null without throwing and without navigating.
 */
export function validateContextReturn(state: unknown, user: CurrentUser): ValidContextReturn | null {
  try {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    const from = (state as { from?: unknown }).from;
    if (!from || typeof from !== 'object' || Array.isArray(from)) return null;
    const raw = from as RawFrom;
    if (typeof raw.pathname !== 'string') return null;
    const pathname = raw.pathname;
    if (!isSafePathname(pathname)) return null;

    const search = normalizeSearch(raw.search);
    if (search === null) return null;
    const hash = normalizeHash(raw.hash);
    if (hash === null) return null;

    const match = matchRouteIdentity(pathname);
    if (!match) return null;
    if (!canAccessRoute(match.identity.id, user, match.params)) return null;

    return {
      pathname,
      search,
      hash,
      identityId: match.identity.id,
      params: match.params,
    };
  } catch {
    return null;
  }
}

/** Rebuilds the exact safe internal target href from a validated context return. */
export function contextReturnHref(valid: ContextReturnLocation): string {
  return `${valid.pathname}${valid.search}${valid.hash}`;
}

/**
 * Producer helper: captures the current internal location as canonical
 * context state. Callers must pass the router's current location; only
 * internal pathnames are captured (returns null for anything else).
 */
export function buildContextState(
  location: { pathname: unknown; search?: unknown; hash?: unknown },
): { from: ContextReturnLocation } | null {
  try {
    if (!location || typeof location.pathname !== 'string') return null;
    if (!isSafePathname(location.pathname)) return null;
    const search = normalizeSearch(location.search ?? '');
    const hash = normalizeHash(location.hash ?? '');
    if (search === null || hash === null) return null;
    return { from: { pathname: location.pathname, search, hash } };
  } catch {
    return null;
  }
}
