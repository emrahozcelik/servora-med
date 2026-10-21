import { ApiError, boolean, json, nullableString, number, object, request, string } from './api';
import { CUSTOMER_STATUSES, CUSTOMER_TYPES, type CustomerStatus, type CustomerType } from './crm-api';

export const duplicateReasonLabels = {
  SAME_NAME_AND_PHONE: 'İsim ve telefon aynı', SAME_NAME_AND_EMAIL: 'İsim ve e-posta aynı',
  SAME_NAME_AND_ADDRESS: 'İsim ve tam adres aynı', SAME_PHONE: 'Telefon aynı', SAME_NAME: 'İsim aynı',
} as const;
export type DuplicateMatchCode = keyof typeof duplicateReasonLabels;
export const duplicateDecisionLabels = {
  CONFIRMED_DUPLICATE: 'Mükerrer olarak doğrula',
  DISMISSED: 'Eşleşmeyi reddet',
} as const;
export type DuplicateDecision = keyof typeof duplicateDecisionLabels;
export const duplicateDecisionReasonLabels = {
  SAME_OPERATIONAL_CUSTOMER_VERIFIED: 'Aynı operasyonel müşteri olduğu doğrulandı',
  DISTINCT_BRANCH: 'Ayrı şube',
  DISTINCT_CUSTOMER: 'Ayrı müşteri',
  SHARED_CONTACT_DETAILS: 'Yalnız iletişim bilgileri ortak',
  INSUFFICIENT_EVIDENCE: 'Kanıt yetersiz',
} as const;
export type DuplicateDecisionReason = keyof typeof duplicateDecisionReasonLabels;
export const duplicateReasonOptions: Record<DuplicateDecision, readonly DuplicateDecisionReason[]> = {
  CONFIRMED_DUPLICATE: ['SAME_OPERATIONAL_CUSTOMER_VERIFIED'],
  DISMISSED: ['DISTINCT_BRANCH', 'DISTINCT_CUSTOMER', 'SHARED_CONTACT_DETAILS', 'INSUFFICIENT_EVIDENCE'],
};
export const duplicateFreshnessLabels = {
  NOT_APPLICABLE: 'Henüz karar yok', CURRENT: 'Kanıt güncel', STALE: 'Kanıt eskidi', UNVERIFIABLE: 'Kanıt doğrulanamıyor',
} as const;
export const duplicateEffectiveLabels = {
  PENDING_REVIEW: 'İnceleme bekliyor', CONFIRMED_DUPLICATE: 'Mükerrer doğrulandı', DISMISSED: 'Eşleşme reddedildi',
  REVIEW_REQUIRED: 'Yeniden inceleme gerekli', BLOCKED: 'İnceleme engellendi', UNAVAILABLE: 'Kaynak kullanılamıyor',
} as const;
export const duplicateFreshnessReasonLabels = {
  SOURCE_CHANGED: 'Müşteri veya ilgili kişi bilgisi değişti', RULE_CHANGED: 'Eşleştirme kuralı değişti',
  KEY_UNAVAILABLE: 'Eski kanıt anahtarı kullanılamıyor', OVER_BUDGET: 'Kanıt bütçesi aşıldı', SOURCE_UNAVAILABLE: 'Kaynak kullanılamıyor',
} as const;

const invalid = (): never => { throw new ApiError(0, 'INVALID_RESPONSE', 'Karşılaştırma yanıtı geçersiz. Yeniden deneyin.'); };
function list(value: unknown) { if (!Array.isArray(value)) return invalid(); return value; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid(); return value as T; }
const pair = (value: unknown) => { const v = object(value); return { customerAId: string(v.customerAId, 'customerAId'), customerBId: string(v.customerBId, 'customerBId') }; };
function summary(value: unknown) {
  const v = object(value);
  return { id: string(v.id, 'id'), name: string(v.name, 'name'), status: oneOf<CustomerStatus>(v.status, CUSTOMER_STATUSES), city: nullableString(v.city, 'city'), district: nullableString(v.district, 'district') };
}
function matching(value: unknown) { return list(value).map((v) => oneOf<DuplicateMatchCode>(v, Object.keys(duplicateReasonLabels) as DuplicateMatchCode[])); }
function warnings(value: unknown) { return list(value).map((v) => oneOf(v, ['CONFLICTING_TAX_NUMBERS'] as const)); }

function decisionInfo(value: unknown) {
  if (value === null) return null;
  const v = object(value);
  return {
    eventId: string(v.eventId, 'eventId'), seq: number(v.seq, 'seq'),
    status: oneOf(v.status, ['CONFIRMED_DUPLICATE', 'DISMISSED'] as const),
    reasonCode: oneOf<DuplicateDecisionReason>(v.reasonCode, Object.keys(duplicateDecisionReasonLabels) as DuplicateDecisionReason[]),
    actorUserId: string(v.actorUserId, 'actorUserId'), decidedAt: string(v.decidedAt, 'decidedAt'),
  };
}

