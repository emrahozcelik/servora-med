import { describe, expect, it } from 'vitest';

import {
  evaluateCustomerSchedule,
  isOnSiteJobType,
  localDateKey,
  type ActiveOnSiteJobRecord,
  type CustomerScheduleReader,
  type RecentOnSiteVisitRecord,
} from '../src/modules/job-cards/customer-schedule.js';

const instant = (value: string) => new Date(value);

function stubReader(input: {
  timezone?: string;
  activeJobs?: ActiveOnSiteJobRecord[];
  recentVisits?: RecentOnSiteVisitRecord[];
} = {}): CustomerScheduleReader {
  const timezone = input.timezone ?? 'Europe/Istanbul';
  const activeJobs = input.activeJobs ?? [];
  const recentVisits = input.recentVisits ?? [];
  return {
    getOrganizationTimezone: async () => timezone,
    listActiveOnSiteJobs: async (_org, _customer, from, to) => activeJobs.filter((job) => {
      const value = new Date(job.scheduledAt).valueOf();
      return value >= from.valueOf() && value <= to.valueOf();
    }),
    listRecentOnSiteVisits: async (_org, _customer, from, to) => recentVisits.filter((visit) => {
      const value = new Date(visit.occurredAt).valueOf();
      return value >= from.valueOf() && value <= to.valueOf();
    }),
  };
}

const activeJob = (overrides: Partial<ActiveOnSiteJobRecord> = {}): ActiveOnSiteJobRecord => ({
  id: 'job-1',
  title: 'Ürün teslimatı',
  scheduledAt: '2026-08-08T10:00:00.000Z',
  type: 'PRODUCT_DELIVERY',
  status: 'ACCEPTED',
  assignedTo: 'staff-2',
  assigneeName: 'Bora Yılmaz',
  ...overrides,
});

const visit = (overrides: Partial<RecentOnSiteVisitRecord> = {}): RecentOnSiteVisitRecord => ({
  id: 'visit-1',
  type: 'PRODUCT_DELIVERY',
  title: 'Ürün teslimatı',
  occurredAt: '2026-08-05T09:00:00.000Z',
  staffName: 'Bora Yılmaz',
  resultSummary: 'Teslim edildi.',
  ...overrides,
});

const baseInput = (overrides: {
  customerId?: string | null;
  proposedAt?: Date;
  jobType?: 'SALES_MEETING' | 'PRODUCT_DELIVERY' | 'GENERAL_TASK';
  excludeJobId?: string;
} = {}) => ({
  organizationId: 'org-1',
  customerId: overrides.customerId ?? 'customer-1',
  proposedAt: overrides.proposedAt ?? instant('2026-08-08T10:30:00.000Z'),
  jobType: overrides.jobType ?? 'SALES_MEETING',
  excludeJobId: overrides.excludeJobId,
  now: instant('2026-08-01T10:00:00.000Z'),
});

describe('visit classification', () => {
  it('classifies SALES_MEETING and PRODUCT_DELIVERY as ON_SITE', () => {
    expect(isOnSiteJobType('SALES_MEETING')).toBe(true);
    expect(isOnSiteJobType('PRODUCT_DELIVERY')).toBe(true);
  });

  it('classifies GENERAL_TASK as remote/non-visit', () => {
    expect(isOnSiteJobType('GENERAL_TASK')).toBe(false);
  });
});

describe('localDateKey', () => {
  it('maps instants to org-local calendar dates', () => {
    expect(localDateKey(instant('2026-08-08T23:30:00.000Z'), 'Europe/Istanbul'))
      .toBe('2026-08-09');
    expect(localDateKey(instant('2026-08-08T10:00:00.000Z'), 'Europe/Istanbul'))
      .toBe('2026-08-08');
  });
});

