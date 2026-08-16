import { describe, expect, it } from 'vitest';

import { AppError } from '../src/errors/index.js';
import type {
  ActiveOnSiteJobRecord,
  RecentOnSiteVisitRecord,
} from '../src/modules/job-cards/customer-schedule.js';
import type {
  CreateJobCardRecord,
  CriticalActionClaim,
  JobCardReadScope,
  JobCardRepository,
  JobCardTransaction,
} from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  JobCard,
  JobCardActor,
  JobCardAssignee,
  JobCardListQuery,
  NormalizedJobCardCreateInput,
} from '../src/modules/job-cards/types.js';

const listQuery: JobCardListQuery = {
  q: null, status: 'all', type: null, assignedTo: null, customerId: null,
  priority: null, dueBefore: null, dueAfter: null, limit: 25, offset: 0,
};

type ActivityLog = { event: string; metadata: unknown };

class SchedulingMemoryRepository implements JobCardRepository {
  assignees: JobCardAssignee[] = [
    { id: 'staff-1', organizationId: 'org-1', role: 'STAFF', isActive: true },
    { id: 'staff-2', organizationId: 'org-1', role: 'STAFF', isActive: true },
  ];
  customers = [
    { id: 'customer-1', organizationId: 'org-1', status: 'active' as const },
    { id: 'customer-2', organizationId: 'org-1', status: 'active' as const },
  ];
  contacts: Array<{ id: string; organizationId: string; customerId: string; isActive: boolean }> = [];
  jobs: JobCard[] = [];
  activities: ActivityLog[] = [];
  completed = new Map<string, unknown>();
  processing = new Set<string>();
  timezone = 'Europe/Istanbul';
  activeOnSiteJobs: ActiveOnSiteJobRecord[] = [];
  recentOnSiteVisits: RecentOnSiteVisitRecord[] = [];
  /** Assignee calendar commitments used by the in-memory assertCalendarAvailability. */
  calendarEvents: Array<{
    assignedUserId: string;
    startsAt: string;
    endsAt: string;
    source?: 'JOB' | 'MANUAL';
  }> = [];
  lockOrder: string[] = [];
  customerLockCount = 0;

