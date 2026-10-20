import { expect, it } from 'vitest';

import {
  duplicateDecisionRequestHash,
  duplicateReopenRequestHash,
  parseDuplicateDecisionCommand,
  parseDuplicateReopenCommand,
} from '../src/modules/crm/duplicate-command.js';

const pair = { customerAId: '10000000-0000-4000-8000-000000000001', customerBId: '10000000-0000-4000-8000-000000000002' };
const actor = { id: '50000000-0000-4000-8000-000000000001', organizationId: '90000000-0000-4000-8000-000000000001', role: 'MANAGER' as const };
const revision = 'ev1.synthetic.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const body = {
  clientActionId: ' 40000000-0000-4000-8000-000000000001 ',
  expectedReviewVersion: 0,
  expectedEvidenceRevision: revision,
  matchingRuleVersion: 'crm-duplicate-v1',
  decision: 'CONFIRMED_DUPLICATE',
  reasonCode: 'SAME_OPERATIONAL_CUSTOMER_VERIFIED',
};

it('CMD-03/API-5: parses the exact decision allowlist and binds the normalized intent hash', () => {
  const parsed = parseDuplicateDecisionCommand(body);
  expect(parsed.clientActionId).toBe('40000000-0000-4000-8000-000000000001');
  const hash = duplicateDecisionRequestHash(actor, pair, parsed);
  expect(hash).toHaveLength(64);
  expect(duplicateDecisionRequestHash(actor, { customerAId: pair.customerBId, customerBId: pair.customerAId }, parsed)).toBe(hash);
  expect(duplicateDecisionRequestHash(actor, pair, { ...parsed, expectedReviewVersion: 1 })).not.toBe(hash);
  expect(duplicateDecisionRequestHash({ ...actor, id: '50000000-0000-4000-8000-000000000002' }, pair, parsed)).not.toBe(hash);
  expect(duplicateDecisionRequestHash(actor, pair, { ...parsed, reasonCode: 'INSUFFICIENT_EVIDENCE' })).not.toBe(hash);
  for (const changed of [
    { ...parsed, expectedEvidenceRevision: `ev1.synthetic.${'B'.repeat(43)}` },
    { ...parsed, matchingRuleVersion: 'crm-duplicate-v2' },
    { ...parsed, decision: 'DISMISSED' as const, reasonCode: 'DISTINCT_BRANCH' as const },
  ]) expect(duplicateDecisionRequestHash(actor, pair, changed)).not.toBe(hash);
  expect(duplicateDecisionRequestHash({ ...actor, organizationId: pair.customerAId }, pair, parsed)).not.toBe(hash);
  expect(duplicateDecisionRequestHash(actor, { ...pair, customerBId: actor.id }, parsed)).not.toBe(hash);
});

it('SEC-04/API-5: rejects unknown keys, free text, bad versions, bad evidence and mismatched reasons', () => {
  for (const invalid of [
    { ...body, note: 'serbest metin' },
    { ...body, reasonCode: 'DISTINCT_CUSTOMER' },
    { ...body, decision: 'DISMISSED', reasonCode: 'SAME_OPERATIONAL_CUSTOMER_VERIFIED' },
    { ...body, expectedReviewVersion: -1 },
    { ...body, expectedReviewVersion: 2 ** 31 },
    { ...body, expectedEvidenceRevision: 'ev2.synthetic.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    { ...body, expectedEvidenceRevision: 'ev1.synthetic.short' },
    { ...body, matchingRuleVersion: 'CRM Duplicate v1' },
    { ...body, clientActionId: ' ' },
  ]) expect(() => parseDuplicateDecisionCommand(invalid)).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }));
});

it('API-6: reopen accepts no decision/reason/free text and binds expected evidence/version/rule', () => {
  const { decision: _decision, reasonCode: _reason, ...reopen } = body;
  const parsed = parseDuplicateReopenCommand(reopen);
  expect(parsed).toEqual({
    clientActionId: '40000000-0000-4000-8000-000000000001', expectedReviewVersion: 0,
    expectedEvidenceRevision: revision, matchingRuleVersion: 'crm-duplicate-v1',
  });
  expect(() => parseDuplicateReopenCommand({ ...reopen, reasonCode: 'RECHECK_REQUESTED' })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  const hash = duplicateReopenRequestHash(actor, pair, parsed);
  expect(hash).toHaveLength(64);
  expect(duplicateReopenRequestHash(actor, pair, { ...parsed, expectedReviewVersion: 1 })).not.toBe(hash);
});