describe('evaluateCustomerSchedule', () => {
  it('CSI-4: a customerless or non-visit proposal evaluates CLEAR without any lookup', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput(),
      reader: stubReader(),
      customerId: null,
    });
    expect(result.level).toBe('CLEAR');
    expect(result.conflicts).toEqual([]);

    const taskResult = await evaluateCustomerSchedule({
      ...baseInput(),
      reader: stubReader(),
      jobType: 'GENERAL_TASK',
    });
    expect(taskResult.level).toBe('CLEAR');
  });

  it('CSI-1: detects a same-Customer future ON_SITE job on the same local date', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput(),
      reader: stubReader({
        activeJobs: [activeJob({ id: 'other', scheduledAt: '2026-08-08T08:00:00.000Z' })],
      }),
    });
    expect(result.level).toBe('CONFLICT');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ jobCardId: 'other', title: 'Ürün teslimatı' });
  });

  it('CSI-2: detects another Staff member\'s Job regardless of assignee', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput(),
      reader: stubReader({
        activeJobs: [activeJob({ assignedTo: 'someone-else', assigneeName: 'Ayşe K' })],
      }),
    });
    expect(result.level).toBe('CONFLICT');
  });

  it('ignores the excluded JobCard itself', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput({ excludeJobId: 'job-1' }),
      reader: stubReader({ activeJobs: [activeJob()] }),
    });
    expect(result.level).toBe('CLEAR');
  });

  it('does not treat a job on an adjacent local date as a conflict', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput(),
      reader: stubReader({
        activeJobs: [activeJob({ scheduledAt: '2026-08-09T10:00:00.000Z' })],
      }),
    });
    expect(result.level).toBe('CLEAR');
  });

  it('CSI-5: reports a recent completed ON_SITE visit as WARNING', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt: instant('2026-08-08T10:30:00.000Z') }),
      reader: stubReader({
        recentVisits: [visit({ occurredAt: '2026-08-05T09:00:00.000Z' })],
      }),
    });
    expect(result.level).toBe('WARNING');
    expect(result.recentVisit).toMatchObject({ jobType: 'PRODUCT_DELIVERY', staffName: 'Bora Yılmaz' });
  });

  it('ignores visits older than the recent window', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt: instant('2026-08-20T10:30:00.000Z') }),
      reader: stubReader({
        recentVisits: [visit({ occurredAt: '2026-08-05T09:00:00.000Z' })],
      }),
    });
    expect(result.level).toBe('CLEAR');
    expect(result.recentVisit).toBeNull();
  });

  it('CSI-8/9: suggests the earliest conflict-free alternative within the horizon', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt: instant('2026-08-08T10:30:00.000Z') }),
      reader: stubReader({
        activeJobs: [
          activeJob({ id: 'd1', scheduledAt: '2026-08-08T08:00:00.000Z' }),
          activeJob({ id: 'd2', scheduledAt: '2026-08-09T08:00:00.000Z' }),
        ],
      }),
    });
    expect(result.level).toBe('CONFLICT');
    expect(result.suggestedAlternativeAt).toBe('2026-08-10T10:30:00.000Z');
  });

  it('does not specially skip weekends when suggesting alternatives', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt: instant('2026-08-14T10:30:00.000Z') }), // Friday
      reader: stubReader({
        activeJobs: [activeJob({ scheduledAt: '2026-08-14T08:00:00.000Z' })],
      }),
    });
    expect(result.suggestedAlternativeAt).toBe('2026-08-15T10:30:00.000Z'); // Saturday
  });

  it('returns null alternative when every horizon day is occupied', async () => {
    const jobs = Array.from({ length: 32 }, (_, index) => activeJob({
      id: `job-${index}`,
      scheduledAt: new Date(instant('2026-08-08T10:30:00.000Z').valueOf()
        + index * 24 * 60 * 60 * 1000).toISOString(),
    }));
    const result = await evaluateCustomerSchedule({
      ...baseInput(),
      reader: stubReader({ activeJobs: jobs }),
    });
    expect(result.suggestedAlternativeAt).toBeNull();
  });

  it('CSI-12: a 4th visit/commitment in 14 days exceeds the frequency guard', async () => {
    const proposedAt = instant('2026-08-15T10:30:00.000Z');
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt }),
      reader: stubReader({
        recentVisits: [
          visit({ id: 'v1', occurredAt: '2026-08-10T09:00:00.000Z' }),
          visit({ id: 'v2', occurredAt: '2026-08-12T09:00:00.000Z' }),
        ],
        activeJobs: [activeJob({
          id: 'future-1',
          scheduledAt: '2026-08-18T10:00:00.000Z',
        })],
      }),
    });
    expect(result.level).toBe('FREQUENCY_EXCEEDED');
    expect(result.frequencyCount).toBe(4);
  });

  it('stays below the guard for exactly 3 commitments', async () => {
    const proposedAt = instant('2026-08-15T10:30:00.000Z');
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt }),
      reader: stubReader({
        recentVisits: [visit({ occurredAt: '2026-08-10T09:00:00.000Z' })],
        activeJobs: [activeJob({
          id: 'future-1',
          scheduledAt: '2026-08-18T10:00:00.000Z',
        })],
      }),
    });
    expect(result.level).not.toBe('FREQUENCY_EXCEEDED');
    expect(result.frequencyCount).toBe(3);
  });

  it('prefers CONFLICT over FREQUENCY_EXCEEDED when both apply', async () => {
    const proposedAt = instant('2026-08-15T10:30:00.000Z');
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt }),
      reader: stubReader({
        recentVisits: [
          visit({ id: 'v1', occurredAt: '2026-08-10T09:00:00.000Z' }),
          visit({ id: 'v2', occurredAt: '2026-08-12T09:00:00.000Z' }),
        ],
        activeJobs: [
          activeJob({ id: 'same-day', scheduledAt: '2026-08-15T08:00:00.000Z' }),
          activeJob({ id: 'future-1', scheduledAt: '2026-08-18T10:00:00.000Z' }),
        ],
      }),
    });
    expect(result.level).toBe('CONFLICT');
  });
});
