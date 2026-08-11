import type {
  DeliveryPurpose,
  PersistedJobCardListItem,
  MeetingOutcome,
} from '../job-cards/types.js';

export type RequestedReportRange = Readonly<{ from: string; to: string }> | null;
export type ResolvedReportRange = Readonly<{
  from: string;
  to: string;
  timezone: string;
}>;

export type StaffOperationalCounters = Readonly<{
  openJobCards: number;
  waitingApproval: number;
  revisionRequested: number;
  overdueJobCards: number;
  completedInPeriod: number;
}>;

export type StaffOperationalSummary = Readonly<{
  staffUserId: string;
  range: ResolvedReportRange;
  counters: StaffOperationalCounters;
}>;

export type StaffOperationalSummaryScope = Readonly<{
  organizationId: string;
  requestedRange: RequestedReportRange;
  requestTime: Date;
}>;

export type StaffOperationalSummaryOneInput = StaffOperationalSummaryScope
  & Readonly<{ staffUserId: string }>;
export type StaffOperationalSummaryManyInput = StaffOperationalSummaryScope
  & Readonly<{ staffUserIds: readonly string[] }>;

export type StaffCurrentWorkload = Readonly<{
  openJobCards: number;
  overdueJobCards: number;
  waitingApproval: number;
  revisionRequested: number;
}>;

export type StaffHistoricalPerformance = Readonly<{
  completedJobs: number;
  completionDays: number;
  jobsPerCompletionDay: number;
  correctionRequestEvents: number;
  authoredOperationalNotes: number;
}>;

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
  staff: {
    userId: string;
    name: string;
    isActive: boolean;
  };
  unit: string | null;
  quantity: string;
};

export type DeliveryReportResponse =
  | {
      groupBy: 'day';
      items: DeliveryDayItem[];
      range: ResolvedReportRange;
      total: number;
      limit: number;
      offset: number;
    }
  | {
      groupBy: 'purpose';
      items: DeliveryPurposeItem[];
      range: ResolvedReportRange;
      total: number;
      limit: number;
      offset: number;
    }
  | {
      groupBy: 'product';
      items: DeliveryProductItem[];
      range: ResolvedReportRange;
      total: number;
      limit: number;
      offset: number;
    }
  | {
      groupBy: 'staff';
      items: DeliveryStaffItem[];
      range: ResolvedReportRange;
      total: number;
      limit: number;
      offset: number;
    };

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
};

export type ReportStaffIdentity = {
  userId: string;
  name: string;
  isActive: boolean;
};

export type ReportStaffLifecycleIdentity = ReportStaffIdentity & Readonly<{
  createdAt: string;
}>;

export type StaffPerformanceScopeInput = StaffOperationalSummaryScope & Readonly<{
  includeInactive: boolean;
}>;

export type StaffPerformanceScope = Readonly<{
  range: ResolvedReportRange;
  staff: ReportStaffLifecycleIdentity[];
}>;

export type StaffCompletionPerformance = Readonly<{
  staffUserId: string;
  completionDays: number;
  completionWorkTypes: WorkTypeDistributionItem[];
}>;

export type StaffExecutionAggregate = Readonly<{
  staffUserId: string;
  staffCompletedJobs: number;
  staffCompletionDays: number;
  missingStaffCompletionTimestamp: number;
}>;

export type StaffExecutionMetrics = Readonly<{
  staffCompletedJobs: number;
  staffCompletionDays: number;
  jobsPerStaffCompletionDay: number;
  missingStaffCompletionTimestamp: number;
}>;

export type StaffOnTimeAggregate = Readonly<{
  staffUserId: string;
  eligibleScheduledCompletedJobs: number;
  onTimeCompletedJobs: number;
  lateCompletedJobs: number;
  ineligibleOrNoDeadlineCompletedJobs: number;
}>;

export type StaffOnTimeMetrics = Readonly<{
  eligibleScheduledCompletedJobs: number;
  onTimeCompletedJobs: number;
  lateCompletedJobs: number;
  ineligibleOrNoDeadlineCompletedJobs: number;
  onTimeRate: number | null;
}>;

/**
 * Availability is based only on the user's organization-local creation date:
 * true only when the user existed from the start of the prior range
 * (created on or before priorRange.from). A user created after the prior start
 * does not get a full equal-length prior comparison; this is not a fabricated
 * zero. Historical deactivation is not inferred, and an available all-zero
 * performance is valid data.
 */
export type StaffPriorPerformance = Readonly<{
  available: boolean;
  performance: StaffHistoricalPerformance | null;
}>;

export type StaffPerformanceItem = Readonly<{
  staff: ReportStaffIdentity;
  performance: StaffHistoricalPerformance;
  priorPerformance: StaffPriorPerformance;
  staffExecution: StaffExecutionMetrics;
  onTime: StaffOnTimeMetrics;
  completionWorkTypes: WorkTypeDistributionItem[];
  currentWorkload: StaffCurrentWorkload;
}>;

export type StaffPerformanceResponse = Readonly<{
  range: ResolvedReportRange;
  priorRange: ResolvedReportRange;
  items: StaffPerformanceItem[];
}>;

export type MeetingOutcomeItem = {
  outcome: MeetingOutcome;
  count: number;
};

export type StaffReportResponse = {
  staff: ReportStaffIdentity;
  range: ResolvedReportRange;
  priorRange: ResolvedReportRange;
  performance: StaffHistoricalPerformance;
  priorPerformance: StaffPriorPerformance;
  staffExecution: StaffExecutionMetrics;
  onTime: StaffOnTimeMetrics;
  completionWorkTypes: WorkTypeDistributionItem[];
  completedTrend: Array<{ date: string; count: number }>;
  deliveriesByPurpose: DeliveryPurposeItem[];
  meetingsByOutcome: MeetingOutcomeItem[];
  currentWorkload: StaffCurrentWorkload;
};

export type ReportRangeQuery = { requestedRange: RequestedReportRange };
export type DeliveryReportQuery = ReportRangeQuery & {
  groupBy: 'day' | 'purpose' | 'product' | 'staff';
  staffUserId: string | null;
  limit: number;
  offset: number;
};
export type ApprovalReportQuery = { limit: number; offset: number };
export type DeliveryReportReadInput = StaffOperationalSummaryScope
  & Omit<DeliveryReportQuery, 'requestedRange'>;

export type WorkTypeDistributionItem = Readonly<{
  type: string;
  count: number;
}>;

export type WorkTypeDistributionInput = Readonly<{
  organizationId: string;
  from: string;
  to: string;
  staffUserId: string | null;
  managerUserId?: string;
}>;
