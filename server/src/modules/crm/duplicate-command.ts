import { AppError } from '../../errors/index.js';
import { hashRequestIdentity } from '../job-cards/critical-action-request-hash.js';
import { parseDuplicateEvidenceRevision } from './duplicate-evidence.js';
import {
  DUPLICATE_CONFIRM_REASONS,
  DUPLICATE_DECISIONS,
  DUPLICATE_DISMISS_REASONS,
  type DuplicateDecision,
  type DuplicateDecisionReason,
} from './duplicate-review.js';
import type { CustomerPair } from './duplicate-candidates.js';
import type { CrmActor } from './types.js';

export const DUPLICATE_DECISION_OPERATION = 'CRM_DUPLICATE_DECISION';
export const DUPLICATE_REOPEN_OPERATION = 'CRM_DUPLICATE_REOPEN';
export const DUPLICATE_DECISION_HASH_VERSION = 'CRM_DUPLICATE_DECISION:v1';
export const DUPLICATE_REOPEN_HASH_VERSION = 'CRM_DUPLICATE_REOPEN:v1';

export type DuplicateDecisionCommand = {
  clientActionId: string;
  expectedReviewVersion: number;
  expectedEvidenceRevision: string;
  matchingRuleVersion: string;
  decision: DuplicateDecision;
  reasonCode: DuplicateDecisionReason;
};

export type DuplicateReopenCommand = Omit<DuplicateDecisionCommand, 'decision' | 'reasonCode'>;

const ruleVersionPattern = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const decisionFields = [
  'clientActionId', 'expectedReviewVersion', 'expectedEvidenceRevision',
  'matchingRuleVersion', 'decision', 'reasonCode',
] as const;
const reopenFields = [
  'clientActionId', 'expectedReviewVersion', 'expectedEvidenceRevision', 'matchingRuleVersion',
] as const;

function invalid(fieldErrors: Record<string, string>): never {
  throw new AppError('VALIDATION_ERROR', 400, 'İnceleme isteği geçersiz.', { fieldErrors });
}

function exactObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid({ body: 'Nesne bekleniyor.' });
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!allowed.includes(key)) invalid({ body: `${key} alanı kabul edilmez.` });
  return record;
}

function clientActionId(value: unknown): string {
  if (typeof value !== 'string') return invalid({ clientActionId: 'Metin bekleniyor.' });
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) return invalid({ clientActionId: '1–255 karakter olmalıdır.' });
  return normalized;
}

function expectedReviewVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    return invalid({ expectedReviewVersion: '0–2147483647 aralığında tam sayı olmalıdır.' });
  }
  return value;
}

function expectedEvidenceRevision(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !parseDuplicateEvidenceRevision(value)) {
    return invalid({ expectedEvidenceRevision: 'Geçerli bir kanıt revizyonu bekleniyor.' });
  }
  return value;
}

function matchingRuleVersion(value: unknown): string {
  if (typeof value !== 'string' || !ruleVersionPattern.test(value)) {
    return invalid({ matchingRuleVersion: 'Geçerli bir kural sürümü bekleniyor.' });
  }
  return value;
}

function reasonFor(decision: unknown, reasonCode: unknown): { decision: DuplicateDecision; reasonCode: DuplicateDecisionReason } {
  if (typeof decision !== 'string' || !DUPLICATE_DECISIONS.includes(decision as DuplicateDecision)) {
    return invalid({ decision: 'CONFIRMED_DUPLICATE veya DISMISSED seçilmelidir.' });
  }
  const allowed: readonly string[] = decision === 'CONFIRMED_DUPLICATE' ? DUPLICATE_CONFIRM_REASONS : DUPLICATE_DISMISS_REASONS;
  if (typeof reasonCode !== 'string' || !allowed.includes(reasonCode)) {
    return invalid({ reasonCode: 'Seçilen karar için izinli gerekçe seçilmelidir.' });
  }
  return { decision: decision as DuplicateDecision, reasonCode: reasonCode as DuplicateDecisionReason };
}

export function parseDuplicateDecisionCommand(value: unknown): DuplicateDecisionCommand {
  const body = exactObject(value, decisionFields);
  return {
    clientActionId: clientActionId(body.clientActionId),
    expectedReviewVersion: expectedReviewVersion(body.expectedReviewVersion),
    expectedEvidenceRevision: expectedEvidenceRevision(body.expectedEvidenceRevision),
    matchingRuleVersion: matchingRuleVersion(body.matchingRuleVersion),
    ...reasonFor(body.decision, body.reasonCode),
  };
}

export function parseDuplicateReopenCommand(value: unknown): DuplicateReopenCommand {
  const body = exactObject(value, reopenFields);
  return {
    clientActionId: clientActionId(body.clientActionId),
    expectedReviewVersion: expectedReviewVersion(body.expectedReviewVersion),
    expectedEvidenceRevision: expectedEvidenceRevision(body.expectedEvidenceRevision),
    matchingRuleVersion: matchingRuleVersion(body.matchingRuleVersion),
  };
}

const canonicalPair = (pair: CustomerPair) => pair.customerAId < pair.customerBId
  ? pair
  : { customerAId: pair.customerBId, customerBId: pair.customerAId };

export function duplicateDecisionRequestHash(actor: CrmActor, pair: CustomerPair, input: DuplicateDecisionCommand) {
  const ordered = canonicalPair(pair);
  return hashRequestIdentity({
    operation: DUPLICATE_DECISION_HASH_VERSION,
    organizationId: actor.organizationId,
    actorUserId: actor.id,
    customerAId: ordered.customerAId,
    customerBId: ordered.customerBId,
    expectedReviewVersion: input.expectedReviewVersion,
    expectedEvidenceRevision: input.expectedEvidenceRevision,
    matchingRuleVersion: input.matchingRuleVersion,
    decision: input.decision,
    reasonCode: input.reasonCode,
  });
}

export function duplicateReopenRequestHash(actor: CrmActor, pair: CustomerPair, input: DuplicateReopenCommand) {
  const ordered = canonicalPair(pair);
  return hashRequestIdentity({
    operation: DUPLICATE_REOPEN_HASH_VERSION,
    organizationId: actor.organizationId,
    actorUserId: actor.id,
    customerAId: ordered.customerAId,
    customerBId: ordered.customerBId,
    expectedReviewVersion: input.expectedReviewVersion,
    expectedEvidenceRevision: input.expectedEvidenceRevision,
    matchingRuleVersion: input.matchingRuleVersion,
  });
}