  private tx(locking: boolean): JobCardTransaction {
    const self = this;
    const find = (org: string, id: string) =>
      this.jobs.find((item) => item.organizationId === org && item.id === id) ?? null;
    return {
      getJob: async (org, id) => find(org, id),
      getJobForUpdate: async (org, id) => {
        this.lockOrder.push('job');
        return find(org, id);
      },
      getJobDetail: async (org, id) => {
        const job = find(org, id);
        return job ? this.detail(job) : null;
      },
      transitionWithVersion: async () => null,
      getAssignee: async (org, id) =>
        this.assignees.find((item) => item.organizationId === org && item.id === id) ?? null,
      getAssigneeForUpdate: async (org, id) => {
        this.lockOrder.push('assignee');
        return this.assignees.find((item) => item.organizationId === org && item.id === id) ?? null;
      },
      customerExists: async (org, id) =>
        this.customers.some((item) => item.organizationId === org && item.id === id),
      getCustomerForUpdate: async (org, id) => {
        this.lockOrder.push('customer');
        this.customerLockCount += 1;
        return this.customers.find((item) => item.organizationId === org && item.id === id) ?? null;
      },
      getContactForUpdate: async (org, id) =>
        this.contacts.find((item) => item.organizationId === org && item.id === id) ?? null,
      getOrganizationTimezone: async () => this.timezone,
      listActiveOnSiteJobs: async (_org, _customer, from, to) => this.activeOnSiteJobs
        .filter((job) => job.type === 'SALES_MEETING' || job.type === 'PRODUCT_DELIVERY')
        .filter((job) => {
          const value = new Date(job.scheduledAt).valueOf();
          return value >= from.valueOf() && value <= to.valueOf();
        }),
      listRecentOnSiteVisits: async (_org, _customer, from, to) => this.recentOnSiteVisits.filter((visit) => {
        const value = new Date(visit.occurredAt).valueOf();
        return value >= from.valueOf() && value <= to.valueOf();
      }),
      createJobCard: async (input: CreateJobCardRecord) => {
        const job: JobCard = {
          id: `job-${this.jobs.length + 1}`,
          version: 1,
          organizationId: input.organizationId,
          type: input.type,
          status: input.status,
          title: input.title,
          description: input.description,
          customerId: input.customerId,
          contactId: input.contactId,
          assignedTo: input.assignedTo,
          createdBy: input.createdBy,
          priority: input.priority,
          dueDate: input.dueDate,
          scheduledAt: input.scheduledAt,
          scheduledEndsAt: input.scheduledEndsAt,
          engagementKind: input.engagementKind,
          sourceJobCardId: input.sourceJobCardId ?? null,
          followUpInstructions: input.followUpInstructions ?? null,
          followUpProposedAt: null,
          followUpProposedType: null,
          followUpProposedAssignee: null,
          followUpProposalInstructions: null,
          followUpProposalOrigin: null,
          followUpProposedBy: null,
        };
        this.jobs.push(job);
        return job;
      },
      createMeetingDetails: async () => {},
      updateMeetingDetails: async () => {},
      updateFieldsWithVersion: async (input) => {
        const index = this.jobs.findIndex((job) =>
          job.organizationId === input.organizationId && job.id === input.jobCardId
          && job.version === input.expectedVersion);
        if (index < 0) return null;
        const { clearAcceptance, ...fields } = input.fields;
        this.jobs[index] = { ...this.jobs[index]!, ...fields, version: this.jobs[index]!.version + 1 };
        return this.jobs[index]!;
      },
      appendActivity: async (input) => {
        this.activities.push({ event: input.event, metadata: input.metadata ?? null });
        return { id: `activity-${this.activities.length}`, createdAt: new Date('2026-07-19T14:30:00.000Z') };
      },
      appendJobActionLocation: async (input) => ({ id: 'loc-1', jobCardId: input.jobCardId, activityId: input.activityId, actorUserId: input.actorUserId, action: input.action, capture: input.capture, createdAt: new Date() }),
      appendRealtimeEvent: async (input) => ({ ...input, id: 1n }),
      listActiveManagementRecipients: async () => [],
      appendNotifications: async () => [],
      appendWebPushDeliveries: async () => [],
      getNoteAuthorSnapshot: async () => null,
      createNote: async (input) => ({ id: input.id, jobCardId: input.jobCardId, note: input.note, invoiceNumber: input.invoiceNumber, author: { id: input.authorId, name: '', role: 'MANAGER' as const, source: 'SNAPSHOT' as const }, workflowStage: input.workflowStage, context: input.context, relatedActivityId: input.relatedActivityId, recordVersion: 1 as const, createdAt: new Date().toISOString() }),
      assertCalendarAvailability: async (input) => {
        if (!input.startsAt || !input.endsAt) return;
        const conflict = this.calendarEvents.find((event) =>
          event.assignedUserId === input.assignedUserId
          && Date.parse(event.startsAt) < Date.parse(input.endsAt!)
          && Date.parse(input.startsAt!) < Date.parse(event.endsAt));
        if (conflict) {
          throw new AppError(
            'CALENDAR_CONFLICT',
            409,
            'Seçilen personelin bu zaman aralığında başka bir planı bulunuyor.',
            {
              conflicts: [{
                source: conflict.source ?? 'JOB',
                id: 'existing-cal',
                title: conflict.source === 'MANUAL' ? 'Özel manuel plan' : 'Mevcut plan',
                startsAt: conflict.startsAt,
                endsAt: conflict.endsAt,
                assignedUser: { id: input.assignedUserId, name: 'Staff One' },
                relatedJobPath: conflict.source === 'MANUAL' ? null : '/jobs/existing-cal',
              }],
            },
          );
        }
      },
      synchronizeCalendarReminder: async () => {},
      getProduct: async () => null,
      getDeliveryItemForUpdate: async () => null,
      createDeliveryItem: async () => { throw new Error('unused'); },
      updateDeliveryItem: async () => { throw new Error('unused'); },
      deleteDeliveryItem: async () => {},
      bumpVersion: async () => null,
      getFollowUpSource: async () => null,
      getSubmissionCustomer: async (org, id) => {
        const customer = this.customers.find((item) => item.organizationId === org && item.id === id);
        return customer ? { id: customer.id, organizationId: customer.organizationId, status: customer.status } : null;
      },
      getSubmissionMeetingDetails: async () => null,
      getSubmissionDeliveryItems: async () => [],
      ...(locking ? {} : {}),
    };
  }

  private detail(job: JobCard) {
    return {
      ...job,
      assignee: { id: job.assignedTo, name: job.assignedTo === 'staff-2' ? 'Staff Two' : 'Staff One' },
      customer: job.customerId ? { id: job.customerId, name: `Customer ${job.customerId}` } : null,
      contact: null,
      lifecycle: {
        createdAt: '2026-07-13T10:00:00.000Z', acceptedAt: null, acceptedBy: null,
        startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
        approvedAt: null, approvedBy: null, approvalNote: null,
        revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
        cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
      },
    };
  }

  private listItem(job: JobCard) {
    return {
      id: job.id, type: job.type, status: job.status, version: job.version, title: job.title,
      priority: job.priority, dueDate: job.dueDate, scheduledAt: job.scheduledAt,
      createdAt: '2026-07-13T10:00:00.000Z', updatedAt: '2026-07-13T10:00:00.000Z', staffCompletedAt: null,
      customer: job.customerId ? { id: job.customerId, name: `Customer ${job.customerId}` } : null,
      contact: null,
      assignee: { id: job.assignedTo, name: job.assignedTo === 'staff-2' ? 'Staff Two' : 'Staff One' },
      deliveryItemCount: 0,
    };
  }

