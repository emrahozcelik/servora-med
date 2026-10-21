import { AppError } from '../../errors/index.js';
import {
  duplicateEvidenceDigest,
  duplicateEvidenceMatches,
  type DuplicateEvidenceDetails,
  type DuplicateKeyring,
} from './duplicate-evidence.js';
import { DUPLICATE_RULE_VERSION } from './duplicate-types.js';

export const DUPLICATE_REVIEW_STATUSES = ['PENDING_REVIEW', 'CONFIRMED_DUPLICATE', 'DISMISSED'] as const;
export type DuplicateReviewStatus = typeof DUPLICATE_REVIEW_STATUSES[number];
export const DUPLICATE_EFFECTIVE_STATUSES = [
  'PENDING_REVIEW', 'CONFIRMED_DUPLICATE', 'DISMISSED', 'REVIEW_REQUIRED', 'BLOCKED', 'UNAVAILABLE',
] as const;
export type DuplicateEffectiveStatus = typeof DUPLICATE_EFFECTIVE_STATUSES[number];
export const DUPLICATE_FRESHNESS = ['NOT_APPLICABLE', 'CURRENT', 'STALE', 'UNVERIFIABLE'] as const;
export type DuplicateFreshness = typeof DUPLICATE_FRESHNESS[number];
export const DUPLICATE_FRESHNESS_REASONS = [
  'SOURCE_CHANGED', 'RULE_CHANGED', 'KEY_UNAVAILABLE', 'OVER_BUDGET', 'SOURCE_UNAVAILABLE',
] as const;
export type DuplicateFreshnessReason = typeof DUPLICATE_FRESHNESS_REASONS[number];
export const DUPLICATE_DECISIONS = ['CONFIRMED_DUPLICATE', 'DISMISSED'] as const;
export type DuplicateDecision = typeof DUPLICATE_DECISIONS[number];
export const DUPLICATE_CONFIRM_REASONS = ['SAME_OPERATIONAL_CUSTOMER_VERIFIED'] as const;
export const DUPLICATE_DISMISS_REASONS = [
  'DISTINCT_BRANCH', 'DISTINCT_CUSTOMER', 'SHARED_CONTACT_DETAILS', 'INSUFFICIENT_EVIDENCE',
] as const;
export const DUPLICATE_REOPEN_REASON = 'RECHECK_REQUESTED' as const;
export type DuplicateDecisionReason =
  | typeof DUPLICATE_CONFIRM_REASONS[number]
  | typeof DUPLICATE_DISMISS_REASONS[number];
export type DuplicateAction = 'DECIDE' | 'REOPEN';

export type DuplicateDecisionInfo = {
  eventId: string;
  seq: number;
  status: Exclude<DuplicateReviewStatus, 'PENDING_REVIEW'>;
  reasonCode: DuplicateDecisionReason;
  actorUserId: string;
  decidedAt: string;
};

export type DuplicateReviewSummary = {
  id: string | null;
  version: number;
  reviewStatus: DuplicateReviewStatus;
  effectiveStatus: DuplicateEffectiveStatus;
  freshness: DuplicateFreshness;
  freshnessReason: DuplicateFreshnessReason | null;
  currentDecision: DuplicateDecisionInfo | null;
  lastDecision: DuplicateDecisionInfo | null;
};

export type DuplicateReviewHead = {
  id: string;
  version: number;
  eventId: string;
  seq: number;
  eventKind: 'DECISION_RECORDED' | 'REVIEW_REOPENED';
  resultingStatus: DuplicateReviewStatus;
  reasonCode: string;
  actorUserId: string;
  occurredAt: Date;
  evidenceSchemaVersion: number;
  matchingRuleVersion: string;
  evidenceKeyId: string;
  evidenceDigest: Buffer;
  matchingCodes: readonly string[];
  conflictingTaxNumbers: boolean;
  previousDecision: DuplicateDecisionInfo | null;
};

