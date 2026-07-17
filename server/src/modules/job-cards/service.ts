import { AppError } from '../../errors/index.js';
import { presentActivity } from './activity-presenter.js';
import {
  assertCanCreateForAssignee,
  assertCanEdit,
  assertCanEditMeetingResult,
  assertCanTransition,
  assertCanViewMeetingResult,
  assertCreateAssignmentRequest,
  assertProductDeliveryJob,
  assertSalesMeetingJob,
} from './policy.js';
import type { DeliveryItemRecord, JobCardRepository, JobCardTransaction, PageQuery, ProductReference } from './repository.js';
import {
  DELIVERY_PURPOSES,
  JOB_CARD_PRIORITIES,
  type DeliveryPurpose,
  type JobCard,
  type JobCardActor,
  type JobCardBoard,
  type JobCardBoardQuery,
  type JobCardActivityEvent,
  type JobCardListQuery,
  type NormalizedJobCardCreateInput,
  type JobCardPriority,
  type JobCardStatus,
  type LifecycleCommand,
  MEETING_DETAIL_FIELDS,
  type MeetingDetails,
  type MeetingDetailsCandidate,
  type PatchMeetingDetailsInput,
} from './types.js';
import { optionalLifecycleNote, requireActionId, requireLifecycleReason, validation } from './validation.js';
import { JobCardNotesService, type CreateNoteInput } from './notes-service.js';
import { validateSubmission } from './submission-policy.js';
import { validateMeetingDetailsCandidate } from './meeting-details-input.js';

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
type RevisionInput = LifecycleInput & { revisionReason: string };
type CancelInput = LifecycleInput & { cancelReason: string };
type LifecycleDefinition = {
  command: LifecycleCommand;
  operationKey: string;
  target: JobCardStatus;
  event: JobCardActivityEvent;
  note: string | null;
  revisionReason: string | null;
  cancelReason: string | null;
};

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

function invariantViolation(): never {
  throw new AppError(
    'INVARIANT_VIOLATION',
    500,
    'İş kaydının yapılandırılmış görüşme bilgileri bulunamadı.',
  );
}

function meetingDetailsResponse(
  jobCardId: string,
  jobCardVersion: number,
  details: MeetingDetailsCandidate,
): MeetingDetails {
  return { jobCardId, ...details, jobCardVersion };
}

const DELIVERY_FIELDS = [
  'expectedVersion', 'productId', 'deliveryPurpose', 'deliveredAt', 'quantity',
  'lotNo', 'serialNo', 'expiryDate', 'deliveryNote',
] as const;

function lifecycleReason(value: unknown, field: 'revisionReason' | 'cancelReason') {
  if (typeof value !== 'string' || !value.trim()) {
    const revision = field === 'revisionReason';
    throw new AppError(
      revision ? 'REVISION_REASON_REQUIRED' : 'CANCEL_REASON_REQUIRED',
      400,
      revision ? 'Düzeltme nedeni zorunludur.' : 'İptal nedeni zorunludur.',
    );
  }
  return requireLifecycleReason(value, field);
}

export class JobCardService {
  private readonly notesService: JobCardNotesService;

  constructor(
    private readonly repository: JobCardRepository,
    private readonly now: () => Date = () => new Date(),
  ) { this.notesService = new JobCardNotesService(repository); }

  async listNotes(actor: JobCardActor, jobCardId: string, page: PageQuery) {
    return this.notesService.listNotes(actor, jobCardId, page);
  }

  async addNote(actor: JobCardActor, jobCardId: string, input: CreateNoteInput) {
    return this.notesService.addNote(actor, jobCardId, input);
  }

