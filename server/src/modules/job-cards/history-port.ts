import type { JobCardActor } from './types.js';
import type {
  JobCardPriority,
  JobCardStatus,
  JobCardType,
  RelatedIdentity,
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
}
