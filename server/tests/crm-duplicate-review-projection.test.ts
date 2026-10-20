import { expect, it } from 'vitest';

import {
  createDuplicateEvidence,
  createDuplicateEvidenceDetails,
  parseDuplicateEvidenceRevision,
  parseDuplicateKeyring,
} from '../src/modules/crm/duplicate-evidence.js';
import { projectDuplicateReview, type DuplicateReviewHead } from '../src/modules/crm/duplicate-review.js';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(9);
const keyring = parseDuplicateKeyring(JSON.stringify({
  activeKeyId: 'new', keys: { new: Buffer.alloc(32, 7).toString('base64'), old: Buffer.alloc(32, 8).toString('base64') },
}));
const customer = (n: number) => ({
  id: id(n), name: 'İSTANBUL KLİNİK', customerType: 'clinic' as const,
  taxNumber: null, phone: '(0532) 123 45 67', email: 'test@example.invalid',
  city: 'İstanbul', district: 'Merkez', address: 'Test sokak', status: 'active' as const,
  version: 1, assignedStaffUserId: null, contacts: [], addressOverflow: false,
});
const a = customer(1); const b = customer(2);
const evidence = createDuplicateEvidenceDetails(org, a, b, keyring);
const head = (overrides: Partial<DuplicateReviewHead> = {}): DuplicateReviewHead => ({
  id: id(20), version: 1, eventId: id(30), seq: 1, eventKind: 'DECISION_RECORDED',
  resultingStatus: 'CONFIRMED_DUPLICATE', reasonCode: 'SAME_OPERATIONAL_CUSTOMER_VERIFIED',
  actorUserId: id(40), occurredAt: new Date('2026-10-20T10:00:00.000Z'),
  evidenceSchemaVersion: 1, matchingRuleVersion: 'crm-duplicate-v1',
  evidenceKeyId: evidence.keyId, evidenceDigest: evidence.digest,
  matchingCodes: evidence.matchingCodes, conflictingTaxNumbers: false,
  previousDecision: null, ...overrides,
});

it('EVID-06: exposes the exact canonical digest and parses strict revision tokens', () => {
  expect(evidence.revision).toBe(createDuplicateEvidence(org, a, b, keyring));
  expect(evidence.digest).toHaveLength(32);
  expect(parseDuplicateEvidenceRevision(evidence.revision)).toEqual({ keyId: evidence.keyId, digest: evidence.digest });
  expect(parseDuplicateEvidenceRevision(`ev1.${evidence.keyId}.AAAA`)).toBeNull();
  expect(parseDuplicateEvidenceRevision(`ev2.${evidence.keyId}.${evidence.revision.split('.')[2]}`)).toBeNull();
});

it('SD-5/CURRENT: a current terminal review allows explicit reopen only', () => {
  const projection = projectDuplicateReview({ head: head(), current: evidence, keyring, sourceAvailable: true });
  expect(projection.review).toMatchObject({
    id: id(20), version: 1, reviewStatus: 'CONFIRMED_DUPLICATE',
    effectiveStatus: 'CONFIRMED_DUPLICATE', freshness: 'CURRENT', freshnessReason: null,
    currentDecision: { eventId: id(30), seq: 1, status: 'CONFIRMED_DUPLICATE', reasonCode: 'SAME_OPERATIONAL_CUSTOMER_VERIFIED', actorUserId: id(40) },
  });
  expect(projection.review.lastDecision).toEqual(projection.review.currentDecision);
  expect(projection.allowedActions).toEqual(['REOPEN']);
});

it('SD-5/SOURCE_CHANGED, RULE_CHANGED: a stale terminal review projects REVIEW_REQUIRED', () => {
  expect(projectDuplicateReview({ head: head(), current: createDuplicateEvidenceDetails(org, a, { ...b, name: 'Başka' }, keyring), keyring, sourceAvailable: true }))
    .toMatchObject({ review: { effectiveStatus: 'REVIEW_REQUIRED', freshness: 'STALE', freshnessReason: 'SOURCE_CHANGED' }, allowedActions: ['REOPEN'] });
  expect(projectDuplicateReview({ head: head({ matchingRuleVersion: 'crm-duplicate-v0' }), current: evidence, keyring, sourceAvailable: true }))
    .toMatchObject({ review: { effectiveStatus: 'REVIEW_REQUIRED', freshness: 'STALE', freshnessReason: 'RULE_CHANGED' }, allowedActions: ['REOPEN'] });
});

