import type { Contact, Customer } from './types.js';

export const DUPLICATE_RULE_VERSION = 'crm-duplicate-v1';
export const DUPLICATE_LIMITS = Object.freeze({
  sourceCustomers: 20_000, page: 20, pairs: 32, contacts: 200,
  addressBytes: 16 * 1024, evidenceBytes: 2 * 1024 * 1024,
  statementMs: 2_000, requestMs: 5_000, cursorMs: 15 * 60_000,
  listPerMinute: 6, detailPerMinute: 20, inflightPerOrg: 2,
});
export const DUPLICATE_MATCH_CODES = [
  'SAME_NAME_AND_PHONE', 'SAME_NAME_AND_EMAIL', 'SAME_NAME_AND_ADDRESS', 'SAME_PHONE', 'SAME_NAME',
] as const;
export type DuplicateMatchCode = typeof DUPLICATE_MATCH_CODES[number];
export type DuplicateWarning = 'CONFLICTING_TAX_NUMBERS';
export type DuplicateContact = Omit<Contact, 'organizationId' | 'customerId' | 'createdAt' | 'updatedAt'>;
export type DuplicateCustomer = Omit<Customer, 'organizationId' | 'createdAt' | 'updatedAt'> & { contacts: DuplicateContact[] };
export type DuplicateCustomerFacts = DuplicateCustomer & { addressOverflow: boolean };

export const virtualDuplicateReview = () => ({
  id: null, version: 0, reviewStatus: 'PENDING_REVIEW', effectiveStatus: 'PENDING_REVIEW',
  freshness: 'NOT_APPLICABLE', freshnessReason: null, currentDecision: null, lastDecision: null,
} as const);
