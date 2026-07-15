import type {
  ApprovalItem,
  ApprovalSummary,
  DashboardReportResponse,
  DeliveryPurposeItem,
  DeliveryReportReadInput,
  DeliveryReportResponse,
  MeetingOutcomeItem,
  ReportStaffIdentity,
  StaffOperationalSummary,
  StaffOperationalSummaryManyInput,
  StaffOperationalSummaryOneInput,
  StaffOperationalSummaryScope,
} from './types.js';

export interface StaffOperationalSummaryPort {
  getOne(input: StaffOperationalSummaryOneInput): Promise<StaffOperationalSummary | null>;
  getMany(input: StaffOperationalSummaryManyInput):
    Promise<ReadonlyMap<string, StaffOperationalSummary>>;
}

export interface ReportsReadModel extends StaffOperationalSummaryPort {
  getDashboard(input: StaffOperationalSummaryScope): Promise<DashboardReportResponse>;
  getStaffIdentity(input: { organizationId: string; staffUserId: string }):
    Promise<ReportStaffIdentity | null>;
  getStaffDeliveriesByPurpose(input: StaffOperationalSummaryOneInput):
    Promise<DeliveryPurposeItem[]>;
  getStaffMeetingsByOutcome(input: StaffOperationalSummaryOneInput):
    Promise<MeetingOutcomeItem[]>;
  getDeliveryReport(input: DeliveryReportReadInput): Promise<DeliveryReportResponse>;
  getApprovalSummary(input: { organizationId: string; requestTime: Date }):
    Promise<ApprovalSummary>;
}

export interface ApprovalQueueItemPort {
  getApprovalItems(input: {
    organizationId: string;
    requestTime: Date;
    limit: number;
    offset: number;
  }): Promise<ApprovalItem[]>;
}
