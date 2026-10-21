import { expect, it } from 'vitest';
import { parseDuplicateKeyring } from '../src/modules/crm/duplicate-evidence.js';
import { decodeRegisterCursor, encodeRegisterCursor } from '../src/modules/crm/duplicate-register-cursor.js';
import {
  duplicateRegisterItem, duplicateRegisterNeedsAttention,
  type DuplicateReviewRegisterItem,
} from '../src/modules/crm/duplicate-register.js';
import type { DuplicateReviewHead } from '../src/modules/crm/duplicate-review.js';
import type { DuplicateCustomerFacts } from '../src/modules/crm/duplicate-types.js';

const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 8).toString('base64') } }));
const pair = { customerAId: '10000000-0000-4000-8000-000000000001', customerBId: '10000000-0000-4000-8000-000000000002' };
const context = { organizationId: 'org', view: 'ALL' as const, limit: 20 };

let seq = 0;
function facts(id: string, overrides: Partial<DuplicateCustomerFacts> = {}): DuplicateCustomerFacts {
  return {
    id, name: 'Sentetik Klinik', customerType: 'clinic', taxNumber: null,
    phone: '+905321234567', email: null, city: 'İstanbul', district: 'Merkez', address: null,
    assignedStaffUserId: null, status: 'active', version: 1, addressOverflow: false, contacts: [],
    ...overrides,
  };
}

function head(overrides: Partial<DuplicateReviewHead> = {}): DuplicateReviewHead {
  seq += 1;
  return {
    id: '20000000-0000-4000-8000-000000000001', version: 2,
    eventId: '30000000-0000-4000-8000-000000000001', seq,
    eventKind: 'DECISION_RECORDED', resultingStatus: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER',
    actorUserId: '40000000-0000-4000-8000-000000000001', occurredAt: new Date('2026-10-20T10:00:00Z'),
    evidenceSchemaVersion: 1, matchingRuleVersion: 'crm-duplicate-v1', evidenceKeyId: 'test',
    evidenceDigest: Buffer.alloc(32, 3), matchingCodes: ['SAME_NAME'], conflictingTaxNumbers: false,
    previousDecision: null,
    ...overrides,
  };
}

it('READ-03/READ-05: register cursor is authenticated, scoped and domain-separated', () => {
  const cursor = encodeRegisterCursor(context, pair, keys, 1000);
  expect(cursor.startsWith('dr1.')).toBe(true);
  expect(decodeRegisterCursor(cursor, context, keys, 1001)).toEqual(pair);
  expect(() => decodeRegisterCursor(cursor.slice(0, -2) + 'aa', context, keys, 1001)).toThrow();
  expect(() => decodeRegisterCursor(cursor, { ...context, organizationId: 'foreign' }, keys, 1001)).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  expect(() => decodeRegisterCursor(cursor, { ...context, view: 'ATTENTION' }, keys, 1001)).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  expect(() => decodeRegisterCursor(cursor, context, keys, 901001)).toThrowError(expect.objectContaining({ code: 'CURSOR_RESTART_REQUIRED' }));
});

it('READ-03: ATTENTION keeps every unresolved or stale review and drops only current decisions', () => {
  const base: DuplicateReviewRegisterItem = {
    reviewId: head().id, pair, sourceAvailability: 'AVAILABLE', customerA: null, customerB: null,
    matchingCodes: [], warnings: [], comparisonStatus: 'READY',
    review: {
      id: head().id, version: 2, reviewStatus: 'DISMISSED', effectiveStatus: 'DISMISSED',
      freshness: 'CURRENT', freshnessReason: null, currentDecision: null, lastDecision: null,
    },
  };
  expect(duplicateRegisterNeedsAttention(base)).toBe(false);
  expect(duplicateRegisterNeedsAttention({ ...base, review: { ...base.review, effectiveStatus: 'REVIEW_REQUIRED', freshness: 'STALE', freshnessReason: 'SOURCE_CHANGED' } })).toBe(true);
  expect(duplicateRegisterNeedsAttention({ ...base, review: { ...base.review, effectiveStatus: 'PENDING_REVIEW', reviewStatus: 'PENDING_REVIEW', freshness: 'CURRENT' } })).toBe(true);
  expect(duplicateRegisterNeedsAttention({ ...base, review: { ...base.review, effectiveStatus: 'BLOCKED', freshness: 'STALE', freshnessReason: 'OVER_BUDGET' } })).toBe(true);
});

