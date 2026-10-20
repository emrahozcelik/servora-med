import { AppError } from '../../errors/index.js';
import {
  duplicateDecisionRequestHash,
  duplicateReopenRequestHash,
  type DuplicateDecisionCommand,
  type DuplicateReopenCommand,
} from './duplicate-command.js';
import type { CustomerPair } from './duplicate-candidates.js';
import type { DuplicateHistoryPage } from './duplicate-review.js';
import type { PostgresDuplicateReviewRepository } from './duplicate-review-repository.js';
import type { CrmActor } from './types.js';

const management = (actor: CrmActor) => {
  if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') {
    throw new AppError('FORBIDDEN', 403, 'Bu ekranı yalnız yöneticiler kullanabilir.');
  }
};

function canonicalPair(first: string, second: string): CustomerPair {
  if (first === second) throw new AppError('VALIDATION_ERROR', 400, 'Aynı müşteri çift olarak incelenemez.');
  return first < second
    ? { customerAId: first, customerBId: second }
    : { customerAId: second, customerBId: first };
}

export class DuplicateReviewService {
  constructor(private readonly repository: PostgresDuplicateReviewRepository) {}

  decide(actor: CrmActor, first: string, second: string, command: DuplicateDecisionCommand) {
    management(actor);
    const pair = canonicalPair(first, second);
    return this.repository.decide(actor, pair, command, duplicateDecisionRequestHash(actor, pair, command));
  }

  reopen(actor: CrmActor, first: string, second: string, command: DuplicateReopenCommand) {
    management(actor);
    const pair = canonicalPair(first, second);
    return this.repository.reopen(actor, pair, command, duplicateReopenRequestHash(actor, pair, command));
  }

  history(actor: CrmActor, reviewId: string, cursor: string | null, limit: number): Promise<DuplicateHistoryPage> {
    management(actor);
    return this.repository.history(actor, reviewId, cursor, limit);
  }
}
