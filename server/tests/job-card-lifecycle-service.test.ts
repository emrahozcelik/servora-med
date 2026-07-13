import { describe, expect, it } from 'vitest';

import type { CriticalActionClaim, JobCardRepository, JobCardTransaction, SubmissionDeliveryItem } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';

class LifecycleRepository implements JobCardRepository {
  job: JobCard = { id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS', version: 2,
    title: 'Teslim', description: null, customerId: 'customer-1', assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: null };
  assignee = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const, isActive: true };
  customerExistsValue = true;
  items: Array<SubmissionDeliveryItem & { productActive: boolean }> = [{ id: 'item-1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'product-1',
    deliveryPurpose: 'SALE', deliveredAt: new Date(), quantity: 2, unit: 'adet', productNameSnapshot: 'Set',
    productSkuSnapshot: 'S1', productModelSnapshot: null, lotNo: null, serialNo: null, expiryDate: null,
    deliveryNote: null, productActive: true }];
  events: string[] = []; completed = new Map<string, unknown>();
  private tx(): JobCardTransaction { return {
    getJobForUpdate: async (org, id) => org === this.job.organizationId && id === this.job.id ? { ...this.job } : null,
    transitionWithVersion: async (input) => { if (input.expectedVersion !== this.job.version) return null;
      this.job = { ...this.job, status: input.status, version: this.job.version + 1 }; return { ...this.job }; },
    appendActivity: async (input) => { this.events.push(input.event); },
    getAssignee: async () => this.assignee, customerExists: async () => this.customerExistsValue,
    getSubmissionDeliveryItems: async () => this.items,
    createJobCard: async () => { throw new Error('unused'); }, updateFieldsWithVersion: async () => null,
    getProduct: async () => null, getDeliveryItemForUpdate: async () => null,
    createDeliveryItem: async () => { throw new Error('unused'); }, updateDeliveryItem: async () => { throw new Error('unused'); },
    deleteDeliveryItem: async () => {}, bumpVersion: async () => null,
  }; }
  async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<T>) {
    const key = `${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key) as T };
    const response = await work(this.tx()); this.completed.set(key, response); return { kind: 'completed' as const, response };
  }
  async executeTransaction<T>(work: (tx: JobCardTransaction) => Promise<T>) { return work(this.tx()); }
  async listJobCards() { return [this.job]; } async findJobCard() { return this.job; } async listDeliveryItems() { return this.items; }
}

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const manager: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };

describe('JobCard lifecycle commands', () => {
  it('submits a complete delivery for approval with one event', async () => {
    const repo = new LifecycleRepository();
    const result = await new JobCardService(repo).submitForApproval(staff, 'job-1', {
      expectedVersion: 2, clientActionId: 'submit-1', note: 'Teslim tamamlandı',
    });
    expect(result).toMatchObject({ status: 'WAITING_APPROVAL', version: 3 });
    expect(repo.events).toEqual(['JOB_SUBMITTED_FOR_APPROVAL']);
  });

  it('replays duplicate submission without a second transition or event', async () => {
    const repo = new LifecycleRepository(); const service = new JobCardService(repo);
    const input = { expectedVersion: 2, clientActionId: 'submit-replay' };
    const first = await service.submitForApproval(staff, 'job-1', input);
    expect(await service.submitForApproval(staff, 'job-1', input)).toEqual(first);
    expect(repo.job.version).toBe(3); expect(repo.events).toEqual(['JOB_SUBMITTED_FOR_APPROVAL']);
  });

  it('blocks submission for missing data or an ineligible assignee', async () => {
    const repo = new LifecycleRepository(); const service = new JobCardService(repo);
    repo.items = [];
    await expect(service.submitForApproval(staff, 'job-1', { expectedVersion: 2, clientActionId: 's1' }))
      .rejects.toMatchObject({ code: 'DELIVERY_NOT_READY' });
    repo.items = [{ ...new LifecycleRepository().items[0]!, productActive: false }];
    repo.assignee.isActive = false;
    await expect(service.submitForApproval(staff, 'job-1', { expectedVersion: 2, clientActionId: 's3' }))
      .rejects.toMatchObject({ code: 'ASSIGNEE_NOT_ELIGIBLE' });
  });

  it('submits an immutable delivery snapshot after its catalog Product becomes inactive', async () => {
    const repo = new LifecycleRepository();
    repo.items = [{ ...repo.items[0]!, productActive: false }];

    await expect(new JobCardService(repo).submitForApproval(staff, 'job-1', {
      expectedVersion: 2, clientActionId: 'submit-inactive-catalog-product',
    })).resolves.toMatchObject({ status: 'WAITING_APPROVAL', version: 3 });
  });

  it('forbids staff approval and allows manager approval', async () => {
    const repo = new LifecycleRepository(); repo.job.status = 'WAITING_APPROVAL'; repo.job.version = 3;
    const service = new JobCardService(repo);
    await expect(service.approve(staff, 'job-1', { expectedVersion: 3, clientActionId: 'a1' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.approve(manager, 'job-1', { expectedVersion: 3, clientActionId: 'a2', note: 'Uygun' }))
      .resolves.toMatchObject({ status: 'COMPLETED', version: 4 });
    expect(repo.events).toEqual(['JOB_APPROVED']);
  });

  it('requires revision reason and transitions review to revision requested', async () => {
    const repo = new LifecycleRepository(); repo.job.status = 'WAITING_APPROVAL'; repo.job.version = 3;
    const service = new JobCardService(repo);
    await expect(service.requestRevision(manager, 'job-1', { expectedVersion: 3, clientActionId: 'r1', revisionReason: ' ' }))
      .rejects.toMatchObject({ code: 'REVISION_REASON_REQUIRED' });
    await expect(service.requestRevision(manager, 'job-1', { expectedVersion: 3, clientActionId: 'r2', revisionReason: 'Teslim notunu düzeltin' }))
      .resolves.toMatchObject({ status: 'REVISION_REQUESTED', version: 4 });
    expect(repo.events).toEqual(['JOB_REVISION_REQUESTED']);
  });
});
