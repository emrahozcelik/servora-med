import type { RequestedReportRange, ResolvedReportRange } from '../reports/types.js';

export type OverviewQuery = Readonly<{
  requestedRange: RequestedReportRange;
}>;

export type OverviewRecentWork = Readonly<{
  id: string;
  title: string;
  customerName: string | null;
  assigneeName: string | null;
  completedAt: string;
}>;

export type OverviewRecentNote = Readonly<{
  id: string;
  jobCardId: string;
  jobTitle: string;
  authorName: string;
  createdAt: string;
}>;

type OverviewCommon = Readonly<{
  range: ResolvedReportRange;
  generatedAt: string;
  recentCompletedWork: OverviewRecentWork[];
  recentNotes: OverviewRecentNote[];
  upcomingWork: OverviewUpcomingWork | null;
}>;

export type OverviewUpcomingItem = Readonly<{
  id: string;
  source: 'JOB' | 'MANUAL';
  title: string;
  startsAt: string;
  endsAt: string | null;
  assignedUserName: string;
  path: string;
}>;

export type OverviewUpcomingWork = Readonly<{
  items: OverviewUpcomingItem[];
  window: Readonly<{ from: string; to: string }>;
}>;

export type WorkTypeDistributionItem = Readonly<{
  type: string;
  count: number;
}>;

export type MessageUnreadSummary = Readonly<{
  unreadTotal: number;
}>;

export type StaffOverviewResponse = OverviewCommon & Readonly<{
  scope: 'staff';
  openJobCards: number;
  waitingApproval: number;
  revisionRequested: number;
  completedInPeriod: number;
  messageUnreadSummary?: MessageUnreadSummary;
}>;

export type ManagementOverviewResponse = OverviewCommon & Readonly<{
  scope: 'management';
  active: number;
  overdue: number;
  waitingApproval: number;
  revisionRequested: number;
  completedInPeriod: number;
  cancelledInPeriod: number;
  completionTrend: Array<{ date: string; count: number }>;
  approvalQueueSummary: Readonly<{
    pendingCount: number;
    oldestWaitingMinutes: number | null;
  }>;
  workTypeDistribution?: WorkTypeDistributionItem[];
  messageUnreadSummary?: MessageUnreadSummary;
}>;

export type OverviewResponse = StaffOverviewResponse | ManagementOverviewResponse;
