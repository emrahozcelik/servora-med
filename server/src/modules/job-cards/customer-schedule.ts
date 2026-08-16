import {
  FREQUENT_VISIT_MAX_COUNT,
  FREQUENT_VISIT_WINDOW_DAYS,
  FOLLOW_UP_SEARCH_HORIZON_DAYS,
  RECENT_VISIT_WARNING_DAYS,
  advanceByOneDay,
} from './follow-up-policy.js';
import {
  addCalendarDaysToDateKey,
  dateKeyToOrdinal,
  localDateKey,
} from './local-calendar.js';
import type { JobCardType } from './types.js';

export { localDateKey } from './local-calendar.js';

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

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_TZ_OFFSET_MS = 15 * 60 * 60 * 1000;

export type CustomerScheduleSnapshot = Readonly<{
  timezone: string;
  activeJobs: readonly ActiveOnSiteJobRecord[];
  recentVisits: readonly RecentOnSiteVisitRecord[];
}>;

/**
 * Adapter used by bounded joint-slot evaluation. It preserves the canonical
 * customer evaluator while ensuring every candidate reads the same already
 * loaded snapshot instead of issuing candidate-sized database queries.
 */
export function createCustomerScheduleSnapshotReader(
  snapshot: CustomerScheduleSnapshot,
): CustomerScheduleReader {
  const inRange = (value: string, from: Date, to: Date) => {
    const timestamp = new Date(value).valueOf();
    return timestamp >= from.valueOf() && timestamp <= to.valueOf();
  };
  return {
    async getOrganizationTimezone() {
      return snapshot.timezone;
    },
    async listActiveOnSiteJobs(_organizationId, _customerId, from, to) {
      return snapshot.activeJobs.filter((job) => inRange(job.scheduledAt, from, to));
    },
    async listRecentOnSiteVisits(_organizationId, _customerId, from, to) {
      return snapshot.recentVisits.filter((visit) => inRange(visit.occurredAt, from, to));
    },
  };
}

/**
 * Maximum number of ON_SITE commitments/history records (including the
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
    new Date(proposedAt.valueOf() - FREQUENT_VISIT_WINDOW_DAYS * DAY_MS - MAX_TZ_OFFSET_MS),
    proposedAt,
  );
  const frequencyFuture = activeJobs.filter((job) => {
    const value = new Date(job.scheduledAt).valueOf();
    return value > proposedAt.valueOf()
      && value <= proposedAt.valueOf() + FREQUENT_VISIT_WINDOW_DAYS * DAY_MS + MAX_TZ_OFFSET_MS;
  });
  const frequencyCount = maxCommitmentsInWindow(
    proposedDate,
    [
      ...frequencyPast.map((visit) => localDateKey(new Date(visit.occurredAt), timezone)),
      ...frequencyFuture.map((job) => localDateKey(new Date(job.scheduledAt), timezone)),
    ],
    FREQUENT_VISIT_WINDOW_DAYS,
  );
  const frequencyExceeded = frequencyCount > FREQUENT_VISIT_MAX_COUNT;

  let suggestedAlternativeAt: string | null = null;
  if (conflicts.length > 0) {
    let candidate = proposedAt;
    for (let step = 0; step < FOLLOW_UP_SEARCH_HORIZON_DAYS; step += 1) {
      candidate = advanceByOneDay(candidate, timezone);
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
    safeMessage = 'Bu ziyaret, müşteri için 14 günlük bir dönemde ziyaret sıklığı sınırını aşıyor.';
  } else if (recentVisit !== null) {
    level = 'WARNING';
    safeMessage = 'Bu müşteriye yakın tarihte ziyaret gerçekleştirildi.';
  }

  void now;
  return { level, safeMessage, conflicts, recentVisit, suggestedAlternativeAt, frequencyCount };
}
