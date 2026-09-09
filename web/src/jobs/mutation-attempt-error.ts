import { ApiError } from '../services/api';

/**
 * Mutation-attempt error classifier (single source of truth for every
 * frozen-attempt surface).
 *
 * AMBIGUOUS means the mutation outcome cannot be determined from this error:
 * the server may have committed the mutation, so the retained attempt must
 * stay frozen and only the exact original request may be retried.
 *
 * DEFINITIVE means the server authoritatively rejected (or confirmed) the
 * mutation with a real HTTP response, so the attempt may be resolved.
 *
 * Rules:
 * - non-ApiError / unknown errors → AMBIGUOUS (fail-safe);
 * - status === 0 (no authoritative HTTP outcome, e.g. transport loss or an
 *   unparseable successful response body) → AMBIGUOUS;
 * - retryable === true → AMBIGUOUS;
 * - ACTION_IN_PROGRESS (another operation holds the claim; the original
 *   outcome is still unknown) → AMBIGUOUS;
 * - anything else is a real HTTP response → DEFINITIVE.
 */
export function isAmbiguousMutationError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0
    || error.retryable
    || error.code === 'ACTION_IN_PROGRESS';
}

/** Definitive = the server gave an authoritative, non-ambiguous answer. */
export function isDefinitiveMutationError(error: unknown): boolean {
  return !isAmbiguousMutationError(error);
}
