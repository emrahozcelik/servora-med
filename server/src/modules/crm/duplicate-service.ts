import { AppError } from '../../errors/index.js';
import { createCandidateIndex, type CustomerPair } from './duplicate-candidates.js';
import { decodeDuplicateCursor, encodeDuplicateCursor } from './duplicate-cursor.js';
import { compareDuplicateFacts, createDuplicateEvidenceDetails, duplicateHmac, type DuplicateKeyring } from './duplicate-evidence.js';
import { projectDuplicateReview, type DuplicateReviewHead } from './duplicate-review.js';
import { duplicateUnavailable, PostgresDuplicateReadRepository } from './duplicate-repository.js';
import { DUPLICATE_LIMITS, DUPLICATE_RULE_VERSION, type DuplicateCustomerFacts } from './duplicate-types.js';
import type { CrmActor } from './types.js';

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
        const consumed: CustomerPair[] = [];
        let exhausted = false;
        for (let i = 0; i < DUPLICATE_LIMITS.pairs; i++) {
          const next = iterator.next();
          if (next.done) { exhausted = true; break; }
          consumed.push(next.value);
        }
        if (!exhausted) exhausted = iterator.next().done === true;
        const ids = [...new Set(consumed.flatMap((pair) => [pair.customerAId, pair.customerBId]))];
        const facts = ids.length ? await snapshot.facts(org, ids) : new Map<string, DuplicateCustomerFacts>();
        const heads = await snapshot.reviewHeads(org, consumed);
        const items: Array<Record<string, unknown>> = [];
        let evaluatedPairs = 0;
        for (const pair of consumed) {
          if (items.length >= input.limit) break;
          snapshot.checkpoint();
          const a = facts.get(pair.customerAId); const b = facts.get(pair.customerBId);
          if (!a || !b) throw duplicateUnavailable();
          const projected = this.project(org, a, b, heads.get(`${pair.customerAId}:${pair.customerBId}`) ?? null);
          evaluatedPairs++;
          if (input.view === 'ATTENTION' && projected.review.freshness === 'CURRENT'
            && (projected.review.effectiveStatus === 'CONFIRMED_DUPLICATE' || projected.review.effectiveStatus === 'DISMISSED')) continue;
          items.push({ pair, customerA: header(a), customerB: header(b), matchingCodes: projected.matchingCodes,
            warnings: projected.warnings, comparisonStatus: projected.comparisonStatus, review: projected.review });
        }
        exhausted = exhausted && evaluatedPairs === consumed.length;
        snapshot.checkpoint();
        return { scope: { dataClass: 'BUSINESS' as const, includesInactive: true as const, anchorCustomerId: input.anchorCustomerId },
          asOf: snapshot.asOf, matchingRuleVersion: DUPLICATE_RULE_VERSION, coverage: 'COMPLETE_SOURCE' as const,
          rawPairCount: index.pairCount(input.anchorCustomerId), largestNameGroupSize: index.largestNameGroupSize, largestPhoneGroupSize: index.largestPhoneGroupSize,
          items, page: { nextCursor: !exhausted && evaluatedPairs ? encodeDuplicateCursor(context, consumed[evaluatedPairs - 1]!, this.keys) : null,
            exhausted, evaluatedPairs, returnedItems: items.length } };
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
      const head = (await snapshot.reviewHeads(actor.organizationId, [pair])).get(`${pair.customerAId}:${pair.customerBId}`) ?? null;
      const match = compareDuplicateFacts(a, b);
      if (!head && !match.matchingCodes.length) return notFound();
      const projected = this.project(actor.organizationId, a, b, head);
      if (projected.comparisonStatus === 'OVER_BUDGET' || !projected.details) throw new AppError('EVIDENCE_LIMIT_EXCEEDED', 422, 'Karşılaştırma kanıtının bütünü okunamadı.');
      snapshot.checkpoint();
      return { pair, asOf: snapshot.asOf, customerA: publicCustomer(a), customerB: publicCustomer(b),
        evidence: { revision: projected.details.revision, schemaVersion: projected.details.schemaVersion, matchingRuleVersion: projected.details.matchingRuleVersion, matchingCodes: projected.matchingCodes, warnings: projected.warnings },
        review: projected.review, allowedActions: projected.allowedActions };
    });
  }

  private project(org: string, a: DuplicateCustomerFacts, b: DuplicateCustomerFacts, head: DuplicateReviewHead | null) {
    let details = null as ReturnType<typeof createDuplicateEvidenceDetails> | null;
    let overBudget = false;
    try { details = createDuplicateEvidenceDetails(org, a, b, this.keys); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'EVIDENCE_LIMIT_EXCEEDED') throw error;
      overBudget = true;
    }
    const projected = projectDuplicateReview({ head, current: details, keyring: this.keys, sourceAvailable: true, overBudget });
    return { ...projected, details, comparisonStatus: overBudget ? 'OVER_BUDGET' as const : 'READY' as const,
      matchingCodes: details?.matchingCodes ?? compareDuplicateFacts(a, b).matchingCodes,
      warnings: details?.warnings ?? compareDuplicateFacts(a, b).warnings };
  }
}
