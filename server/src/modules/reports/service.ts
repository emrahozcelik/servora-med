import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import type { ApprovalQueueItemPort, ReportsReadModel } from './ports.js';
import type {
  ApprovalReportQuery,
  DeliveryReportQuery,
  ReportRangeQuery,
  StaffCompletionPerformance,
  StaffCurrentWorkload,
  StaffHistoricalPerformance,
  StaffOperationalSummary,
  StaffPerformanceResponse,
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

function currentWorkload(summary: StaffOperationalSummary): StaffCurrentWorkload {
  return {
    openJobCards: summary.counters.openJobCards,
    overdueJobCards: summary.counters.overdueJobCards,
    waitingApproval: summary.counters.waitingApproval,
    revisionRequested: summary.counters.revisionRequested,
  };
}

function historicalPerformance(
  summary: StaffOperationalSummary,
  completion: StaffCompletionPerformance,
  correctionRequestEvents: number,
  authoredOperationalNotes: number,
): StaffHistoricalPerformance {
  const completedJobs = summary.counters.completedInPeriod;
  return {
    completedJobs,
    completionDays: completion.completionDays,
    jobsPerCompletionDay: completion.completionDays === 0
      ? 0
      : completedJobs / completion.completionDays,
    correctionRequestEvents,
    authoredOperationalNotes,
  };
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

  async getStaffPerformance(
    actor: SafeUser,
    query: ReportRangeQuery,
  ): Promise<StaffPerformanceResponse> {
    requireManagement(actor);
    const requestTime = this.now();
    const scopeInput = {
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      requestTime,
      includeInactive: actor.role === 'ADMIN',
    };
    const scope = await this.reports.getStaffPerformanceScope(scopeInput);
    if (scope.staff.length === 0) return { range: scope.range, items: [] };

    const staffUserIds = scope.staff.map((staff) => staff.userId);
    const batchInput = {
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      requestTime,
      staffUserIds,
    };
    const [summaries, completions, correctionEvents, authoredNotes] = await Promise.all([
      this.reports.getMany(batchInput),
      this.reports.getStaffCompletionPerformanceMany(batchInput),
      this.reports.getStaffCorrectionRequestEventsMany(batchInput),
      this.reports.getStaffAuthoredOperationalNotesMany(batchInput),
    ]);

    return {
      range: scope.range,
      items: scope.staff.map((staff) => {
        const summary = summaries.get(staff.userId);
        const completion = completions.get(staff.userId);
        if (!summary || !completion) {
          throw new Error('Staff performance aggregate could not be resolved.');
        }
        return {
          staff,
          performance: historicalPerformance(
            summary,
            completion,
            correctionEvents.get(staff.userId) ?? 0,
            authoredNotes.get(staff.userId) ?? 0,
          ),
          completionWorkTypes: completion.completionWorkTypes,
          currentWorkload: currentWorkload(summary),
        };
      }),
    };
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
    const batchInput = {
      organizationId,
      staffUserIds: [staffUserId],
      requestedRange: query.requestedRange,
      requestTime,
    };
    const [
      identity,
      summary,
      completions,
      correctionEvents,
      authoredNotes,
      completedTrend,
      deliveriesByPurpose,
      meetingsByOutcome,
    ] = await Promise.all([
      this.reports.getStaffIdentity({ organizationId, staffUserId }),
      this.reports.getOne(input),
      this.reports.getStaffCompletionPerformanceMany(batchInput),
      this.reports.getStaffCorrectionRequestEventsMany(batchInput),
      this.reports.getStaffAuthoredOperationalNotesMany(batchInput),
      this.reports.getStaffDailyCompletionTrend(input),
      this.reports.getStaffDeliveriesByPurpose(input),
      this.reports.getStaffMeetingsByOutcome(input),
    ]);
    if (!identity || !summary) throw staffProfileNotFound();
    const completion = completions.get(staffUserId);
    if (!completion) throw new Error('Staff completion performance could not be resolved.');
    return {
      staff: identity,
      range: summary.range,
      performance: historicalPerformance(
        summary,
        completion,
        correctionEvents.get(staffUserId) ?? 0,
        authoredNotes.get(staffUserId) ?? 0,
      ),
      completionWorkTypes: completion.completionWorkTypes,
      completedTrend,
      deliveriesByPurpose,
      meetingsByOutcome,
      currentWorkload: currentWorkload(summary),
    };
  }
}
