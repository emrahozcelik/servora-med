import { AppError } from '../../errors/index.js';
import { assertCanCreateForAssignee, assertCanEdit, assertCanTransition, assertDeliveryReadyForSubmission } from './policy.js';
import type { DeliveryItemRecord, JobCardRepository, JobCardTransaction, ProductReference } from './repository.js';
import { DELIVERY_PURPOSES, JOB_CARD_PRIORITIES, type DeliveryPurpose, type JobCard, type JobCardActor, type JobCardPriority } from './types.js';

type CommandInput = {
  jobCardId: string;
  expectedVersion: number;
  clientActionId: string;
};

type CreateInput = {
  clientActionId: string;
  type: 'PRODUCT_DELIVERY';
  title: string;
  description?: string | null;
  customerId: string;
  contactId?: string | null;
  assignedTo: string;
  priority?: JobCardPriority;
  dueDate?: string | null;
};

type PatchInput = {
  expectedVersion: number; title?: string; description?: string | null;
  customerId?: string; contactId?: string | null; assignedTo?: string; priority?: JobCardPriority; dueDate?: string | null;
};
type DeliveryInput = {
  expectedVersion: number; productId: string; deliveryPurpose: DeliveryPurpose;
  deliveredAt: string; quantity: number; lotNo?: string | null; serialNo?: string | null;
  expiryDate?: string | null; deliveryNote?: string | null;
};
type AddDeliveryInput = DeliveryInput & { clientActionId: string };
type PatchDeliveryInput = { expectedVersion: number } & Partial<Omit<DeliveryInput, 'expectedVersion'>>;
type LifecycleInput = { expectedVersion: number; clientActionId: string; note?: string | null };

function deliveryRecord(organizationId: string, jobCardId: string, input: DeliveryInput, product: ProductReference): Omit<DeliveryItemRecord, 'id'> {
  const deliveredAt = new Date(input.deliveredAt);
  if (!DELIVERY_PURPOSES.includes(input.deliveryPurpose) || !Number.isFinite(input.quantity) || input.quantity <= 0 ||
    Number.isNaN(deliveredAt.getTime()) || !input.productId) {
    throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünü bilgileri geçersiz.');
  }
  return { organizationId, jobCardId, productId: product.id, deliveryPurpose: input.deliveryPurpose,
    deliveredAt, quantity: input.quantity, unit: product.unit, productNameSnapshot: product.name,
    productSkuSnapshot: product.sku, productModelSnapshot: product.model, lotNo: input.lotNo?.trim() || null,
    serialNo: input.serialNo?.trim() || null, expiryDate: input.expiryDate ?? null,
    deliveryNote: input.deliveryNote?.trim() || null };
}

function assertKnownFields(input: object, allowed: readonly string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new AppError('VALIDATION_ERROR', 400, 'İstek desteklenmeyen alan içeriyor.');
  }
}

const DELIVERY_FIELDS = [
  'expectedVersion', 'productId', 'deliveryPurpose', 'deliveredAt', 'quantity',
  'lotNo', 'serialNo', 'expiryDate', 'deliveryNote',
] as const;

