import type {
  DeliveryPurpose,
  JobCardStatus,
  JobCardType,
  MeetingOutcome,
  PersistedJobCardListItem,
} from '../jobs/jobs-api';

export type RequestedReportRange = { from: string; to: string } | null;
export type ResolvedReportRange = { from: string; to: string; timezone: string };

export type StaffCurrentWorkload = {
  openJobCards: number;
  overdueJobCards: number;
  waitingApproval: number;
  revisionRequested: number;
};

export type StaffHistoricalPerformance = {
  completedJobs: number;
  completionDays: number;
  jobsPerCompletionDay: number;
  correctionRequestEvents: number;
  authoredOperationalNotes: number;
};

export type StaffPriorPerformance = {
  available: boolean;
  performance: StaffHistoricalPerformance | null;
};

export type StaffExecutionMetrics = {
  staffCompletedJobs: number;
  staffCompletionDays: number;
  jobsPerStaffCompletionDay: number;
  missingStaffCompletionTimestamp: number;
};

export type StaffOnTimeMetrics = {
  eligibleScheduledCompletedJobs: number;
  onTimeCompletedJobs: number;
  lateCompletedJobs: number;
  ineligibleOrNoDeadlineCompletedJobs: number;
  onTimeRate: number | null;
};

export type CompletionWorkType = {
  type: JobCardType;
  count: number;
};

export type ActiveStatusDistributionItem = {
  status: JobCardStatus;
  count: number;
};

export type CreatedWorkTypeDistributionItem = {
  type: JobCardType;
  count: number;
};

export type DeliveryDayItem = {
  date: string;
  unit: string | null;
  quantity: string;
};

export type DeliveryPurposeItem = {
  purpose: DeliveryPurpose;
  unit: string | null;
  quantity: string;
};

export type DeliveryProductItem = {
  productId: string;
  productNameSnapshot: string;
  productSkuSnapshot: string | null;
  productModelSnapshot: string | null;
  unit: string | null;
  quantity: string;
};

export type DeliveryStaffItem = {
  staff: { userId: string; name: string; isActive: boolean };
  unit: string | null;
  quantity: string;
};

type DeliveryPage<TGroup extends string, TItem> = {
  groupBy: TGroup;
  items: TItem[];
  range: ResolvedReportRange;
  total: number;
  limit: number;
  offset: number;
};

export type DeliveryReportResponse =
  | DeliveryPage<'day', DeliveryDayItem>
  | DeliveryPage<'purpose', DeliveryPurposeItem>
  | DeliveryPage<'product', DeliveryProductItem>
  | DeliveryPage<'staff', DeliveryStaffItem>;

export type DashboardReportResponse = {
  range: ResolvedReportRange;
  counters: {
    activeJobCards: number;
    overdueJobCards: number;
    waitingApproval: number;
    revisionRequested: number;
    completedInPeriod: number;
    cancelledInPeriod: number;
  };
  completedTrend: Array<{ date: string; count: number }>;
  dailyCreatedTrend: Array<{ date: string; count: number }>;
  activeStatusDistribution: ActiveStatusDistributionItem[];
  createdWorkTypeDistribution: CreatedWorkTypeDistributionItem[];
};

export type StaffReportResponse = {
  staff: { userId: string; name: string; isActive: boolean };
  range: ResolvedReportRange;
  priorRange: ResolvedReportRange;
  performance: StaffHistoricalPerformance;
  priorPerformance: StaffPriorPerformance;
  staffExecution: StaffExecutionMetrics;
  onTime: StaffOnTimeMetrics;
  completionWorkTypes: CompletionWorkType[];
  completedTrend: Array<{ date: string; count: number }>;
  deliveriesByPurpose: DeliveryPurposeItem[];
  meetingsByOutcome: Array<{ outcome: MeetingOutcome; count: number }>;
  currentWorkload: StaffCurrentWorkload;
};

export type StaffPerformanceItem = {
  staff: { userId: string; name: string; isActive: boolean };
  performance: StaffHistoricalPerformance;
  priorPerformance: StaffPriorPerformance;
  staffExecution: StaffExecutionMetrics;
  onTime: StaffOnTimeMetrics;
  completionWorkTypes: CompletionWorkType[];
  currentWorkload: StaffCurrentWorkload;
};

export type StaffPerformanceResponse = {
  range: ResolvedReportRange;
  priorRange: ResolvedReportRange;
  items: StaffPerformanceItem[];
};

/** Approval queue rows reuse the persisted list projection, not actor-scoped commands. */
export type ApprovalItem = PersistedJobCardListItem & { waitingMinutes: number };
export type ApprovalSummary = {
  pendingCount: number;
  oldestWaitingMinutes: number | null;
  averageWaitingMinutes: number | null;
  under2Hours: number;
  between2And8Hours: number;
  between8And24Hours: number;
  over24Hours: number;
};
export type ApprovalReportResponse = {
  summary: ApprovalSummary;
  items: ApprovalItem[];
  total: number;
  limit: number;
  offset: number;
};

export type DeliveryReportRequest = {
  groupBy: DeliveryReportResponse['groupBy'];
  staffUserId: string | null;
  requestedRange: RequestedReportRange;
  limit?: number;
  offset?: number;
};
