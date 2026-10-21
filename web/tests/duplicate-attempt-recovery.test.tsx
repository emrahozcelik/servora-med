/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { DuplicateAttemptRecovery } from '../src/DuplicateAttemptRecovery';
import { classifyDuplicateRecoveryFailure, duplicateRecoveryRequest, duplicateRecoveryRetryable } from '../src/duplicate-recovery';
import { clearDuplicateAttempt, writeDuplicateAttempt, type DuplicateAttempt } from '../src/duplicate-review-attempt';
import { ApiError } from '../src/services/api';

const organizationId = '20000000-0000-4000-8000-0000000000aa';
const actorId = '40000000-0000-4000-8000-000000000001';
const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const frozen: DuplicateAttempt = {
  version: 1, kind: 'DECIDE', clientActionId: '6f1f0d1e-0000-4000-8000-00000000000c',
  expectedReviewVersion: 3, expectedEvidenceRevision: 'ev1.synthetic.digest',
  matchingRuleVersion: 'crm-duplicate-v1', decision: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER',
  createdAt: 1_760_000_000_000,
};

it('P3: the replay request reuses the frozen identity, version and evidence verbatim', () => {
  const decide = duplicateRecoveryRequest(frozen, a, b);
  expect(decide.kind).toBe('DECIDE');
  expect(decide.body).toEqual({
    clientActionId: frozen.clientActionId, expectedReviewVersion: 3,
    expectedEvidenceRevision: 'ev1.synthetic.digest', matchingRuleVersion: 'crm-duplicate-v1',
    decision: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER',
  });
  const reopen = duplicateRecoveryRequest({ ...frozen, kind: 'REOPEN', decision: undefined, reasonCode: undefined }, a, b);
  expect(reopen.kind).toBe('REOPEN');
  expect(reopen.body).toEqual({
    clientActionId: frozen.clientActionId, expectedReviewVersion: 3,
    expectedEvidenceRevision: 'ev1.synthetic.digest', matchingRuleVersion: 'crm-duplicate-v1',
  });
});

it('P3: only definitive failures close the frozen attempt; uncertainty keeps it', () => {
  expect(classifyDuplicateRecoveryFailure(new ApiError(404, 'DUPLICATE_PAIR_NOT_FOUND', 'yok'))).toBe('definitive-no-commit');
  expect(classifyDuplicateRecoveryFailure(new ApiError(422, 'EVIDENCE_LIMIT_EXCEEDED', 'limit'))).toBe('definitive-no-commit');
  expect(classifyDuplicateRecoveryFailure(new ApiError(409, 'VERSION_CONFLICT', 'çakışma'))).toBe('definitive-no-commit');
  expect(classifyDuplicateRecoveryFailure(new ApiError(409, 'EVIDENCE_CHANGED', 'değişti'))).toBe('definitive-no-commit');
  expect(classifyDuplicateRecoveryFailure(new ApiError(409, 'ACTION_IN_PROGRESS', 'işleniyor'))).toBe('uncertain');
  expect(classifyDuplicateRecoveryFailure(new ApiError(409, 'REVIEW_BUSY', 'meşgul'))).toBe('uncertain');
  expect(classifyDuplicateRecoveryFailure(new ApiError(503, 'REVIEW_TEMPORARILY_UNAVAILABLE', 'geçici'))).toBe('uncertain');
  expect(classifyDuplicateRecoveryFailure(new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'kota'))).toBe('uncertain');
  expect(classifyDuplicateRecoveryFailure(new Error('ağ hatası'))).toBe('uncertain');
  expect(classifyDuplicateRecoveryFailure(new ApiError(401, 'UNAUTHENTICATED', 'oturum'))).toBe('forbidden');
  expect(classifyDuplicateRecoveryFailure(new ApiError(403, 'FORBIDDEN', 'yetki'))).toBe('forbidden');
  expect(duplicateRecoveryRetryable(new ApiError(503, 'REVIEW_TEMPORARILY_UNAVAILABLE', 'geçici'))).toBe(true);
  expect(duplicateRecoveryRetryable(new ApiError(409, 'VERSION_CONFLICT', 'çakışma'))).toBe(false);
});

it('P3/UI: the recovery surface is actor-bound and never shows a receipt as current state', () => {
  const render = (id: string) => renderToStaticMarkup(
    <MemoryRouter><DuplicateAttemptRecovery user={{ id, organizationId }} aId={a} bId={b} /></MemoryRouter>,
  );
  expect(render(actorId)).toBe('');
  writeDuplicateAttempt(organizationId, actorId, a, b, frozen);
  const html = render(actorId);
  expect(html).toContain('Yanıtı alınamamış inceleme isteği');
  expect(html).toContain('Özgün isteği tekrar dene');
  expect(html).toContain('Ayrı müşteri');
  expect(html).not.toContain('güncel inceleme durumu değildir');
  expect(render('40000000-0000-4000-8000-000000000009')).toBe('');
  clearDuplicateAttempt(organizationId, actorId, a, b);
  expect(render(actorId)).toBe('');
});
