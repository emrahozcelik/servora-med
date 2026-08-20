import type { Customer } from '../crm/types.js';
import type {
  DeliveryPurpose,
  FollowUpProposalOrigin,
  JobCardStatus,
  JobCardType,
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
  /** Current snapshot buckets; selected range never changes these counts. */
  currentWorkloadByType: WorkTypeDistributionItem[];
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
  /** Manager-approved completions currently associated with the Staff member. */
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
  dailyCreatedTrend: Array<{ date: string; count: number }>;
  activeStatusDistribution: Array<{ status: JobCardStatus; count: number }>;
  createdWorkTypeDistribution: WorkTypeDistributionItem[];
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
  /** Current recorded staff_completed_by/staff_completed_at attribution. */
  recordedSubmissionCount: number;
  recordedSubmissionDays: number;
}>;

export type StaffExecutionMetrics = Readonly<{
  /** Legacy current-assignee Staff execution cohort, not actor attribution. */
  staffCompletedJobs: number;
  staffCompletionDays: number;
  jobsPerStaffCompletionDay: number;
  missingStaffCompletionTimestamp: number;
}>;

/**
 * A current recorded submission attribution, not an immutable event history.
 * JobCard lifecycle fields may be overwritten on a later submission.
 */
export type StaffSubmissionAttributionMetrics = Readonly<{
  recordedSubmissionCount: number;
  recordedSubmissionDays: number;
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
  staffSubmissionAttribution: StaffSubmissionAttributionMetrics;
  onTime: StaffOnTimeMetrics;
  /** Selected-period manager-approved completions by current assignee. */
  completionWorkTypes: WorkTypeDistributionItem[];
  /** Current active snapshot by current assignee; independent of selected range. */
  currentWorkloadByType: WorkTypeDistributionItem[];
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
  staffSubmissionAttribution: StaffSubmissionAttributionMetrics;
  onTime: StaffOnTimeMetrics;
  /** Selected-period manager-approved completions by current assignee. */
  completionWorkTypes: WorkTypeDistributionItem[];
  /** Current active snapshot by current assignee; independent of selected range. */
  currentWorkloadByType: WorkTypeDistributionItem[];
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
}>;

/**
 * Current customer association attribution: every metric is attributed to the
 * JobCard's current customer_id at read time, never reconstructed from the
 * activity log. A JobCard reassigned after creation keeps counting for its
 * current customer only.
 */
export type CustomerReportReadInput = StaffOperationalSummaryScope & Readonly<{
  search: string | null;
  status: Customer['status'] | null;
  customerType: Customer['customerType'] | null;
  limit: number;
  offset: number;
}>;

export type CustomerReportSnapshot = Readonly<{
  active: number;
  actionable: number;
  waitingApproval: number;
  revisionRequested: number;
  overdue: number;
}>;

export type CustomerReportPeriod = Readonly<{
  created: number;
  createdWorkTypes: Readonly<{
    PRODUCT_DELIVERY: number;
    GENERAL_TASK: number;
    SALES_MEETING: number;
  }>;
  managerApproved: number;
  followUpChildren: number;
}>;

export type CustomerReportActivity = Readonly<{
  snapshot: CustomerReportSnapshot;
  period: CustomerReportPeriod;
}>;

export type CustomerReportItem = Readonly<{
  customer: Pick<Customer, 'id' | 'name' | 'customerType' | 'status'>;
  activity: CustomerReportActivity;
}>;

/**
 * Reconciliation for JobCards whose current customer_id is NULL. Kept separate
 * from paginated customer rows: never a customer row, never filtered by
 * customer search/status/type, never paginated.
 */
export type CustomerReportUnassigned = Readonly<{
  snapshot: CustomerReportSnapshot;
  period: CustomerReportPeriod;
}>;

export type CustomerReportResponse = Readonly<{
  range: ResolvedReportRange;
  total: number;
  limit: number;
  offset: number;
  items: CustomerReportItem[];
  unassigned: CustomerReportUnassigned;
}>;

