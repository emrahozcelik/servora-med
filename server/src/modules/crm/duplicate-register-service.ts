import { AppError } from '../../errors/index.js';
import { decodeRegisterCursor, encodeRegisterCursor, type DuplicateRegisterCursorContext } from './duplicate-register-cursor.js';
import {
  duplicateRegisterItem, duplicateRegisterNeedsAttention,
  type DuplicateReviewRegisterItem, type DuplicateReviewRegisterPage,
} from './duplicate-register.js';
import type { DuplicateKeyring } from './duplicate-evidence.js';
import { PostgresDuplicateReadRepository } from './duplicate-repository.js';
import { DUPLICATE_LIMITS, DUPLICATE_RULE_VERSION, type DuplicateCustomerFacts } from './duplicate-types.js';
import type { CrmActor } from './types.js';

export type DuplicateRegisterInput = { view: 'ALL' | 'ATTENTION'; cursor: string | null; limit: number };

const management = (actor: CrmActor) => {
  if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') {
    throw new AppError('FORBIDDEN', 403, 'Bu ekranı yalnız yöneticiler kullanabilir.');
  }
};

/**
 * Persistent review register: reads bounded review heads by canonical pair and
 * never scans the global customer candidate space. Historical pairs stay
 * reachable even when they no longer match or their source disappeared.
 */
export class DuplicateRegisterService {
  constructor(private readonly repository: PostgresDuplicateReadRepository, private readonly keys: DuplicateKeyring) {}

  async register(actor: CrmActor, input: DuplicateRegisterInput): Promise<DuplicateReviewRegisterPage> {
    management(actor);
    const organizationId = actor.organizationId;
    return this.repository.snapshot(async (snapshot) => {
      const context: DuplicateRegisterCursorContext = { organizationId, view: input.view, limit: input.limit };
      const after = input.cursor ? decodeRegisterCursor(input.cursor, context, this.keys) : null;
      const heads = await snapshot.registerHeads(organizationId, after, DUPLICATE_LIMITS.pairs + 1);
      const hasMoreHeads = heads.length > DUPLICATE_LIMITS.pairs;
      const consumed = hasMoreHeads ? heads.slice(0, DUPLICATE_LIMITS.pairs) : heads;

      const ids = [...new Set(consumed.flatMap(({ pair }) => [pair.customerAId, pair.customerBId]))];
      const facts = ids.length
        ? await snapshot.facts(organizationId, ids)
        : new Map<string, DuplicateCustomerFacts>();

      const items: DuplicateReviewRegisterItem[] = [];
      let evaluatedReviews = 0;
      let lastConsumed: { customerAId: string; customerBId: string } | null = null;
      for (const entry of consumed) {
        if (items.length >= input.limit) break;
        snapshot.checkpoint();
        evaluatedReviews += 1;
        lastConsumed = entry.pair;
        const item = duplicateRegisterItem({
          organizationId,
          pair: entry.pair,
          head: entry.head,
          customerA: facts.get(entry.pair.customerAId) ?? null,
          customerB: facts.get(entry.pair.customerBId) ?? null,
          keyring: this.keys,
        });
        if (input.view === 'ATTENTION' && !duplicateRegisterNeedsAttention(item)) continue;
        items.push(item);
      }

      const exhausted = !hasMoreHeads && evaluatedReviews === consumed.length;
      snapshot.checkpoint();
      return {
        asOf: snapshot.asOf,
        matchingRuleVersion: DUPLICATE_RULE_VERSION,
        items,
        page: {
          nextCursor: exhausted || !lastConsumed ? null : encodeRegisterCursor(context, lastConsumed, this.keys),
          exhausted,
          evaluatedReviews,
          returnedItems: items.length,
        },
      };
    });
  }
}
