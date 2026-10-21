import type { CustomerPair } from './duplicate-candidates.js';
import type { DuplicateKeyring } from './duplicate-evidence.js';
import {
  projectDuplicatePair,
  projectDuplicateReview,
  type DuplicateReviewHead,
  type DuplicateReviewSummary,
} from './duplicate-review.js';
import type { DuplicateCustomerFacts } from './duplicate-types.js';

export type DuplicateRegisterSourceAvailability = 'AVAILABLE' | 'UNAVAILABLE';
export type DuplicateRegisterComparisonStatus = 'READY' | 'OVER_BUDGET' | 'UNAVAILABLE';

/** Same bounded header shape the candidate list exposes; no raw source snapshot. */
export type DuplicateRegisterCustomerHeader = {
  id: string; name: string; status: string; city: string | null; district: string | null;
};

export type DuplicateReviewRegisterItem = {
  reviewId: string;
  pair: CustomerPair;
  sourceAvailability: DuplicateRegisterSourceAvailability;
  customerA: DuplicateRegisterCustomerHeader | null;
  customerB: DuplicateRegisterCustomerHeader | null;
  matchingCodes: readonly string[];
  warnings: readonly string[];
  comparisonStatus: DuplicateRegisterComparisonStatus;
  review: DuplicateReviewSummary;
};

export type DuplicateReviewRegisterPage = {
  asOf: string;
  matchingRuleVersion: string;
  items: DuplicateReviewRegisterItem[];
  page: {
    nextCursor: string | null;
    exhausted: boolean;
    evaluatedReviews: number;
    returnedItems: number;
  };
};

const header = ({ id, name, status, city, district }: DuplicateCustomerFacts): DuplicateRegisterCustomerHeader =>
  ({ id, name, status, city, district });

/**
 * A register row keeps its safe historical review view even when the source
 * customers are deleted, converted to DEMO, or moved out of the organization.
 * Any unavailable side removes both headers, matching codes and warnings so a
 * partial source never leaks into the registry projection.
 */
export function duplicateRegisterItem(input: {
  organizationId: string;
  pair: CustomerPair;
  head: DuplicateReviewHead;
  customerA: DuplicateCustomerFacts | null;
  customerB: DuplicateCustomerFacts | null;
  keyring: DuplicateKeyring;
}): DuplicateReviewRegisterItem {
  const { organizationId, pair, head, customerA, customerB, keyring } = input;
  if (!customerA || !customerB) {
    const unavailable = projectDuplicateReview({ head, current: null, keyring, sourceAvailable: false });
    return {
      reviewId: head.id, pair, sourceAvailability: 'UNAVAILABLE',
      customerA: null, customerB: null, matchingCodes: [], warnings: [],
      comparisonStatus: 'UNAVAILABLE', review: unavailable.review,
    };
  }
  const projected = projectDuplicatePair({ organizationId, customerA, customerB, head, keyring });
  return {
    reviewId: head.id, pair, sourceAvailability: 'AVAILABLE',
    customerA: header(customerA), customerB: header(customerB),
    matchingCodes: projected.matchingCodes, warnings: projected.warnings,
    comparisonStatus: projected.comparisonStatus, review: projected.review,
  };
}

/**
 * ATTENTION keeps only reviews that still need a manager: pending work and
 * every stale, unverifiable, over-budget or unavailable row. A current decision
 * is the only state it suppresses.
 */
export function duplicateRegisterNeedsAttention(item: DuplicateReviewRegisterItem): boolean {
  return !(item.review.freshness === 'CURRENT'
    && (item.review.effectiveStatus === 'CONFIRMED_DUPLICATE' || item.review.effectiveStatus === 'DISMISSED'));
}
