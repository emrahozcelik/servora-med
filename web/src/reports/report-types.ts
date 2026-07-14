import type {
  DeliveryPurpose,
  JobCardListItem,
} from '../jobs/jobs-api';

export type RequestedReportRange = { from: string; to: string } | null;
export type ResolvedReportRange = { from: string; to: string; timezone: string };

export type StaffOperationalCounters = {
  openJobCards: number;
  waitingApproval: number;
  revisionRequested: number;
  overdueJobCards: number;
  completedInPeriod: number;
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
};

export type StaffReportResponse = {
  staff: { userId: string; name: string; isActive: boolean };
  range: ResolvedReportRange;
  counters: StaffOperationalCounters;
  deliveriesByPurpose: DeliveryPurposeItem[];
};

export type ApprovalItem = JobCardListItem & { waitingMinutes: number };
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
