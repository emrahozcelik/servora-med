import { describe, expect, it } from 'vitest';

import type {
  CriticalActionClaim, DeliveryItemRecord, JobCardRepository, JobCardTransaction, ProductReference,
} from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';

class DeliveryRepository implements JobCardRepository {
  job: JobCard = { id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS', version: 1,
    title: 'Teslim', description: null, customerId: 'customer-1', assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: null };
  product: ProductReference = { id: 'product-1', organizationId: 'org-1', name: 'İmplant Seti', sku: 'IMP-1', model: 'M1', unit: 'adet', isActive: true };
  replacementProduct: ProductReference = { id: 'product-2', organizationId: 'org-1', name: 'Greft Seti', sku: 'GRF-2', model: 'G2', unit: 'kutu', isActive: true };
  items: DeliveryItemRecord[] = []; events: string[] = []; completed = new Map<string, unknown>();
  getProductCalls: string[] = [];
  getItemCalls = 0;
  bumpVersionCalls = 0;
  listDeliveryItemCalls = 0;

  private tx(): JobCardTransaction { return {
    getJobForUpdate: async (org, id) => org === this.job.organizationId && id === this.job.id ? { ...this.job } : null,
    transitionWithVersion: async () => null, appendActivity: async (i) => { this.events.push(i.event); },
    getAssignee: async () => null, customerExists: async () => false, createJobCard: async () => { throw new Error('unused'); },
    updateFieldsWithVersion: async () => null,
    getProduct: async (org, id) => {
      this.getProductCalls.push(id);
      const product = [this.product, this.replacementProduct].find((candidate) => candidate.organizationId === org && candidate.id === id);
      return product ? { ...product } : null;
    },
    getDeliveryItemForUpdate: async (org, job, id) => {
      this.getItemCalls += 1;
      return this.items.find((i) => i.organizationId === org && i.jobCardId === job && i.id === id) ?? null;
    },
    createDeliveryItem: async (input) => { const item = { ...input, id: `item-${this.items.length + 1}` }; this.items.push(item); return item; },
    updateDeliveryItem: async (id, input) => { const index = this.items.findIndex((i) => i.id === id); this.items[index] = { ...this.items[index]!, ...input }; return this.items[index]!; },
    deleteDeliveryItem: async (id) => { this.items = this.items.filter((i) => i.id !== id); },
    bumpVersion: async (_org, _id, version) => {
      this.bumpVersionCalls += 1;
      if (this.job.version !== version) return null; this.job.version++; return { ...this.job };
    },
  }; }
  async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<T>) {
    const key = `${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key) as T };
    const response = await work(this.tx()); this.completed.set(key, response); return { kind: 'completed' as const, response };
  }
  async executeTransaction<T>(work: (tx: JobCardTransaction) => Promise<T>) { return work(this.tx()); }
  async listJobCards() { return [this.job]; }
  async findJobCard(organizationId: string, jobCardId: string) {
    return this.job.organizationId === organizationId && this.job.id === jobCardId ? this.job : null;
  }
  async findJobCardDetail(organizationId: string, jobCardId: string) {
    const job = await this.findJobCard(organizationId, jobCardId);
    return job ? {
      ...job,
      assignee: { id: job.assignedTo, name: 'Staff One' },
      customer: job.customerId ? { id: job.customerId, name: 'Demo Klinik' } : null,
      contact: null,
    } : null;
  }
  async listDeliveryItems() { this.listDeliveryItemCalls += 1; return this.items; }
}

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const create = { clientActionId: 'item-action-1', expectedVersion: 1, productId: 'product-1',
  deliveryPurpose: 'SAMPLE' as const, deliveredAt: '2026-07-11T10:00:00.000Z', quantity: 2, deliveryNote: 'Deneme' };

describe('delivery item mutations', () => {
  it.each([
    ['list', async (service: JobCardService) => service.listDeliveryItems(staff, 'job-1')],
    ['add', async (service: JobCardService) => service.addDeliveryItem(staff, 'job-1', {
      ...create, expectedVersion: 99,
    })],
    ['patch', async (service: JobCardService) => service.patchDeliveryItem(
      staff, 'job-1', 'item-1', { expectedVersion: 99, quantity: 3 },
    )],
    ['remove', async (service: JobCardService) => service.removeDeliveryItem(
      staff, 'job-1', 'item-1', { expectedVersion: 99 },
    )],
  ] as const)('rejects General Task delivery %s before subresource work', async (_path, run) => {
    const repo = new DeliveryRepository(); repo.job.type = 'GENERAL_TASK';

    await expect(run(new JobCardService(repo))).rejects.toMatchObject({
      code: 'INVALID_JOB_TYPE', statusCode: 409,
      message: 'Teslim kalemleri yalnız ürün teslimi işlerinde kullanılabilir.',
    });
    expect(repo.listDeliveryItemCalls).toBe(0);
    expect(repo.getProductCalls).toEqual([]);
    expect(repo.getItemCalls).toBe(0);
    expect(repo.bumpVersionCalls).toBe(0);
    expect(repo.items).toHaveLength(0);
    expect(repo.events).toHaveLength(0);
  });

  it('conceals a missing or cross-organization parent before delivery access', async () => {
    const repo = new DeliveryRepository(); const service = new JobCardService(repo);

    await expect(service.listDeliveryItems(staff, 'missing'))
      .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
    await expect(service.addDeliveryItem({ ...staff, organizationId: 'org-2' }, 'job-1', create))
      .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
    expect(repo.listDeliveryItemCalls).toBe(0);
    expect(repo.getProductCalls).toEqual([]);
  });

  it('creates from the catalog snapshot, increments parent version, and emits one event', async () => {
    const repo = new DeliveryRepository(); const result = await new JobCardService(repo).addDeliveryItem(staff, 'job-1', create);
    expect(result).toMatchObject({ item: { productNameSnapshot: 'İmplant Seti', productSkuSnapshot: 'IMP-1', unit: 'adet', quantity: 2 }, jobCardVersion: 2 });
    expect(repo.events).toEqual(['DELIVERY_ITEM_ADDED']);
  });
  it('creates a name-only Product snapshot without fabricating SKU, model, or unit', async () => {
    const repo = new DeliveryRepository();
    repo.product = { ...repo.product, sku: null, model: null, unit: null };

    const result = await new JobCardService(repo).addDeliveryItem(staff, 'job-1', create);

    expect(result.item).toMatchObject({
      productNameSnapshot: 'İmplant Seti', productSkuSnapshot: null, productModelSnapshot: null, unit: null,
    });
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
  it('rejects replacement with an inactive Product', async () => {
    const repo = new DeliveryRepository(); const service = new JobCardService(repo);
    const added = await service.addDeliveryItem(staff, 'job-1', create);
    repo.replacementProduct.isActive = false;

    await expect(service.patchDeliveryItem(staff, 'job-1', added.item.id, {
      expectedVersion: 2, productId: repo.replacementProduct.id,
    })).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
  });
  it('edits non-Product fields without looking up or refreshing an inactive catalog Product', async () => {
    const repo = new DeliveryRepository(); const service = new JobCardService(repo);
    const added = await service.addDeliveryItem(staff, 'job-1', create);
    repo.product.isActive = false;
    repo.getProductCalls = [];

    const result = await service.patchDeliveryItem(staff, 'job-1', added.item.id, {
      expectedVersion: 2, quantity: 5, deliveryPurpose: 'SALE', deliveredAt: '2026-07-12T10:00:00.000Z',
      deliveryNote: 'Güncellendi',
    });

    expect(repo.getProductCalls).toEqual([]);
    expect(result.item).toMatchObject({ quantity: 5, deliveryPurpose: 'SALE', deliveryNote: 'Güncellendi' });
  });
  it('preserves every snapshot when patch supplies the unchanged Product ID', async () => {
    const repo = new DeliveryRepository(); const service = new JobCardService(repo);
    repo.product = { ...repo.product, sku: null, model: null, unit: null };
    const added = await service.addDeliveryItem(staff, 'job-1', create);
    repo.product = { ...repo.product, name: 'Yeni Ad', sku: 'NEW-SKU', model: 'NEW-MODEL', unit: 'paket', isActive: false };
    repo.getProductCalls = [];

    const result = await service.patchDeliveryItem(staff, 'job-1', added.item.id, {
      expectedVersion: 2, productId: repo.product.id, quantity: 3,
    });

    expect(repo.getProductCalls).toEqual([]);
    expect(result.item).toMatchObject({
      productNameSnapshot: 'İmplant Seti', productSkuSnapshot: null, productModelSnapshot: null, unit: null,
    });
  });
  it('refreshes all snapshots when replacing with a different active Product', async () => {
    const repo = new DeliveryRepository(); const service = new JobCardService(repo);
    const added = await service.addDeliveryItem(staff, 'job-1', create);

    const result = await service.patchDeliveryItem(staff, 'job-1', added.item.id, {
      expectedVersion: 2, productId: repo.replacementProduct.id,
    });

    expect(repo.getProductCalls).toEqual(['product-1', 'product-2']);
    expect(result.item).toMatchObject({
      productId: 'product-2', productNameSnapshot: 'Greft Seti', productSkuSnapshot: 'GRF-2',
      productModelSnapshot: 'G2', unit: 'kutu',
    });
  });
  it('rejects stale item mutation without another event', async () => {
    const repo = new DeliveryRepository(); const service = new JobCardService(repo);
    const added = await service.addDeliveryItem(staff, 'job-1', create);
    await expect(service.patchDeliveryItem(staff, 'job-1', added.item.id!, { expectedVersion: 1, quantity: 3 }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(repo.events).toHaveLength(1);
  });
});
