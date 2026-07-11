import { describe, expect, it } from 'vitest';

import type {
  CreateJobCardRecord,
  CriticalActionClaim,
  JobCardListScope,
  JobCardRepository,
  JobCardTransaction,
} from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor, JobCardAssignee } from '../src/modules/job-cards/types.js';

class CrudMemoryRepository implements JobCardRepository {
  assignees: JobCardAssignee[] = [
    { id: 'staff-1', organizationId: 'org-1', role: 'STAFF', isActive: true },
    { id: 'staff-2', organizationId: 'org-1', role: 'STAFF', isActive: true },
  ];
  customers = [{ id: 'customer-1', organizationId: 'org-1' }];
  jobs: JobCard[] = [];
  activities: string[] = [];
  completed = new Map<string, unknown>();

  async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<T>) {
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key) as T };
    const tx: JobCardTransaction = {
      getJobForUpdate: async () => null,
      transitionWithVersion: async () => null,
      getAssignee: async (org, id) => this.assignees.find((item) => item.organizationId === org && item.id === id) ?? null,
      customerExists: async (org, id) => this.customers.some((item) => item.organizationId === org && item.id === id),
      createJobCard: async (input: CreateJobCardRecord) => {
        const job: JobCard = { id: `job-${this.jobs.length + 1}`, status: 'NEW', version: 1, ...input };
        this.jobs.push(job); return job;
      },
      appendActivity: async (input) => { this.activities.push(input.event); },
    };
    const response = await work(tx); this.completed.set(key, response);
    return { kind: 'completed' as const, response };
  }

  async listJobCards(scope: JobCardListScope) {
    return this.jobs.filter((job) => job.organizationId === scope.organizationId && (!scope.assignedTo || job.assignedTo === scope.assignedTo));
  }
  async findJobCard(organizationId: string, id: string) {
    return this.jobs.find((job) => job.organizationId === organizationId && job.id === id) ?? null;
  }
  async executeTransaction<T>(work: (tx: JobCardTransaction) => Promise<T>) {
    const before = this.jobs.map((job) => ({ ...job })); const eventCount = this.activities.length;
    const tx: JobCardTransaction = {
      getJobForUpdate: async (org, id) => this.jobs.find((job) => job.organizationId === org && job.id === id) ?? null,
      transitionWithVersion: async () => null,
      getAssignee: async (org, id) => this.assignees.find((item) => item.organizationId === org && item.id === id) ?? null,
      customerExists: async (org, id) => this.customers.some((item) => item.organizationId === org && item.id === id),
      createJobCard: async () => { throw new Error('unused'); },
      updateFieldsWithVersion: async (input) => {
        const index = this.jobs.findIndex((job) => job.organizationId === input.organizationId && job.id === input.jobCardId && job.version === input.expectedVersion);
        if (index < 0) return null;
        this.jobs[index] = { ...this.jobs[index]!, ...input.fields, version: this.jobs[index]!.version + 1 };
        return this.jobs[index]!;
      },
      appendActivity: async (input) => { this.activities.push(input.event); },
    };
    try { return await work(tx); } catch (error) { this.jobs = before; this.activities.splice(eventCount); throw error; }
  }
}

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const manager: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const createInput = {
  clientActionId: 'create-1', type: 'PRODUCT_DELIVERY' as const, title: ' ABC Klinik teslimi ',
  customerId: 'customer-1', assignedTo: 'staff-1', priority: 'normal' as const,
};

describe('JobCardService create and reads', () => {
  it('creates a staff self-assigned delivery with one JOB_CREATED event', async () => {
    const repository = new CrudMemoryRepository();
    const result = await new JobCardService(repository).create(staff, createInput);
    expect(result).toMatchObject({ title: 'ABC Klinik teslimi', assignedTo: 'staff-1', status: 'NEW', version: 1 });
    expect(repository.activities).toEqual(['JOB_CREATED']);
  });

  it('replays duplicate create without another JobCard or event', async () => {
    const repository = new CrudMemoryRepository(); const service = new JobCardService(repository);
    const first = await service.create(staff, createInput);
    expect(await service.create(staff, createInput)).toEqual(first);
    expect(repository.jobs).toHaveLength(1); expect(repository.activities).toHaveLength(1);
  });

  it('rejects staff assignment to another user and cross-org references', async () => {
    const repository = new CrudMemoryRepository(); const service = new JobCardService(repository);
    await expect(service.create(staff, { ...createInput, assignedTo: 'staff-2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.create(staff, { ...createInput, customerId: 'missing' })).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  it('allows a manager to assign an active same-organization staff user', async () => {
    const repository = new CrudMemoryRepository();
    await expect(new JobCardService(repository).create(manager, { ...createInput, assignedTo: 'staff-2' }))
      .resolves.toMatchObject({ assignedTo: 'staff-2' });
  });

  it('scopes staff list and detail to their own assignments', async () => {
    const repository = new CrudMemoryRepository(); const service = new JobCardService(repository);
    await service.create(staff, createInput);
    await service.create(manager, { ...createInput, clientActionId: 'create-2', assignedTo: 'staff-2' });
    expect(await service.list(staff)).toHaveLength(1);
    expect(await service.list(manager)).toHaveLength(2);
    await expect(service.detail(staff, 'job-2')).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND' });
    await expect(service.detail(manager, 'job-2')).resolves.toMatchObject({ id: 'job-2' });
  });

  it('patches editable fields with version increment and canonical activity', async () => {
    const repository = new CrudMemoryRepository(); const service = new JobCardService(repository);
    const created = await service.create(staff, createInput);
    const updated = await service.patch(staff, created.id, { expectedVersion: 1, title: 'Güncel teslim', priority: 'high' });
    expect(updated).toMatchObject({ title: 'Güncel teslim', priority: 'high', version: 2 });
    expect(repository.activities).toEqual(['JOB_CREATED', 'JOB_FIELDS_UPDATED']);
  });

  it('rejects stale and review-state patches without an update event', async () => {
    const repository = new CrudMemoryRepository(); const service = new JobCardService(repository);
    const created = await service.create(staff, createInput);
    await expect(service.patch(staff, created.id, { expectedVersion: 9, title: 'Stale' }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    repository.jobs[0]!.status = 'WAITING_APPROVAL';
    await expect(service.patch(manager, created.id, { expectedVersion: 1, title: 'Sessiz düzeltme' }))
      .rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE' });
    expect(repository.activities).toEqual(['JOB_CREATED']);
  });
});
