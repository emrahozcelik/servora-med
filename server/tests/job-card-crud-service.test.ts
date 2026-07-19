import { describe, expect, it } from 'vitest';

import type {
  CreateJobCardRecord,
  CriticalActionClaim,
  JobCardReadScope,
  JobCardRepository,
  JobCardTransaction,
} from '../src/modules/job-cards/repository.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
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

class CrudMemoryRepository implements JobCardRepository {
  assignees: JobCardAssignee[] = [
    { id: 'staff-1', organizationId: 'org-1', role: 'STAFF', isActive: true },
    { id: 'staff-2', organizationId: 'org-1', role: 'STAFF', isActive: true },
  ];
  customers = [
    { id: 'customer-1', organizationId: 'org-1', status: 'active' as const },
    { id: 'customer-2', organizationId: 'org-1', status: 'active' as const },
    { id: 'customer-inactive', organizationId: 'org-1', status: 'inactive' as const },
  ];
  contacts = [
    { id: 'contact-1', organizationId: 'org-1', customerId: 'customer-1', isActive: true },
    { id: 'contact-2', organizationId: 'org-1', customerId: 'customer-2', isActive: true },
    { id: 'contact-inactive', organizationId: 'org-1', customerId: 'customer-1', isActive: false },
    { id: 'contact-cross-org', organizationId: 'org-2', customerId: 'customer-1', isActive: true },
  ];
  jobs: JobCard[] = [];
  activities: string[] = [];
  assigneeLookupCount = 0;
  completed = new Map<string, unknown>();
  processing = new Set<string>();
  failActivity = false;
  listCalls: Array<{ scope: JobCardReadScope; query: JobCardListQuery }> = [];

  acceptance = new Map<string, { acceptedAt: string; acceptedBy: string }>();

  private detail(job: JobCard) {
    const acceptance = this.acceptance.get(job.id);
    return {
      ...job,
      assignee: { id: job.assignedTo, name: job.assignedTo === 'staff-2' ? 'Staff Two' : 'Staff One' },
      customer: job.customerId ? { id: job.customerId, name: `Customer ${job.customerId}` } : null,
      contact: job.contactId ? { id: job.contactId, name: `Contact ${job.contactId}` } : null,
      lifecycle: {
        createdAt: '2026-07-13T10:00:00.000Z',
        acceptedAt: acceptance?.acceptedAt ?? null,
        acceptedBy: acceptance
          ? {
            id: acceptance.acceptedBy,
            name: acceptance.acceptedBy === 'staff-2' ? 'Staff Two' : 'Staff One',
          }
          : null,
        startedAt: null, submittedAt: null, submittedBy: null,
        submissionNote: null, approvedAt: null, approvedBy: null, approvalNote: null,
        revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
        cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
      },
    };
  }

