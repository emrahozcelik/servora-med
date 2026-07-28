import { AppError } from '../../errors/index.js';
import type { Pool } from 'pg';
import type { SafeUser } from '../auth/types.js';
import type { OverviewReadModel } from './repository.js';
import type {
  ManagementOverviewResponse,
  MessageUnreadSummary,
  OverviewQuery,
  WorkTypeDistributionItem,
} from './types.js';

const overviewUnavailable = () => new AppError(
  'NOT_FOUND',
  404,
  'Sayfa bulunamadı.',
);

export class OverviewService {
  constructor(
    private readonly enabled: boolean,
    private readonly repository: OverviewReadModel,
    private readonly pool?: Pool,
    private readonly now: () => Date = () => new Date(),
    private readonly calendarEnabled = false,
    private readonly messagingEnabled = false,
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

    let workTypeDistribution: WorkTypeDistributionItem[] | undefined;
    let messageUnreadSummary: MessageUnreadSummary | undefined;

    if (actor.role !== 'STAFF' && this.repository.getWorkTypeDistribution) {
      try {
        const detailedOverview = overview as Omit<ManagementOverviewResponse, 'upcomingWork' | 'messageUnreadSummary' | 'workTypeDistribution'>;
        workTypeDistribution = await this.repository.getWorkTypeDistribution(
          actor.organizationId,
          detailedOverview.range.from,
          detailedOverview.range.to,
          null,
          actor.role === 'MANAGER' ? actor.id : undefined,
        );
      } catch {
        workTypeDistribution = undefined;
      }
    }

    if (this.messagingEnabled && this.repository.getMessageUnreadSummary) {
      try {
        const summary = await this.repository.getMessageUnreadSummary(
          actor.organizationId,
          actor.id,
        );
        messageUnreadSummary = summary ?? undefined;
      } catch {
        messageUnreadSummary = undefined;
      }
    }

    return {...overview, upcomingWork, ...(actor.role !== 'STAFF' ? { workTypeDistribution } : {}), ...(this.messagingEnabled ? { messageUnreadSummary } : {})};
  }
}