it('EVID-08/09/SD-5: previous key preserves freshness; missing key is BLOCKED+UNVERIFIABLE, never CURRENT', () => {
  const old = createDuplicateEvidenceDetails(org, a, b, keyring, 'old');
  const oldHead = head({ evidenceKeyId: 'old', evidenceDigest: old.digest });
  expect(projectDuplicateReview({ head: oldHead, current: evidence, keyring, sourceAvailable: true }))
    .toMatchObject({ review: { effectiveStatus: 'CONFIRMED_DUPLICATE', freshness: 'CURRENT' }, allowedActions: ['REOPEN'] });
  const missing = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'new', keys: { new: Buffer.alloc(32, 7).toString('base64') } }));
  expect(projectDuplicateReview({ head: oldHead, current: evidence, keyring: missing, sourceAvailable: true }))
    .toMatchObject({ review: { effectiveStatus: 'BLOCKED', freshness: 'UNVERIFIABLE', freshnessReason: 'KEY_UNAVAILABLE' }, allowedActions: ['REOPEN'] });
});

it('SD-5: pending stale evidence remains PENDING_REVIEW but demands a current GET; blocked source has no action', () => {
  const reopened = head({
    version: 2, eventId: id(31), seq: 2, eventKind: 'REVIEW_REOPENED',
    resultingStatus: 'PENDING_REVIEW', reasonCode: 'RECHECK_REQUESTED',
    previousDecision: {
      eventId: id(30), seq: 1, status: 'DISMISSED', reasonCode: 'DISTINCT_BRANCH',
      actorUserId: id(40), decidedAt: new Date('2026-10-19T10:00:00.000Z'),
    },
  });
  expect(projectDuplicateReview({ head: reopened, current: evidence, keyring, sourceAvailable: true }))
    .toMatchObject({
      review: { reviewStatus: 'PENDING_REVIEW', effectiveStatus: 'PENDING_REVIEW', freshness: 'CURRENT', currentDecision: null,
        lastDecision: { eventId: id(30), seq: 1, status: 'DISMISSED' } },
      allowedActions: ['DECIDE'],
    });
  expect(projectDuplicateReview({ head: reopened, current: createDuplicateEvidenceDetails(org, a, { ...b, phone: '+902125550101' }, keyring), keyring, sourceAvailable: true }))
    .toMatchObject({ review: { effectiveStatus: 'PENDING_REVIEW', freshness: 'STALE', freshnessReason: 'SOURCE_CHANGED' }, allowedActions: ['DECIDE'] });
  expect(projectDuplicateReview({ head: reopened, current: null, keyring, sourceAvailable: false }))
    .toMatchObject({ review: { effectiveStatus: 'UNAVAILABLE', freshness: 'STALE', freshnessReason: 'SOURCE_UNAVAILABLE' }, allowedActions: [] });
});

it('READ-02/UI-08: an unavailable or over-budget current evidence blocks every command', () => {
  expect(projectDuplicateReview({ head: head(), current: null, keyring, sourceAvailable: true, overBudget: true }))
    .toMatchObject({ review: { effectiveStatus: 'BLOCKED', freshness: 'STALE', freshnessReason: 'OVER_BUDGET' }, allowedActions: [] });
  expect(projectDuplicateReview({ head: null, current: null, keyring, sourceAvailable: true, overBudget: true }))
    .toMatchObject({ review: { id: null, version: 0, effectiveStatus: 'BLOCKED', freshness: 'STALE', freshnessReason: 'OVER_BUDGET' }, allowedActions: [] });
});

it('SD-5: a reopened chain without its previous decision fails closed', () => {
  expect(() => projectDuplicateReview({
    head: head({ eventKind: 'REVIEW_REOPENED', resultingStatus: 'PENDING_REVIEW', reasonCode: 'RECHECK_REQUESTED' }),
    current: evidence, keyring, sourceAvailable: true,
  })).toThrowError(expect.objectContaining({ code: 'REVIEW_TEMPORARILY_UNAVAILABLE' }));
});