  private listItem(job: JobCard) {
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      version: job.version,
      title: job.title,
      priority: job.priority,
      dueDate: job.dueDate,
      scheduledAt: job.scheduledAt,
      createdAt: '2026-07-13T10:00:00.000Z',
      updatedAt: '2026-07-13T10:00:00.000Z',
      staffCompletedAt: null,
      customer: job.customerId ? { id: job.customerId, name: `Customer ${job.customerId}` } : null,
      contact: job.contactId ? { id: job.contactId, name: `Contact ${job.contactId}` } : null,
      assignee: {
        id: job.assignedTo,
        name: job.assignedTo === 'staff-2' ? 'Staff Two' : 'Staff One',
      },
      deliveryItemCount: 0,
    };
  }

  async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<T>) {
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key) as T };
    if (this.processing.has(key)) return { kind: 'processing' as const };
    this.processing.add(key);
    const jobsBefore = this.jobs.map((job) => ({ ...job }));
    const acceptanceBefore = new Map(this.acceptance);
    const activityCount = this.activities.length;
    const tx: JobCardTransaction = {
      getJob: async () => null,
      getJobForUpdate: async () => null,
      getJobDetail: async (org, id) => {
        const job = this.jobs.find((item) => item.organizationId === org && item.id === id);
        return job ? this.detail(job) : null;
      },
      transitionWithVersion: async () => null,
      getAssignee: async (org, id) => this.assignees.find((item) => item.organizationId === org && item.id === id) ?? null,
      getAssigneeForUpdate: async (org, id) => {
        this.assigneeLookupCount += 1;
        return this.assignees.find((item) => item.organizationId === org && item.id === id) ?? null;
      },
      customerExists: async (org, id) => this.customers.some((item) => item.organizationId === org && item.id === id),
      getCustomerForUpdate: async (org, id) => this.customers.find((item) => item.organizationId === org && item.id === id) ?? null,
      getContactForUpdate: async (org, id) => this.contacts.find((item) => item.organizationId === org && item.id === id) ?? null,
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
        };
        this.jobs.push(job);
        if (input.acceptedAt && input.acceptedBy) {
          this.acceptance.set(job.id, {
            acceptedAt: input.acceptedAt.toISOString(),
            acceptedBy: input.acceptedBy,
          });
        }
        return job;
      },
      createMeetingDetails: async () => {},
      appendActivity: async (input) => {
        if (this.failActivity) throw new Error('activity failed');
        this.activities.push(input.event);
        return { id: `activity-${this.activities.length}`, createdAt: new Date('2026-07-19T14:30:00.000Z') };
      },
      appendRealtimeEvent: async () => { throw new Error('appendRealtimeEvent not implemented'); },
    };
    try {
      const response = await work(tx); this.completed.set(key, response);
      return { kind: 'completed' as const, response };
    } catch (error) {
      this.jobs = jobsBefore;
      this.acceptance = acceptanceBefore;
      this.activities.splice(activityCount);
      throw error;
    } finally {
      this.processing.delete(key);
    }
  }

  async listJobCards(scope: JobCardReadScope, query: JobCardListQuery) {
    this.listCalls.push({ scope, query });
    const items = this.jobs
      .filter((job) => job.organizationId === scope.organizationId
        && (!scope.assignedTo || job.assignedTo === scope.assignedTo)
        && (!query.assignedTo || job.assignedTo === query.assignedTo))
      .map((job) => this.listItem(job));
    return { items, total: items.length, limit: query.limit, offset: query.offset };
  }
  async getAssignee(org: string, id: string) {
    return this.assignees.find((item) => item.organizationId === org && item.id === id) ?? null;
  }
  async getSubmissionCustomer(org: string, id: string) {
    const customer = this.customers.find((item) => item.organizationId === org && item.id === id);
    return customer ? { id: customer.id, organizationId: customer.organizationId, status: customer.status } : null;
  }
  async getSubmissionMeetingDetails() { return null; }
  async getSubmissionDeliveryItems() { return []; }
  async findJobCard(organizationId: string, id: string) {
    return this.jobs.find((job) => job.organizationId === organizationId && job.id === id) ?? null;
  }
  async findJobCardDetail(organizationId: string, id: string) {
    const job = await this.findJobCard(organizationId, id);
    return job ? this.detail(job) : null;
  }
  async executeTransaction<T>(work: (tx: JobCardTransaction) => Promise<T>) {
    const before = this.jobs.map((job) => ({ ...job })); const eventCount = this.activities.length;
    const tx: JobCardTransaction = {
      getJob: async (org, id) => this.jobs.find((job) => job.organizationId === org && job.id === id) ?? null,
      getJobForUpdate: async (org, id) => this.jobs.find((job) => job.organizationId === org && job.id === id) ?? null,
      getJobDetail: async (org, id) => {
        const job = this.jobs.find((item) => item.organizationId === org && item.id === id);
        return job ? this.detail(job) : null;
      },
      transitionWithVersion: async () => null,
      getAssignee: async (org, id) => this.assignees.find((item) => item.organizationId === org && item.id === id) ?? null,
      getAssigneeForUpdate: async (org, id) => this.assignees.find((item) => item.organizationId === org && item.id === id) ?? null,
      customerExists: async (org, id) => this.customers.some((item) => item.organizationId === org && item.id === id),
      getCustomerForUpdate: async (org, id) => this.customers.find((item) => item.organizationId === org && item.id === id) ?? null,
      getContactForUpdate: async (org, id) => this.contacts.find((item) => item.organizationId === org && item.id === id) ?? null,
      createJobCard: async () => { throw new Error('unused'); },
      createMeetingDetails: async () => { throw new Error('unused'); },
      updateFieldsWithVersion: async (input) => {
        const index = this.jobs.findIndex((job) => job.organizationId === input.organizationId && job.id === input.jobCardId && job.version === input.expectedVersion);
        if (index < 0) return null;
        const { clearAcceptance, ...fields } = input.fields;
        this.jobs[index] = {
          ...this.jobs[index]!,
          ...fields,
          version: this.jobs[index]!.version + 1,
        };
        if (clearAcceptance) this.acceptance.delete(input.jobCardId);
        return this.jobs[index]!;
      },
      appendActivity: async (input) => {
        this.activities.push(input.event);
        return { id: `activity-${this.activities.length}`, createdAt: new Date('2026-07-19T14:30:00.000Z') };
      },
      appendRealtimeEvent: async () => { throw new Error('appendRealtimeEvent not implemented'); },
    };
    try { return await work(tx); } catch (error) { this.jobs = before; this.activities.splice(eventCount); throw error; }
  }
}

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const manager: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const admin: JobCardActor = { id: 'admin-1', organizationId: 'org-1', role: 'ADMIN' };
const now = new Date('2026-07-13T10:00:00.000Z');
const SCHEDULED_AT = '2026-07-20T10:30:00.000Z';
const createInput: NormalizedJobCardCreateInput = {
  clientActionId: 'create-1', type: 'PRODUCT_DELIVERY' as const, title: ' ABC Klinik teslimi ',
  description: null, customerId: 'customer-1', contactId: null,
  assignedTo: 'staff-1', priority: 'normal' as const, dueDate: null,
  scheduledAt: SCHEDULED_AT,
};
const generalTaskInput: NormalizedJobCardCreateInput = {
  clientActionId: 'task-create-1', type: 'GENERAL_TASK' as const, title: ' Doktoru ara ',
  description: null, customerId: null, contactId: null, assignedTo: 'staff-1',
  priority: 'normal' as const, dueDate: null, scheduledAt: null,
};

