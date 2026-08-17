import { describe, expect, it } from 'vitest';

import { JobCardService } from '../src/modules/job-cards/service.js';
import type { ProductDeliveryCreateInput, JobCard, JobCardActor } from '../src/modules/job-cards/types.js';
import type { DeliveryItemRecord, ProductReference } from '../src/modules/job-cards/repository.js';

class ProductDeliveryRepository {
  jobs: JobCard[] = [];
  items: DeliveryItemRecord[] = [];
  activities: Array<{ event: string; newValue?: unknown }> = [];
  realtimeRows: unknown[] = [];
  notificationRows: unknown[] = [];
  webPushRows: unknown[] = [];
  products: ProductReference[] = [
    { id: 'product-1', organizationId: 'org-1', name: 'Matrix Sistem', sku: 'M-1', model: 'M1', unit: 'kutu', isActive: true },
    { id: 'product-2', organizationId: 'org-1', name: 'Cycles Kit', sku: 'C-2', model: 'C2', unit: 'adet', isActive: true },
    { id: 'product-3', organizationId: 'org-1', name: 'Greft Seti', sku: null, model: 'G3', unit: 'paket', isActive: true },
  ];
  completed = new Map<string, unknown>();
  failOnItemNumber: number | null = null;
  private itemCalls = 0;