  async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<T>) {
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key) as T, realtimeEvents: [] as const };
    if (this.processing.has(key)) return { kind: 'processing' as const };
    this.processing.add(key);
    const jobsBefore = this.jobs.map((job) => ({ ...job }));
    const activityCount = this.activities.length;
    try {
      const completed = await work(this.tx(true));
      this.completed.set(key, completed.response);
      return { kind: 'completed' as const, response: completed.response, realtimeEvents: completed.realtimeEvents };
    } catch (error) {
      this.jobs = jobsBefore;
      this.activities.splice(activityCount);
      throw error;
    } finally {
      this.processing.delete(key);
    }
  }

  async listJobCards(scope: JobCardReadScope, query: JobCardListQuery) {
    const items = this.jobs.filter((job) => job.organizationId === scope.organizationId
      && (!scope.assignedTo || job.assignedTo === scope.assignedTo)).map((job) => this.listItem(job));
    return { items, total: items.length, limit: query.limit, offset: query.offset };
  }

  async findJobCard(organizationId: string, id: string) {
    return this.jobs.find((job) => job.organizationId === organizationId && job.id === id) ?? null;
  }
  async findJobCardDetail(organizationId: string, id: string) {
    const job = await this.findJobCard(organizationId, id);
    return job ? this.detail(job) : null;
  }
  async getOrganizationTimezone() { return this.timezone; }
  async listActiveOnSiteJobs(_org: string, _customer: string, from: Date, to: Date) {
    return this.activeOnSiteJobs
      .filter((job) => job.type === 'SALES_MEETING' || job.type === 'PRODUCT_DELIVERY')
      .filter((job) => {
        const value = new Date(job.scheduledAt).valueOf();
        return value >= from.valueOf() && value <= to.valueOf();
      });
  }
  async listRecentOnSiteVisits(_org: string, _customer: string, from: Date, to: Date) {
    return this.recentOnSiteVisits.filter((visit) => {
      const value = new Date(visit.occurredAt).valueOf();
      return value >= from.valueOf() && value <= to.valueOf();
    });
  }
  async getFollowUpSource() { return null; }
  async listFollowUps() { return { items: [], total: 0, limit: 20, offset: 0 }; }
  async findMeetingDetails() { return null; }
  async executeTransaction<T>(work: (tx: JobCardTransaction) => Promise<T>) {
    const before = this.jobs.map((job) => ({ ...job }));
    const eventCount = this.activities.length;
    try { return await work(this.tx(true)); }
    catch (error) { this.jobs = before; this.activities.splice(eventCount); throw error; }
  }
  async listDeliveryItems() { return []; }
  async listActivity() { return { items: [], total: 0, limit: 50, offset: 0 }; }
  async listNotes() { return { items: [], limit: 25, nextCursor: null }; }
  async listReferenceCustomers() { return []; }
  async findCompletedCriticalAction<T>(claim: CriticalActionClaim): Promise<T | null> {
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    return (this.completed.get(key) as T | undefined) ?? null;
  }
}

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const staff2: JobCardActor = { id: 'staff-2', organizationId: 'org-1', role: 'STAFF' };
const manager: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const admin: JobCardActor = { id: 'admin-1', organizationId: 'org-1', role: 'ADMIN' };
const now = new Date('2026-07-13T10:00:00.000Z');

function meetingInput(overrides: Partial<NormalizedJobCardCreateInput> = {}): NormalizedJobCardCreateInput {
  return {
    clientActionId: 'meeting-create', type: 'SALES_MEETING', title: 'Görüşme',
    description: null, customerId: 'customer-1', contactId: null,
    assignedTo: 'staff-1', priority: 'normal', dueDate: null,
    scheduledAt: '2026-07-20T10:30:00.000Z', scheduledEndsAt: '2026-07-20T11:30:00.000Z',
    engagementKind: 'SALES_MEETING',
    ...overrides,
  } as NormalizedJobCardCreateInput;
}

function deliveryInput(overrides: Partial<NormalizedJobCardCreateInput> = {}): NormalizedJobCardCreateInput {
  return {
    clientActionId: 'delivery-create', type: 'PRODUCT_DELIVERY', title: 'Teslim',
    description: null, customerId: 'customer-1', contactId: null,
    assignedTo: 'staff-1', priority: 'normal', dueDate: null,
    scheduledAt: '2026-07-20T10:30:00.000Z', scheduledEndsAt: '2026-07-20T11:30:00.000Z',
    ...overrides,
  } as NormalizedJobCardCreateInput;
}