function serviceOf(repository: CrudMemoryRepository) {
  return new JobCardService(repository, () => now);
}

describe('JobCardService create and reads', () => {
  it('creates a title-only General Task with nullable context and one JOB_CREATED event', async () => {
    const repository = new CrudMemoryRepository();
    const result = await serviceOf(repository).create(staff, generalTaskInput);

    expect(result).toMatchObject({
      type: 'GENERAL_TASK', status: 'ACCEPTED', version: 1, title: 'Doktoru ara',
      customerId: null, contactId: null, assignedTo: 'staff-1', priority: 'normal',
      scheduledAt: null,
      assignee: { id: 'staff-1', name: 'Staff One' }, customer: null, contact: null,
      workflowContext: {
        lifecycle: {
          acceptedAt: now.toISOString(),
          acceptedBy: { id: 'staff-1', name: 'Staff One' },
        },
      },
    });
    expect(repository.activities).toEqual(['JOB_CREATED']);
  });

  it('persists optional matching Customer and Contact context on a General Task', async () => {
    const repository = new CrudMemoryRepository();
    const result = await serviceOf(repository).create(staff, {
      ...generalTaskInput, clientActionId: 'task-with-context',
      customerId: 'customer-1', contactId: 'contact-1',
    });

    expect(result).toMatchObject({
      type: 'GENERAL_TASK', customerId: 'customer-1', contactId: 'contact-1',
      assignee: { id: 'staff-1', name: 'Staff One' },
      customer: { id: 'customer-1', name: 'Customer customer-1' },
      contact: { id: 'contact-1', name: 'Contact contact-1' },
    });
  });

  it('applies the shared assignment boundary to General Task before lookup', async () => {
    const repository = new CrudMemoryRepository();

    await expect(serviceOf(repository).create(staff, {
      ...generalTaskInput, assignedTo: 'staff-2',
    })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(repository.assigneeLookupCount).toBe(0);
  });

  it('applies canonical optional Customer and Contact errors to General Task', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);

    await expect(service.create(staff, {
      ...generalTaskInput, clientActionId: 'task-contact-without-customer', contactId: 'contact-1',
    })).rejects.toMatchObject({ code: 'CONTACT_NOT_IN_CUSTOMER', statusCode: 409 });
    await expect(service.create(staff, {
      ...generalTaskInput, clientActionId: 'task-contact-mismatch',
      customerId: 'customer-1', contactId: 'contact-2',
    })).rejects.toMatchObject({ code: 'CONTACT_NOT_IN_CUSTOMER', statusCode: 409 });
    await expect(service.create(staff, {
      ...generalTaskInput, clientActionId: 'task-inactive-customer', customerId: 'customer-inactive',
    })).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE', statusCode: 409 });
    await expect(service.create(staff, {
      ...generalTaskInput, clientActionId: 'task-inactive-contact',
      customerId: 'customer-1', contactId: 'contact-inactive',
    })).rejects.toMatchObject({ code: 'CONTACT_INACTIVE', statusCode: 409 });
  });

  it('replays General Task creation without another record or activity', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);
    const first = await service.create(staff, generalTaskInput);

    await expect(service.create(staff, generalTaskInput)).resolves.toEqual(first);
    expect(repository.jobs).toHaveLength(1);
    expect(repository.activities).toEqual(['JOB_CREATED']);
  });

  it('returns ACTION_IN_PROGRESS for a live duplicate General Task claim', async () => {
    const repository = new CrudMemoryRepository();
    repository.processing.add('org-1:staff-1:task-create-1:JOB_CREATE');

    await expect(serviceOf(repository).create(staff, generalTaskInput))
      .rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS', statusCode: 409 });
    expect(repository.jobs).toHaveLength(0);
    expect(repository.activities).toHaveLength(0);
  });

  it('allows only one concurrent General Task create claim to complete', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);

    const results = await Promise.allSettled([
      service.create(staff, generalTaskInput),
      service.create(staff, generalTaskInput),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'ACTION_IN_PROGRESS', statusCode: 409 },
    });
    expect(repository.jobs).toHaveLength(1);
    expect(repository.activities).toEqual(['JOB_CREATED']);
  });

  it('rolls back General Task creation when JOB_CREATED append fails', async () => {
    const repository = new CrudMemoryRepository(); repository.failActivity = true;

    await expect(serviceOf(repository).create(staff, generalTaskInput))
      .rejects.toThrow('activity failed');
    expect(repository.jobs).toHaveLength(0);
    expect(repository.activities).toHaveLength(0);
  });

  it('creates a staff self-assigned delivery as ACCEPTED with one JOB_CREATED event', async () => {
    const repository = new CrudMemoryRepository();
    const result = await serviceOf(repository).create(staff, createInput);
    expect(result).toMatchObject({
      title: 'ABC Klinik teslimi', assignedTo: 'staff-1', status: 'ACCEPTED', version: 1,
      scheduledAt: SCHEDULED_AT,
      workflowContext: {
        lifecycle: {
          acceptedAt: now.toISOString(),
          acceptedBy: { id: 'staff-1', name: 'Staff One' },
        },
      },
    });
    expect(repository.activities).toEqual(['JOB_CREATED']);
  });

  it('creates management-assigned work as NEW without acceptance facts', async () => {
    const repository = new CrudMemoryRepository();
    const result = await serviceOf(repository).create(manager, {
      ...createInput, clientActionId: 'manager-create-1', assignedTo: 'staff-1',
    });
    expect(result).toMatchObject({
      status: 'NEW', version: 1, assignedTo: 'staff-1', scheduledAt: SCHEDULED_AT,
      workflowContext: { lifecycle: { acceptedAt: null, acceptedBy: null } },
    });
    expect(repository.activities).toEqual(['JOB_CREATED']);
  });

  it('replays duplicate create without another JobCard or event', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);
    const first = await service.create(staff, createInput);
    expect(await service.create(staff, createInput)).toEqual(first);
    expect(repository.jobs).toHaveLength(1); expect(repository.activities).toHaveLength(1);
  });

  it('rejects staff assignment to another user and cross-org references', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);
    await expect(service.create(staff, { ...createInput, assignedTo: 'staff-2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.assigneeLookupCount).toBe(0);
    await expect(service.create(staff, { ...createInput, customerId: 'missing' })).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  it('uses the canonical assignee errors after manager assignment lookup', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);
    repository.assignees.push(
      { id: 'staff-inactive', organizationId: 'org-1', role: 'STAFF', isActive: false },
      { id: 'manager-assignee', organizationId: 'org-1', role: 'MANAGER', isActive: true },
      { id: 'staff-cross-org', organizationId: 'org-2', role: 'STAFF', isActive: true },
    );

    await expect(service.create(manager, {
      ...createInput, clientActionId: 'missing-assignee', assignedTo: 'missing',
    })).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_FOUND', statusCode: 404 });
    await expect(service.create(manager, {
      ...createInput, clientActionId: 'cross-org-assignee', assignedTo: 'staff-cross-org',
    })).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_FOUND', statusCode: 404 });
    await expect(service.create(manager, {
      ...createInput, clientActionId: 'inactive-assignee', assignedTo: 'staff-inactive',
    })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    await expect(service.create(manager, {
      ...createInput, clientActionId: 'non-staff-assignee', assignedTo: 'manager-assignee',
    })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(repository.assigneeLookupCount).toBe(4);
  });

  it('allows a manager to assign an active same-organization staff user', async () => {
    const repository = new CrudMemoryRepository();
    await expect(serviceOf(repository).create(manager, { ...createInput, assignedTo: 'staff-2' }))
      .resolves.toMatchObject({ assignedTo: 'staff-2' });
  });

  it('persists a valid Contact and rejects a Contact from another Customer', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);
    const created = await service.create(staff, { ...createInput, contactId: 'contact-1' });
    expect(created.contactId).toBe('contact-1');

    await expect(service.create(staff, {
      ...createInput, clientActionId: 'create-contact-mismatch', contactId: 'contact-2',
    })).rejects.toMatchObject({ code: 'CONTACT_NOT_IN_CUSTOMER' });
  });

  it('rejects inactive and cross-organization references', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);
    await expect(service.create(staff, {
      ...createInput, clientActionId: 'inactive-customer', customerId: 'customer-inactive',
    })).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE' });
    await expect(service.create(staff, {
      ...createInput, clientActionId: 'inactive-contact', contactId: 'contact-inactive',
    })).rejects.toMatchObject({ code: 'CONTACT_INACTIVE' });
    await expect(service.create(staff, {
      ...createInput, clientActionId: 'cross-contact', contactId: 'contact-cross-org',
    })).rejects.toMatchObject({ code: 'CONTACT_NOT_FOUND' });
  });

  it('patches a compatible Contact and clears it when Customer changes without one', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);
    const created = await service.create(staff, createInput);
    const withContact = await service.patch(staff, created.id, {
      expectedVersion: 1, contactId: 'contact-1',
    } as never);
    expect(withContact).toMatchObject({ contactId: 'contact-1', version: 2 });

    const moved = await service.patch(staff, created.id, {
      expectedVersion: 2, customerId: 'customer-2',
    });
    expect(moved).toMatchObject({ customerId: 'customer-2', contactId: null, version: 3 });
  });

  it('scopes staff list and detail to their own assignments', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);
    await service.create(staff, createInput);
    await service.create(manager, { ...createInput, clientActionId: 'create-2', assignedTo: 'staff-2' });
    expect((await service.list(staff, listQuery)).items).toHaveLength(1);
    expect((await service.list(manager, listQuery)).items).toHaveLength(2);
    await expect(service.detail(staff, 'job-2')).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND' });
    await expect(service.detail(manager, 'job-2')).resolves.toMatchObject({ id: 'job-2' });
    await expect(service.detail(manager, 'job-2')).resolves.toMatchObject({
      assignee: { id: 'staff-2', name: 'Staff Two' },
    });
  });

  it('keeps Staff scope authoritative and short-circuits a conflicting assignee filter', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);

    await expect(service.list(staff, { ...listQuery, assignedTo: 'staff-2', limit: 1, offset: 7 }))
      .resolves.toEqual({ items: [], total: 0, limit: 1, offset: 7 });
    expect(repository.listCalls).toHaveLength(0);

    await service.list(staff, { ...listQuery, assignedTo: 'staff-1' });
    expect(repository.listCalls[0]).toMatchObject({
      scope: { organizationId: 'org-1', assignedTo: 'staff-1' },
      query: { assignedTo: 'staff-1' },
    });

    await service.list(manager, { ...listQuery, assignedTo: 'staff-2' });
    expect(repository.listCalls[1]).toMatchObject({
      scope: { organizationId: 'org-1', assignedTo: null },
      query: { assignedTo: 'staff-2' },
    });

    await service.list(admin, { ...listQuery, assignedTo: 'staff-2' });
    expect(repository.listCalls[2]).toMatchObject({
      scope: { organizationId: 'org-1', assignedTo: null },
      query: { assignedTo: 'staff-2' },
    });
  });

  it('patches editable fields with version increment and canonical activity', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);
    const created = await service.create(staff, createInput);
    const updated = await service.patch(staff, created.id, { expectedVersion: 1, title: 'Güncel teslim', priority: 'high' });
    expect(updated).toMatchObject({ title: 'Güncel teslim', priority: 'high', version: 2 });
    expect(updated).toMatchObject({
      assignee: { id: 'staff-1', name: 'Staff One' },
      customer: { id: 'customer-1', name: 'Customer customer-1' }, contact: null,
    });
    expect(repository.activities).toEqual(['JOB_CREATED', 'JOB_FIELDS_UPDATED']);
  });

  it('rejects stale and review-state patches without an update event', async () => {
    const repository = new CrudMemoryRepository(); const service = serviceOf(repository);
    const created = await service.create(staff, createInput);
    await expect(service.patch(staff, created.id, { expectedVersion: 9, title: 'Stale' }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    repository.jobs[0]!.status = 'WAITING_APPROVAL';
    await expect(service.patch(manager, created.id, { expectedVersion: 1, title: 'Sessiz düzeltme' }))
      .rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE' });
    expect(repository.activities).toEqual(['JOB_CREATED']);
  });

  it('lets assigned staff edit scheduledAt in NEW and ACCEPTED without clearing acceptance', async () => {
    const repository = new CrudMemoryRepository();
    const service = serviceOf(repository);
    const created = await service.create(manager, {
      ...createInput, clientActionId: 'schedule-new', assignedTo: 'staff-1',
    });
    expect(created.status).toBe('NEW');

    const inNew = await service.patch(staff, created.id, {
      expectedVersion: 1, scheduledAt: '2026-07-21T09:00:00.000Z',
    });
    expect(inNew).toMatchObject({
      status: 'NEW', version: 2, scheduledAt: '2026-07-21T09:00:00.000Z',
      workflowContext: { lifecycle: { acceptedAt: null, acceptedBy: null } },
    });

    repository.jobs[0]!.status = 'ACCEPTED';
    repository.acceptance.set(created.id, {
      acceptedAt: now.toISOString(), acceptedBy: 'staff-1',
    });
    const inAccepted = await service.patch(staff, created.id, {
      expectedVersion: 2, scheduledAt: '2026-07-22T11:15:00.000Z',
    });
    expect(inAccepted).toMatchObject({
      status: 'ACCEPTED', version: 3, scheduledAt: '2026-07-22T11:15:00.000Z',
      workflowContext: {
        lifecycle: {
          acceptedAt: now.toISOString(),
          acceptedBy: { id: 'staff-1', name: 'Staff One' },
        },
      },
    });
  });

  it('invalidates acceptance when management changes schedule or assignee on ACCEPTED work', async () => {
    const repository = new CrudMemoryRepository();
    const service = serviceOf(repository);
    const created = await service.create(staff, createInput);
    expect(created.status).toBe('ACCEPTED');

    const rescheduled = await service.patch(manager, created.id, {
      expectedVersion: 1, scheduledAt: '2026-07-25T08:00:00.000Z',
    });
    expect(rescheduled).toMatchObject({
      status: 'NEW', version: 2, scheduledAt: '2026-07-25T08:00:00.000Z',
      workflowContext: { lifecycle: { acceptedAt: null, acceptedBy: null } },
    });
    expect(repository.acceptance.has(created.id)).toBe(false);

    repository.jobs[0]!.status = 'ACCEPTED';
    repository.acceptance.set(created.id, {
      acceptedAt: now.toISOString(), acceptedBy: 'staff-1',
    });
    const reassigned = await service.patch(manager, created.id, {
      expectedVersion: 2, assignedTo: 'staff-2',
    });
    expect(reassigned).toMatchObject({
      status: 'NEW', version: 3, assignedTo: 'staff-2',
      workflowContext: { lifecycle: { acceptedAt: null, acceptedBy: null } },
    });
    expect(repository.acceptance.has(created.id)).toBe(false);
    expect(repository.activities).toEqual([
      'JOB_CREATED', 'JOB_FIELDS_UPDATED', 'JOB_ASSIGNED', 'JOB_FIELDS_UPDATED',
    ]);
  });

  it('rejects schedule and reassignment changes after START with JOB_NOT_EDITABLE', async () => {
    const repository = new CrudMemoryRepository();
    const service = serviceOf(repository);
    const created = await service.create(staff, createInput);
    repository.jobs[0]!.status = 'IN_PROGRESS';

    await expect(service.patch(staff, created.id, {
      expectedVersion: 1, scheduledAt: '2026-07-30T10:00:00.000Z',
    })).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });
    await expect(service.patch(manager, created.id, {
      expectedVersion: 1, assignedTo: 'staff-2',
    })).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });
    await expect(service.patch(manager, created.id, {
      expectedVersion: 1, scheduledAt: '2026-07-30T10:00:00.000Z',
    })).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });
    expect(repository.jobs[0]).toMatchObject({
      status: 'IN_PROGRESS', version: 1, scheduledAt: SCHEDULED_AT, assignedTo: 'staff-1',
    });
    expect(repository.activities).toEqual(['JOB_CREATED']);
  });

  it('rejects clearing required scheduledAt for Product Delivery and Sales Meeting', async () => {
    const repository = new CrudMemoryRepository();
    const service = serviceOf(repository);
    const delivery = await service.create(staff, {
      ...createInput, clientActionId: 'pd-clear-schedule',
    });
    await expect(service.patch(staff, delivery.id, {
      expectedVersion: 1, scheduledAt: null,
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      message: 'Planlanan zaman bu iş türü için zorunludur.',
    });
    expect(repository.jobs[0]).toMatchObject({
      scheduledAt: SCHEDULED_AT, version: 1,
    });

    const meeting = await service.create(manager, {
      clientActionId: 'sm-clear-schedule',
      type: 'SALES_MEETING',
      title: 'Görüşme',
      description: null,
      customerId: 'customer-1',
      contactId: null,
      assignedTo: 'staff-1',
      priority: 'normal',
      dueDate: '2026-07-20',
      scheduledAt: SCHEDULED_AT,
    });
    await expect(service.patch(staff, meeting.id, {
      expectedVersion: 1, scheduledAt: null,
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      message: 'Planlanan zaman bu iş türü için zorunludur.',
    });
    expect(repository.jobs[1]).toMatchObject({
      type: 'SALES_MEETING', scheduledAt: SCHEDULED_AT, version: 1,
    });
    expect(repository.activities).toEqual(['JOB_CREATED', 'JOB_CREATED']);
  });

  it('allows clearing optional scheduledAt for General Task', async () => {
    const repository = new CrudMemoryRepository();
    const service = serviceOf(repository);
    const created = await service.create(staff, {
      ...generalTaskInput,
      clientActionId: 'gt-clear-schedule',
      scheduledAt: SCHEDULED_AT,
    });
    const cleared = await service.patch(staff, created.id, {
      expectedVersion: 1, scheduledAt: null,
    });
    expect(cleared).toMatchObject({
      type: 'GENERAL_TASK', scheduledAt: null, version: 2,
    });
  });
});

describe('Postgres JobCard versioned patch regression', () => {
  it('executes updateFieldsWithVersion with exactly one WHERE clause', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      async query(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        if (text.includes('UPDATE job_cards SET')) {
          return { rows: [{
            id: 'job-1', organization_id: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW',
            version: 2, title: 'Güncel teslim', description: null, customer_id: 'customer-1',
            contact_id: null, assigned_to: 'staff-1', created_by: 'staff-1',
            priority: 'normal', due_date: null,
          }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const repository = new PostgresJobCardRepository({ connect: async () => client } as never);

    const result = await repository.executeTransaction((tx) => tx.updateFieldsWithVersion({
      organizationId: 'org-1', jobCardId: 'job-1', expectedVersion: 1,
      fields: { title: 'Güncel teslim' },
    }));

    expect(result).toMatchObject({ id: 'job-1', title: 'Güncel teslim', version: 2 });
    const update = calls.find((call) => call.text.includes('UPDATE job_cards SET'))!;
    expect(update.text.match(/\bWHERE\b/g)).toHaveLength(1);
    expect(update.text).toContain('WHERE organization_id = $1 AND id = $2 AND version = $3');
    expect(update.values).toEqual(['org-1', 'job-1', 1, 'Güncel teslim']);
  });
});
