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

export type MeetingOutcomeItem = {
  outcome: MeetingOutcome;
  count: number;
};

export type StaffReportResponse = {
  staff: ReportStaffIdentity;
  range: ResolvedReportRange;
  counters: StaffOperationalCounters;
  deliveriesByPurpose: DeliveryPurposeItem[];
  meetingsByOutcome: MeetingOutcomeItem[];
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
