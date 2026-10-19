import { AppError } from '../../errors/index.js';
import { createCandidateIndex, foldDuplicateText, type CustomerPair } from './duplicate-candidates.js';
import { decodeDuplicateCursor, encodeDuplicateCursor } from './duplicate-cursor.js';
import { compareDuplicateFacts, createDuplicateEvidence, duplicateHmac, type DuplicateKeyring } from './duplicate-evidence.js';
import { PostgresDuplicateReadRepository } from './duplicate-repository.js';
import { DUPLICATE_LIMITS, DUPLICATE_RULE_VERSION, virtualDuplicateReview, type DuplicateCustomerFacts } from './duplicate-types.js';
import { normalizeTurkishPhone, type CrmActor } from './types.js';

export type DuplicateListInput = { view: 'ALL' | 'ATTENTION'; anchorCustomerId: string | null; cursor: string | null; limit: number };
const notFound = (): never => { throw new AppError('DUPLICATE_PAIR_NOT_FOUND', 404, 'Karşılaştırılabilir müşteri çifti bulunamadı.'); };
const management = (actor: CrmActor) => { if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') throw new AppError('FORBIDDEN', 403, 'Bu ekranı yalnız yöneticiler kullanabilir.'); };
const header = ({ id, name, status, city, district }: DuplicateCustomerFacts) => ({ id, name, status, city, district });
const publicCustomer = ({ addressOverflow: _overflow, ...customer }: DuplicateCustomerFacts) => customer;

export class DuplicateComparisonService {
  private inflight = new Map<string, number>();
  constructor(private repository: PostgresDuplicateReadRepository, private keys: DuplicateKeyring) {}
  async candidates(actor: CrmActor, input: DuplicateListInput) {
    management(actor);
    const org = actor.organizationId;
    if ((this.inflight.get(org) ?? 0) >= DUPLICATE_LIMITS.inflightPerOrg) throw new AppError('RATE_LIMIT_EXCEEDED', 429, 'Tarama kapasitesi dolu. Lütfen yeniden deneyin.');
    this.inflight.set(org, (this.inflight.get(org) ?? 0) + 1);
    try {
      return await this.repository.snapshot(async (snapshot) => {
        const source = await snapshot.source(org, input.anchorCustomerId);
        if (input.anchorCustomerId && !source.length) return notFound();
        if (source.length > DUPLICATE_LIMITS.sourceCustomers) throw new AppError('CANDIDATE_SCAN_LIMIT', 422, 'Kuruluşta 20.000 üzerinde müşteri var. Tarama tamamlanamadı.');
        const index = createCandidateIndex(source, snapshot.checkpoint);
        const context = { organizationId: org, view: input.view, anchorCustomerId: input.anchorCustomerId, limit: input.limit,
          sourceRevision: duplicateHmac(this.keys, 'CRM_DUPLICATE_SOURCE_KEYS:v1', index.sourceKeys) };
        const after = input.cursor ? decodeDuplicateCursor(input.cursor, context, this.keys) : null;
        const iterator = index.pairs({ anchorCustomerId: input.anchorCustomerId, after });
        const pairs: CustomerPair[] = [];
        for (let i = 0; i < Math.min(input.limit, DUPLICATE_LIMITS.pairs); i++) {
          const next = iterator.next(); if (next.done) break; pairs.push(next.value);
        }
        const exhausted = iterator.next().done === true;
        const facts = pairs.length ? await snapshot.facts(org, [...new Set(pairs.flatMap((pair) => [pair.customerAId, pair.customerBId]))]) : new Map<string, DuplicateCustomerFacts>();
        const items = pairs.map((pair) => {
          snapshot.checkpoint();
          const a = facts.get(pair.customerAId)!; const b = facts.get(pair.customerBId)!;
          let comparisonStatus: 'READY' | 'OVER_BUDGET' = 'READY';
          try { createDuplicateEvidence(org, a, b, this.keys); } catch (error) {
            if (!(error instanceof AppError) || error.code !== 'EVIDENCE_LIMIT_EXCEEDED') throw error;
            comparisonStatus = 'OVER_BUDGET';
          }
          return { pair, customerA: header(a), customerB: header(b), ...compareDuplicateFacts(a, b), comparisonStatus, review: virtualDuplicateReview() };
        });
        snapshot.checkpoint();
        return { scope: { dataClass: 'BUSINESS' as const, includesInactive: true as const, anchorCustomerId: input.anchorCustomerId },
          asOf: snapshot.asOf, matchingRuleVersion: DUPLICATE_RULE_VERSION, coverage: 'COMPLETE_SOURCE' as const,
          rawPairCount: index.pairCount(input.anchorCustomerId), largestNameGroupSize: index.largestNameGroupSize, largestPhoneGroupSize: index.largestPhoneGroupSize,
          items, page: { nextCursor: !exhausted && pairs.length ? encodeDuplicateCursor(context, pairs.at(-1)!, this.keys) : null,
            exhausted, evaluatedPairs: pairs.length, returnedItems: items.length } };
      });
    } finally {
      const remaining = this.inflight.get(org)! - 1;
      if (remaining) this.inflight.set(org, remaining); else this.inflight.delete(org);
    }
  }
  async comparison(actor: CrmActor, first: string, second: string) {
    management(actor);
    return this.repository.snapshot(async (snapshot) => {
      const pair = { customerAId: first < second ? first : second, customerBId: first < second ? second : first };
      const facts = await snapshot.facts(actor.organizationId, [pair.customerAId, pair.customerBId]);
      const a = facts.get(pair.customerAId); const b = facts.get(pair.customerBId);
      if (!a || !b) return notFound();
      const match = compareDuplicateFacts(a, b);
      if (!match.matchingCodes.length) return notFound();
      const revision = createDuplicateEvidence(actor.organizationId, a, b, this.keys);
      snapshot.checkpoint();
      return { pair, asOf: snapshot.asOf, customerA: publicCustomer(a), customerB: publicCustomer(b),
        evidence: { revision, schemaVersion: 1, matchingRuleVersion: DUPLICATE_RULE_VERSION, ...match }, review: virtualDuplicateReview(), allowedActions: [] };
    });
  }
}
