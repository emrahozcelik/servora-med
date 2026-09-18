import {
  FREQUENT_VISIT_ADVISORY_THRESHOLD,
  FREQUENT_VISIT_WINDOW_DAYS,
  RECENT_VISIT_WARNING_DAYS,
} from './follow-up-policy.js';
import {
  addCalendarDaysToDateKey,
  dateKeyToOrdinal,
  localDateKey,
} from './local-calendar.js';
import type { JobCardType, JobCardEngagementKind } from './types.js';

export { localDateKey } from './local-calendar.js';

/** Physical calendar types; independent of Customer contact frequency. */
export function isOnSiteJobType(type: JobCardType): boolean {
  return type === 'SALES_MEETING' || type === 'PRODUCT_DELIVERY';
}

/** V1 customer-contact observation. TRAINING/OTHER have no assumed sales-contact meaning. */
export const FREQUENCY_ENGAGEMENT_KINDS: readonly JobCardEngagementKind[] = [
  'CUSTOMER_VISIT', 'PRODUCT_DEMO', 'SALES_MEETING', 'FOLLOW_UP',
];

export function observesCustomerFrequency(type: JobCardType, kind: JobCardEngagementKind | null): boolean {
  return type === 'SALES_MEETING' && kind !== null && FREQUENCY_ENGAGEMENT_KINDS.includes(kind);
}

export type CustomerVisitDuplicateInput = {
  organizationId: string;
  customerId: string;
  assignedTo: string;
  engagementKind: JobCardEngagementKind;
  startsAt: string;
  endsAt: string;
  excludeJobId?: string;
};
export type CustomerVisitDuplicate = { jobCardId: string; jobPath: string };
export type CustomerFrequencyAdvisory = {
  source: 'SYSTEM';
  windowDays: number;
  countIncludingCandidate: number;
};

export type ActiveOnSiteJobRecord = {
  id: string;
  title: string;
  scheduledAt: string;
  type: JobCardType;
  status: string;
  assignedTo: string;
  assigneeName: string;
};

export type RecentOnSiteVisitRecord = {
  id: string;
  type: JobCardType;
  title: string;
  occurredAt: string;
  staffName: string;
  resultSummary: string | null;
};

export type CustomerScheduleReader = {
  getOrganizationTimezone(organizationId: string): Promise<string>;
  listActiveOnSiteJobs(
    organizationId: string,
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<ActiveOnSiteJobRecord[]>;
  listRecentOnSiteVisits(
    organizationId: string,
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<RecentOnSiteVisitRecord[]>;
};

export type CustomerScheduleLevel = 'CLEAR' | 'WARNING';

export type CustomerScheduleConflictDetail = {
  jobCardId: string;
  title: string;
  scheduledAt: string;
  type: JobCardType;
  status: string;
  assignee: { id: string; name: string };
  jobPath: string;
};

export type RecentVisitSummary = {
  occurredAt: string;
  jobType: JobCardType;
  title: string;
  staffName: string;
  resultSummary: string | null;
};

export type CustomerScheduleEvaluation = {
  level: CustomerScheduleLevel;
  safeMessage: string | null;
  conflicts: CustomerScheduleConflictDetail[];
  recentVisit: RecentVisitSummary | null;
  suggestedAlternativeAt: string | null;
  frequencyCount: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_TZ_OFFSET_MS = 15 * 60 * 60 * 1000;

/**
 * Maximum number of observed Customer contact records (including the
 * candidate itself) inside any contiguous `windowDays`-calendar-day window that
 * contains the candidate's local date. This is a true rolling window: records
 * are only counted when a single window spans them, never a past-union-future
 * ~2×window aggregation.
 */
export function maxCommitmentsInWindow(
  candidateDate: string,
  recordDates: string[],
  windowDays: number,
): number {
  const candidateOrdinal = dateKeyToOrdinal(candidateDate);
  let max = 1;
  for (let offset = -(windowDays - 1); offset <= 0; offset += 1) {
    const start = addCalendarDaysToDateKey(candidateDate, offset);
    const startOrdinal = dateKeyToOrdinal(start);
    const endOrdinal = startOrdinal + (windowDays - 1);
    const count = 1 + recordDates.reduce((total, date) => {
      const ordinal = dateKeyToOrdinal(date);
      return ordinal >= startOrdinal && ordinal <= endOrdinal ? total + 1 : total;
    }, 0);
    if (count > max) max = count;
  }
  return max;
}

export type EvaluateCustomerScheduleInput = {
  reader: CustomerScheduleReader;
  organizationId: string;
  customerId: string | null;
  proposedAt: Date;
  jobType: JobCardType;
  engagementKind?: JobCardEngagementKind | null;
  excludeJobId?: string;
  now: Date;
};

export async function evaluateCustomerSchedule(
  input: EvaluateCustomerScheduleInput,
): Promise<CustomerScheduleEvaluation> {
  const { reader, organizationId, customerId, proposedAt, jobType, excludeJobId } = input;
  const clear: CustomerScheduleEvaluation = {
    level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null,
    suggestedAlternativeAt: null, frequencyCount: 0,
  };
  if (customerId === null || !observesCustomerFrequency(jobType, input.engagementKind ?? 'SALES_MEETING')) return clear;
  const timezone = await reader.getOrganizationTimezone(organizationId);
  const from = new Date(proposedAt.valueOf() - FREQUENT_VISIT_WINDOW_DAYS * DAY_MS - MAX_TZ_OFFSET_MS);
  const to = new Date(proposedAt.valueOf() + FREQUENT_VISIT_WINDOW_DAYS * DAY_MS + MAX_TZ_OFFSET_MS);
  // Reader queries select only the explicitly observed engagement kinds.
  // Count each row once, including overdue active plans on the past side.
  const activeJobs = (await reader.listActiveOnSiteJobs(organizationId, customerId, from, to))
    .filter((job) => job.id !== excludeJobId && job.type === 'SALES_MEETING');
  const recentVisits = (await reader.listRecentOnSiteVisits(organizationId, customerId, from, proposedAt))
    .filter((visit) => visit.id !== excludeJobId && visit.type === 'SALES_MEETING');
  const dates = new Map<string, string>();
  for (const job of activeJobs) dates.set(job.id, localDateKey(new Date(job.scheduledAt), timezone));
  for (const visit of recentVisits) dates.set(visit.id, localDateKey(new Date(visit.occurredAt), timezone));
  const frequencyCount = maxCommitmentsInWindow(
    localDateKey(proposedAt, timezone), [...dates.values()], FREQUENT_VISIT_WINDOW_DAYS,
  );
  const latest = recentVisits.filter((visit) => Date.parse(visit.occurredAt)
    >= proposedAt.valueOf() - RECENT_VISIT_WARNING_DAYS * DAY_MS)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  const recentVisit: RecentVisitSummary | null = latest ? {
    occurredAt: latest.occurredAt, jobType: latest.type, title: latest.title,
    staffName: latest.staffName, resultSummary: latest.resultSummary,
  } : null;
  const notable = frequencyCount > FREQUENT_VISIT_ADVISORY_THRESHOLD;
  return {
    ...clear,
    level: notable || recentVisit !== null ? 'WARNING' : 'CLEAR',
    safeMessage: notable
      ? `Bu plan dahil, müşteriyle 14 günlük yakın dönem içinde ${frequencyCount} saha teması planlandı veya gerçekleştirildi.`
      : recentVisit ? 'Bu müşteriye yakın tarihte ziyaret gerçekleştirildi.' : null,
    recentVisit,
    frequencyCount,
  };
}