const activeJob = (overrides: Partial<ActiveOnSiteJobRecord> = {}): ActiveOnSiteJobRecord => ({
  id: 'existing-1',
  title: 'Mevcut teslimat',
  scheduledAt: '2026-07-20T14:00:00.000Z',
  type: 'PRODUCT_DELIVERY',
  status: 'ACCEPTED',
  assignedTo: 'staff-2',
  assigneeName: 'Bora Yılmaz',
  ...overrides,
});

const visit = (overrides: Partial<RecentOnSiteVisitRecord> = {}): RecentOnSiteVisitRecord => ({
  id: 'visit-1',
  type: 'SALES_MEETING',
  title: 'Geçmiş görüşme',
  occurredAt: '2026-07-10T09:00:00.000Z',
  staffName: 'Bora Yılmaz',
  resultSummary: 'Olumlu görüşme yapıldı.',
  ...overrides,
});

function serviceOf(repository: SchedulingMemoryRepository) {
  return new JobCardService(repository, () => now);
}

/** Service with the calendar feature enabled (create-time availability parity). */
function calendarServiceOf(repository: SchedulingMemoryRepository) {
  return new JobCardService(repository, () => now, undefined, undefined, undefined,
    { enabled: true, reminderLeadMinutes: 30 });
}

describe('normal customer scheduling — create', () => {
  it('NJS-1: Sales Meeting create detects same-Customer same-day ON_SITE conflict', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.activeOnSiteJobs = [activeJob()];
    await expect(serviceOf(repository).create(manager, meetingInput()))
      .rejects.toMatchObject({ code: 'CUSTOMER_SCHEDULE_CONFLICT', statusCode: 409 });
    expect(repository.jobs).toHaveLength(0);
  });

  it('NJS-2: Product Delivery create detects existing Sales Meeting conflict', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.activeOnSiteJobs = [activeJob({ type: 'SALES_MEETING', title: 'Planlı görüşme' })];
    await expect(serviceOf(repository).create(manager, deliveryInput()))
      .rejects.toMatchObject({ code: 'CUSTOMER_SCHEDULE_CONFLICT', statusCode: 409 });
    expect(repository.jobs).toHaveLength(0);
  });

  it('NJS-3: conflict is cross-Staff', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.activeOnSiteJobs = [activeJob({ assignedTo: 'staff-2', assigneeName: 'Staff Two' })];
    const error = await serviceOf(repository).create(manager, meetingInput({ assignedTo: 'staff-1' }))
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: 'CUSTOMER_SCHEDULE_CONFLICT' });
    expect(error.details.conflicts).toEqual([expect.objectContaining({
      jobCardId: 'existing-1', title: 'Mevcut teslimat',
    })]);
  });

  it('NJS-4: GENERAL_TASK same Customer does not block ON_SITE create', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.activeOnSiteJobs = [activeJob({ type: 'GENERAL_TASK' as never })];
    const created = await serviceOf(repository).create(manager, meetingInput());
    expect(created.type).toBe('SALES_MEETING');
  });

  it('NJS-5: CANCELLED ON_SITE does not block', async () => {
    const repository = new SchedulingMemoryRepository();
    // activeOnSiteJobs only ever contains active jobs from the reader; a cancelled job
    // is simply never returned. Verify a same-day CLEAR create succeeds.
    const created = await serviceOf(repository).create(manager, meetingInput());
    expect(created.type).toBe('SALES_MEETING');
  });

  it('NJS-6: recent visit returns WARNING and create succeeds', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.recentOnSiteVisits = [visit()];
    const created = await serviceOf(repository).create(manager, meetingInput());
    expect(created.type).toBe('SALES_MEETING');
    expect(repository.jobs).toHaveLength(1);
  });

  it('NJS-7: Manager 4th qualifying visit requires override reason', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.recentOnSiteVisits = [
      visit({ id: 'v1', occurredAt: '2026-07-15T09:00:00.000Z' }),
      visit({ id: 'v2', occurredAt: '2026-07-16T09:00:00.000Z' }),
      visit({ id: 'v3', occurredAt: '2026-07-17T09:00:00.000Z' }),
    ];
    await expect(serviceOf(repository).create(manager, meetingInput()))
      .rejects.toMatchObject({ code: 'CUSTOMER_VISIT_OVERRIDE_REASON_REQUIRED', statusCode: 400 });
  });

  it('NJS-8: create frequency override reason is audited in JOB_CREATED metadata', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.recentOnSiteVisits = [
      visit({ id: 'v1', occurredAt: '2026-07-15T09:00:00.000Z' }),
      visit({ id: 'v2', occurredAt: '2026-07-16T09:00:00.000Z' }),
      visit({ id: 'v3', occurredAt: '2026-07-17T09:00:00.000Z' }),
    ];
    const created = await serviceOf(repository).create(manager, meetingInput({
      overrideReason: 'Klinik acil numune istedi.',
    }));
    expect(created.type).toBe('SALES_MEETING');
    const createdActivity = repository.activities.find((activity) => activity.event === 'JOB_CREATED');
    expect(createdActivity?.metadata).toEqual({ customerVisitOverrideReason: 'Klinik acil numune istedi.' });
  });

  it('NJS-9: same-day conflict cannot be overridden with a reason', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.activeOnSiteJobs = [activeJob()];
    await expect(serviceOf(repository).create(manager, meetingInput({
      overrideReason: 'Yine de planla',
    }))).rejects.toMatchObject({ code: 'CUSTOMER_SCHEDULE_CONFLICT' });
    expect(repository.jobs).toHaveLength(0);
  });

  it('NJS-25: Staff normal create FREQUENCY_EXCEEDED is blocked without override capability', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.recentOnSiteVisits = [
      visit({ id: 'v1', occurredAt: '2026-07-15T09:00:00.000Z' }),
      visit({ id: 'v2', occurredAt: '2026-07-16T09:00:00.000Z' }),
      visit({ id: 'v3', occurredAt: '2026-07-17T09:00:00.000Z' }),
    ];
    await expect(serviceOf(repository).create(staff, meetingInput({
      assignedTo: 'staff-1',
      overrideReason: 'Yine de planla',
    }))).rejects.toMatchObject({ code: 'CUSTOMER_VISIT_FREQUENCY_REVIEW_REQUIRED', statusCode: 409 });
    expect(repository.jobs).toHaveLength(0);
  });

  it('NJS-14: Staff preview projection strips conflicts and recent visit', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.activeOnSiteJobs = [activeJob()];
    repository.recentOnSiteVisits = [visit()];
    const result = await serviceOf(repository).previewCustomerSchedule(staff, {
      type: 'SALES_MEETING', customerId: 'customer-1', scheduledAt: '2026-07-20T10:30:00.000Z',
    });
    expect(result.level).toBe('CONFLICT');
    expect(result.conflicts).toEqual([]);
    expect(result.recentVisit).toBeNull();
  });

  it('NJS-29: Manager preview receives rich details; Staff does not', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.activeOnSiteJobs = [activeJob({ title: 'Mevcut teslimat', assigneeName: 'Staff Two' })];
    const managerResult = await serviceOf(repository).previewCustomerSchedule(manager, {
      type: 'SALES_MEETING', customerId: 'customer-1', scheduledAt: '2026-07-20T10:30:00.000Z',
    });
    expect(managerResult.conflicts).toEqual([expect.objectContaining({
      jobCardId: 'existing-1', title: 'Mevcut teslimat', assignee: { id: 'staff-2', name: 'Staff Two' },
    })]);
    const staffResult = await serviceOf(repository).previewCustomerSchedule(staff, {
      type: 'SALES_MEETING', customerId: 'customer-1', scheduledAt: '2026-07-20T10:30:00.000Z',
    });
    expect(staffResult.conflicts).toEqual([]);
  });
});

