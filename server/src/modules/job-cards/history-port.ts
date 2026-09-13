import type { JobCardActor } from './types.js';
import type {
  JobCardPriority,
  JobCardStatus,
  JobCardType,
  MeetingOutcome,
  RelatedIdentity,
  UnsuccessfulVisitReasonCode,
} from './types.js';

export type JobHistoryStatus = 'open' | 'completed' | 'all';
export type JobHistoryStatusFilter = JobHistoryStatus | JobCardStatus | readonly JobCardStatus[];

export type JobHistoryItem = {
  id: string;
  title: string;
  type: JobCardType;
  status: JobCardStatus;
  priority: JobCardPriority;
  scheduledAt: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  assignee: RelatedIdentity;
  customer: RelatedIdentity | null;
  contact: RelatedIdentity | null;
  followUp: { sourceJobCardId: string } | null;
  childCount: number | null;
};

export type PaginatedJobHistory = {
  items: JobHistoryItem[];
  total: number;
  limit: number;
  offset: number;
};

export type CustomerJobHistoryQuery = {
  organizationId: string;
  customerId: string;
  actor: JobCardActor;
  status?: JobHistoryStatusFilter;
  type?: JobCardType;
  limit: number;
  offset: number;
};

export type StaffJobHistoryQuery = {
  organizationId: string;
  targetUserId: string;
  actor: JobCardActor;
  status?: JobHistoryStatusFilter;
  type?: JobCardType;
  limit: number;
  offset: number;
};

export interface JobHistoryReadPort {
  listCustomerJobHistory(input: CustomerJobHistoryQuery): Promise<PaginatedJobHistory>;
  listStaffJobHistory(input: StaffJobHistoryQuery): Promise<PaginatedJobHistory>;
  getCustomerOperationalSummary(input: CustomerOperationalSummaryQuery): Promise<CustomerOperationalSummary>;
}

export type OperationalSummaryFollowUpKind = 'FOLLOW_UP_JOB' | 'SOURCE_JOB';

export type CustomerOperationalSummary = {
  latestInteraction: {
    jobCardId: string;
    title: string;
    type: JobCardType;
    completedAt: string;
    assignee: RelatedIdentity;
  } | null;
  nextPlannedWork: {
    jobCardId: string;
    title: string;
    type: JobCardType;
    status: JobCardStatus;
    scheduledAt: string;
    assignee: RelatedIdentity;
  } | null;
  pendingReview: {
    waitingApprovalCount: number;
    revisionRequestedCount: number;
  };
  latestMeetingOutcome: {
    jobCardId: string;
    meetingAt: string | null;
    outcome: MeetingOutcome;
    unsuccessfulReason: UnsuccessfulVisitReasonCode | null;
    meetingSummary: string | null;
    nextFollowUpAt: string | null;
  } | null;
  followUp: {
    jobCardId: string;
    kind: OperationalSummaryFollowUpKind;
  } | null;
};

export type CustomerOperationalSummaryQuery = {
  organizationId: string;
  customerId: string;
  actor: JobCardActor;
  now: Date;
};