export type DuplicateReviewSummary = ReturnType<typeof parseReview>;
export function parseReview(value: unknown) {
  const v = object(value);
  const id = v.id === null ? null : string(v.id, 'review.id');
  const version = number(v.version, 'review.version');
  if (id === null && version !== 0) invalid();
  const currentDecision = decisionInfo(v.currentDecision);
  const lastDecision = decisionInfo(v.lastDecision);
  return {
    id, version,
    reviewStatus: oneOf(v.reviewStatus, ['PENDING_REVIEW', 'CONFIRMED_DUPLICATE', 'DISMISSED'] as const),
    effectiveStatus: oneOf(v.effectiveStatus, Object.keys(duplicateEffectiveLabels) as Array<keyof typeof duplicateEffectiveLabels>),
    freshness: oneOf(v.freshness, Object.keys(duplicateFreshnessLabels) as Array<keyof typeof duplicateFreshnessLabels>),
    freshnessReason: v.freshnessReason === null ? null : oneOf(v.freshnessReason, Object.keys(duplicateFreshnessReasonLabels) as Array<keyof typeof duplicateFreshnessReasonLabels>),
    currentDecision, lastDecision,
  };
}

export function parseDuplicatePage(value: unknown) {
  const v = object(value); const scope = object(v.scope); const page = object(v.page);
  if (scope.dataClass !== 'BUSINESS' || scope.includesInactive !== true || v.coverage !== 'COMPLETE_SOURCE' || typeof v.rawPairCount !== 'string' || !/^\d+$/.test(v.rawPairCount)) invalid();
  const result = {
    scope: { dataClass: 'BUSINESS' as const, includesInactive: true as const, anchorCustomerId: nullableString(scope.anchorCustomerId, 'anchorCustomerId') },
    asOf: string(v.asOf, 'asOf'), matchingRuleVersion: string(v.matchingRuleVersion, 'matchingRuleVersion'), coverage: 'COMPLETE_SOURCE' as const,
    rawPairCount: v.rawPairCount as string, largestNameGroupSize: number(v.largestNameGroupSize, 'largestNameGroupSize'), largestPhoneGroupSize: number(v.largestPhoneGroupSize, 'largestPhoneGroupSize'),
    items: list(v.items).map((item) => { const row = object(item); return {
      pair: pair(row.pair), customerA: summary(row.customerA), customerB: summary(row.customerB), matchingCodes: matching(row.matchingCodes), warnings: warnings(row.warnings), comparisonStatus: oneOf(row.comparisonStatus, ['READY', 'OVER_BUDGET', 'UNVERIFIABLE'] as const),
      review: parseReview(row.review),
    }; }),
    page: { nextCursor: nullableString(page.nextCursor, 'nextCursor'), exhausted: boolean(page.exhausted, 'exhausted'), evaluatedPairs: number(page.evaluatedPairs, 'evaluatedPairs'), returnedItems: number(page.returnedItems, 'returnedItems') },
  };
  if (result.items.length > 20 || result.page.returnedItems !== result.items.length || result.page.evaluatedPairs > 32 || (!result.page.exhausted && !result.page.nextCursor)) invalid();
  return result;
}
export type DuplicatePage = ReturnType<typeof parseDuplicatePage>;
export function listDuplicateCandidates(params: URLSearchParams, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const field of ['view', 'anchorCustomerId', 'cursor'] as const) if (params.has(field)) query.set(field, params.get(field)!);
  return request(`/api/customers/duplicate-candidates?${query}`, { signal }).then(parseDuplicatePage);
}

function customer(value: unknown) {
  const v = object(value);
  return { ...summary(v), customerType: oneOf<CustomerType>(v.customerType, CUSTOMER_TYPES), taxNumber: nullableString(v.taxNumber, 'taxNumber'), phone: nullableString(v.phone, 'phone'), email: nullableString(v.email, 'email'), address: nullableString(v.address, 'address'), version: number(v.version, 'version'), assignedStaffUserId: nullableString(v.assignedStaffUserId, 'assignedStaffUserId'),
    contacts: list(v.contacts).map((item) => { const c = object(item); return { id: string(c.id, 'id'), name: string(c.name, 'name'), title: nullableString(c.title, 'title'), phone: nullableString(c.phone, 'phone'), email: nullableString(c.email, 'email'), isPrimary: boolean(c.isPrimary, 'isPrimary'), isActive: boolean(c.isActive, 'isActive'), version: number(c.version, 'version') }; }),
  };
}
export const DUPLICATE_ACTIONS = ['DECIDE', 'REOPEN'] as const;
export type DuplicateAction = typeof DUPLICATE_ACTIONS[number];
export function parseDuplicateComparison(value: unknown) {
  const v = object(value); const evidence = object(v.evidence);
  if (evidence.schemaVersion !== 1) invalid();
  const allowedActions = list(v.allowedActions).map((action) => oneOf<DuplicateAction>(action, DUPLICATE_ACTIONS));
  return { pair: pair(v.pair), asOf: string(v.asOf, 'asOf'), customerA: customer(v.customerA), customerB: customer(v.customerB),
    evidence: { revision: string(evidence.revision, 'revision'), matchingRuleVersion: string(evidence.matchingRuleVersion, 'matchingRuleVersion'), matchingCodes: matching(evidence.matchingCodes), warnings: warnings(evidence.warnings) },
    review: parseReview(v.review), allowedActions };
}
export type DuplicateComparison = ReturnType<typeof parseDuplicateComparison>;
export function getDuplicateComparison(a: string, b: string, signal?: AbortSignal) {
  return request(`/api/customers/duplicate-review-pairs/${encodeURIComponent(a)}/${encodeURIComponent(b)}`, { signal }).then(parseDuplicateComparison);
}

