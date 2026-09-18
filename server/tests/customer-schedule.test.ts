import { describe, expect, it } from 'vitest';

import {
  evaluateCustomerSchedule,
  isOnSiteJobType,
  localDateKey,
  maxCommitmentsInWindow,
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
  type: 'SALES_MEETING',
  status: 'ACCEPTED',
  assignedTo: 'staff-2',
  assigneeName: 'Bora Yılmaz',
  ...overrides,
});

const visit = (overrides: Partial<RecentOnSiteVisitRecord> = {}): RecentOnSiteVisitRecord => ({
  id: 'visit-1',
  type: 'SALES_MEETING',
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

  it('CSI-1: allows a same-Customer plan on the same local date', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput(),
      reader: stubReader({
        activeJobs: [activeJob({ id: 'other', scheduledAt: '2026-08-08T08:00:00.000Z' })],
      }),
    });
    expect(result.level).toBe('CLEAR');
    expect(result.conflicts).toEqual([]);
  });

  it('CSI-2: does not block another Staff member\'s contact', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput(),
      reader: stubReader({
        activeJobs: [activeJob({ assignedTo: 'someone-else', assigneeName: 'Ayşe K' })],
      }),
    });
    expect(result.level).toBe('CLEAR');
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
    expect(result.recentVisit).toMatchObject({ jobType: 'SALES_MEETING', staffName: 'Bora Yılmaz' });
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

  it('CSI-8/9: does not suggest another day solely due to Customer plans', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt: instant('2026-08-08T10:30:00.000Z') }),
      reader: stubReader({
        activeJobs: [
          activeJob({ id: 'd1', scheduledAt: '2026-08-08T08:00:00.000Z' }),
          activeJob({ id: 'd2', scheduledAt: '2026-08-09T08:00:00.000Z' }),
        ],
      }),
    });
    expect(result.level).toBe('CLEAR');
    expect(result.suggestedAlternativeAt).toBeNull();
  });

  it('does not move a Customer contact solely due to its date', async () => {
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt: instant('2026-08-14T10:30:00.000Z') }), // Friday
      reader: stubReader({
        activeJobs: [activeJob({ scheduledAt: '2026-08-14T08:00:00.000Z' })],
      }),
    });
    expect(result.suggestedAlternativeAt).toBeNull(); // Saturday
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

  it('CSI-12: a 4th visit/commitment in 14 days triggers informational frequency', async () => {
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
    expect(result.level).toBe('WARNING');
    expect(result.frequencyCount).toBe(4);
  });

  it('stays below the advisory trigger for exactly 3 commitments', async () => {
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
    expect(result.level).not.toBe('CONFLICT');
    expect(result.frequencyCount).toBe(3);
  });

  it('R1-5: does not flag records spread across more than one 14-day window', async () => {
    const proposedAt = instant('2026-08-15T10:30:00.000Z');
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt }),
      reader: stubReader({
        recentVisits: [
          visit({ id: 'v-a', occurredAt: '2026-08-02T09:00:00.000Z' }),
          visit({ id: 'v-b', occurredAt: '2026-08-03T09:00:00.000Z' }),
        ],
        activeJobs: [activeJob({
          id: 'plan-c',
          scheduledAt: '2026-08-27T10:00:00.000Z',
        })],
      }),
    });
    expect(result.level).not.toBe('CONFLICT');
    expect(result.frequencyCount).toBe(3);
  });

  it('R1-5: flags a future cluster of three planned visits in one 14-day window', async () => {
    const proposedAt = instant('2026-08-15T10:30:00.000Z');
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt }),
      reader: stubReader({
        activeJobs: [
          activeJob({ id: 'f1', scheduledAt: '2026-08-16T10:00:00.000Z' }),
          activeJob({ id: 'f2', scheduledAt: '2026-08-17T10:00:00.000Z' }),
          activeJob({ id: 'f3', scheduledAt: '2026-08-18T10:00:00.000Z' }),
        ],
      }),
    });
    expect(result.level).toBe('WARNING');
    expect(result.frequencyCount).toBe(4);
  });

  it('R1-5: flags a past cluster of three visits in one 14-day window', async () => {
    const proposedAt = instant('2026-08-15T10:30:00.000Z');
    const result = await evaluateCustomerSchedule({
      ...baseInput({ proposedAt }),
      reader: stubReader({
        recentVisits: [
          visit({ id: 'p1', occurredAt: '2026-08-02T09:00:00.000Z' }),
          visit({ id: 'p2', occurredAt: '2026-08-03T09:00:00.000Z' }),
          visit({ id: 'p3', occurredAt: '2026-08-04T09:00:00.000Z' }),
        ],
      }),
    });
    expect(result.level).toBe('WARNING');
    expect(result.frequencyCount).toBe(4);
  });

  it('maxCommitmentsInWindow never unions disjoint clusters into a false positive', () => {
    const count = maxCommitmentsInWindow('2026-08-15', ['2026-08-02', '2026-08-03', '2026-08-27'], 14);
    expect(count).toBe(3);
  });

  it('same-day contact contributes only to advisory frequency', async () => {
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
    expect(result.level).toBe('WARNING');
    expect(result.frequencyCount).toBe(5);
  });
});