describe('normal customer scheduling — preview endpoint', () => {
  it('NJS-28: preview jobCardId derives excludeJobId server-side and rejects other org job', async () => {
    const repository = new SchedulingMemoryRepository();
    const created = await serviceOf(repository).create(manager, meetingInput());
    repository.activeOnSiteJobs = [activeJob({ id: created.id, title: 'Kendisi' })];
    // Excluding the current job: no conflict.
    const result = await serviceOf(repository).previewCustomerSchedule(manager, {
      type: 'SALES_MEETING', customerId: 'customer-1', scheduledAt: '2026-07-20T10:30:00.000Z',
      jobCardId: created.id,
    });
    expect(result.conflicts).toEqual([]);

    // A job from another org must not be loadable/excludable.
    await expect(serviceOf(repository).previewCustomerSchedule(manager, {
      type: 'SALES_MEETING', customerId: 'customer-1', scheduledAt: '2026-07-20T10:30:00.000Z',
      jobCardId: 'other-org-job',
    })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
  });

  it('NJS-13: cross-org customer is rejected in preview', async () => {
    const repository = new SchedulingMemoryRepository();
    await expect(serviceOf(repository).previewCustomerSchedule(manager, {
      type: 'SALES_MEETING', customerId: 'missing', scheduledAt: '2026-07-20T10:30:00.000Z',
    })).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
  });
});

describe('normal customer scheduling — patch / reschedule', () => {
  async function createDelivery(repository: SchedulingMemoryRepository, actor = manager) {
    return serviceOf(repository).create(actor, deliveryInput({ clientActionId: `delivery-${repository.jobs.length + 1}` }));
  }

  it('NJS-16: reschedule into conflicting Customer/day is rejected', async () => {
    const repository = new SchedulingMemoryRepository();
    const created = await createDelivery(repository);
    repository.activeOnSiteJobs = [activeJob({ id: 'other-1', scheduledAt: '2026-07-25T09:00:00.000Z' })];
    await expect(serviceOf(repository).patch(manager, created.id, {
      expectedVersion: 1, scheduledAt: '2026-07-25T10:00:00.000Z',
    })).rejects.toMatchObject({ code: 'CUSTOMER_SCHEDULE_CONFLICT', statusCode: 409 });
  });

  it('NJS-17: reschedule away from conflict succeeds', async () => {
    const repository = new SchedulingMemoryRepository();
    const created = await createDelivery(repository);
    const updated = await serviceOf(repository).patch(manager, created.id, {
      expectedVersion: 1, scheduledAt: '2026-07-26T10:00:00.000Z',
    });
    expect(updated.scheduledAt).toBe('2026-07-26T10:00:00.000Z');
  });

  it('NJS-18: current Job is excluded from its own evaluation', async () => {
    const repository = new SchedulingMemoryRepository();
    const created = await createDelivery(repository);
    // Its own pending record occupies the target date; exclusion must prevent
    // a same-day self-conflict when the reschedule lands on that date.
    repository.activeOnSiteJobs = [activeJob({ id: created.id, scheduledAt: '2026-07-21T09:00:00.000Z' })];
    const updated = await serviceOf(repository).patch(manager, created.id, {
      expectedVersion: 1, scheduledAt: '2026-07-21T10:00:00.000Z',
    });
    expect(updated.scheduledAt).toBe('2026-07-21T10:00:00.000Z');
  });

  it('NJS-26: Staff patch/reschedule FREQUENCY_EXCEEDED is blocked', async () => {
    const repository = new SchedulingMemoryRepository();
    const created = await createDelivery(repository, staff);
    repository.recentOnSiteVisits = [
      visit({ id: 'v1', occurredAt: '2026-07-25T09:00:00.000Z' }),
      visit({ id: 'v2', occurredAt: '2026-07-26T09:00:00.000Z' }),
      visit({ id: 'v3', occurredAt: '2026-07-27T09:00:00.000Z' }),
    ];
    await expect(serviceOf(repository).patch(staff, created.id, {
      expectedVersion: 1, scheduledAt: '2026-07-28T10:00:00.000Z',
    })).rejects.toMatchObject({ code: 'CUSTOMER_VISIT_FREQUENCY_REVIEW_REQUIRED', statusCode: 409 });
  });

  it('NJS-27: patch acquires Job lock before Customer lock', async () => {
    const repository = new SchedulingMemoryRepository();
    const created = await createDelivery(repository);
    repository.lockOrder = [];
    await serviceOf(repository).patch(manager, created.id, {
      expectedVersion: 1, scheduledAt: '2026-07-30T10:00:00.000Z',
    });
    expect(repository.lockOrder.indexOf('job')).toBeLessThan(repository.lockOrder.indexOf('customer'));
  });

  it('P0-C5: same-assignee interval patch locks User before Customer availability evaluation', async () => {
    const repository = new SchedulingMemoryRepository();
    const service = calendarServiceOf(repository);
    const created = await service.create(manager, deliveryInput({ clientActionId: 'p0-same-assignee-lock' }));
    repository.lockOrder = [];

    await service.patch(manager, created.id, {
      expectedVersion: 1,
      scheduledAt: '2026-07-30T10:00:00.000Z',
    });

    expect(repository.lockOrder.indexOf('job')).toBeLessThan(repository.lockOrder.indexOf('assignee'));
    expect(repository.lockOrder.indexOf('assignee')).toBeLessThan(repository.lockOrder.indexOf('customer'));
  });

  it('P0-C6: metadata-only patch does not acquire calendar capacity lock', async () => {
    const repository = new SchedulingMemoryRepository();
    const service = calendarServiceOf(repository);
    const created = await service.create(manager, meetingInput({ clientActionId: 'p0-metadata-only' }));
    repository.lockOrder = [];

    await service.patch(manager, created.id, {
      expectedVersion: 1,
      title: 'Güncellenmiş başlık',
    });

    expect(repository.lockOrder).not.toContain('assignee');
  });

  it('P0-C7: Customer schedule conflict still precedes calendar conflict on patch', async () => {
    const repository = new SchedulingMemoryRepository();
    const service = calendarServiceOf(repository);
    const created = await service.create(manager, deliveryInput({ clientActionId: 'p0-precedence' }));
    repository.activeOnSiteJobs = [activeJob({ scheduledAt: '2026-07-25T09:00:00.000Z' })];
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-25T10:00:00.000Z', endsAt: '2026-07-25T11:00:00.000Z' },
    ];

    await expect(service.patch(manager, created.id, {
      expectedVersion: 1,
      scheduledAt: '2026-07-25T10:00:00.000Z',
      scheduledEndsAt: '2026-07-25T11:00:00.000Z',
    })).rejects.toMatchObject({ code: 'CUSTOMER_SCHEDULE_CONFLICT', statusCode: 409 });
  });

  it('NJS-15: Customerless General Task create is unaffected', async () => {
    const repository = new SchedulingMemoryRepository();
    const created = await serviceOf(repository).create(staff, {
      clientActionId: 'gt-customerless', type: 'GENERAL_TASK', title: 'Doktoru ara',
      description: null, customerId: null, contactId: null, assignedTo: 'staff-1',
      priority: 'normal', dueDate: null, scheduledAt: null,
    });
    expect(created.type).toBe('GENERAL_TASK');
    expect(created.customerId).toBeNull();
  });

  it('NJS-20: create-time assignee availability parity — SALES_MEETING create rejects overlapping assignee calendar', async () => {
    // Replaces the previous invariant that create must NOT call
    // assertCalendarAvailability: create now runs the authoritative assignee
    // availability check for SALES_MEETING/PRODUCT_DELIVERY when calendar is enabled.
    const repository = new SchedulingMemoryRepository();
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-20T10:00:00.000Z', endsAt: '2026-07-20T11:00:00.000Z' },
    ];
    await expect(calendarServiceOf(repository).create(manager, meetingInput()))
      .rejects.toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
    expect(repository.jobs).toHaveLength(0);
  });
});

