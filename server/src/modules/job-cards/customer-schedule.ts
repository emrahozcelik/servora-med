import {
  FREQUENT_VISIT_MAX_COUNT,
  FREQUENT_VISIT_WINDOW_DAYS,
  FOLLOW_UP_SEARCH_HORIZON_DAYS,
  RECENT_VISIT_WARNING_DAYS,
  advanceByOneDay,
} from './follow-up-policy.js';
import type { JobCardType } from './types.js';

/**
 * Shared domain-layer Customer scheduling intelligence.
 *
 * V1 visit classification without a visit-mode column:
 *   ON_SITE            SALES_MEETING, PRODUCT_DELIVERY
 *   REMOTE_OR_NON_VISIT GENERAL_TASK
 * A GENERAL_TASK referencing the same Customer never blocks an ON_SITE visit.
 */

const ON_SITE_TYPES: readonly JobCardType[] = ['SALES_MEETING', 'PRODUCT_DELIVERY'];

export function isOnSiteJobType(type: JobCardType): boolean {
  return (ON_SITE_TYPES as readonly string[]).includes(type);
}

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

export type CustomerScheduleLevel = 'CLEAR' | 'WARNING' | 'CONFLICT' | 'FREQUENCY_EXCEEDED';

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

/** Canonical org-local calendar date key ('YYYY-MM-DD') for a timezone. */
export function localDateKey(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TZ_OFFSET_MS = 15 * 60 * 60 * 1000;

export type EvaluateCustomerScheduleInput = {
  reader: CustomerScheduleReader;
  organizationId: string;
  customerId: string | null;
  proposedAt: Date;
  jobType: JobCardType;
  excludeJobId?: string;
  now: Date;
};

export async function evaluateCustomerSchedule(
  input: EvaluateCustomerScheduleInput,
): Promise<CustomerScheduleEvaluation> {
  const { reader, organizationId, customerId, proposedAt, jobType, excludeJobId, now } = input;
  if (customerId === null || !isOnSiteJobType(jobType)) {
    return {
      level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null,
      suggestedAlternativeAt: null, frequencyCount: 0,
    };
  }
  const timezone = await reader.getOrganizationTimezone(organizationId);
  const horizonFrom = new Date(proposedAt.valueOf() - MAX_TZ_OFFSET_MS);
  const horizonTo = new Date(
    proposedAt.valueOf() + (FOLLOW_UP_SEARCH_HORIZON_DAYS + 1) * DAY_MS + MAX_TZ_OFFSET_MS,
  );
  const activeJobs = (await reader.listActiveOnSiteJobs(
    organizationId, customerId, horizonFrom, horizonTo,
  )).filter((job) => job.id !== excludeJobId);

  const occupiedDates = new Set(activeJobs.map((job) => localDateKey(new Date(job.scheduledAt), timezone)));
  const proposedDate = localDateKey(proposedAt, timezone);
  const conflicts = activeJobs
    .filter((job) => localDateKey(new Date(job.scheduledAt), timezone) === proposedDate)
    .map((job): CustomerScheduleConflictDetail => ({
      jobCardId: job.id,
      title: job.title,
      scheduledAt: job.scheduledAt,
      type: job.type,
      status: job.status,
      assignee: { id: job.assignedTo, name: job.assigneeName },
      jobPath: `/jobs/${job.id}`,
    }));

  const recentVisits = await reader.listRecentOnSiteVisits(
    organizationId,
    customerId,
    new Date(proposedAt.valueOf() - RECENT_VISIT_WARNING_DAYS * DAY_MS),
    proposedAt,
  );
  const recentVisitRecord = recentVisits.reduce<RecentOnSiteVisitRecord | null>(
    (latest, visit) => (
      latest === null || new Date(visit.occurredAt).valueOf() > new Date(latest.occurredAt).valueOf()
        ? visit : latest),
    null,
  );
  const recentVisit: RecentVisitSummary | null = recentVisitRecord === null
    ? null
    : {
        occurredAt: recentVisitRecord.occurredAt,
        jobType: recentVisitRecord.type,
        title: recentVisitRecord.title,
        staffName: recentVisitRecord.staffName,
        resultSummary: recentVisitRecord.resultSummary,
      };

  const frequencyPast = await reader.listRecentOnSiteVisits(
    organizationId,
    customerId,
    new Date(proposedAt.valueOf() - FREQUENT_VISIT_WINDOW_DAYS * DAY_MS),
    proposedAt,
  );
  const frequencyFuture = activeJobs.filter((job) => {
    const value = new Date(job.scheduledAt).valueOf();
    return value > proposedAt.valueOf()
      && value <= proposedAt.valueOf() + FREQUENT_VISIT_WINDOW_DAYS * DAY_MS;
  });
  const frequencyCount = frequencyPast.length + frequencyFuture.length + 1;
  const frequencyExceeded = frequencyCount > FREQUENT_VISIT_MAX_COUNT;

  let suggestedAlternativeAt: string | null = null;
  if (conflicts.length > 0) {
    let candidate = proposedAt;
    for (let step = 0; step < FOLLOW_UP_SEARCH_HORIZON_DAYS; step += 1) {
      candidate = advanceByOneDay(candidate);
      if (!occupiedDates.has(localDateKey(candidate, timezone))) {
        suggestedAlternativeAt = candidate.toISOString();
        break;
      }
    }
  }

  let level: CustomerScheduleLevel = 'CLEAR';
  let safeMessage: string | null = null;
  if (conflicts.length > 0) {
    level = 'CONFLICT';
    safeMessage = 'Bu müşteri için yakın tarihte başka bir iş planlandı.';
  } else if (frequencyExceeded) {
    level = 'FREQUENCY_EXCEEDED';
    safeMessage = 'Bu müşteri son 14 gün içinde sık ziyaret edildi. Yine de yeni ziyaret planlamak için nedeni belirtin.';
  } else if (recentVisit !== null) {
    level = 'WARNING';
    safeMessage = 'Bu müşteriye yakın tarihte ziyaret gerçekleştirildi.';
  }

  void now;
  return { level, safeMessage, conflicts, recentVisit, suggestedAlternativeAt, frequencyCount };
}
