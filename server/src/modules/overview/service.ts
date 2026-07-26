import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import type { OverviewReadModel } from './repository.js';
import type { OverviewQuery } from './types.js';

const overviewUnavailable = () => new AppError(
  'NOT_FOUND',
  404,
  'Sayfa bulunamadı.',
);

export class OverviewService {
  constructor(
    private readonly enabled: boolean,
    private readonly repository: OverviewReadModel,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getOverview(actor: SafeUser, query: OverviewQuery) {
    if (!this.enabled) throw overviewUnavailable();
    const requestTime = this.now();
    return actor.role === 'STAFF'
      ? this.repository.getStaffOverview(actor, query, requestTime)
      : this.repository.getManagementOverview(actor, query, requestTime);
  }
}
