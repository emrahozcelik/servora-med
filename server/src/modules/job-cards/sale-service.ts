import { AppError } from '../../errors/index.js';
import { hashRequestIdentity } from './critical-action-request-hash.js';
import { lockAssigneesInOrder } from './assignee-lock.js';
import { assertCanCreateForAssignee, assertCanEdit } from './policy.js';
import type { AppendedActivity, JobCardRepository, JobCardTransaction } from './repository.js';
import type { JobCard, JobCardActor, JobCardActivityEvent } from './types.js';
import type { RealtimeEventRecord } from '../realtime/types.js';
import { MAX_SALE_ITEMS, parseSaleAddition, parseSaleDetailsPatch, parseSaleFromVisitCreateInput, parseSaleQuantityPatch, parseSaleRemoval } from './sale-input.js';
import { uuidString } from './validation.js';
import { assertSaleSourceEligible, assertSaleTimeValid } from './sale-policy.js';

type SaleEffects = (tx: JobCardTransaction, job: JobCard, activity: AppendedActivity,
  event: JobCardActivityEvent, actorId: string) => Promise<RealtimeEventRecord[]>;

/** Transactional Sale domain service; HTTP wiring delegates without changing receipt semantics. */
export class JobCardSaleService {
  constructor(private readonly repository: JobCardRepository, private readonly now: () => Date,
    private readonly effects: SaleEffects, private readonly publish: (events: readonly RealtimeEventRecord[]) => void) {}

