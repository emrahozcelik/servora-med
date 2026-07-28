import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import type { OverviewReadModel } from './repository.js';
import type { ReportsReadModel } from '../reports/ports.js';
import type { MessagingReadPort } from '../messaging/types.js';
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
    private readonly reports?: ReportsReadModel,
    private readonly now: () => Date = () => new Date(),
    private readonly calendarEnabled = false,
    private readonly messagingEnabled = false,
    private readonly messagingRead?: MessagingReadPort,
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

    // Work-type distribution owned by reports module
    if (actor.role !== 'STAFF' && this.reports?.getWorkTypeDistribution) {
      try {
        const detailedOverview = overview as Omit<ManagementOverviewResponse, 'upcomingWork' | 'messageUnreadSummary' | 'workTypeDistribution'>;
        workTypeDistribution = await this.reports.getWorkTypeDistribution({
          organizationId: actor.organizationId,
          from: detailedOverview.range.from,
          to: detailedOverview.range.to,
          staffUserId: null,
          managerUserId: actor.role === 'MANAGER' ? actor.id : undefined,
        });
      } catch {
        workTypeDistribution = undefined;
      }
    }

    // Message unread summary owned by messaging module
    if (this.messagingEnabled && this.messagingRead) {
      try {
        const unreadTotal = await this.messagingRead.getUnreadCount(
          actor.organizationId,
          actor.id,
        );
        messageUnreadSummary = { unreadTotal };
      } catch {
        messageUnreadSummary = undefined;
      }
    }

    return {...overview, upcomingWork, ...(actor.role !== 'STAFF' ? { workTypeDistribution } : {}), ...(this.messagingEnabled ? { messageUnreadSummary } : {})};
  }
}