  async create(actor: JobCardActor, input: NormalizedJobCardCreateInput) {
    const title = input.title.trim();
    const priority = input.priority;
    if (!input.clientActionId.trim() || !title ||
      (input.type === 'PRODUCT_DELIVERY' && !input.customerId) ||
      !input.assignedTo || !JOB_CARD_PRIORITIES.includes(priority)) {
      throw new AppError('VALIDATION_ERROR', 400, 'JobCard oluşturma bilgileri geçersiz.');
    }
    assertCreateAssignmentRequest(actor, input.assignedTo);
    const result = await this.repository.executeCriticalAction(
      {
        organizationId: actor.organizationId, userId: actor.id,
        clientActionId: input.clientActionId, operationKey: 'JOB_CREATE',
      },
      async (transaction) => {
        const assignee = await transaction.getAssigneeForUpdate(actor.organizationId, input.assignedTo);
        if (!assignee) throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
        assertCanCreateForAssignee(actor, assignee);
        await this.validateJobReferences(transaction, actor.organizationId, input.customerId, input.contactId);
        const job = await transaction.createJobCard({
          organizationId: actor.organizationId, type: input.type, title,
          description: input.description?.trim() || null, customerId: input.customerId,
          contactId: input.contactId,
          assignedTo: input.assignedTo, createdBy: actor.id, priority,
          dueDate: input.dueDate,
        });
        if (input.type === 'SALES_MEETING') {
          await transaction.createMeetingDetails({
            organizationId: actor.organizationId,
            jobCardId: job.id,
          });
        }
        await transaction.appendActivity({
          organizationId: actor.organizationId, jobCardId: job.id, actorId: actor.id,
          event: 'JOB_CREATED', clientActionId: input.clientActionId,
          newValue: { status: job.status, assignedTo: job.assignedTo, version: job.version },
        });
        const detail = await transaction.getJobDetail(actor.organizationId, job.id);
        if (!detail) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        return detail;
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    return result.response;
  }

  async list(actor: JobCardActor, query: JobCardListQuery) {
    if (actor.role === 'STAFF' && query.assignedTo !== null && query.assignedTo !== actor.id) {
      return { items: [], total: 0, limit: query.limit, offset: query.offset };
    }
    return this.repository.listJobCards(
      {
        organizationId: actor.organizationId,
        assignedTo: actor.role === 'STAFF' ? actor.id : null,
      },
      query,
    );
  }

  async board(actor: JobCardActor, query: JobCardBoardQuery): Promise<JobCardBoard> {
    if (actor.role === 'STAFF' && query.assignedTo !== null && query.assignedTo !== actor.id) {
      return {
        columns: {
          NEW: { items: [], count: 0 },
          PLANNED: { items: [], count: 0 },
          IN_PROGRESS: { items: [], count: 0 },
          WAITING_APPROVAL: { items: [], count: 0 },
          REVISION_REQUESTED: { items: [], count: 0 },
        },
        closedCounts: { COMPLETED: 0, CANCELLED: 0 },
      };
    }
    return this.repository.listBoard(
      {
        organizationId: actor.organizationId,
        assignedTo: actor.role === 'STAFF' ? actor.id : null,
      },
      query,
    );
  }

  async detail(actor: JobCardActor, jobCardId: string) {
    const job = await this.repository.findJobCardDetail(actor.organizationId, jobCardId);
    if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    }
    return job;
  }

  async getMeetingDetails(actor: JobCardActor, jobCardId: string) {
    const job = await this.repository.findJobCard(actor.organizationId, jobCardId);
    if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    }
    assertSalesMeetingJob(job);
    assertCanViewMeetingResult(actor, job);
    const details = await this.repository.findMeetingDetails(actor.organizationId, jobCardId);
    if (!details) invariantViolation();
    return meetingDetailsResponse(jobCardId, job.version, details);
  }