it('READ-05: removed sources keep safe historical review fields and drop both headers', () => {
  const item = duplicateRegisterItem({
    organizationId: 'org', pair, head: head(), customerA: facts(pair.customerAId), customerB: null, keyring: keys,
  });
  expect(item.sourceAvailability).toBe('UNAVAILABLE');
  expect(item.customerA).toBeNull();
  expect(item.customerB).toBeNull();
  expect(item.matchingCodes).toEqual([]);
  expect(item.warnings).toEqual([]);
  expect(item.comparisonStatus).toBe('UNAVAILABLE');
  expect(item.review.reviewStatus).toBe('DISMISSED');
  expect(item.review.effectiveStatus).toBe('UNAVAILABLE');
  expect(item.review.freshnessReason).toBe('SOURCE_UNAVAILABLE');
  expect(item.review.currentDecision).toMatchObject({ status: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER' });
});

it('READ-03: available sources keep bounded headers and projected freshness', () => {
  const item = duplicateRegisterItem({
    organizationId: 'org', pair, head: head(),
    customerA: facts(pair.customerAId), customerB: facts(pair.customerBId), keyring: keys,
  });
  expect(item.sourceAvailability).toBe('AVAILABLE');
  expect(item.customerA).toEqual({ id: pair.customerAId, name: 'Sentetik Klinik', status: 'active', city: 'İstanbul', district: 'Merkez' });
  expect(item.comparisonStatus).toBe('READY');
  // Stored digest does not match current sources, so the decision is stale.
  expect(item.review.freshness).toBe('STALE');
  expect(item.review.freshnessReason).toBe('SOURCE_CHANGED');
  expect(item.review.effectiveStatus).toBe('REVIEW_REQUIRED');
});

it('READ-03: a page evaluates at most 32 heads, returns 20 and carries the last consumed pair', async () => {
  const { createDuplicateEvidenceDetails } = await import('../src/modules/crm/duplicate-evidence.js');
  const { DuplicateRegisterService } = await import('../src/modules/crm/duplicate-register-service.js');
  const { DUPLICATE_RULE_VERSION } = await import('../src/modules/crm/duplicate-types.js');

  const org = '50000000-0000-4000-8000-000000000001';
  const heads: Array<{ pair: { customerAId: string; customerBId: string }; head: DuplicateReviewHead }> = [];
  const allFacts = new Map<string, DuplicateCustomerFacts>();
  const uuid = (index: number) => `60000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

  for (let index = 0; index < 33; index++) {
    const a = uuid(index * 2 + 1); const b = uuid(index * 2 + 2);
    const customerA = facts(a); const customerB = facts(b, { name: 'SENTETİK KLİNİK' });
    allFacts.set(a, customerA); allFacts.set(b, customerB);
    // The first 12 heads are current decisions, so ATTENTION filters them out.
    const details = createDuplicateEvidenceDetails(org, customerA, customerB, keys);
    heads.push({
      pair: { customerAId: a, customerBId: b },
      head: {
        ...head({ id: uuid(100 + index) }),
        evidenceDigest: index < 12 ? details.digest : Buffer.alloc(32, index),
        evidenceKeyId: keys.activeKeyId,
        matchingRuleVersion: DUPLICATE_RULE_VERSION,
        resultingStatus: 'DISMISSED', eventKind: 'DECISION_RECORDED',
      },
    });
  }

  const snapshot = {
    asOf: new Date().toISOString(),
    checkpoint: () => undefined,
    registerHeads: async (_org: string, _after: unknown, limit: number) => heads.slice(0, limit),
    facts: async () => new Map(allFacts),
  };
  const repository = { snapshot: async (run: (value: typeof snapshot) => Promise<unknown>) => run(snapshot) };
  const service = new DuplicateRegisterService(repository as never, keys);
  const page = await service.register(
    { id: '70000000-0000-4000-8000-000000000001', organizationId: org, role: 'MANAGER' } as never,
    { view: 'ATTENTION', cursor: null, limit: 20 },
  );

  expect(page.page.evaluatedReviews).toBe(32);
  expect(page.page.returnedItems).toBe(20);
  expect(page.page.exhausted).toBe(false);
  expect(page.page.nextCursor).not.toBeNull();
  expect(decodeRegisterCursor(page.page.nextCursor!, { organizationId: org, view: 'ATTENTION', limit: 20 }, keys)).toEqual(heads[31]!.pair);
});
