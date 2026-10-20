import type { DuplicateDecision, DuplicateDecisionReason } from './services/duplicate-customers-api';

export type DuplicateAttemptKind = 'DECIDE' | 'REOPEN';
export type DuplicateAttempt = {
  version: 1;
  kind: DuplicateAttemptKind;
  clientActionId: string;
  expectedReviewVersion: number;
  expectedEvidenceRevision: string;
  matchingRuleVersion: string;
  decision?: DuplicateDecision;
  reasonCode?: DuplicateDecisionReason;
  createdAt: number;
};

const keyFor = (organizationId: string, actorId: string, a: string, b: string) =>
  `CRM_DUPLICATE_COMMAND_ATTEMPT:v1:${organizationId}:${actorId}:${a < b ? a : b}:${a < b ? b : a}`;

function valid(value: unknown): value is DuplicateAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && (v.kind === 'DECIDE' || v.kind === 'REOPEN')
    && typeof v.clientActionId === 'string' && v.clientActionId.length > 0 && v.clientActionId.length <= 255
    && typeof v.expectedReviewVersion === 'number' && Number.isInteger(v.expectedReviewVersion)
    && typeof v.expectedEvidenceRevision === 'string'
    && typeof v.matchingRuleVersion === 'string' && typeof v.createdAt === 'number'
    && (v.kind === 'REOPEN' || (typeof v.decision === 'string' && typeof v.reasonCode === 'string'));
}

export function readDuplicateAttempt(organizationId: string, actorId: string, a: string, b: string): DuplicateAttempt | null {
  try {
    const raw = window.sessionStorage.getItem(keyFor(organizationId, actorId, a, b));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDuplicateAttempt(organizationId: string, actorId: string, a: string, b: string, attempt: DuplicateAttempt) {
  try {
    window.sessionStorage.setItem(keyFor(organizationId, actorId, a, b), JSON.stringify(attempt));
  } catch {
    throw new Error('İnceleme taslağı bu tarayıcıda saklanamadı. İşlem gönderilmedi.');
  }
}

export function clearDuplicateAttempt(organizationId: string, actorId: string, a: string, b: string) {
  try { window.sessionStorage.removeItem(keyFor(organizationId, actorId, a, b)); } catch { /* storage is optional */ }
}

export function attemptMatchesCurrent(
  attempt: DuplicateAttempt,
  review: { version: number },
  revision: string,
  matchingRuleVersion: string,
) {
  return attempt.expectedReviewVersion === review.version
    && attempt.expectedEvidenceRevision === revision
    && attempt.matchingRuleVersion === matchingRuleVersion;
}
