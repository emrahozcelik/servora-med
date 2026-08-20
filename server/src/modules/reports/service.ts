import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import type { ApprovalQueueItemPort, ReportsReadModel } from './ports.js';
import { precedingEqualLengthRange, staffExistedDuringPriorRange } from './range.js';
import type {
  ApprovalReportQuery,
  CustomerReportQuery,
  DeliveryReportQuery,
  ReportRangeQuery,
  SalesFollowUpReportQuery,
  StaffCompletionPerformance,
  StaffCurrentWorkload,
  StaffExecutionAggregate,
  StaffExecutionMetrics,
  StaffHistoricalPerformance,
  StaffOnTimeAggregate,
  StaffOnTimeMetrics,
  StaffSubmissionAttributionMetrics,
  StaffOperationalSummary,
  ReportStaffLifecycleIdentity,
  ReportStaffIdentity,
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

function currentWorkloadByType(summary: StaffOperationalSummary) {
  const total = summary.currentWorkloadByType.reduce((sum, item) => sum + item.count, 0);
  const expected = summary.counters.openJobCards
    + summary.counters.waitingApproval
    + summary.counters.revisionRequested;
  if (total !== expected) {
    throw new Error('Staff current workload type aggregate invariant could not be resolved.');
  }
  return summary.currentWorkloadByType;
}

function completedWorkTypes(
  summary: StaffOperationalSummary,
  completion: StaffCompletionPerformance,
) {
  const total = completion.completionWorkTypes.reduce((sum, item) => sum + item.count, 0);
  if (total !== summary.counters.completedInPeriod) {
    throw new Error('Staff completion work type aggregate invariant could not be resolved.');
  }
  return completion.completionWorkTypes;
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

function publicStaffIdentity(staff: ReportStaffLifecycleIdentity): ReportStaffIdentity {
  return { userId: staff.userId, name: staff.name, isActive: staff.isActive };
}

function staffExecution(aggregate: StaffExecutionAggregate): StaffExecutionMetrics {
  const completed = aggregate.staffCompletedJobs;
  const days = aggregate.staffCompletionDays;
  if ((completed === 0) !== (days === 0) || days > completed) {
    throw new Error('Staff execution aggregate invariant could not be resolved.');
  }
  return {
    staffCompletedJobs: completed,
    staffCompletionDays: days,
    jobsPerStaffCompletionDay: days === 0
      ? 0
      : completed / days,
    missingStaffCompletionTimestamp: aggregate.missingStaffCompletionTimestamp,
  };
}

function staffSubmissionAttribution(
  aggregate: StaffExecutionAggregate,
): StaffSubmissionAttributionMetrics {
  const count = aggregate.recordedSubmissionCount;
  const days = aggregate.recordedSubmissionDays;
  if ((count === 0) !== (days === 0) || days > count) {
    throw new Error('Staff submission attribution aggregate invariant could not be resolved.');
  }
  return { recordedSubmissionCount: count, recordedSubmissionDays: days };
}

function onTime(aggregate: StaffOnTimeAggregate): StaffOnTimeMetrics {
  if (aggregate.eligibleScheduledCompletedJobs
    !== aggregate.onTimeCompletedJobs + aggregate.lateCompletedJobs) {
    throw new Error('Staff on-time aggregate invariant could not be resolved.');
  }
  return {
    eligibleScheduledCompletedJobs: aggregate.eligibleScheduledCompletedJobs,
    onTimeCompletedJobs: aggregate.onTimeCompletedJobs,
    lateCompletedJobs: aggregate.lateCompletedJobs,
    ineligibleOrNoDeadlineCompletedJobs: aggregate.ineligibleOrNoDeadlineCompletedJobs,
    onTimeRate: aggregate.eligibleScheduledCompletedJobs === 0
      ? null
      : aggregate.onTimeCompletedJobs / aggregate.eligibleScheduledCompletedJobs,
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
      includeInactive: true,
    };
    const scope = await this.reports.getStaffPerformanceScope(scopeInput);
    const priorRange = precedingEqualLengthRange(scope.range);
    if (scope.staff.length === 0) return { range: scope.range, priorRange, items: [] };

    const staffUserIds = scope.staff.map((staff) => staff.userId);
    const batchInput = {
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      requestTime,
      staffUserIds,
    };
    const priorBatchInput = {
      ...batchInput,
      requestedRange: { from: priorRange.from, to: priorRange.to },
    };
    const [
      summaries,
      completions,
      correctionEvents,
      authoredNotes,
      priorSummaries,
      priorCompletions,
      priorCorrectionEvents,
      priorAuthoredNotes,
      executionAggregates,
      onTimeAggregates,
    ] = await Promise.all([
      this.reports.getMany(batchInput),
      this.reports.getStaffCompletionPerformanceMany(batchInput),
      this.reports.getStaffCorrectionRequestEventsMany(batchInput),
      this.reports.getStaffAuthoredOperationalNotesMany(batchInput),
      this.reports.getMany(priorBatchInput),
      this.reports.getStaffCompletionPerformanceMany(priorBatchInput),
      this.reports.getStaffCorrectionRequestEventsMany(priorBatchInput),
      this.reports.getStaffAuthoredOperationalNotesMany(priorBatchInput),
      this.reports.getStaffExecutionMany(batchInput),
      this.reports.getStaffOnTimeMany(batchInput),
    ]);

    return {
      range: scope.range,
      priorRange,
      items: scope.staff.map((staff) => {
        const summary = summaries.get(staff.userId);
        const completion = completions.get(staff.userId);
        const priorSummary = priorSummaries.get(staff.userId);
        const priorCompletion = priorCompletions.get(staff.userId);
        const executionAggregate = executionAggregates.get(staff.userId);
        const onTimeAggregate = onTimeAggregates.get(staff.userId);
        if (!summary || !completion || !priorSummary || !priorCompletion
          || !executionAggregate || !onTimeAggregate) {
          throw new Error('Staff performance aggregate could not be resolved.');
        }
        const priorAvailable = staffExistedDuringPriorRange(staff.createdAt, priorRange);
        const selectedCompletionWorkTypes = completedWorkTypes(summary, completion);
        const selectedCurrentWorkloadByType = currentWorkloadByType(summary);
        if (priorAvailable) {
          completedWorkTypes(priorSummary, priorCompletion);
        }
        return {
          staff: publicStaffIdentity(staff),
          performance: historicalPerformance(
            summary,
            completion,
            correctionEvents.get(staff.userId) ?? 0,
            authoredNotes.get(staff.userId) ?? 0,
          ),
          priorPerformance: {
            available: priorAvailable,
            performance: priorAvailable
              ? historicalPerformance(
                  priorSummary,
                  priorCompletion,
                  priorCorrectionEvents.get(staff.userId) ?? 0,
                  priorAuthoredNotes.get(staff.userId) ?? 0,
                )
              : null,
          },
          staffExecution: staffExecution(executionAggregate),
          staffSubmissionAttribution: staffSubmissionAttribution(executionAggregate),
          onTime: onTime(onTimeAggregate),
          completionWorkTypes: selectedCompletionWorkTypes,
          currentWorkloadByType: selectedCurrentWorkloadByType,
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

  async getCustomers(actor: SafeUser, query: CustomerReportQuery) {
    requireManagement(actor);
    return this.reports.getCustomerReport({
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      requestTime: this.now(),
      search: query.search,
      status: query.status,
      customerType: query.customerType,
      limit: query.limit,
      offset: query.offset,
    });
  }

  async getSalesFollowUp(actor: SafeUser, query: SalesFollowUpReportQuery) {
    requireManagement(actor);
    return this.reports.getSalesFollowUpReport({
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      requestTime: this.now(),
      limit: query.limit,
      offset: query.offset,
    });
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
    const [identity, summary] = await Promise.all([
      this.reports.getStaffIdentity({ organizationId, staffUserId }),
      this.reports.getOne(input),
    ]);
    if (!identity || !summary) throw staffProfileNotFound();
    const priorRange = precedingEqualLengthRange(summary.range);
    const batchInput = {
      organizationId,
      staffUserIds: [staffUserId],
      requestedRange: query.requestedRange,
      requestTime,
    };
    const priorBatchInput = {
      ...batchInput,
      requestedRange: { from: priorRange.from, to: priorRange.to },
    };
    const [
      completions,
      correctionEvents,
      authoredNotes,
      completedTrend,
      deliveriesByPurpose,
      meetingsByOutcome,
      priorSummaries,
      priorCompletions,
      priorCorrectionEvents,
      priorAuthoredNotes,
      executionAggregates,
      onTimeAggregates,
    ] = await Promise.all([
      this.reports.getStaffCompletionPerformanceMany(batchInput),
      this.reports.getStaffCorrectionRequestEventsMany(batchInput),
      this.reports.getStaffAuthoredOperationalNotesMany(batchInput),
      this.reports.getStaffDailyCompletionTrend(input),
      this.reports.getStaffDeliveriesByPurpose(input),
      this.reports.getStaffMeetingsByOutcome(input),
      this.reports.getMany(priorBatchInput),
      this.reports.getStaffCompletionPerformanceMany(priorBatchInput),
      this.reports.getStaffCorrectionRequestEventsMany(priorBatchInput),
      this.reports.getStaffAuthoredOperationalNotesMany(priorBatchInput),
      this.reports.getStaffExecutionMany(batchInput),
      this.reports.getStaffOnTimeMany(batchInput),
    ]);
    const completion = completions.get(staffUserId);
    const priorSummary = priorSummaries.get(staffUserId);
    const priorCompletion = priorCompletions.get(staffUserId);
    const executionAggregate = executionAggregates.get(staffUserId);
    const onTimeAggregate = onTimeAggregates.get(staffUserId);
    if (!completion || !priorSummary || !priorCompletion
      || !executionAggregate || !onTimeAggregate) {
      throw new Error('Staff performance aggregate could not be resolved.');
    }
    const priorAvailable = staffExistedDuringPriorRange(identity.createdAt, priorRange);
    const selectedCompletionWorkTypes = completedWorkTypes(summary, completion);
    const selectedCurrentWorkloadByType = currentWorkloadByType(summary);
    if (priorAvailable) {
      completedWorkTypes(priorSummary, priorCompletion);
    }
    return {
      staff: publicStaffIdentity(identity),
      range: summary.range,
      priorRange,
      performance: historicalPerformance(
        summary,
        completion,
        correctionEvents.get(staffUserId) ?? 0,
        authoredNotes.get(staffUserId) ?? 0,
      ),
      priorPerformance: {
        available: priorAvailable,
        performance: priorAvailable
          ? historicalPerformance(
              priorSummary,
              priorCompletion,
              priorCorrectionEvents.get(staffUserId) ?? 0,
              priorAuthoredNotes.get(staffUserId) ?? 0,
            )
          : null,
      },
      staffExecution: staffExecution(executionAggregate),
      staffSubmissionAttribution: staffSubmissionAttribution(executionAggregate),
      onTime: onTime(onTimeAggregate),
      completionWorkTypes: selectedCompletionWorkTypes,
      currentWorkloadByType: selectedCurrentWorkloadByType,
      completedTrend,
      deliveriesByPurpose,
      meetingsByOutcome,
      currentWorkload: currentWorkload(summary),
    };
  }
}
