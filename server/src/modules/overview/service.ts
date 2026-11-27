import type { SafeUser } from '../auth/types.js';
import { assertModuleEnabled } from '../installation-modules/gate.js';
import {
  readModuleEnabledOrFalse,
  type ModuleStateLogger,
  type ModuleStateReader,
} from '../installation-modules/state.js';
import type { OverviewReadModel } from './repository.js';
import type { ReportsReadModel } from '../reports/ports.js';
import type { MessagingReadPort } from '../messaging/types.js';
import type {
  ManagementOverviewResponse,
  MessageUnreadSummary,
  OverviewQuery,
  WorkTypeDistributionItem,
} from './types.js';

export class OverviewService {
  constructor(
    private readonly moduleState: ModuleStateReader,
    private readonly repository: OverviewReadModel,
    private readonly reports?: ReportsReadModel,
    private readonly now: () => Date = () => new Date(),
    private readonly calendarEnabled = false,
    private readonly messagingRead?: MessagingReadPort,
  ) {}

  async getOverview(
    actor: SafeUser,
    query: OverviewQuery,
    logger: ModuleStateLogger = console,
  ) {
    await this.assertEnabled(logger);
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
          ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
        });
      } catch {
        workTypeDistribution = undefined;
      }
    }

    // Message unread summary owned by messaging module
    const messagingEnabled = await readModuleEnabledOrFalse(this.moduleState, 'MESSAGING', logger);
    if (messagingEnabled && this.messagingRead) {
      try {
        const unreadTotal = await this.messagingRead.getUnreadCount(
          actor.organizationId,
          actor.id,
          actor.role,
        );
        messageUnreadSummary = { unreadTotal };
      } catch {
        messageUnreadSummary = undefined;
      }
    }

    return {
      ...overview,
      upcomingWork,
      ...(actor.role !== 'STAFF' ? { workTypeDistribution } : {}),
      ...(messagingEnabled && messageUnreadSummary !== undefined ? { messageUnreadSummary } : {}),
    };
  }

  /**
   * Runtime module gate (MOD-002): disabled → the existing 404; a missing row
   * or a read failure → 503 (fail closed, no env fallback).
   */
  private async assertEnabled(logger: ModuleStateLogger): Promise<void> {
    await assertModuleEnabled(this.moduleState, 'OVERVIEW', logger);
  }
}