export type DuplicateDecisionInput = {
  clientActionId: string; expectedReviewVersion: number; expectedEvidenceRevision: string;
  matchingRuleVersion: string; decision: DuplicateDecision; reasonCode: DuplicateDecisionReason;
};
export type DuplicateReopenInput = Omit<DuplicateDecisionInput, 'decision' | 'reasonCode'>;
export type DuplicateCommandReceipt = {
  reviewId: string; pair: { customerAId: string; customerBId: string }; reviewVersion: number;
  eventId: string; eventKind: 'DECISION_RECORDED' | 'REVIEW_REOPENED';
  resultingStatus: 'PENDING_REVIEW' | 'CONFIRMED_DUPLICATE' | 'DISMISSED';
  reasonCode: string; actorUserId: string; occurredAt: string;
};
export function parseDuplicateCommandReceipt(value: unknown): DuplicateCommandReceipt {
  const v = object(value);
  return {
    reviewId: string(v.reviewId, 'reviewId'), pair: pair(v.pair), reviewVersion: number(v.reviewVersion, 'reviewVersion'),
    eventId: string(v.eventId, 'eventId'), eventKind: oneOf(v.eventKind, ['DECISION_RECORDED', 'REVIEW_REOPENED'] as const),
    resultingStatus: oneOf(v.resultingStatus, ['PENDING_REVIEW', 'CONFIRMED_DUPLICATE', 'DISMISSED'] as const),
    reasonCode: string(v.reasonCode, 'reasonCode'), actorUserId: string(v.actorUserId, 'actorUserId'),
    occurredAt: string(v.occurredAt, 'occurredAt'),
  };
}
export function decideDuplicateReview(a: string, b: string, input: DuplicateDecisionInput) {
  return request(`/api/customers/duplicate-review-pairs/${encodeURIComponent(a)}/${encodeURIComponent(b)}/decisions`, json('POST', input)).then(parseDuplicateCommandReceipt);
}
export function reopenDuplicateReview(a: string, b: string, input: DuplicateReopenInput) {
  return request(`/api/customers/duplicate-review-pairs/${encodeURIComponent(a)}/${encodeURIComponent(b)}/reopen`, json('POST', input)).then(parseDuplicateCommandReceipt);
}

export type DuplicateHistoryItem = {
  eventId: string; seq: number; eventKind: 'DECISION_RECORDED' | 'REVIEW_REOPENED';
  resultingStatus: 'PENDING_REVIEW' | 'CONFIRMED_DUPLICATE' | 'DISMISSED';
  reasonCode: string; actorUserId: string; occurredAt: string; matchingRuleVersion: string;
  matchingCodes: DuplicateMatchCode[]; warnings: ReturnType<typeof warnings>;
};
export type DuplicateHistoryPage = { reviewId: string; upperSeq: number; items: DuplicateHistoryItem[]; nextCursor: string | null };
export function parseDuplicateHistoryPage(value: unknown): DuplicateHistoryPage {
  const v = object(value);
  return {
    reviewId: string(v.reviewId, 'reviewId'), upperSeq: number(v.upperSeq, 'upperSeq'),
    items: list(v.items).map((item) => { const row = object(item); return {
      eventId: string(row.eventId, 'eventId'), seq: number(row.seq, 'seq'),
      eventKind: oneOf(row.eventKind, ['DECISION_RECORDED', 'REVIEW_REOPENED'] as const),
      resultingStatus: oneOf(row.resultingStatus, ['PENDING_REVIEW', 'CONFIRMED_DUPLICATE', 'DISMISSED'] as const),
      reasonCode: string(row.reasonCode, 'reasonCode'), actorUserId: string(row.actorUserId, 'actorUserId'),
      occurredAt: string(row.occurredAt, 'occurredAt'), matchingRuleVersion: string(row.matchingRuleVersion, 'matchingRuleVersion'),
      matchingCodes: matching(row.matchingCodes), warnings: warnings(row.warnings),
    }; }),
    nextCursor: nullableString(v.nextCursor, 'nextCursor'),
  };
}
export function getDuplicateReviewHistory(reviewId: string, cursor?: string | null, signal?: AbortSignal) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return request(`/api/customers/duplicate-reviews/${encodeURIComponent(reviewId)}/history${query}`, { signal }).then(parseDuplicateHistoryPage);
}
