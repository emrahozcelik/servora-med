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
    private readonly calendarEnabled = false,
  ) {}

  async getOverview(actor: SafeUser, query: OverviewQuery) {
    if (!this.enabled) throw overviewUnavailable();
    const requestTime = this.now();
    const overview = await (actor.role === 'STAFF'
      ? this.repository.getStaffOverview(actor, query, requestTime)
      : this.repository.getManagementOverview(actor, query, requestTime));
    const upcomingWork = this.calendarEnabled
      ? await this.repository.getUpcomingWork!(actor, requestTime)
      : null;
    return { ...overview, upcomingWork };
  }
}
