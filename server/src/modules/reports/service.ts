import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import type { ApprovalQueueItemPort, ReportsReadModel } from './ports.js';
import type {
  ApprovalReportQuery,
  DeliveryReportQuery,
  ReportRangeQuery,
  StaffReportResponse,
} from './types.js';

const forbidden = () => new AppError(
  'FORBIDDEN',
  403,
  'Bu işlem için yetkiniz yok.',
);

const staffProfileNotFound = () => new AppError(
  'STAFF_PROFILE_NOT_FOUND',
  404,
  'Personel profili bulunamadı.',
);

function requireManagement(actor: SafeUser) {
  if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') throw forbidden();
}

export class ReportsService {
  constructor(
    private readonly reports: ReportsReadModel,
    private readonly approvalItems: ApprovalQueueItemPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async dashboard(actor: SafeUser, query: ReportRangeQuery) {
    requireManagement(actor);
    return this.reports.getDashboard({
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      requestTime: this.now(),
    });
  }

  async getOwnStaffReport(actor: SafeUser, query: ReportRangeQuery) {
    if (actor.role !== 'STAFF') throw forbidden();
    return this.staffReport(actor.organizationId, actor.id, query, this.now());
  }

  async getStaffReport(
    actor: SafeUser,
    staffUserId: string,
    query: ReportRangeQuery,
  ) {
    requireManagement(actor);
    return this.staffReport(actor.organizationId, staffUserId, query, this.now());
  }

  async getDeliveries(actor: SafeUser, query: DeliveryReportQuery) {
    requireManagement(actor);
    const requestTime = this.now();
    if (query.staffUserId !== null) {
      const identity = await this.reports.getStaffIdentity({
        organizationId: actor.organizationId,
        staffUserId: query.staffUserId,
      });
      if (!identity) throw staffProfileNotFound();
    }
    return this.reports.getDeliveryReport({
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      requestTime,
      groupBy: query.groupBy,
      staffUserId: query.staffUserId,
      limit: query.limit,
      offset: query.offset,
    });
  }

  async getApprovals(actor: SafeUser, query: ApprovalReportQuery) {
    requireManagement(actor);
    const requestTime = this.now();
    const [summary, items] = await Promise.all([
      this.reports.getApprovalSummary({
        organizationId: actor.organizationId,
        requestTime,
      }),
      this.approvalItems.getApprovalItems({
        organizationId: actor.organizationId,
        requestTime,
        limit: query.limit,
        offset: query.offset,
      }),
    ]);
    return {
      summary,
      items,
      total: summary.pendingCount,
      limit: query.limit,
      offset: query.offset,
    };
  }

  private async staffReport(
    organizationId: string,
    staffUserId: string,
    query: ReportRangeQuery,
    requestTime: Date,
  ): Promise<StaffReportResponse> {
    const input = {
      organizationId,
      staffUserId,
      requestedRange: query.requestedRange,
      requestTime,
    };
    const [identity, summary, deliveriesByPurpose, meetingsByOutcome] = await Promise.all([
      this.reports.getStaffIdentity({ organizationId, staffUserId }),
      this.reports.getOne(input),
      this.reports.getStaffDeliveriesByPurpose(input),
      this.reports.getStaffMeetingsByOutcome(input),
    ]);
    if (!identity || !summary) throw staffProfileNotFound();
    return {
      staff: identity,
      range: summary.range,
      counters: summary.counters,
      deliveriesByPurpose,
      meetingsByOutcome,
    };
  }
}