export type DuplicateReviewTimelineItem = {
  eventId: string;
  seq: number;
  eventKind: 'DECISION_RECORDED' | 'REVIEW_REOPENED';
  resultingStatus: DuplicateReviewStatus;
  reasonCode: string;
  actorUserId: string;
  occurredAt: string;
  matchingRuleVersion: string;
  matchingCodes: readonly string[];
  warnings: readonly string[];
};

export type DuplicateCommandReceipt = {
  reviewId: string;
  pair: { customerAId: string; customerBId: string };
  reviewVersion: number;
  eventId: string;
  eventKind: 'DECISION_RECORDED' | 'REVIEW_REOPENED';
  resultingStatus: DuplicateReviewStatus;
  reasonCode: string;
  actorUserId: string;
  occurredAt: string;
};

export type DuplicateHistoryPage = {
  reviewId: string;
  upperSeq: number;
  items: DuplicateReviewTimelineItem[];
  nextCursor: string | null;
};

const integrity = (): never => {
  throw new AppError('REVIEW_TEMPORARILY_UNAVAILABLE', 503, 'İnceleme geçmişi doğrulanamıyor. Lütfen yeniden deneyin.');
};

function decisionInfo(head: DuplicateReviewHead): DuplicateDecisionInfo | null {
  if (head.eventKind !== 'DECISION_RECORDED') return null;
  if (head.resultingStatus !== 'CONFIRMED_DUPLICATE' && head.resultingStatus !== 'DISMISSED') return integrity();
  return {
    eventId: head.eventId,
    seq: head.seq,
    status: head.resultingStatus,
    reasonCode: head.reasonCode as DuplicateDecisionReason,
    actorUserId: head.actorUserId,
    decidedAt: head.occurredAt.toISOString(),
  };
}

function virtualReview(freshness: DuplicateFreshness = 'NOT_APPLICABLE', reason: DuplicateFreshnessReason | null = null, effective: DuplicateEffectiveStatus = 'PENDING_REVIEW'): DuplicateReviewSummary {
  return {
    id: null, version: 0, reviewStatus: 'PENDING_REVIEW', effectiveStatus: effective,
    freshness, freshnessReason: reason, currentDecision: null, lastDecision: null,
  };
}

export function projectDuplicateReview(input: {
  head: DuplicateReviewHead | null;
  current: DuplicateEvidenceDetails | null;
  keyring: DuplicateKeyring;
  sourceAvailable: boolean;
  overBudget?: boolean;
}): { review: DuplicateReviewSummary; allowedActions: DuplicateAction[] } {
  const { head, current, keyring, sourceAvailable, overBudget = false } = input;
  if (!sourceAvailable) {
    const summary = head ? reviewFromHead(head) : virtualReview('STALE', 'SOURCE_UNAVAILABLE', 'UNAVAILABLE');
    return { review: { ...summary, effectiveStatus: 'UNAVAILABLE', freshness: 'STALE', freshnessReason: 'SOURCE_UNAVAILABLE' }, allowedActions: [] };
  }
  if (overBudget || !current) {
    const summary = head ? reviewFromHead(head) : virtualReview('STALE', 'OVER_BUDGET', 'BLOCKED');
    return { review: { ...summary, effectiveStatus: 'BLOCKED', freshness: 'STALE', freshnessReason: 'OVER_BUDGET' }, allowedActions: [] };
  }
  if (!head) return { review: virtualReview(), allowedActions: ['DECIDE'] };
  const summary = reviewFromHead(head);
  const storedDigest = duplicateEvidenceDigest(keyring, current.canonical, head.evidenceKeyId);
  if (!storedDigest) {
    return {
      review: { ...summary, effectiveStatus: head.eventKind === 'REVIEW_REOPENED' ? 'PENDING_REVIEW' : 'BLOCKED', freshness: 'UNVERIFIABLE', freshnessReason: 'KEY_UNAVAILABLE' },
      allowedActions: head.eventKind === 'DECISION_RECORDED' ? ['REOPEN'] : ['DECIDE'],
    };
  }
  if (head.matchingRuleVersion !== DUPLICATE_RULE_VERSION) {
    if (head.eventKind === 'REVIEW_REOPENED') {
      return { review: { ...summary, effectiveStatus: 'PENDING_REVIEW', freshness: 'STALE', freshnessReason: 'RULE_CHANGED' }, allowedActions: ['DECIDE'] };
    }
    return { review: { ...summary, effectiveStatus: 'REVIEW_REQUIRED', freshness: 'STALE', freshnessReason: 'RULE_CHANGED' }, allowedActions: ['REOPEN'] };
  }
  if (!duplicateEvidenceMatches(head.evidenceDigest, storedDigest)) {
    if (head.eventKind === 'REVIEW_REOPENED') {
      return { review: { ...summary, effectiveStatus: 'PENDING_REVIEW', freshness: 'STALE', freshnessReason: 'SOURCE_CHANGED' }, allowedActions: ['DECIDE'] };
    }
    return { review: { ...summary, effectiveStatus: 'REVIEW_REQUIRED', freshness: 'STALE', freshnessReason: 'SOURCE_CHANGED' }, allowedActions: ['REOPEN'] };
  }
  return {
    review: { ...summary, effectiveStatus: head.resultingStatus, freshness: 'CURRENT', freshnessReason: null },
    allowedActions: head.eventKind === 'DECISION_RECORDED' ? ['REOPEN'] : ['DECIDE'],
  };
}