export class JobCardService {
  constructor(
    private readonly repository: JobCardRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(actor: JobCardActor, input: CreateInput) {
    const title = input.title.trim();
    const priority = input.priority ?? 'normal';
    if (!input.clientActionId.trim() || !title || input.type !== 'PRODUCT_DELIVERY' ||
      !input.customerId || !input.assignedTo || !JOB_CARD_PRIORITIES.includes(priority)) {
      throw new AppError('VALIDATION_ERROR', 400, 'JobCard oluşturma bilgileri geçersiz.');
    }
    const result = await this.repository.executeCriticalAction(
      {
        organizationId: actor.organizationId, userId: actor.id,
        clientActionId: input.clientActionId, operationKey: 'JOB_CREATE',
      },
      async (transaction) => {
        const assignee = await transaction.getAssigneeForUpdate(actor.organizationId, input.assignedTo);
        if (!assignee) throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
        assertCanCreateForAssignee(actor, assignee);
        await this.validateJobReferences(transaction, actor.organizationId, input.customerId, input.contactId ?? null);
        const job = await transaction.createJobCard({
          organizationId: actor.organizationId, type: input.type, title,
          description: input.description?.trim() || null, customerId: input.customerId,
          contactId: input.contactId ?? null,
          assignedTo: input.assignedTo, createdBy: actor.id, priority,
          dueDate: input.dueDate ?? null,
        });
        await transaction.appendActivity({
          organizationId: actor.organizationId, jobCardId: job.id, actorId: actor.id,
          event: 'JOB_CREATED', clientActionId: input.clientActionId,
          newValue: { status: job.status, assignedTo: job.assignedTo, version: job.version },
        });
        return job;
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    return result.response;
  }

  async list(actor: JobCardActor) {
    return this.repository.listJobCards({
      organizationId: actor.organizationId,
      ...(actor.role === 'STAFF' ? { assignedTo: actor.id } : {}),
    });
  }

  async detail(actor: JobCardActor, jobCardId: string) {
    const job = await this.repository.findJobCard(actor.organizationId, jobCardId);
    if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    }
    return job;
  }

  async patch(actor: JobCardActor, jobCardId: string, input: PatchInput) {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AppError('VALIDATION_ERROR', 400, 'expectedVersion pozitif bir tam sayı olmalıdır.');
    }
    const fields = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'expectedVersion')) as Omit<PatchInput, 'expectedVersion'>;
    if (Object.keys(fields).length === 0 || (fields.title !== undefined && !fields.title.trim()) ||
      (fields.priority !== undefined && !JOB_CARD_PRIORITIES.includes(fields.priority))) {
      throw new AppError('VALIDATION_ERROR', 400, 'JobCard güncelleme bilgileri geçersiz.');
    }
    if (fields.title !== undefined) fields.title = fields.title.trim();
    if (fields.description !== undefined) fields.description = fields.description?.trim() || null;

