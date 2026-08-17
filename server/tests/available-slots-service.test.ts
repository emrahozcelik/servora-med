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

  it('derives a 30-minute Product Delivery duration when the end is omitted', async () => {
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
    ).availableSlots(actor, {
      ...input,
      type: 'PRODUCT_DELIVERY',
      scheduledEndsAt: undefined,
    });

    expect(result.slots[0]).toEqual({
      startsAt: '2026-08-17T10:00:00.000Z',
      endsAt: '2026-08-17T10:30:00.000Z',
    });
  });

  it('derives exact elapsed durations across the Europe/Berlin fall-back when the end is omitted', async () => {
    for (const [type, expectedEnd] of [
      ['SALES_MEETING', '2026-10-26T02:30:00.000Z'],
      ['PRODUCT_DELIVERY', '2026-10-26T02:00:00.000Z'],
    ] as const) {
      const tx = {
        getAssignee: vi.fn().mockResolvedValue({
          id: input.assignedTo,
          organizationId: actor.organizationId,
          role: 'STAFF' as const,
          isActive: true,
        }),
        customerExists: vi.fn().mockResolvedValue(true),
        getOrganizationTimezone: vi.fn().mockResolvedValue('Europe/Berlin'),
        listActiveOnSiteJobs: vi.fn().mockResolvedValue([]),
        listRecentOnSiteVisits: vi.fn().mockResolvedValue([]),
        listAssigneeCalendarIntervals: vi.fn().mockResolvedValue([]),
      };
      const repository = {
        executeTransaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
      } as unknown as JobCardRepository;

      const result = await new JobCardService(
        repository,
        () => new Date('2026-10-01T00:00:00.000Z'),
        undefined,
        undefined,
        undefined,
        { enabled: true, reminderLeadMinutes: 30 },
      ).availableSlots(actor, {
        ...input,
        type,
        scheduledAt: '2026-10-25T00:30:00.000Z',
        scheduledEndsAt: undefined,
      });

      expect(result.slots[0]).toEqual({
        startsAt: '2026-10-26T01:30:00.000Z',
        endsAt: expectedEnd,
      });
    }
  });

  it('rejects a noncanonical explicit end for a new Product Delivery search', async () => {
    const executeTransaction = vi.fn();
    const repository = { executeTransaction } as unknown as JobCardRepository;

    await expect(new JobCardService(
      repository,
      () => new Date('2026-08-01T00:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    ).availableSlots(actor, {
      ...input,
      type: 'PRODUCT_DELIVERY',
      scheduledEndsAt: '2026-08-16T11:00:00.000Z',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(executeTransaction).not.toHaveBeenCalled();
  });

  it('uses a persisted custom duration when searching slots for an existing JobCard', async () => {
    const currentJobId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const tx = {
      getJob: vi.fn().mockResolvedValue({
        id: currentJobId,
        organizationId: actor.organizationId,
        customerId: input.customerId,
        type: input.type,
        assignedTo: input.assignedTo,
        status: 'NEW',
        scheduledAt: '2026-08-10T10:00:00.000Z',
        scheduledEndsAt: '2026-08-10T12:00:00.000Z',
      }),
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
    ).availableSlots(actor, {
      ...input,
      scheduledEndsAt: undefined,
      jobCardId: currentJobId,
    });

    expect(result.slots[0]).toEqual({
      startsAt: '2026-08-17T10:00:00.000Z',
      endsAt: '2026-08-17T12:00:00.000Z',
    });
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
      getJob: vi.fn().mockResolvedValue({
        id: currentJobId,
        organizationId: actor.organizationId,
        customerId: input.customerId,
        type: input.type,
        assignedTo: input.assignedTo,
        status: 'NEW',
      }),
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

  it('does not self-exclude an otherwise editable job for a different customer', async () => {
    const currentJobId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const tx = {
      getJob: vi.fn().mockResolvedValue({
        id: currentJobId,
        organizationId: actor.organizationId,
        customerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        type: input.type,
        assignedTo: input.assignedTo,
        status: 'NEW',
      }),
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

    await expect(new JobCardService(
      repository,
      () => new Date('2026-08-01T00:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    ).availableSlots(actor, { ...input, jobCardId: currentJobId })).rejects.toMatchObject({
      code: 'JOB_CARD_NOT_FOUND',
      statusCode: 404,
    });
    expect(tx.listAssigneeCalendarIntervals).not.toHaveBeenCalled();
  });

  it('does not self-exclude an otherwise editable job for a different type', async () => {
    const currentJobId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const tx = {
      getJob: vi.fn().mockResolvedValue({
        id: currentJobId,
        organizationId: actor.organizationId,
        customerId: input.customerId,
        type: 'PRODUCT_DELIVERY',
        assignedTo: input.assignedTo,
        status: 'NEW',
      }),
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
    ).availableSlots(actor, { ...input, jobCardId: currentJobId })).rejects.toMatchObject({
      code: 'JOB_CARD_NOT_FOUND',
      statusCode: 404,
    });
    expect(tx.getAssignee).not.toHaveBeenCalled();
  });

  it('fails closed for a Staff-owned job with a mismatched edit target', async () => {
    const staffActor: JobCardActor = {
      id: input.assignedTo,
      organizationId: actor.organizationId,
      role: 'STAFF',
    };
    const currentJobId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const tx = {
      getJob: vi.fn().mockResolvedValue({
        id: currentJobId,
        organizationId: actor.organizationId,
        customerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        type: input.type,
        assignedTo: staffActor.id,
        status: 'NEW',
      }),
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
    ).availableSlots(staffActor, { ...input, jobCardId: currentJobId })).rejects.toMatchObject({
      code: 'JOB_CARD_NOT_FOUND',
      statusCode: 404,
    });
    expect(tx.getAssignee).not.toHaveBeenCalled();
  });

  it('allows Manager reassignment search when the current job target still matches', async () => {
    const currentJobId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const previousAssigneeId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const tx = {
      getJob: vi.fn().mockResolvedValue({
        id: currentJobId,
        organizationId: actor.organizationId,
        customerId: input.customerId,
        type: input.type,
        assignedTo: previousAssigneeId,
        status: 'NEW',
      }),
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

  it('does not self-exclude a matching job that the Staff actor cannot edit', async () => {
    const staffActor: JobCardActor = {
      id: input.assignedTo,
      organizationId: actor.organizationId,
      role: 'STAFF',
    };
    const currentJobId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const tx = {
      getJob: vi.fn().mockResolvedValue({
        id: currentJobId,
        organizationId: actor.organizationId,
        customerId: input.customerId,
        type: input.type,
        assignedTo: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        status: 'NEW',
      }),
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
    ).availableSlots(staffActor, { ...input, jobCardId: currentJobId })).rejects.toMatchObject({
      code: 'JOB_CARD_NOT_FOUND',
      statusCode: 404,
    });
    expect(tx.getAssignee).not.toHaveBeenCalled();
  });

  it('fails closed for a cross-organization exclusion target', async () => {
    const currentJobId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const tx = {
      getJob: vi.fn().mockResolvedValue({
        id: currentJobId,
        organizationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        customerId: input.customerId,
        type: input.type,
        assignedTo: input.assignedTo,
        status: 'NEW',
      }),
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
    ).availableSlots(actor, { ...input, jobCardId: currentJobId })).rejects.toMatchObject({
      code: 'JOB_CARD_NOT_FOUND',
      statusCode: 404,
    });
    expect(tx.getAssignee).not.toHaveBeenCalled();
  });

  it('fails closed when the matching JobCard is not currently editable', async () => {
    const currentJobId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const tx = {
      getJob: vi.fn().mockResolvedValue({
        id: currentJobId,
        organizationId: actor.organizationId,
        customerId: input.customerId,
        type: input.type,
        assignedTo: input.assignedTo,
        status: 'WAITING_APPROVAL',
      }),
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
    ).availableSlots(actor, { ...input, jobCardId: currentJobId })).rejects.toMatchObject({
      code: 'JOB_CARD_NOT_FOUND',
      statusCode: 404,
    });
    expect(tx.getAssignee).not.toHaveBeenCalled();
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
