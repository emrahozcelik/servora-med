import { describe, expect, it, vi } from 'vitest';

import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardRepository } from '../src/modules/job-cards/repository.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

const actor: JobCardActor = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'MANAGER',
};

const input = {
  type: 'SALES_MEETING' as const,
  customerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  assignedTo: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  scheduledAt: '2026-08-16T10:00:00.000Z',
  scheduledEndsAt: '2026-08-16T11:00:00.000Z',
  jobCardId: null,
};

describe('JobCardService.availableSlots', () => {
  it('fails closed without opening a transaction when calendar is disabled', async () => {
    const repository = {
      executeTransaction: vi.fn(),
    } as unknown as JobCardRepository;

    await expect(
      new JobCardService(
        repository,
        undefined,
        undefined,
        undefined,
        undefined,
        { enabled: false, reminderLeadMinutes: 30 },
      ).availableSlots(actor, input),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(repository.executeTransaction).not.toHaveBeenCalled();
  });

  it('returns the bounded next-local-day candidates from one in-memory snapshot', async () => {
    const tx = {
      getAssignee: vi.fn().mockResolvedValue({
        id: input.assignedTo,
        organizationId: actor.organizationId,
        role: 'STAFF' as const,
        isActive: true,
      }),
      customerExists: vi.fn().mockResolvedValue(true),
      getOrganizationTimezone: vi.fn().mockResolvedValue('UTC'),
      listActiveOnSiteJobs: vi.fn().mockResolvedValue([]),
      listRecentOnSiteVisits: vi.fn().mockResolvedValue([]),
      listAssigneeCalendarIntervals: vi.fn().mockResolvedValue([]),
    };
    const repository = {
      executeTransaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as JobCardRepository;

    const result = await new JobCardService(
      repository,
      () => new Date('2026-08-01T00:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    ).availableSlots(actor, input);

    expect(result.slots).toHaveLength(30);
    expect(result.slots[0]).toEqual({
      startsAt: '2026-08-17T10:00:00.000Z',
      endsAt: '2026-08-17T11:00:00.000Z',
    });
    expect(tx.listActiveOnSiteJobs).toHaveBeenCalledTimes(1);
    expect(tx.listRecentOnSiteVisits).toHaveBeenCalledTimes(1);
    expect(tx.listAssigneeCalendarIntervals).toHaveBeenCalledTimes(1);
  });

  it('removes a customer-conflicting local day while retaining later days', async () => {
    const tx = {
      getAssignee: vi.fn().mockResolvedValue({
        id: input.assignedTo,
        organizationId: actor.organizationId,
        role: 'STAFF' as const,
        isActive: true,
      }),
      customerExists: vi.fn().mockResolvedValue(true),
      getOrganizationTimezone: vi.fn().mockResolvedValue('UTC'),
      listActiveOnSiteJobs: vi.fn().mockResolvedValue([{
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        title: 'Aynı müşteri planı',
        scheduledAt: '2026-08-17T09:00:00.000Z',
        type: 'SALES_MEETING' as const,
        status: 'NEW',
        assignedTo: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        assigneeName: 'Başka personel',
      }]),
      listRecentOnSiteVisits: vi.fn().mockResolvedValue([]),
      listAssigneeCalendarIntervals: vi.fn().mockResolvedValue([]),
    };
    const repository = {
      executeTransaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as JobCardRepository;

    const result = await new JobCardService(
      repository,
      () => new Date('2026-08-01T00:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    ).availableSlots(actor, input);

    expect(result.slots[0]).toEqual({
      startsAt: '2026-08-18T10:00:00.000Z',
      endsAt: '2026-08-18T11:00:00.000Z',
    });
  });

  it('removes assignee-overlapping candidates after customer evaluation', async () => {
    const tx = {
      getAssignee: vi.fn().mockResolvedValue({
        id: input.assignedTo,
        organizationId: actor.organizationId,
        role: 'STAFF' as const,
        isActive: true,
      }),
      customerExists: vi.fn().mockResolvedValue(true),
      getOrganizationTimezone: vi.fn().mockResolvedValue('UTC'),
      listActiveOnSiteJobs: vi.fn().mockResolvedValue([]),
      listRecentOnSiteVisits: vi.fn().mockResolvedValue([]),
      listAssigneeCalendarIntervals: vi.fn().mockResolvedValue([{
        startsAt: '2026-08-17T10:30:00.000Z',
        endsAt: '2026-08-17T11:30:00.000Z',
      }]),
    };
    const repository = {
      executeTransaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as JobCardRepository;

    const result = await new JobCardService(
      repository,
      () => new Date('2026-08-01T00:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    ).availableSlots(actor, input);

    expect(result.slots[0]!.startsAt).toBe('2026-08-18T10:00:00.000Z');
  });

  it('omits candidates that exceed the customer frequency limit without an override path', async () => {
    const tx = {
      getAssignee: vi.fn().mockResolvedValue({
        id: input.assignedTo,
        organizationId: actor.organizationId,
        role: 'STAFF' as const,
        isActive: true,
      }),
      customerExists: vi.fn().mockResolvedValue(true),
      getOrganizationTimezone: vi.fn().mockResolvedValue('UTC'),
      listActiveOnSiteJobs: vi.fn().mockResolvedValue([]),
      listRecentOnSiteVisits: vi.fn().mockResolvedValue([
        '2026-08-10T10:00:00.000Z',
        '2026-08-12T10:00:00.000Z',
        '2026-08-14T10:00:00.000Z',
      ].map((occurredAt, index) => ({
        id: `recent-${index}`,
        type: 'SALES_MEETING' as const,
        title: `Geçmiş ziyaret ${index}`,
        occurredAt,
        staffName: 'Başka personel',
        resultSummary: null,
      }))),
      listAssigneeCalendarIntervals: vi.fn().mockResolvedValue([]),
    };
    const repository = {
      executeTransaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as JobCardRepository;

    const result = await new JobCardService(
      repository,
      () => new Date('2026-08-01T00:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    ).availableSlots(actor, input);

    expect(result.slots[0]!.startsAt).toBe('2026-08-24T10:00:00.000Z');
  });

  it('self-excludes an authorized current job from customer and assignee evaluation', async () => {
    const currentJobId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const tx = {
      getJob: vi.fn().mockResolvedValue({ id: currentJobId, assignedTo: input.assignedTo }),
      getAssignee: vi.fn().mockResolvedValue({
        id: input.assignedTo,
        organizationId: actor.organizationId,
        role: 'STAFF' as const,
        isActive: true,
      }),
      customerExists: vi.fn().mockResolvedValue(true),
      getOrganizationTimezone: vi.fn().mockResolvedValue('UTC'),
      listActiveOnSiteJobs: vi.fn().mockResolvedValue([{
        id: currentJobId,
        title: 'Mevcut plan',
        scheduledAt: '2026-08-17T10:00:00.000Z',
        type: 'PRODUCT_DELIVERY' as const,
        status: 'NEW',
        assignedTo: input.assignedTo,
        assigneeName: 'Seçili personel',
      }]),
      listRecentOnSiteVisits: vi.fn().mockResolvedValue([]),
      listAssigneeCalendarIntervals: vi.fn((
        _organizationId: string,
        _assignedTo: string,
        _from: Date,
        _to: Date,
        excludeJobId: string | null,
      ) => Promise.resolve(excludeJobId === currentJobId ? [] : [{
        startsAt: '2026-08-17T10:00:00.000Z',
        endsAt: '2026-08-17T11:00:00.000Z',
      }])),
    };
    const repository = {
      executeTransaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as JobCardRepository;

    const result = await new JobCardService(
      repository,
      () => new Date('2026-08-01T00:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    ).availableSlots(actor, { ...input, jobCardId: currentJobId });

    expect(result.slots[0]!.startsAt).toBe('2026-08-17T10:00:00.000Z');
    expect(tx.listAssigneeCalendarIntervals).toHaveBeenCalledWith(
      actor.organizationId,
      input.assignedTo,
      expect.any(Date),
      expect.any(Date),
      currentJobId,
    );
  });

  it('fails closed before availability reads for an unauthorized self-exclusion job', async () => {
    const tx = {
      getJob: vi.fn().mockResolvedValue(null),
      getAssignee: vi.fn(),
      customerExists: vi.fn(),
      getOrganizationTimezone: vi.fn(),
      listActiveOnSiteJobs: vi.fn(),
      listRecentOnSiteVisits: vi.fn(),
      listAssigneeCalendarIntervals: vi.fn(),
    };
    const repository = {
      executeTransaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as JobCardRepository;

    await expect(new JobCardService(
      repository,
      undefined,
      undefined,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    ).availableSlots(actor, {
      ...input,
      jobCardId: '99999999-9999-4999-8999-999999999999',
    })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
    expect(tx.getAssignee).not.toHaveBeenCalled();
    expect(tx.customerExists).not.toHaveBeenCalled();
  });
});
