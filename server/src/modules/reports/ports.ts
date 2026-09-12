import type { SqlExecutor } from '../../db/executor.js';
import type {
  ApprovalItem,
  ApprovalSummary,
  CustomerReportReadInput,
  CustomerReportResponse,
  DashboardReportResponse,
  DeliveryPurposeItem,
  DeliveryReportReadInput,
  DeliveryReportResponse,
  MeetingOutcomeItem,
  ReportStaffLifecycleIdentity,
  StaffCompletionPerformance,
  StaffExecutionAggregate,
  StaffOnTimeAggregate,
  StaffOperationalSummary,
  StaffOperationalSummaryManyInput,
  StaffOperationalSummaryOneInput,
  StaffOperationalSummaryScope,
  StaffPerformanceScope,
  StaffPerformanceScopeInput,
  SalesFollowUpReportReadInput,
  SalesFollowUpReportResponse,
  WorkTypeDistributionInput,
  WorkTypeDistributionItem,
} from './types.js';

export interface StaffOperationalSummaryPort {
  getOne(input: StaffOperationalSummaryOneInput): Promise<StaffOperationalSummary | null>;
  getMany(input: StaffOperationalSummaryManyInput):
    Promise<ReadonlyMap<string, StaffOperationalSummary>>;
}

export interface ReportsReadModel extends StaffOperationalSummaryPort {
  getDashboard(input: StaffOperationalSummaryScope): Promise<DashboardReportResponse>;
  getStaffPerformanceScope(input: StaffPerformanceScopeInput): Promise<StaffPerformanceScope>;
  getStaffCompletionPerformanceMany(input: StaffOperationalSummaryManyInput):
    Promise<ReadonlyMap<string, StaffCompletionPerformance>>;
  getStaffExecutionMany(input: StaffOperationalSummaryManyInput):
    Promise<ReadonlyMap<string, StaffExecutionAggregate>>;
  getStaffOnTimeMany(input: StaffOperationalSummaryManyInput):
    Promise<ReadonlyMap<string, StaffOnTimeAggregate>>;
  getStaffCorrectionRequestEventsMany(input: StaffOperationalSummaryManyInput):
    Promise<ReadonlyMap<string, number>>;
  getStaffAuthoredOperationalNotesMany(input: StaffOperationalSummaryManyInput):
    Promise<ReadonlyMap<string, number>>;
  getStaffDailyCompletionTrend(input: StaffOperationalSummaryOneInput):
    Promise<Array<{ date: string; count: number }>>;
  getStaffIdentity(input: { organizationId: string; staffUserId: string }):
    Promise<ReportStaffLifecycleIdentity | null>;
  getStaffDeliveriesByPurpose(input: StaffOperationalSummaryOneInput):
    Promise<DeliveryPurposeItem[]>;
  getStaffMeetingsByOutcome(input: StaffOperationalSummaryOneInput):
    Promise<MeetingOutcomeItem[]>;
  getDeliveryReport(input: DeliveryReportReadInput): Promise<DeliveryReportResponse>;
  getApprovalSummary(input: { organizationId: string; requestTime: Date }):
    Promise<ApprovalSummary>;
  getWorkTypeDistribution(input: WorkTypeDistributionInput):
    Promise<WorkTypeDistributionItem[]>;
  getCustomerReport(input: CustomerReportReadInput): Promise<CustomerReportResponse>;
  getSalesFollowUpReport(input: SalesFollowUpReportReadInput):
    Promise<SalesFollowUpReportResponse>;
}

export interface ApprovalQueueItemPort {
  getApprovalItems(input: {
    organizationId: string;
    requestTime: Date;
    limit: number;
    offset: number;
  }): Promise<ApprovalItem[]>;
  /**
   * Returns an equivalent port whose reads execute on the supplied executor
   * instead of a pooled connection, so approval items can join the same
   * request-scoped snapshot as the reports read model.
   */
  bindTo(executor: SqlExecutor): ApprovalQueueItemPort;
}

/** The read ports that a single report response is composed from. */
export type ReportReaders = {
  reports: ReportsReadModel;
  approvalItems: ApprovalQueueItemPort;
};

/**
 * Runs a report composition against one database snapshot. Every read the
 * callback performs on the supplied readers observes the same committed state,
 * so a response can never mix aggregates from different points in time.
 */
export interface ReportReadSnapshot {
  run<T>(work: (readers: ReportReaders) => Promise<T>): Promise<T>;
}