  async patchMeetingDetails(
    actor: JobCardActor,
    jobCardId: string,
    input: PatchMeetingDetailsInput,
  ) {
    const clientActionId = requireActionId(input.clientActionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw validation('expectedVersion');
    }
    if (!MEETING_DETAIL_FIELDS.some((field) => Object.hasOwn(input, field))) {
      throw validation('body');
    }
    const result = await this.repository.executeCriticalAction(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId,
        operationKey: `MEETING_DETAILS_UPDATE:${jobCardId}`,
      },
      async (transaction) => {
        const job = await transaction.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        assertSalesMeetingJob(job);
        if (job.version !== input.expectedVersion) {
          throw new AppError(
            'VERSION_CONFLICT',
            409,
            'JobCard başka bir işlem tarafından güncellendi.',
          );
        }
        assertCanEditMeetingResult(actor, job);
        const current = await transaction.getSubmissionMeetingDetails(
          actor.organizationId,
          jobCardId,
        );
        if (!current) invariantViolation();
        const candidate: MeetingDetailsCandidate = {
          meetingAt: input.meetingAt === undefined ? current.meetingAt : input.meetingAt,
          outcome: input.outcome === undefined ? current.outcome : input.outcome,
          meetingSummary: input.meetingSummary === undefined
            ? current.meetingSummary
            : input.meetingSummary,
          nextFollowUpAt: input.nextFollowUpAt === undefined
            ? current.nextFollowUpAt
            : input.nextFollowUpAt,
        };
        validateMeetingDetailsCandidate(candidate);
        const changedFields = MEETING_DETAIL_FIELDS.filter(
          (field) => Object.hasOwn(input, field) && candidate[field] !== current[field],
        );
        if (changedFields.length === 0) {
          throw new AppError(
            'MEETING_DETAILS_UNCHANGED',
            400,
            'Görüşme sonucunda kaydedilecek bir değişiklik yok.',
          );
        }
        await transaction.updateMeetingDetails({
          organizationId: actor.organizationId,
          jobCardId,
          ...candidate,
        });
        const updated = await transaction.bumpVersion(
          actor.organizationId,
          jobCardId,
          input.expectedVersion,
        );
        if (!updated) {
          throw new AppError(
            'VERSION_CONFLICT',
            409,
            'JobCard başka bir işlem tarafından güncellendi.',
          );
        }
        await transaction.appendActivity({
          organizationId: actor.organizationId,
          jobCardId,
          actorId: actor.id,
          event: 'MEETING_DETAILS_UPDATED',
          clientActionId,
          metadata: { changedFields },
        });
        return meetingDetailsResponse(jobCardId, updated.version, candidate);
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    return result.response;
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
      const detail = await transaction.getJobDetail(actor.organizationId, jobCardId);
      if (!detail) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      return detail;
    });
  }

  private async validateJobReferences(tx: JobCardTransaction, organizationId: string, customerId: string | null, contactId: string | null) {
    if (!customerId) {
      if (contactId) {
        throw new AppError('CONTACT_NOT_IN_CUSTOMER', 409, 'İlgili kişi seçilen müşteriye bağlı değil.');
      }
      return;
    }
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
        if (actor.role === 'STAFF' && actor.id !== job.assignedTo) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        assertProductDeliveryJob(job);
        if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        assertCanEdit(actor, job);
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
      if (actor.role === 'STAFF' && actor.id !== job.assignedTo) {
        throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      }
      assertProductDeliveryJob(job);
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
      if (actor.role === 'STAFF' && actor.id !== job.assignedTo) {
        throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      }
      assertProductDeliveryJob(job);
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
    const job = await this.detail(actor, jobCardId);
    assertProductDeliveryJob(job);
    return this.repository.listDeliveryItems(actor.organizationId, jobCardId);
  }

  async listActivity(actor: JobCardActor, jobCardId: string, page: PageQuery) {
    await this.detail(actor, jobCardId);
    const result = await this.repository.listActivity(actor.organizationId, jobCardId, page);
    return {
      items: result.items.map(presentActivity),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }

  async listReferenceCustomers(actor: JobCardActor) {
    return this.repository.listReferenceCustomers(actor.organizationId);
  }

  async plan(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'PLAN', operationKey: 'JOB_PLAN', target: 'PLANNED', event: 'JOB_PLANNED',
      note: null, revisionReason: null, cancelReason: null,
    });
  }

  async start(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'START', operationKey: 'JOB_START', target: 'IN_PROGRESS', event: 'JOB_STARTED',
      note: null, revisionReason: null, cancelReason: null,
    });
  }

  async submitForApproval(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'SUBMIT_FOR_APPROVAL', operationKey: 'JOB_SUBMIT_FOR_APPROVAL',
      target: 'WAITING_APPROVAL', event: 'JOB_SUBMITTED_FOR_APPROVAL',
      note: optionalLifecycleNote(input.note), revisionReason: null, cancelReason: null,
    });
  }

  async approve(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'APPROVE', operationKey: 'JOB_APPROVE', target: 'COMPLETED', event: 'JOB_APPROVED',
      note: optionalLifecycleNote(input.note), revisionReason: null, cancelReason: null,
    });
  }

  async requestRevision(actor: JobCardActor, jobCardId: string, input: RevisionInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'REQUEST_REVISION', operationKey: 'JOB_REQUEST_REVISION', target: 'REVISION_REQUESTED',
      event: 'JOB_REVISION_REQUESTED', note: null,
      revisionReason: lifecycleReason(input.revisionReason, 'revisionReason'), cancelReason: null,
    });
  }

  async withdrawFromApproval(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'WITHDRAW_FROM_APPROVAL', operationKey: 'JOB_WITHDRAW_FROM_APPROVAL',
      target: 'IN_PROGRESS', event: 'JOB_APPROVAL_WITHDRAWN',
      note: null, revisionReason: null, cancelReason: null,
    });
  }

  async resume(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'RESUME', operationKey: 'JOB_RESUME', target: 'IN_PROGRESS', event: 'JOB_RESUMED',
      note: null, revisionReason: null, cancelReason: null,
    });
  }

  async cancel(actor: JobCardActor, jobCardId: string, input: CancelInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'CANCEL', operationKey: 'JOB_CANCEL', target: 'CANCELLED', event: 'JOB_CANCELLED',
      note: null, revisionReason: null,
      cancelReason: lifecycleReason(input.cancelReason, 'cancelReason'),
    });
  }

  private lifecycleInput(input: LifecycleInput) {
    const clientActionId = requireActionId(input.clientActionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw validation('expectedVersion');
    }
    return { clientActionId, expectedVersion: input.expectedVersion };
  }

  private async runLifecycle(
    actor: JobCardActor,
    jobCardId: string,
    input: { clientActionId: string; expectedVersion: number },
    definition: LifecycleDefinition,
  ) {
    const requestTime = this.now();
    const result = await this.repository.executeCriticalAction(
      { organizationId: actor.organizationId, userId: actor.id,
        clientActionId: input.clientActionId,
        operationKey: `${definition.operationKey}:${jobCardId}` },
      async (tx) => {
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        assertCanTransition(
          actor, job, definition.command,
          definition.revisionReason ?? definition.cancelReason ?? undefined,
        );
        if (definition.command === 'SUBMIT_FOR_APPROVAL') {
          await validateSubmission(tx, actor, job, requestTime);
        }
        const occurredAt = requestTime;
        const updated = await tx.transitionWithVersion({
          organizationId: actor.organizationId, jobCardId, expectedVersion: input.expectedVersion,
          command: definition.command, status: definition.target, occurredAt, actorId: actor.id,
          note: definition.note, revisionReason: definition.revisionReason,
          cancelReason: definition.cancelReason,
        });
        if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        await tx.appendActivity({ organizationId: actor.organizationId, jobCardId, actorId: actor.id,
          event: definition.event, clientActionId: input.clientActionId,
          oldValue: { status: job.status, version: job.version }, newValue: { status: updated.status, version: updated.version } });
        const detail = await tx.getJobDetail(actor.organizationId, jobCardId);
        if (!detail) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        return detail;
      });
    if (result.kind === 'processing') throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    return result.response;
  }

}