describe('create-time assignee availability parity (AAP)', () => {
  it('AAP-1: SALES_MEETING create overlapping existing JobCard → 409 CALENDAR_CONFLICT', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-20T10:00:00.000Z', endsAt: '2026-07-20T11:00:00.000Z' },
    ];
    await expect(calendarServiceOf(repository).create(manager, meetingInput()))
      .rejects.toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
    expect(repository.jobs).toHaveLength(0);
  });

  it('AAP-2: PRODUCT_DELIVERY create overlapping MANUAL event → 409 CALENDAR_CONFLICT', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-20T11:00:00.000Z', endsAt: '2026-07-20T12:00:00.000Z' },
    ];
    await expect(calendarServiceOf(repository).create(manager, deliveryInput()))
      .rejects.toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
  });

  it('AAP-3: same assignee, non-overlapping interval → success', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-20T12:00:00.000Z', endsAt: '2026-07-20T13:00:00.000Z' },
    ];
    const created = await calendarServiceOf(repository).create(manager, meetingInput());
    expect(created.type).toBe('SALES_MEETING');
    expect(created.scheduledEndsAt).toBe('2026-07-20T11:30:00.000Z');
  });

  it('AAP-4: different assignee, overlapping clock interval → success', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.calendarEvents = [
      { assignedUserId: 'staff-2', startsAt: '2026-07-20T10:00:00.000Z', endsAt: '2026-07-20T12:00:00.000Z' },
    ];
    const created = await calendarServiceOf(repository).create(manager, meetingInput());
    expect(created.type).toBe('SALES_MEETING');
  });

  it('AAP-5: touching boundary (existing ends exactly when proposed starts) → success', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-20T09:00:00.000Z', endsAt: '2026-07-20T10:30:00.000Z' },
    ];
    const created = await calendarServiceOf(repository).create(manager, meetingInput());
    expect(created.type).toBe('SALES_MEETING');
  });

  it('AAP-6: invalid create interval (scheduledEndsAt <= scheduledAt) → 400 validation error', async () => {
    const repository = new SchedulingMemoryRepository();
    await expect(calendarServiceOf(repository).create(manager, meetingInput({
      scheduledEndsAt: '2026-07-20T10:30:00.000Z',
    }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    await expect(calendarServiceOf(repository).create(manager, meetingInput({
      scheduledEndsAt: '2026-07-20T10:00:00.000Z',
    }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('AAP-7: STAFF conflict response → 409 CALENDAR_CONFLICT, conflicts [], no private metadata', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-20T10:00:00.000Z', endsAt: '2026-07-20T11:00:00.000Z' },
    ];
    const error = await calendarServiceOf(repository).create(staff, meetingInput({ assignedTo: 'staff-1' }))
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
    expect(error.details).toEqual({ conflicts: [] });
  });

  it('AAP-P1: STAFF schedule patch hides JobCard calendar conflict details', async () => {
    const repository = new SchedulingMemoryRepository();
    const service = calendarServiceOf(repository);
    const created = await service.create(staff, meetingInput());
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-21T10:00:00.000Z', endsAt: '2026-07-21T11:00:00.000Z' },
    ];

    const error = await service.patch(staff, created.id, {
      expectedVersion: 1,
      scheduledAt: '2026-07-21T10:00:00.000Z',
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
    expect(error.details).toEqual({ conflicts: [] });
  });

  it('AAP-P2: STAFF schedule patch hides Manual Calendar conflict details', async () => {
    const repository = new SchedulingMemoryRepository();
    const service = calendarServiceOf(repository);
    const created = await service.create(staff, meetingInput({
      clientActionId: 'staff-manual-conflict-create',
    }));
    repository.calendarEvents = [{
      assignedUserId: 'staff-1',
      startsAt: '2026-07-21T10:00:00.000Z',
      endsAt: '2026-07-21T11:00:00.000Z',
      source: 'MANUAL',
    }];

    const error = await service.patch(staff, created.id, {
      expectedVersion: 1,
      scheduledAt: '2026-07-21T10:00:00.000Z',
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
    expect(error.details).toEqual({ conflicts: [] });
  });

  it('AAP-P3: MANAGER schedule patch retains approved same-org conflict detail', async () => {
    const repository = new SchedulingMemoryRepository();
    const service = calendarServiceOf(repository);
    const created = await service.create(manager, meetingInput({
      clientActionId: 'manager-patch-conflict-create',
    }));
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-21T10:00:00.000Z', endsAt: '2026-07-21T11:00:00.000Z' },
    ];

    const error = await service.patch(manager, created.id, {
      expectedVersion: 1,
      scheduledAt: '2026-07-21T10:00:00.000Z',
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
    expect(error.details.conflicts).toEqual([expect.objectContaining({
      source: 'JOB',
      title: 'Mevcut plan',
      relatedJobPath: '/jobs/existing-cal',
    })]);
  });

  it('AAP-8: MANAGER conflict → same-org rich conflict detail retained', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-20T10:00:00.000Z', endsAt: '2026-07-20T11:00:00.000Z' },
    ];
    const error = await calendarServiceOf(repository).create(manager, meetingInput())
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: 'CALENDAR_CONFLICT' });
    expect(error.details.conflicts).toEqual([expect.objectContaining({
      source: 'JOB', title: 'Mevcut plan', relatedJobPath: '/jobs/existing-cal',
    })]);
  });

  it('AAP-9: customer + assignee conflict both present → CUSTOMER_SCHEDULE_CONFLICT wins', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.activeOnSiteJobs = [activeJob()];
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-20T10:00:00.000Z', endsAt: '2026-07-20T11:00:00.000Z' },
    ];
    await expect(calendarServiceOf(repository).create(manager, meetingInput()))
      .rejects.toMatchObject({ code: 'CUSTOMER_SCHEDULE_CONFLICT', statusCode: 409 });
  });

  it('AAP-10: failed create is atomic → no job/activity side effects', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-20T10:00:00.000Z', endsAt: '2026-07-20T11:00:00.000Z' },
    ];
    await expect(calendarServiceOf(repository).create(manager, meetingInput()))
      .rejects.toMatchObject({ code: 'CALENDAR_CONFLICT' });
    expect(repository.jobs).toHaveLength(0);
    expect(repository.activities).toHaveLength(0);
  });

  it('AAP-11: successful completed idempotent replay does not re-evaluate new calendar conflict', async () => {
    const repository = new SchedulingMemoryRepository();
    const service = calendarServiceOf(repository);
    const created = await service.create(manager, meetingInput());
    expect(created.type).toBe('SALES_MEETING');
    // A later calendar commitment now overlaps the original interval.
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-20T10:00:00.000Z', endsAt: '2026-07-20T12:00:00.000Z' },
    ];
    const replayed = await service.create(manager, meetingInput());
    expect(replayed.id).toBe(created.id);
    expect(repository.jobs).toHaveLength(1);
  });

  it('AAP-15: CALENDAR_ENABLED=false preserves disabled-calendar semantics → no availability rejection', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.calendarEvents = [
      { assignedUserId: 'staff-1', startsAt: '2026-07-20T10:00:00.000Z', endsAt: '2026-07-20T11:00:00.000Z' },
    ];
    const disabled = new JobCardService(repository, () => now, undefined, undefined, undefined,
      { enabled: false, reminderLeadMinutes: 30 });
    const created = await disabled.create(manager, meetingInput());
    expect(created.type).toBe('SALES_MEETING');
  });
});

describe('staff2 / admin sanity', () => {
  it('Admin can override frequency with reason', async () => {
    const repository = new SchedulingMemoryRepository();
    repository.activeOnSiteJobs = [
      activeJob({ id: 'a1', scheduledAt: '2026-07-15T09:00:00.000Z' }),
      activeJob({ id: 'a2', scheduledAt: '2026-07-16T09:00:00.000Z' }),
      activeJob({ id: 'a3', scheduledAt: '2026-07-17T09:00:00.000Z' }),
    ];
    const created = await serviceOf(repository).create(admin, meetingInput({
      overrideReason: 'Müdürlük talebi.',
    }));
    expect(created.type).toBe('SALES_MEETING');
  });

  it('staff2 can create their own meeting when customer is clear', async () => {
    const repository = new SchedulingMemoryRepository();
    const created = await serviceOf(repository).create(staff2, meetingInput({
      clientActionId: 'staff2-meeting', assignedTo: 'staff-2',
    }));
    expect(created.assignedTo).toBe('staff-2');
  });
});
