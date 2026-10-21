import { ApiError } from './services/api';
import type {
  DuplicateDecisionInput, DuplicateReopenInput,
} from './services/duplicate-customers-api';
import type { DuplicateAttempt } from './duplicate-review-attempt';

const conflictCodes = new Set([
  'VERSION_CONFLICT', 'EVIDENCE_CHANGED', 'MATCHING_RULE_CHANGED', 'REVIEW_REOPEN_REQUIRED',
  'REVIEW_ALREADY_PENDING', 'EVIDENCE_KEY_UNAVAILABLE',
]);
const retryCodes = new Set([
  'ACTION_IN_PROGRESS', 'REVIEW_BUSY', 'REVIEW_TEMPORARILY_UNAVAILABLE', 'RATE_LIMIT_EXCEEDED',
]);

/** Replays the frozen attempt verbatim: no new clientActionId, version or evidence is derived. */
export function duplicateRecoveryRequest(frozen: DuplicateAttempt, aId: string, bId: string) {
  const base = {
    clientActionId: frozen.clientActionId,
    expectedReviewVersion: frozen.expectedReviewVersion,
    expectedEvidenceRevision: frozen.expectedEvidenceRevision,
    matchingRuleVersion: frozen.matchingRuleVersion,
  };
  return frozen.kind === 'REOPEN'
    ? { kind: 'REOPEN' as const, aId, bId, body: base as DuplicateReopenInput }
    : { kind: 'DECIDE' as const, aId, bId, body: { ...base, decision: frozen.decision!, reasonCode: frozen.reasonCode! } as DuplicateDecisionInput };
}

export type DuplicateRecoveryOutcome = 'definitive-no-commit' | 'uncertain' | 'forbidden';

/**
 * Classifies a replay failure without issuing a new intent.
 * - 404/422 and known conflicts prove the original request did not commit.
 * - 401/403 are authorization failures; the attempt is retained and nothing leaks.
 * - Anything else (429, 5xx, transport) stays unresolved.
 */
export function classifyDuplicateRecoveryFailure(error: unknown): DuplicateRecoveryOutcome {
  if (!(error instanceof ApiError)) return 'uncertain';
  if (error.status === 401 || error.status === 403) return 'forbidden';
  if (error.status === 404 || error.status === 422) return 'definitive-no-commit';
  if (error.status === 409 && conflictCodes.has(error.code)) return 'definitive-no-commit';
  return 'uncertain';
}

export function duplicateRecoveryRetryable(error: unknown) {
  if (!(error instanceof ApiError)) return true;
  return retryCodes.has(error.code) || error.status === 0 || error.status >= 500;
}
