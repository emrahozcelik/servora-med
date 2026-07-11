import { describe, expect, it } from 'vitest';

import type { CriticalActionClaim, JobCardRepository, JobCardTransaction } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { DeliveryItem, JobCard, JobCardActor } from '../src/modules/job-cards/types.js';

class DeliveryRepository implements JobCardRepository {
  job: JobCard = { id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS', version: 1,
    title: 'Teslim', description: null, customerId: 'customer-1', assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: null };
  product = { id: 'product-1', organizationId: 'org-1', name: 'İmplant Seti', sku: 'IMP-1', model: 'M1', unit: 'adet', isActive: true };
  items: DeliveryItem[] = []; events: string[] = []; completed = new Map<string, unknown>();

  private tx(): JobCardTransaction { return {
    getJobForUpdate: async (org, id) => org === this.job.organizationId && id === this.job.id ? { ...this.job } : null,
    transitionWithVersion: async () => null, appendActivity: async (i) => { this.events.push(i.event); },
    getAssignee: async () => null, customerExists: async () => false, createJobCard: async () => { throw new Error('unused'); },
    updateFieldsWithVersion: async () => null,
    getProduct: async (org, id) => org === this.product.organizationId && id === this.product.id ? { ...this.product } : null,
    getDeliveryItemForUpdate: async (org, job, id) => this.items.find((i) => i.organizationId === org && i.jobCardId === job && i.id === id) ?? null,
    createDeliveryItem: async (input) => { const item = { ...input, id: `item-${this.items.length + 1}` }; this.items.push(item); return item; },
    updateDeliveryItem: async (id, input) => { const index = this.items.findIndex((i) => i.id === id); this.items[index] = { ...this.items[index]!, ...input }; return this.items[index]!; },
    deleteDeliveryItem: async (id) => { this.items = this.items.filter((i) => i.id !== id); },
    bumpVersion: async (_org, _id, version) => { if (this.job.version !== version) return null; this.job.version++; return { ...this.job }; },
  }; }
  async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<T>) {
    const key = `${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key) as T };
    const response = await work(this.tx()); this.completed.set(key, response); return { kind: 'completed' as const, response };
  }
  async executeTransaction<T>(work: (tx: JobCardTransaction) => Promise<T>) { return work(this.tx()); }
  async listJobCards() { return [this.job]; } async findJobCard() { return this.job; }
  async listDeliveryItems() { return this.items; }
}

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const create = { clientActionId: 'item-action-1', expectedVersion: 1, productId: 'product-1',
  deliveryPurpose: 'SAMPLE' as const, deliveredAt: '2026-07-11T10:00:00.000Z', quantity: 2, deliveryNote: 'Deneme' };

describe('delivery item mutations', () => {
  it('creates from the catalog snapshot, increments parent version, and emits one event', async () => {
    const repo = new DeliveryRepository(); const result = await new JobCardService(repo).addDeliveryItem(staff, 'job-1', create);
    expect(result).toMatchObject({ item: { productNameSnapshot: 'İmplant Seti', productSkuSnapshot: 'IMP-1', unit: 'adet', quantity: 2 }, jobCardVersion: 2 });
    expect(repo.events).toEqual(['DELIVERY_ITEM_ADDED']);
  });
  it('replays duplicate create without duplicate item or event', async () => {
    const repo = new DeliveryRepository(); const service = new JobCardService(repo);
    await service.addDeliveryItem(staff, 'job-1', create); await service.addDeliveryItem(staff, 'job-1', create);
    expect(repo.items).toHaveLength(1); expect(repo.events).toHaveLength(1);
  });
  it('rejects inactive/missing product, invalid quantity, and review-state mutation', async () => {
    const repo = new DeliveryRepository(); const service = new JobCardService(repo);
    repo.product.isActive = false;
    await expect(service.addDeliveryItem(staff, 'job-1', create)).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    repo.product.isActive = true;
    await expect(service.addDeliveryItem(staff, 'job-1', { ...create, quantity: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.addDeliveryItem(staff, 'job-1', { ...create, unitPrice: 100 } as typeof create))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    repo.job.status = 'WAITING_APPROVAL';
    await expect(service.addDeliveryItem(staff, 'job-1', create)).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE' });
  });
  it('patches and removes an item with parent versions and events', async () => {
    const repo = new DeliveryRepository(); const service = new JobCardService(repo);
    const added = await service.addDeliveryItem(staff, 'job-1', create);
    const patched = await service.patchDeliveryItem(staff, 'job-1', added.item.id!, { expectedVersion: 2, quantity: 4, deliveryPurpose: 'SALE' });
    expect(patched).toMatchObject({ item: { quantity: 4, deliveryPurpose: 'SALE' }, jobCardVersion: 3 });
    await expect(service.removeDeliveryItem(staff, 'job-1', added.item.id!, { expectedVersion: 3 }))
      .resolves.toEqual({ id: added.item.id, jobCardVersion: 4 });
    expect(repo.events).toEqual(['DELIVERY_ITEM_ADDED', 'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED']);
  });
  it('rejects stale item mutation without another event', async () => {
    const repo = new DeliveryRepository(); const service = new JobCardService(repo);
    const added = await service.addDeliveryItem(staff, 'job-1', create);
    await expect(service.patchDeliveryItem(staff, 'job-1', added.item.id!, { expectedVersion: 1, quantity: 3 }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(repo.events).toHaveLength(1);
  });
});