    return this.repository.executeTransaction(async (transaction) => {
      const snapshot = await transaction.getJob(actor.organizationId, jobCardId);
      if (!snapshot) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      if (snapshot.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      }
      if (fields.assignedTo !== undefined && fields.assignedTo !== snapshot.assignedTo) {
        const assignee = await transaction.getAssigneeForUpdate(actor.organizationId, fields.assignedTo);
        if (!assignee) throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
        assertCanCreateForAssignee(actor, assignee);
      }
      const nextCustomerId = fields.customerId !== undefined ? fields.customerId : snapshot.customerId;
      const nextContactId = fields.contactId !== undefined ? fields.contactId
        : fields.customerId !== undefined && fields.customerId !== snapshot.customerId ? null : snapshot.contactId;
      if (nextCustomerId) await this.validateJobReferences(transaction, actor.organizationId, nextCustomerId, nextContactId);
      else if (nextContactId) throw new AppError('CONTACT_NOT_IN_CUSTOMER', 409, 'İlgili kişi seçilen müşteriye bağlı değil.');
      if (fields.customerId !== undefined && fields.contactId === undefined && fields.customerId !== snapshot.customerId) {
        fields.contactId = null;
      }
      const job = await transaction.getJobForUpdate(actor.organizationId, jobCardId);
      if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      if (job.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      }
      assertCanEdit(actor, job);
      const updated = await transaction.updateFieldsWithVersion({
        organizationId: actor.organizationId, jobCardId, expectedVersion: input.expectedVersion, fields,
      });
      if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      if (fields.assignedTo !== undefined && fields.assignedTo !== job.assignedTo) {
        await transaction.appendActivity({
          organizationId: actor.organizationId, jobCardId, actorId: actor.id,
          event: 'JOB_ASSIGNED',
          oldValue: { assignedTo: job.assignedTo }, newValue: { assignedTo: updated.assignedTo },
        });
      }
      const nonAssignmentFields = Object.keys(fields).filter((key) => key !== 'assignedTo');
      if (nonAssignmentFields.length > 0) {
        await transaction.appendActivity({
          organizationId: actor.organizationId, jobCardId, actorId: actor.id,
          event: 'JOB_FIELDS_UPDATED',
          oldValue: Object.fromEntries(nonAssignmentFields.map((key) => [key, job[key as keyof typeof job]])),
          newValue: Object.fromEntries(nonAssignmentFields.map((key) => [key, updated[key as keyof typeof updated]])),
        });
      }
      return updated;
    });
  }

  private async validateJobReferences(tx: JobCardTransaction, organizationId: string, customerId: string, contactId: string | null) {
    const customer = await tx.getCustomerForUpdate(organizationId, customerId);
    if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
    if (customer.status === 'inactive') throw new AppError('CUSTOMER_INACTIVE', 409, 'Pasif müşteri için iş oluşturulamaz.');
    if (!contactId) return;
    const contact = await tx.getContactForUpdate(organizationId, contactId);
    if (!contact) throw new AppError('CONTACT_NOT_FOUND', 404, 'İlgili kişi bulunamadı.');
    if (contact.customerId !== customerId) throw new AppError('CONTACT_NOT_IN_CUSTOMER', 409, 'İlgili kişi seçilen müşteriye bağlı değil.');
    if (!contact.isActive) throw new AppError('CONTACT_INACTIVE', 409, 'Pasif ilgili kişi iş kartında kullanılamaz.');
  }

  async addDeliveryItem(actor: JobCardActor, jobCardId: string, input: AddDeliveryInput) {
    assertKnownFields(input, ['clientActionId', ...DELIVERY_FIELDS]);
    if (!input.clientActionId.trim()) throw new AppError('VALIDATION_ERROR', 400, 'clientActionId zorunludur.');
    const result = await this.repository.executeCriticalAction(
      { organizationId: actor.organizationId, userId: actor.id, clientActionId: input.clientActionId, operationKey: 'DELIVERY_ITEM_CREATE' },
      async (tx) => {
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        assertCanEdit(actor, job);
        if (job.type !== 'PRODUCT_DELIVERY') throw new AppError('INVALID_JOB_TYPE', 409, 'Bu JobCard teslim ürünü kabul etmez.');
        const product = await tx.getProduct(actor.organizationId, input.productId);
        if (!product?.isActive) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
        const item = await tx.createDeliveryItem(deliveryRecord(actor.organizationId, jobCardId, input, product));
        const updated = await tx.bumpVersion(actor.organizationId, jobCardId, input.expectedVersion);
        if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        await tx.appendActivity({ organizationId: actor.organizationId, jobCardId, actorId: actor.id,
          event: 'DELIVERY_ITEM_ADDED', clientActionId: input.clientActionId,
          newValue: { itemId: item.id, productId: item.productId, deliveryPurpose: item.deliveryPurpose, quantity: item.quantity } });
        return { item, jobCardVersion: updated.version };
      });
    if (result.kind === 'processing') throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    return result.response;
  }

  async patchDeliveryItem(actor: JobCardActor, jobCardId: string, itemId: string, input: PatchDeliveryInput) {
    assertKnownFields(input, DELIVERY_FIELDS);
    return this.repository.executeTransaction(async (tx) => {
      const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
      if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      assertCanEdit(actor, job);
      const current = await tx.getDeliveryItemForUpdate(actor.organizationId, jobCardId, itemId);
      if (!current) throw new AppError('DELIVERY_ITEM_NOT_FOUND', 404, 'Teslim ürünü bulunamadı.');
      const product = input.productId && input.productId !== current.productId
        ? await tx.getProduct(actor.organizationId, input.productId) : {
          id: current.productId, organizationId: current.organizationId, name: current.productNameSnapshot,
          sku: current.productSkuSnapshot, model: current.productModelSnapshot, unit: current.unit, isActive: true };
      if (!product?.isActive) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
      const merged: DeliveryInput = { expectedVersion: input.expectedVersion, productId: input.productId ?? current.productId,
        deliveryPurpose: input.deliveryPurpose ?? current.deliveryPurpose,
        deliveredAt: input.deliveredAt ?? current.deliveredAt.toISOString(), quantity: input.quantity ?? current.quantity,
        lotNo: input.lotNo === undefined ? current.lotNo : input.lotNo, serialNo: input.serialNo === undefined ? current.serialNo : input.serialNo,
        expiryDate: input.expiryDate === undefined ? current.expiryDate : input.expiryDate,
        deliveryNote: input.deliveryNote === undefined ? current.deliveryNote : input.deliveryNote };
      const item = await tx.updateDeliveryItem(itemId, deliveryRecord(actor.organizationId, jobCardId, merged, product));
      const updated = await tx.bumpVersion(actor.organizationId, jobCardId, input.expectedVersion);
      if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      await tx.appendActivity({ organizationId: actor.organizationId, jobCardId, actorId: actor.id,
        event: 'DELIVERY_ITEM_UPDATED', oldValue: { itemId, quantity: current.quantity, deliveryPurpose: current.deliveryPurpose },
        newValue: { itemId, quantity: item.quantity, deliveryPurpose: item.deliveryPurpose } });
      return { item, jobCardVersion: updated.version };
    });
  }

  async removeDeliveryItem(actor: JobCardActor, jobCardId: string, itemId: string, input: { expectedVersion: number }) {
    return this.repository.executeTransaction(async (tx) => {
      const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
      if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      assertCanEdit(actor, job);
      const item = await tx.getDeliveryItemForUpdate(actor.organizationId, jobCardId, itemId);
      if (!item) throw new AppError('DELIVERY_ITEM_NOT_FOUND', 404, 'Teslim ürünü bulunamadı.');
      await tx.deleteDeliveryItem(itemId);
      const updated = await tx.bumpVersion(actor.organizationId, jobCardId, input.expectedVersion);
      if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      await tx.appendActivity({ organizationId: actor.organizationId, jobCardId, actorId: actor.id,
        event: 'DELIVERY_ITEM_REMOVED', oldValue: { itemId, productId: item.productId, quantity: item.quantity } });
      return { id: itemId, jobCardVersion: updated.version };
    });
  }

  async listDeliveryItems(actor: JobCardActor, jobCardId: string) {
    await this.detail(actor, jobCardId);
    return this.repository.listDeliveryItems(actor.organizationId, jobCardId);
  }

  async listActivity(actor: JobCardActor, jobCardId: string) {
    await this.detail(actor, jobCardId);
    return this.repository.listActivity(actor.organizationId, jobCardId);
  }

  async listReferenceCustomers(actor: JobCardActor) {
    return this.repository.listReferenceCustomers(actor.organizationId);
  }

  async listReferenceProducts(actor: JobCardActor) {
    return this.repository.listReferenceProducts(actor.organizationId);
  }

  async submitForApproval(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, input, {
      command: 'SUBMIT_FOR_APPROVAL', operationKey: 'JOB_SUBMIT_FOR_APPROVAL',
      status: 'WAITING_APPROVAL', event: 'JOB_SUBMITTED_FOR_APPROVAL',
      beforeTransition: async (tx, job) => {
        if (!job.customerId || !(await tx.customerExists(actor.organizationId, job.customerId))) {
          throw new AppError('DELIVERY_NOT_READY', 400, 'Ürün teslimi için geçerli müşteri zorunludur.');
        }
        const assignee = await tx.getAssignee(actor.organizationId, job.assignedTo);
        if (!assignee?.isActive || assignee.role !== 'STAFF') {
          throw new AppError('ASSIGNEE_NOT_ELIGIBLE', 400, 'Atanan personel aktif ve uygun olmalıdır.');
        }
        const items = await tx.getSubmissionDeliveryItems(actor.organizationId, job.id);
        assertDeliveryReadyForSubmission(job, items);
      },
    });
  }

  async approve(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, input, {
      command: 'APPROVE', operationKey: 'JOB_APPROVE', status: 'COMPLETED', event: 'JOB_APPROVED',
    });
  }

  async requestRevision(actor: JobCardActor, jobCardId: string, input: LifecycleInput & { revisionReason: string }) {
    return this.runLifecycle(actor, jobCardId, input, {
      command: 'REQUEST_REVISION', operationKey: 'JOB_REQUEST_REVISION', status: 'REVISION_REQUESTED',
      event: 'JOB_REVISION_REQUESTED', revisionReason: input.revisionReason,
    });
  }

  private async runLifecycle(
    actor: JobCardActor,
    jobCardId: string,
    input: LifecycleInput,
    options: {
      command: 'SUBMIT_FOR_APPROVAL' | 'APPROVE' | 'REQUEST_REVISION';
      operationKey: string;
      status: 'WAITING_APPROVAL' | 'COMPLETED' | 'REVISION_REQUESTED';
      event: 'JOB_SUBMITTED_FOR_APPROVAL' | 'JOB_APPROVED' | 'JOB_REVISION_REQUESTED';
      revisionReason?: string;
      beforeTransition?: (tx: JobCardTransaction, job: JobCard) => Promise<void>;
    },
  ) {
    if (!input.clientActionId.trim() || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AppError('VALIDATION_ERROR', 400, 'Lifecycle komut bilgileri geçersiz.');
    }
    const result = await this.repository.executeCriticalAction(
      { organizationId: actor.organizationId, userId: actor.id, clientActionId: input.clientActionId, operationKey: options.operationKey },
      async (tx) => {
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        assertCanTransition(actor, job, options.command, options.revisionReason);
        if (options.beforeTransition) await options.beforeTransition(tx, job);
        const updated = await tx.transitionWithVersion({
          organizationId: actor.organizationId, jobCardId, expectedVersion: input.expectedVersion,
          status: options.status, occurredAt: this.now(), actorId: actor.id,
          note: input.note?.trim() || null, revisionReason: options.revisionReason?.trim() || null,
        });
        if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        await tx.appendActivity({ organizationId: actor.organizationId, jobCardId, actorId: actor.id,
          event: options.event, clientActionId: input.clientActionId,
          oldValue: { status: job.status, version: job.version }, newValue: { status: updated.status, version: updated.version } });
        return updated;
      });
    if (result.kind === 'processing') throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    return result.response;
  }

  async start(actor: JobCardActor, input: CommandInput) {
    if (!input.clientActionId.trim()) {
      throw new AppError('VALIDATION_ERROR', 400, 'clientActionId zorunludur.');
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AppError('VALIDATION_ERROR', 400, 'expectedVersion pozitif bir tam sayı olmalıdır.');
    }

    const result = await this.repository.executeCriticalAction(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId: input.clientActionId,
        operationKey: 'JOB_START',
      },
      async (transaction) => {
        const job = await transaction.getJobForUpdate(actor.organizationId, input.jobCardId);
        if (!job) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        if (job.version !== input.expectedVersion) {
          throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        }
        assertCanTransition(actor, job, 'START');

        const updated = await transaction.transitionWithVersion({
          organizationId: actor.organizationId,
          jobCardId: job.id,
          expectedVersion: input.expectedVersion,
          status: 'IN_PROGRESS',
          occurredAt: this.now(),
        });
        if (!updated) {
          throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        }
        await transaction.appendActivity({
          organizationId: actor.organizationId,
          jobCardId: job.id,
          actorId: actor.id,
          event: 'JOB_STARTED',
          clientActionId: input.clientActionId,
          oldValue: { status: job.status, version: job.version },
          newValue: { status: updated.status, version: updated.version },
        });
        return updated;
      },
    );

    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    return result.response;
  }
}
