import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import type { ReportReadSnapshot, ReportsReadModel } from './ports.js';
import { precedingEqualLengthRange, staffExistedDuringPriorRange } from './range.js';
import { LATENESS_TRACKING_STARTED_ON } from './types.js';
import type {
  ApprovalReportQuery,
  CustomerReportQuery,
  DeliveryReportQuery,
  LatenessDurationStats,
  LatenessGroupCounts,
  LatenessOpenStats,
  OrganizationLatenessAggregate,
  OrganizationLatenessSummary,
  ReportRangeQuery,
  SalesFollowUpReportQuery,
  StaffCompletionPerformance,
  StaffCurrentWorkload,
  StaffExecutionAggregate,
  StaffExecutionMetrics,
  StaffHistoricalPerformance,
  StaffLatenessAggregate,
  StaffLatenessIncidentListResponse,
  StaffLatenessIncidentQuery,
  StaffLatenessSummary,
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
  const total = summary.currentWorkloadByType.reduce((sum, item) => sum + item.count, 0)
    + summary.weeklyReportWorkload;
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

function assertLatenessGroup(group: LatenessGroupCounts, label: string) {
  if (!Number.isInteger(group.delayedJobCount)
    || !Number.isInteger(group.incidentCount)
    || group.delayedJobCount < 0
    || group.incidentCount < 0
    || group.delayedJobCount > group.incidentCount
    || (group.delayedJobCount === 0) !== (group.incidentCount === 0)) {
    throw new Error(`Lateness ${label} group invariant could not be resolved.`);
  }
}

function assertDurationStats(stats: LatenessDurationStats, label: string) {
  const empty = stats.count === 0;
  if (!Number.isInteger(stats.count)
    || stats.count < 0
    || empty !== (stats.medianSeconds === null)
    || empty !== (stats.maxSeconds === null)
    || (stats.medianSeconds !== null
      && (!Number.isInteger(stats.medianSeconds) || stats.medianSeconds < 0))
    || (stats.maxSeconds !== null
      && (!Number.isInteger(stats.maxSeconds) || stats.maxSeconds < 0))
    || (stats.medianSeconds !== null && stats.maxSeconds !== null
      && stats.medianSeconds > stats.maxSeconds)) {
    throw new Error(`Lateness ${label} duration invariant could not be resolved.`);
  }
}

function assertOpenStats(stats: LatenessOpenStats, label: string) {
  if (!Number.isInteger(stats.count)
    || stats.count < 0
    || (stats.count === 0) !== (stats.maxElapsedSeconds === null)
    || (stats.maxElapsedSeconds !== null
      && (!Number.isInteger(stats.maxElapsedSeconds) || stats.maxElapsedSeconds < 0))) {
    throw new Error(`Lateness ${label} open duration invariant could not be resolved.`);
  }
}

function staffLatenessSummary(
  aggregate: StaffLatenessAggregate,
  requestTime: Date,
): StaffLatenessSummary {
  const responsibility = aggregate.staffResponsibility;
  const operational = aggregate.operational;
  assertLatenessGroup(responsibility, 'Staff responsibility');
  assertLatenessGroup(operational, 'Staff operational');
  if (responsibility.byType.length !== 2
    || responsibility.byType[0]?.delayType !== 'LATE_START'
    || responsibility.byType[1]?.delayType !== 'LATE_SUBMISSION') {
    throw new Error('Staff lateness type breakdown invariant could not be resolved.');
  }
  const typeIncidents = responsibility.byType
    .reduce((total, type) => total + type.incidentCount, 0);
  if (typeIncidents !== responsibility.incidentCount) {
    throw new Error('Staff lateness type incident invariant could not be resolved.');
  }
  responsibility.byType.forEach((type) => {
    const label = type.delayType;
    if (!Number.isInteger(type.incidentCount) || type.incidentCount < 0
      || type.incidentCount
        !== type.recovered.count + type.extended.count + type.open.count) {
      throw new Error(`Lateness ${label} outcome invariant could not be resolved.`);
    }
    assertDurationStats(type.recovered, `${label} recovered`);
    assertDurationStats(type.extended, `${label} extended`);
    assertOpenStats(type.open, `${label} open`);
  });
  if (!Number.isInteger(operational.incidentCount) || operational.incidentCount < 0
    || operational.byReason.some((reason) => !Number.isInteger(reason.incidentCount)
      || reason.incidentCount <= 0)
    || operational.byReason.reduce(
      (total, reason) => total + reason.incidentCount,
      0,
    ) !== operational.incidentCount) {
    throw new Error('Lateness operational reason invariant could not be resolved.');
  }
  return {
    trackingStartedOn: LATENESS_TRACKING_STARTED_ON,
    generatedAt: requestTime.toISOString(),
    staffResponsibility: responsibility,
    operational,
  };
}

function organizationLatenessSummary(
  aggregate: OrganizationLatenessAggregate,
  requestTime: Date,
): OrganizationLatenessSummary {
  assertLatenessGroup(aggregate.staffResponsibility, 'organization Staff responsibility');
  assertLatenessGroup(aggregate.operational, 'organization operational');
  assertLatenessGroup(aggregate.unknownAccountability, 'organization unknown');
  assertLatenessGroup(aggregate.managementApprovalWait, 'organization management approval wait');
  assertDurationStats(aggregate.managementApprovalWait.recovered, 'management recovered');
  assertOpenStats(aggregate.managementApprovalWait.open, 'management open');
  // APPROVAL_WAIT is never ended by OVR-5 (only LATE_START / LATE_SUBMISSION
  // can be), so every management incident is either recovered or open.
  if (aggregate.managementApprovalWait.recovered.count + aggregate.managementApprovalWait.open.count
    !== aggregate.managementApprovalWait.incidentCount) {
    throw new Error('Organization lateness management outcome invariant could not be resolved.');
  }
  if (!Number.isInteger(aggregate.totalIncidentCount) || aggregate.totalIncidentCount < 0) {
    throw new Error('Organization lateness total invariant could not be resolved.');
  }
  const classified = aggregate.staffResponsibility.incidentCount
    + aggregate.operational.incidentCount
    + aggregate.unknownAccountability.incidentCount
    + aggregate.managementApprovalWait.incidentCount;
  if (classified !== aggregate.totalIncidentCount) {
    throw new Error('Organization lateness reconciliation invariant could not be resolved.');
  }
  return {
    ...aggregate,
    trackingStartedOn: LATENESS_TRACKING_STARTED_ON,
    generatedAt: requestTime.toISOString(),
  };
}

export class ReportsService {
  constructor(
    private readonly reports: ReportsReadModel,
    private readonly readSnapshot: ReportReadSnapshot,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async dashboard(actor: SafeUser, query: ReportRangeQuery) {
    requireManagement(actor);
    return this.reports.getDashboard({
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
      requestTime: this.now(),
    });
  }

  async getBusinessTrend(actor: SafeUser, query: ReportRangeQuery) {
    requireManagement(actor);
    return this.reports.getBusinessTrend({
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
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
    return this.readSnapshot.run(async ({ reports }) => {
      const scopeInput = {
        organizationId: actor.organizationId,
        requestedRange: query.requestedRange,
        ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
        requestTime,
        includeInactive: true,
      };
      const scope = await reports.getStaffPerformanceScope(scopeInput);
      const priorRange = precedingEqualLengthRange(scope.range);
      if (scope.staff.length === 0) return { range: scope.range, priorRange, items: [] };

      const staffUserIds = scope.staff.map((staff) => staff.userId);
      const batchInput = {
        organizationId: actor.organizationId,
        requestedRange: query.requestedRange,
        ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
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
        reports.getMany(batchInput),
        reports.getStaffCompletionPerformanceMany(batchInput),
        reports.getStaffCorrectionRequestEventsMany(batchInput),
        reports.getStaffAuthoredOperationalNotesMany(batchInput),
        reports.getMany(priorBatchInput),
        reports.getStaffCompletionPerformanceMany(priorBatchInput),
        reports.getStaffCorrectionRequestEventsMany(priorBatchInput),
        reports.getStaffAuthoredOperationalNotesMany(priorBatchInput),
        reports.getStaffExecutionMany(batchInput),
        reports.getStaffOnTimeMany(batchInput),
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
    });
  }

  async getDeliveries(actor: SafeUser, query: DeliveryReportQuery) {
    requireManagement(actor);
    const requestTime = this.now();
    return this.readSnapshot.run(async ({ reports }) => {
      if (query.staffUserId !== null) {
        const identity = await reports.getStaffIdentity({
          organizationId: actor.organizationId,
          staffUserId: query.staffUserId,
        });
        if (!identity) throw staffProfileNotFound();
      }
      return reports.getDeliveryReport({
        organizationId: actor.organizationId,
        requestedRange: query.requestedRange,
        ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
        requestTime,
        groupBy: query.groupBy,
        staffUserId: query.staffUserId,
        limit: query.limit,
        offset: query.offset,
      });
    });
  }

  async getApprovals(actor: SafeUser, query: ApprovalReportQuery) {
    requireManagement(actor);
    const requestTime = this.now();
    return this.readSnapshot.run(async ({ reports, approvalItems }) => {
      const [summary, items] = await Promise.all([
        reports.getApprovalSummary({
          organizationId: actor.organizationId,
          requestTime,
          ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
        }),
        approvalItems.getApprovalItems({
          organizationId: actor.organizationId,
          requestTime,
          ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
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
    });
  }

  async getCustomers(actor: SafeUser, query: CustomerReportQuery) {
    requireManagement(actor);
    const requestTime = this.now();
    return this.readSnapshot.run(({ reports }) => reports.getCustomerReport({
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
      requestTime,
      search: query.search,
      status: query.status,
      customerType: query.customerType,
      limit: query.limit,
      offset: query.offset,
    }));
  }

  async getSalesFollowUp(actor: SafeUser, query: SalesFollowUpReportQuery) {
    requireManagement(actor);
    const requestTime = this.now();
    return this.readSnapshot.run(({ reports }) => reports.getSalesFollowUpReport({
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
      requestTime,
      limit: query.limit,
      offset: query.offset,
      proposalLimit: query.proposalLimit,
      proposalOffset: query.proposalOffset,
    }));
  }

  async getOrganizationLateness(
    actor: SafeUser,
    query: ReportRangeQuery,
  ): Promise<OrganizationLatenessSummary> {
    requireManagement(actor);
    const requestTime = this.now();
    return this.readSnapshot.run(async ({ reports }) => {
      const aggregate = await reports.getOrganizationLatenessSummary({
        organizationId: actor.organizationId,
        requestedRange: query.requestedRange,
        ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
        requestTime,
      });
      return organizationLatenessSummary(aggregate, requestTime);
    });
  }

  async listStaffLatenessIncidents(
    actor: SafeUser,
    staffUserId: string,
    query: StaffLatenessIncidentQuery,
  ): Promise<StaffLatenessIncidentListResponse> {
    requireManagement(actor);
    const requestTime = this.now();
    return this.readSnapshot.run(async ({ reports }) => {
      const identity = await reports.getStaffIdentity({
        organizationId: actor.organizationId,
        staffUserId,
      });
      if (!identity) throw staffProfileNotFound();
      return reports.listStaffLatenessIncidents({
        organizationId: actor.organizationId,
        staffUserId,
        requestedRange: query.requestedRange,
        ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
        requestTime,
        limit: query.limit,
        offset: query.offset,
        viewer: { role: actor.role, userId: actor.id },
      });
    });
  }

  async listOwnLatenessIncidents(
    actor: SafeUser,
    query: StaffLatenessIncidentQuery,
  ): Promise<StaffLatenessIncidentListResponse> {
    if (actor.role !== 'STAFF') throw forbidden();
    const requestTime = this.now();
    return this.readSnapshot.run(({ reports }) => reports.listStaffLatenessIncidents({
      organizationId: actor.organizationId,
      staffUserId: actor.id,
      requestedRange: query.requestedRange,
      ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
      requestTime,
      limit: query.limit,
      offset: query.offset,
      viewer: { role: actor.role, userId: actor.id },
    }));
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
      ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
      requestTime,
    };
    return this.readSnapshot.run(async ({ reports }) => {
      const [identity, summary] = await Promise.all([
        reports.getStaffIdentity({ organizationId, staffUserId }),
        reports.getOne(input),
      ]);
      if (!identity || !summary) throw staffProfileNotFound();
      const priorRange = precedingEqualLengthRange(summary.range);
      const batchInput = {
        organizationId,
        staffUserIds: [staffUserId],
        requestedRange: query.requestedRange,
        ...(query.includeSaleCapability !== undefined ? { includeSaleCapability: query.includeSaleCapability } : {}),
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
        latenessAggregate,
      ] = await Promise.all([
        reports.getStaffCompletionPerformanceMany(batchInput),
        reports.getStaffCorrectionRequestEventsMany(batchInput),
        reports.getStaffAuthoredOperationalNotesMany(batchInput),
        reports.getStaffDailyCompletionTrend(input),
        reports.getStaffDeliveriesByPurpose(input),
        reports.getStaffMeetingsByOutcome(input),
        reports.getMany(priorBatchInput),
        reports.getStaffCompletionPerformanceMany(priorBatchInput),
        reports.getStaffCorrectionRequestEventsMany(priorBatchInput),
        reports.getStaffAuthoredOperationalNotesMany(priorBatchInput),
        reports.getStaffExecutionMany(batchInput),
        reports.getStaffOnTimeMany(batchInput),
        reports.getStaffLatenessSummary(input),
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
        lateness: staffLatenessSummary(latenessAggregate, requestTime),
      };
    });
  }
}
