import { ApiError, boolean, nullableString, number, object, request, string } from './api';
import { CUSTOMER_STATUSES, CUSTOMER_TYPES, type CustomerStatus, type CustomerType } from './crm-api';

export const duplicateReasonLabels = {
  SAME_NAME_AND_PHONE: 'İsim ve telefon aynı', SAME_NAME_AND_EMAIL: 'İsim ve e-posta aynı',
  SAME_NAME_AND_ADDRESS: 'İsim ve tam adres aynı', SAME_PHONE: 'Telefon aynı', SAME_NAME: 'İsim aynı',
} as const;
type MatchCode = keyof typeof duplicateReasonLabels;
const invalid = (): never => { throw new ApiError(0, 'INVALID_RESPONSE', 'Karşılaştırma yanıtı geçersiz. Yeniden deneyin.'); };
function list(value: unknown) { if (!Array.isArray(value)) return invalid(); return value; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid(); return value as T; }
const pair = (value: unknown) => { const v = object(value); return { customerAId: string(v.customerAId, 'customerAId'), customerBId: string(v.customerBId, 'customerBId') }; };
function summary(value: unknown) {
  const v = object(value);
  return { id: string(v.id, 'id'), name: string(v.name, 'name'), status: oneOf<CustomerStatus>(v.status, CUSTOMER_STATUSES), city: nullableString(v.city, 'city'), district: nullableString(v.district, 'district') };
}
function matching(value: unknown) { return list(value).map((v) => oneOf<MatchCode>(v, Object.keys(duplicateReasonLabels) as MatchCode[])); }
function warnings(value: unknown) { return list(value).map((v) => oneOf(v, ['CONFLICTING_TAX_NUMBERS'] as const)); }
function pendingReview(value: unknown) {
  const v = object(value);
  if (v.id !== null || v.version !== 0 || v.reviewStatus !== 'PENDING_REVIEW' || v.effectiveStatus !== 'PENDING_REVIEW' || v.freshness !== 'NOT_APPLICABLE' || v.currentDecision !== null || v.lastDecision !== null) invalid();
}
export function parseDuplicatePage(value: unknown) {
  const v = object(value); const scope = object(v.scope); const page = object(v.page);
  if (scope.dataClass !== 'BUSINESS' || scope.includesInactive !== true || v.coverage !== 'COMPLETE_SOURCE' || typeof v.rawPairCount !== 'string' || !/^\d+$/.test(v.rawPairCount)) invalid();
  const result = {
    scope: { dataClass: 'BUSINESS' as const, includesInactive: true as const, anchorCustomerId: nullableString(scope.anchorCustomerId, 'anchorCustomerId') },
    asOf: string(v.asOf, 'asOf'), matchingRuleVersion: string(v.matchingRuleVersion, 'matchingRuleVersion'), coverage: 'COMPLETE_SOURCE' as const,
    rawPairCount: v.rawPairCount as string, largestNameGroupSize: number(v.largestNameGroupSize, 'largestNameGroupSize'), largestPhoneGroupSize: number(v.largestPhoneGroupSize, 'largestPhoneGroupSize'),
    items: list(v.items).map((item) => { const row = object(item); pendingReview(row.review); return {
      pair: pair(row.pair), customerA: summary(row.customerA), customerB: summary(row.customerB), matchingCodes: matching(row.matchingCodes), warnings: warnings(row.warnings), comparisonStatus: oneOf(row.comparisonStatus, ['READY', 'OVER_BUDGET', 'UNVERIFIABLE'] as const),
    }; }),
    page: { nextCursor: nullableString(page.nextCursor, 'nextCursor'), exhausted: boolean(page.exhausted, 'exhausted'), evaluatedPairs: number(page.evaluatedPairs, 'evaluatedPairs'), returnedItems: number(page.returnedItems, 'returnedItems') },
  };
  if (result.items.length > 20 || result.page.returnedItems !== result.items.length || result.page.evaluatedPairs > 32 || (!result.page.exhausted && !result.page.nextCursor)) invalid();
  return result;
}
export type DuplicatePage = ReturnType<typeof parseDuplicatePage>;
export function listDuplicateCandidates(params: URLSearchParams, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const field of ['anchorCustomerId', 'cursor'] as const) if (params.has(field)) query.set(field, params.get(field)!);
  return request(`/api/customers/duplicate-candidates?${query}`, { signal }).then(parseDuplicatePage);
}

function customer(value: unknown) {
  const v = object(value);
  return { ...summary(v), customerType: oneOf<CustomerType>(v.customerType, CUSTOMER_TYPES), taxNumber: nullableString(v.taxNumber, 'taxNumber'), phone: nullableString(v.phone, 'phone'), email: nullableString(v.email, 'email'), address: nullableString(v.address, 'address'), version: number(v.version, 'version'), assignedStaffUserId: nullableString(v.assignedStaffUserId, 'assignedStaffUserId'),
    contacts: list(v.contacts).map((item) => { const c = object(item); return { id: string(c.id, 'id'), name: string(c.name, 'name'), title: nullableString(c.title, 'title'), phone: nullableString(c.phone, 'phone'), email: nullableString(c.email, 'email'), isPrimary: boolean(c.isPrimary, 'isPrimary'), isActive: boolean(c.isActive, 'isActive'), version: number(c.version, 'version') }; }),
  };
}
export function parseDuplicateComparison(value: unknown) {
  const v = object(value); const evidence = object(v.evidence); pendingReview(v.review);
  if (list(v.allowedActions).length || evidence.schemaVersion !== 1) invalid();
  return { pair: pair(v.pair), asOf: string(v.asOf, 'asOf'), customerA: customer(v.customerA), customerB: customer(v.customerB), evidence: { revision: string(evidence.revision, 'revision'), matchingRuleVersion: string(evidence.matchingRuleVersion, 'matchingRuleVersion'), matchingCodes: matching(evidence.matchingCodes), warnings: warnings(evidence.warnings) } };
}
export type DuplicateComparison = ReturnType<typeof parseDuplicateComparison>;
export function getDuplicateComparison(a: string, b: string, signal?: AbortSignal) {
  return request(`/api/customers/duplicate-review-pairs/${encodeURIComponent(a)}/${encodeURIComponent(b)}`, { signal }).then(parseDuplicateComparison);
}