export type CustomerReportQuery = ReportRangeQuery & {
  search: string | null;
  status: Customer['status'] | null;
  customerType: Customer['customerType'] | null;
  limit: number;
  offset: number;
};

export type SalesFollowUpStatusDistributionItem = Readonly<{
  status: JobCardStatus;
  count: number;
}>;

export type SalesFollowUpTypeDistributionItem = Readonly<{
  type: JobCardType;
  count: number;
}>;

export type ReportAssigneeIdentity = Readonly<{
  userId: string;
  name: string;
}>;

export type ReportCustomerIdentity = Readonly<{
  id: string;
  name: string;
}>;

/**
 * A current operational Sales Meeting queue row. `scheduledAt` is the current
 * mutable planned schedule; `assignee` is the current operational assignee,
 * never a historical meeting actor attribution.
 */
export type CurrentSalesMeetingQueueItem = Readonly<{
  id: string;
  status: JobCardStatus;
  scheduledAt: string | null;
  customer: ReportCustomerIdentity | null;
  assignee: ReportAssigneeIdentity;
}>;

/**
 * A proposal-bearing approval/revision queue row. `proposedFollowUpAt` is the
 * PROPOSED follow-up date/time, never the timestamp the proposal was written.
 */
export type ProposalQueueItem = Readonly<{
  id: string;
  status: JobCardStatus;
  customer: ReportCustomerIdentity | null;
  assignee: ReportAssigneeIdentity;
  followUpProposedType: JobCardType | null;
  followUpProposedAssignee: ReportAssigneeIdentity | null;
  followUpProposalInstructions: string | null;
  proposedFollowUpAt: string | null;
  followUpProposalOrigin: FollowUpProposalOrigin | null;
}>;

export type SalesFollowUpCurrent = Readonly<{
  salesMeetings: Readonly<{
    /** Organization-wide active Sales Meeting total, independent of pagination. */
    total: number;
    statusDistribution: SalesFollowUpStatusDistributionItem[];
    items: CurrentSalesMeetingQueueItem[];
    limit: number;
    offset: number;
  }>;
  proposalQueue: Readonly<{
    /** Organization-wide matching proposal total, independent of pagination. */
    total: number;
    limit: number;
    offset: number;
    items: ProposalQueueItem[];
  }>;
  followUpChildren: Readonly<{
    total: number;
    statusDistribution: SalesFollowUpStatusDistributionItem[];
    typeDistribution: SalesFollowUpTypeDistributionItem[];
    /** Active children with due_date strictly before organization-local today. */
    overdueDueDatedFollowUpChildren: number;
  }>;
}>;

export type SalesFollowUpPeriod = Readonly<{
  salesMeetingsCreated: number;
  salesMeetingsManagerApproved: number;
  /** Current outcomes of completed Sales Meetings whose meeting_at falls in range. */
  meetingOutcomeDistribution: MeetingOutcomeItem[];
  followUpChildrenCreated: number;
  followUpChildrenCreatedByType: SalesFollowUpTypeDistributionItem[];
}>;

export type SalesFollowUpRelationships = Readonly<{
  /** All direct source_job_card_id links; links are immutable current snapshot. */
  directFollowUpLinks: number;
  /** Children whose current parent customer differs from the immutable child customer. */
  currentCustomerDivergence: number;
}>;

export type SalesFollowUpReportResponse = Readonly<{
  range: ResolvedReportRange;
  current: SalesFollowUpCurrent;
  period: SalesFollowUpPeriod;
  relationships: SalesFollowUpRelationships;
}>;

export type SalesFollowUpReportQuery = ReportRangeQuery & {
  limit: number;
  offset: number;
  proposalLimit: number;
  proposalOffset: number;
};

export type SalesFollowUpReportReadInput = StaffOperationalSummaryScope
  & Omit<SalesFollowUpReportQuery, 'requestedRange'>;