  async executeCriticalAction(_claim: unknown, work: (tx: any) => Promise<any>) {
    const claim = _claim as { userId: string; clientActionId: string; operationKey: string };
    const key = `${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key), realtimeEvents: [] as const };
    const beforeJobs = this.jobs.map((job) => ({ ...job }));
    const beforeItems = this.items.map((item) => ({ ...item }));
    const beforeActivities = this.activities.length;
    const beforeRealtimeRows = this.realtimeRows.length;
    const beforeNotificationRows = this.notificationRows.length;
    const beforeWebPushRows = this.webPushRows.length;
    const tx = {
      getAssigneeForUpdate: async (organizationId: string, id: string) =>
        organizationId === 'org-1' && id === 'staff-1'
          ? { id, organizationId, role: 'STAFF' as const, isActive: true }
          : null,
      getCustomerForUpdate: async (organizationId: string, id: string) =>
        organizationId === 'org-1' && id === 'customer-1' ? { id, status: 'active' as const } : null,
      getContactForUpdate: async () => null,
      getOrganizationTimezone: async () => 'Europe/Istanbul',
      listActiveOnSiteJobs: async () => [],
      listRecentOnSiteVisits: async () => [],
      listAssigneeCalendarIntervals: async () => [],
      createJobCard: async (input: any) => {
        const job: JobCard = {
          id: `job-${this.jobs.length + 1}`, version: 1, organizationId: input.organizationId,
          type: input.type, status: input.status, title: input.title, description: input.description,
          customerId: input.customerId, contactId: input.contactId, assignedTo: input.assignedTo,
          createdBy: input.createdBy, priority: input.priority, dueDate: input.dueDate,
          scheduledAt: input.scheduledAt, scheduledEndsAt: input.scheduledEndsAt,
          engagementKind: input.engagementKind, sourceJobCardId: null, followUpInstructions: null,
          followUpProposedAt: null, followUpProposedType: null, followUpProposedAssignee: null,
          followUpProposalInstructions: null, followUpProposalOrigin: null, followUpProposedBy: null,
        };
        this.jobs.push(job);
        return job;
      },
      getProduct: async (organizationId: string, id: string) =>
        this.products.find((product) => product.organizationId === organizationId && product.id === id) ?? null,
      createDeliveryItem: async (input: Omit<DeliveryItemRecord, 'id'>) => {
        this.itemCalls += 1;
        if (this.failOnItemNumber === this.itemCalls) throw new Error('simulated item insert failure');
        const item = { ...input, id: `item-${this.items.length + 1}` };
        this.items.push(item);
        return item;
      },
      bumpVersion: async (organizationId: string, id: string, expectedVersion: number) => {
        const job = this.jobs.find((candidate) => candidate.organizationId === organizationId && candidate.id === id);
        if (!job || job.version !== expectedVersion) return null;
        job.version += 1;
        return { ...job };
      },
      appendActivity: async (input: { event: string; newValue?: unknown }) => {
        this.activities.push(input);
        return { id: `activity-${this.activities.length}`, createdAt: new Date('2026-08-17T10:00:00.000Z') };
      },
      appendRealtimeEvent: async (input: any) => {
        const event = { ...input, id: BigInt(this.realtimeRows.length + 1) };
        this.realtimeRows.push(event);
        return event;
      },
      listActiveManagementRecipients: async () => [],
      appendNotifications: async (input: unknown) => {
        this.notificationRows.push(input);
        return [];
      },
      appendWebPushDeliveries: async (input: unknown) => {
        this.webPushRows.push(input);
        return [];
      },
      assertCalendarAvailability: async () => {},
      synchronizeCalendarReminder: async () => {},
    };
    try {
      const result = await work(tx);
      this.completed.set(key, result.response);
      return { kind: 'completed' as const, ...result };
    } catch (error) {
      this.jobs = beforeJobs;
      this.items = beforeItems;
      this.activities.splice(beforeActivities);
      this.realtimeRows.splice(beforeRealtimeRows);
      this.notificationRows.splice(beforeNotificationRows);
      this.webPushRows.splice(beforeWebPushRows);
      throw error;
    }
  }
}

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const deliveryInput: ProductDeliveryCreateInput = {
  clientActionId: 'delivery-batch-1', type: 'PRODUCT_DELIVERY', title: 'Klinik teslimi',
  description: null, customerId: 'customer-1', contactId: null, assignedTo: 'staff-1',
  priority: 'normal', dueDate: null, scheduledAt: '2026-08-18T10:00:00.000Z',
  scheduledEndsAt: '2026-08-18T10:30:00.000Z', overrideReason: null,
  deliveryPurpose: 'SALE', deliveryNote: 'Tek ortak teslim notu',
  items: [
    { productId: 'product-1', quantity: 2 },
    { productId: 'product-2', quantity: 1 },
    { productId: 'product-3', quantity: 5 },
  ],
};

describe('Product Delivery atomic create', () => {
  it('creates one JobCard and three delivery items with the final version', async () => {
    const repository = new ProductDeliveryRepository();
    const result = await new JobCardService(repository as never).createProductDelivery(staff, deliveryInput);

    expect(result).toEqual({ jobCardId: 'job-1', version: 4 });
    expect(repository.jobs).toHaveLength(1);
    expect(repository.jobs[0]).toMatchObject({ type: 'PRODUCT_DELIVERY', scheduledEndsAt: '2026-08-18T10:30:00.000Z' });
    expect(repository.items).toHaveLength(3);
    expect(repository.items.map((item) => [item.productId, item.quantity, item.deliveryPurpose, item.deliveryNote])).toEqual([
      ['product-1', 2, 'SALE', 'Tek ortak teslim notu'],
      ['product-2', 1, 'SALE', 'Tek ortak teslim notu'],
      ['product-3', 5, 'SALE', 'Tek ortak teslim notu'],
    ]);
    expect(repository.activities.map((activity) => activity.event)).toEqual([
      'JOB_CREATED', 'DELIVERY_ITEM_ADDED', 'DELIVERY_ITEM_ADDED', 'DELIVERY_ITEM_ADDED',
    ]);
    expect(repository.jobs[0]?.version).toBe(4);
  });

  it.each([
    ['second', [
      { productId: 'product-1', quantity: 2 },
      { productId: 'missing-product', quantity: 1 },
    ]],
    ['third', [
      { productId: 'product-1', quantity: 2 },
      { productId: 'product-2', quantity: 1 },
      { productId: 'missing-product', quantity: 5 },
    ]],
  ])('rolls back the whole create when the %s product is invalid', async (_position, items) => {
    const repository = new ProductDeliveryRepository();
    await expect(new JobCardService(repository as never).createProductDelivery(staff, {
      ...deliveryInput, clientActionId: `invalid-${_position}`, items,
    })).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND', statusCode: 404 });
    expect(repository.jobs).toHaveLength(0);
    expect(repository.items).toHaveLength(0);
    expect(repository.activities).toHaveLength(0);
    expect(repository.realtimeRows).toHaveLength(0);
    expect(repository.notificationRows).toHaveLength(0);
  });

  it('fails closed for inactive and cross-organization products before creating the JobCard', async () => {
    const repository = new ProductDeliveryRepository();
    repository.products.find((product) => product.id === 'product-2')!.isActive = false;
    await expect(new JobCardService(repository as never).createProductDelivery(staff, {
      ...deliveryInput, clientActionId: 'inactive-product', items: [{ productId: 'product-2', quantity: 1 }],
    })).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND', statusCode: 404 });

    await expect(new JobCardService(repository as never).createProductDelivery(staff, {
      ...deliveryInput, clientActionId: 'cross-org-product', items: [{ productId: 'org-2-product', quantity: 1 }],
    })).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND', statusCode: 404 });
    expect(repository.jobs).toHaveLength(0);
    expect(repository.items).toHaveLength(0);
  });

  it('rolls back items, activities, transaction artifacts, and publication on an internal failure', async () => {
    const repository = new ProductDeliveryRepository();
    repository.failOnItemNumber = 2;
    const published: unknown[] = [];
    const service = new JobCardService(repository as never, undefined, {
      publish: (event) => published.push(event),
    });

    await expect(service.createProductDelivery(staff, {
      ...deliveryInput, clientActionId: 'insert-failure',
    })).rejects.toThrow('simulated item insert failure');
    expect(repository.jobs).toHaveLength(0);
    expect(repository.items).toHaveLength(0);
    expect(repository.activities).toHaveLength(0);
    expect(repository.realtimeRows).toHaveLength(0);
    expect(repository.notificationRows).toHaveLength(0);
    expect(repository.webPushRows).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('replays the completed result without duplicating the JobCard, items, activities, or events', async () => {
    const repository = new ProductDeliveryRepository();
    const published: unknown[] = [];
    const service = new JobCardService(repository as never, undefined, {
      publish: (event) => published.push(event),
    });
    const first = await service.createProductDelivery(staff, deliveryInput);
    const counts = {
      jobs: repository.jobs.length,
      items: repository.items.length,
      activities: repository.activities.length,
      realtime: repository.realtimeRows.length,
      published: published.length,
    };
    const replay = await service.createProductDelivery(staff, deliveryInput);

    expect(replay).toEqual(first);
    expect(repository.jobs).toHaveLength(counts.jobs);
    expect(repository.items).toHaveLength(counts.items);
    expect(repository.activities).toHaveLength(counts.activities);
    expect(repository.realtimeRows).toHaveLength(counts.realtime);
    expect(published).toHaveLength(counts.published);
  });

  it('rejects duplicate products and invalid quantities at the service boundary', async () => {
    const repository = new ProductDeliveryRepository();
    const service = new JobCardService(repository as never);
    await expect(service.createProductDelivery(staff, {
      ...deliveryInput, clientActionId: 'duplicate-product', items: [
        { productId: 'product-1', quantity: 1 }, { productId: 'product-1', quantity: 2 },
      ],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    await expect(service.createProductDelivery(staff, {
      ...deliveryInput, clientActionId: 'invalid-quantity', items: [{ productId: 'product-1', quantity: 0 }],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(repository.jobs).toHaveLength(0);
  });
});
