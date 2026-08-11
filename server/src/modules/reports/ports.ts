import type {
  ApprovalItem,
  ApprovalSummary,
  DashboardReportResponse,
  DeliveryPurposeItem,
  DeliveryReportReadInput,
  DeliveryReportResponse,
  MeetingOutcomeItem,
  ReportStaffIdentity,
  StaffCompletionPerformance,
  StaffOperationalSummary,
  StaffOperationalSummaryManyInput,
  StaffOperationalSummaryOneInput,
  StaffOperationalSummaryScope,
  StaffPerformanceScope,
  StaffPerformanceScopeInput,
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
  getStaffCorrectionRequestEventsMany(input: StaffOperationalSummaryManyInput):
    Promise<ReadonlyMap<string, number>>;
  getStaffAuthoredOperationalNotesMany(input: StaffOperationalSummaryManyInput):
    Promise<ReadonlyMap<string, number>>;
  getStaffDailyCompletionTrend(input: StaffOperationalSummaryOneInput):
    Promise<Array<{ date: string; count: number }>>;
  getStaffIdentity(input: { organizationId: string; staffUserId: string }):
    Promise<ReportStaffIdentity | null>;
  getStaffDeliveriesByPurpose(input: StaffOperationalSummaryOneInput):
    Promise<DeliveryPurposeItem[]>;
  getStaffMeetingsByOutcome(input: StaffOperationalSummaryOneInput):
    Promise<MeetingOutcomeItem[]>;
  getDeliveryReport(input: DeliveryReportReadInput): Promise<DeliveryReportResponse>;
  getApprovalSummary(input: { organizationId: string; requestTime: Date }):
    Promise<ApprovalSummary>;
  getWorkTypeDistribution(input: WorkTypeDistributionInput):
    Promise<WorkTypeDistributionItem[]>;
}

export interface ApprovalQueueItemPort {
  getApprovalItems(input: {
    organizationId: string;
    requestTime: Date;
    limit: number;
    offset: number;
  }): Promise<ApprovalItem[]>;
}