  private async assertCurrentAccess(actor: JobCardActor, jobCardId: string) {
    const job = await this.repository.findJobCard(actor.organizationId, jobCardId);
    if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    }
    const currentActor = await this.repository.getAssignee(actor.organizationId, actor.id);
    if (!currentActor?.isActive || currentActor.role !== actor.role) {
      throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
    }
  }

  private async correct(actor: JobCardActor, jobCardId: string,
    input: { clientActionId: string; expectedVersion: number }, operation: string, intent: object,
    change: (tx: JobCardTransaction, job: JobCard) => Promise<{
      event: JobCardActivityEvent; oldValue?: Record<string, unknown>; newValue?: Record<string, unknown>;
    }>) {
    const result = await this.repository.executeCriticalAction({
      organizationId: actor.organizationId, userId: actor.id, clientActionId: input.clientActionId,
      operationKey: operation,
      requestHash: hashRequestIdentity({ operation: `${operation}:v1`, jobCardId, expectedVersion: input.expectedVersion, ...intent }),
    }, async (tx) => {
      const snapshot = await tx.getJob(actor.organizationId, jobCardId);
      if (!snapshot || (actor.role === 'STAFF' && snapshot.assignedTo !== actor.id)) {
        throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      }
      const users = await lockAssigneesInOrder(tx, actor.organizationId, [actor.id, snapshot.assignedTo]);
      const currentActor = users.get(actor.id);
      if (!currentActor?.isActive || currentActor.role !== actor.role) {
        throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
      }
      const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
      if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
        throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      }
      if (job.version !== input.expectedVersion || job.assignedTo !== snapshot.assignedTo) {
        throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      }
      if (job.type !== 'SALE') throw new AppError('INVALID_JOB_TYPE', 409, 'Bu işlem yalnız satış kayıtlarında kullanılabilir.');
      assertCanEdit(actor, job);
      const action = await change(tx, job);
      const updated = await tx.bumpVersion(actor.organizationId, jobCardId, input.expectedVersion);
      if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      const activity = await tx.appendActivity({ organizationId: actor.organizationId, jobCardId,
        actorId: actor.id, clientActionId: input.clientActionId, ...action });
      return { response: { jobCardId, version: updated.version },
        realtimeEvents: await this.effects(tx, updated, activity, action.event, actor.id) };
    });
    if (result.kind === 'processing') throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    if (result.kind === 'completed') this.publish(result.realtimeEvents);
    await this.assertCurrentAccess(actor, result.response.jobCardId);
    return result.response;
  }

  async patchSaleItem(actor: JobCardActor, jobId: string, itemIdValue: string, value: unknown) {
    const jobCardId = uuidString(jobId, 'jobCardId').toLowerCase();
    const itemId = uuidString(itemIdValue, 'itemId').toLowerCase();
    const input = parseSaleQuantityPatch(value);
    return this.correct(actor, jobCardId, input, 'SALE_ITEM_UPDATE', { itemId, quantity: input.quantity }, async (tx) => {
      const item = (await tx.sale.getItems(actor.organizationId, jobCardId)).find((item) => item.id === itemId);
      if (!item) throw new AppError('SALE_ITEM_NOT_FOUND', 404, 'Satış kalemi bulunamadı.');
      if (item.quantity === input.quantity) throw new AppError('NO_CHANGES', 400, 'Değişiklik bulunamadı.');
      await tx.sale.updateQuantity(actor.organizationId, jobCardId, itemId, input.quantity);
      return { event: 'SALE_ITEM_UPDATED', oldValue: { ...item }, newValue: { ...item, quantity: input.quantity } };
    });
  }

  async removeSaleItem(actor: JobCardActor, jobId: string, itemIdValue: string, value: unknown) {
    const jobCardId = uuidString(jobId, 'jobCardId').toLowerCase();
    const itemId = uuidString(itemIdValue, 'itemId').toLowerCase();
    const input = parseSaleRemoval(value);
    return this.correct(actor, jobCardId, input, 'SALE_ITEM_REMOVE', { itemId }, async (tx) => {
      const item = (await tx.sale.getItems(actor.organizationId, jobCardId)).find((item) => item.id === itemId);
      if (!item) throw new AppError('SALE_ITEM_NOT_FOUND', 404, 'Satış kalemi bulunamadı.');
      await tx.sale.removeItem(actor.organizationId, jobCardId, itemId);
      return { event: 'SALE_ITEM_REMOVED', oldValue: { ...item } };
    });
  }

  async addSaleItem(actor: JobCardActor, jobId: string, value: unknown) {
    const jobCardId = uuidString(jobId, 'jobCardId').toLowerCase();
    const input = parseSaleAddition(value);
    return this.correct(actor, jobCardId, input, 'SALE_ITEM_ADD', { productId: input.productId, quantity: input.quantity }, async (tx) => {
      const items = await tx.sale.getItems(actor.organizationId, jobCardId);
      if (items.some((item) => item.productId === input.productId)) {
        throw new AppError('SALE_PRODUCT_DUPLICATE', 409, 'Bu ürün satış kaydında zaten var.');
      }
      if (items.length >= MAX_SALE_ITEMS) throw new AppError('SALE_ITEM_LIMIT', 409, 'Satış kalemi sınırına ulaşıldı.');
      const [product] = await tx.sale.getProductsForShare(actor.organizationId, [input.productId]);
      if (!product?.isActive) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
      if (product.dataClass !== 'BUSINESS') throw new AppError('SALE_REFERENCE_NOT_ELIGIBLE', 409, 'Satış kaydı BUSINESS ürünleri gerektirir.');
      const item = await tx.sale.createItem({ organizationId: actor.organizationId, jobCardId,
        productId: product.id, quantity: input.quantity, productNameSnapshot: product.name,
        productSkuSnapshot: product.sku, productBrandSnapshot: product.brand,
        productModelSnapshot: product.model, unitSnapshot: product.unit,
        sortOrder: items.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1 });
      return { event: 'SALE_ITEM_ADDED', newValue: { ...item } };
    });
  }

  async patchSaleDetails(actor: JobCardActor, jobId: string, value: unknown) {
    const jobCardId = uuidString(jobId, 'jobCardId').toLowerCase();
    const input = parseSaleDetailsPatch(value);
    return this.correct(actor, jobCardId, input, 'SALE_DETAILS_UPDATE', input.fields, async (tx, job) => {
      const before = await tx.sale.getDetails(actor.organizationId, jobCardId);
      if (!before) throw new AppError('SALE_DETAILS_NOT_FOUND', 409, 'Satış bilgileri bulunamadı.');
      const after = { ...before, soldAt: input.fields.soldAt ?? before.soldAt };
      assertSaleTimeValid(after.soldAt, this.now());
      if (input.fields.saleContactId !== undefined && input.fields.saleContactId !== before.saleContactId) {
        const id = input.fields.saleContactId;
        const [contact] = id ? await tx.sale.getContactsForShare(actor.organizationId, [id]) : [];
        if (id && !contact) throw new AppError('CONTACT_NOT_FOUND', 404, 'İlgili kişi bulunamadı.');
        if (contact && contact.customerId !== job.customerId) throw new AppError('CONTACT_NOT_IN_CUSTOMER', 409, 'İlgili kişi kaynak müşteriye bağlı değil.');
        if (contact && !contact.isActive) throw new AppError('CONTACT_INACTIVE', 409, 'Pasif ilgili kişi seçilemez.');
        after.saleContactId = id;
        after.saleContactNameSnapshot = contact?.name ?? null;
        after.saleContactTitleSnapshot = contact?.title ?? null;
      }
      if (JSON.stringify(before) === JSON.stringify(after)) throw new AppError('NO_CHANGES', 400, 'Değişiklik bulunamadı.');
      await tx.sale.correctDetails(actor.organizationId, jobCardId, after);
      return { event: 'SALE_DETAILS_UPDATED', oldValue: before, newValue: after };
    });
  }

  private integrityError(error: unknown): never {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
      && 'constraint' in error && error.constraint === 'job_cards_one_active_sale_per_visit_idx') {
      throw new AppError('SALE_FROM_VISIT_ACTIVE_EXISTS', 409, 'Bu ziyaret için aktif satış kaydı zaten var.');
    }
    throw error;
  }

  async createSaleFromVisit(actor: JobCardActor, visitIdValue: string, value: unknown) {
    const visitId = uuidString(visitIdValue, 'sourceVisitId').toLowerCase();
    const input = parseSaleFromVisitCreateInput(value);
    const { clientActionId, ...intent } = input;
    const result = await this.repository.executeCriticalAction(
      { organizationId: actor.organizationId, userId: actor.id, clientActionId,
        operationKey: 'SALE_FROM_VISIT_CREATE',
        requestHash: hashRequestIdentity({ operation: 'SALE_FROM_VISIT_CREATE:v1', sourceVisitId: visitId, ...intent }) },
      async (tx) => {
        const snapshot = await tx.sale.getSource(actor.organizationId, visitId, false);
        if (!snapshot || (actor.role === 'STAFF' && snapshot.assignedTo !== actor.id)) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        const assignees = await lockAssigneesInOrder(tx, actor.organizationId, [snapshot.assignedTo, actor.id]);
        const currentActor = assignees.get(actor.id);
        if (!currentActor?.isActive || currentActor.role !== actor.role) {
          throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
        }
        const source = await tx.sale.getSource(actor.organizationId, visitId);
        if (!source || (actor.role === 'STAFF' && source.assignedTo !== actor.id)) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        if (source.version !== input.expectedSourceVersion || source.assignedTo !== snapshot.assignedTo) {
          throw new AppError('VERSION_CONFLICT', 409, 'Kaynak ziyaret başka bir işlem tarafından güncellendi.');
        }
        assertSaleSourceEligible(source);
        const assignee = assignees.get(source.assignedTo);
        if (!assignee) throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanan personel bulunamadı.');
        assertCanCreateForAssignee(actor, assignee);
        const customer = source.customerId ? await tx.sale.getCustomerForUpdate(actor.organizationId, source.customerId) : null;
        if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
        if (customer.status === 'inactive') throw new AppError('CUSTOMER_INACTIVE', 409, 'Pasif müşteri için satış kaydı oluşturulamaz.');
        if (customer.dataClass !== 'BUSINESS') throw new AppError('SALE_REFERENCE_NOT_ELIGIBLE', 409, 'Satış kaydı BUSINESS kayıtları gerektirir.');
        const contactIds = [...new Set([source.contactId, source.metContactId, input.saleContactId]
          .filter((id): id is string => id !== null))].sort();
        const contacts = new Map((await tx.sale.getContactsForShare(actor.organizationId, contactIds)).map((contact) => [contact.id, contact]));
        const products = new Map((await tx.sale.getProductsForShare(actor.organizationId,
          input.items.map((item) => item.productId).sort())).map((product) => [product.id, product]));
        const time = this.now();
        assertSaleTimeValid(input.soldAt, time);
        for (const id of contactIds) {
          const contact = contacts.get(id);
          if (!contact) throw new AppError('CONTACT_NOT_FOUND', 404, 'İlgili kişi bulunamadı.');
          if (contact.customerId !== customer.id) throw new AppError('CONTACT_NOT_IN_CUSTOMER', 409, 'İlgili kişi kaynak müşteriye bağlı değil.');
          if (id === input.saleContactId && !contact.isActive) throw new AppError('CONTACT_INACTIVE', 409, 'Yeni satış kaydında pasif ilgili kişi seçilemez.');
        }
        for (const entry of input.items) {
          const product = products.get(entry.productId);
          if (!product?.isActive) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
          if (product.dataClass !== 'BUSINESS') throw new AppError('SALE_REFERENCE_NOT_ELIGIBLE', 409, 'Satış kaydı BUSINESS ürünleri gerektirir.');
        }
        const selfAccepted = actor.role === 'STAFF';
        const job = await tx.createJobCard({
          organizationId: actor.organizationId, type: 'SALE', status: selfAccepted ? 'ACCEPTED' : 'NEW',
          title: input.title, description: input.description, customerId: customer.id,
          contactId: null, assignedTo: source.assignedTo, createdBy: actor.id, priority: 'normal',
          dueDate: null, scheduledAt: null, scheduledEndsAt: null, engagementKind: null,
          acceptedAt: selfAccepted ? time : null, acceptedBy: selfAccepted ? actor.id : null,
          sourceJobCardId: null, followUpInstructions: null, saleSourceVisitId: visitId,
          historySource: 'CREATE', historyRecordedAt: time,
        });
        const saleContact = input.saleContactId ? contacts.get(input.saleContactId) : null;
        const planned = source.contactId ? contacts.get(source.contactId) : null;
        const met = source.metContactId ? contacts.get(source.metContactId) : null;
        await tx.sale.createDetails({
          organizationId: actor.organizationId, jobCardId: job.id, soldAt: input.soldAt,
          saleContactId: input.saleContactId, saleContactNameSnapshot: saleContact?.name ?? null,
          saleContactTitleSnapshot: saleContact?.title ?? null,
          sourceVisitVersion: source.version, sourceVisitTitleSnapshot: source.title, sourceCustomerNameSnapshot: customer.name,
          sourcePlannedContactId: source.contactId, sourcePlannedContactNameSnapshot: planned?.name ?? null,
          sourcePlannedContactTitleSnapshot: planned?.title ?? null, sourceMetContactId: source.metContactId,
          sourceMetContactNameSnapshot: met?.name ?? null, sourceMetContactTitleSnapshot: met?.title ?? null,
        });
        const activity = await tx.appendActivity({ organizationId: actor.organizationId, jobCardId: job.id,
          actorId: actor.id, event: 'JOB_CREATED', clientActionId,
          newValue: { status: job.status, assignedTo: job.assignedTo, version: job.version,
            ...(selfAccepted ? { acceptedAt: time.toISOString(), acceptedBy: actor.id } : {}) } });
        for (const [sortOrder, entry] of input.items.entries()) {
          const product = products.get(entry.productId);
          if (!product) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Ürün bulunamadı.');
          const item = await tx.sale.createItem({ organizationId: actor.organizationId, jobCardId: job.id,
            productId: product.id, quantity: entry.quantity, productNameSnapshot: product.name,
            productSkuSnapshot: product.sku, productBrandSnapshot: product.brand,
            productModelSnapshot: product.model, unitSnapshot: product.unit, sortOrder });
          await tx.appendActivity({ organizationId: actor.organizationId, jobCardId: job.id,
            actorId: actor.id, event: 'SALE_ITEM_ADDED', clientActionId,
            newValue: { ...item } });
        }
        const sourceActivity = await tx.appendActivity({ organizationId: actor.organizationId, jobCardId: visitId,
          actorId: actor.id, event: 'SALE_FROM_VISIT_CREATED', clientActionId,
          newValue: { relationKind: 'SALE_FROM_VISIT', saleJobCardId: job.id } });
        const sourceJob = await tx.getJob(actor.organizationId, visitId);
        if (!sourceJob) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        const realtimeEvents = await this.effects(tx, job, activity, 'JOB_CREATED', actor.id);
        realtimeEvents.push(...await this.effects(tx, sourceJob, sourceActivity, 'SALE_FROM_VISIT_CREATED', actor.id));
        return { response: { jobCardId: job.id, version: job.version }, realtimeEvents };
      },
    ).catch((error: unknown) => this.integrityError(error));
    if (result.kind === 'processing') throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    if (result.kind === 'completed') this.publish(result.realtimeEvents);
    await this.assertCurrentAccess(actor, result.response.jobCardId);
    return result.response;
  }
}