function reviewFromHead(head: DuplicateReviewHead): DuplicateReviewSummary {
  const latest = decisionInfo(head);
  const lastDecision = head.eventKind === 'REVIEW_REOPENED'
    ? head.previousDecision
    : latest;
  if (head.eventKind === 'REVIEW_REOPENED' && !lastDecision) integrity();
  return {
    id: head.id,
    version: head.version,
    reviewStatus: head.resultingStatus,
    effectiveStatus: head.resultingStatus,
    freshness: 'CURRENT',
    freshnessReason: null,
    currentDecision: latest,
    lastDecision,
  };
}

export function reviewHeadFromRow(row: {
  customer_a_id: string; customer_b_id: string;
  id: string; version: number; event_id: string; seq: number; event_kind: string;
  resulting_status: string; reason_code: string; actor_user_id: string; occurred_at: Date;
  evidence_schema_version: number; matching_rule_version: string; evidence_key_id: string;
  evidence_digest: Buffer; matching_codes: string[]; conflicting_tax_numbers: boolean;
  previous_decision_id: string | null; previous_decision_seq: number | null;
  previous_decision_status: string | null; previous_decision_reason: string | null;
  previous_decision_actor_id: string | null; previous_decision_at: Date | null;
}): DuplicateReviewHead {
  if (row.event_kind !== 'DECISION_RECORDED' && row.event_kind !== 'REVIEW_REOPENED') integrity();
  if (!DUPLICATE_REVIEW_STATUSES.includes(row.resulting_status as DuplicateReviewStatus)) integrity();
  const previousDecision = row.previous_decision_id
    ? {
        eventId: row.previous_decision_id,
        seq: row.previous_decision_seq!,
        status: row.previous_decision_status as Exclude<DuplicateReviewStatus, 'PENDING_REVIEW'>,
        reasonCode: row.previous_decision_reason as DuplicateDecisionReason,
        actorUserId: row.previous_decision_actor_id!,
        decidedAt: row.previous_decision_at!.toISOString(),
      }
    : null;
  return {
    id: row.id, version: row.version, eventId: row.event_id, seq: row.seq,
    eventKind: row.event_kind as 'DECISION_RECORDED' | 'REVIEW_REOPENED',
    resultingStatus: row.resulting_status as DuplicateReviewStatus,
    reasonCode: row.reason_code, actorUserId: row.actor_user_id, occurredAt: row.occurred_at,
    evidenceSchemaVersion: row.evidence_schema_version,
    matchingRuleVersion: row.matching_rule_version,
    evidenceKeyId: row.evidence_key_id, evidenceDigest: row.evidence_digest,
    matchingCodes: row.matching_codes, conflictingTaxNumbers: row.conflicting_tax_numbers,
    previousDecision,
  };
}
