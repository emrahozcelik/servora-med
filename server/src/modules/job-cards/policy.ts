import { AppError } from '../../errors/index.js';
import { DELIVERY_PURPOSES, type DeliveryItem, type JobCard, type JobCardActor, type JobCardAssignee, type LifecycleCommand } from './types.js';

function forbidden(): never {
  throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
}

function notEditable(): never {
  throw new AppError('JOB_NOT_EDITABLE', 409, 'JobCard bu durumda düzenlenemez.');
}

function assertSameOrganization(actor: JobCardActor, organizationId: string) {
  if (actor.organizationId !== organizationId) forbidden();
}

export function assertCreateAssignmentRequest(actor: JobCardActor, assignedTo: string) {
  if (actor.role === 'STAFF' && actor.id !== assignedTo) forbidden();
}

export function assertCanCreateForAssignee(actor: JobCardActor, assignee: JobCardAssignee) {
  assertSameOrganization(actor, assignee.organizationId);
  if (!assignee.isActive || assignee.role !== 'STAFF') forbidden();
  if (actor.role === 'STAFF' && actor.id !== assignee.id) forbidden();
}

export function assertProductDeliveryJob(job: JobCard) {
  if (job.type !== 'PRODUCT_DELIVERY') {
    throw new AppError(
      'INVALID_JOB_TYPE',
      409,
      'Teslim kalemleri yalnız ürün teslimi işlerinde kullanılabilir.',
    );
  }
}

export function assertSalesMeetingJob(job: JobCard) {
  if (job.type !== 'SALES_MEETING') {
    throw new AppError(
      'INVALID_JOB_TYPE',
      409,
      'Görüşme bilgileri yalnız satış görüşmesi işlerinde kullanılabilir.',
    );
  }
}

export function assertCanEdit(actor: JobCardActor, job: JobCard) {
  assertSameOrganization(actor, job.organizationId);
  if (['WAITING_APPROVAL', 'COMPLETED', 'CANCELLED'].includes(job.status)) {
    notEditable();
  }
  if (actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();
}

export function assertCanEditMeetingResult(actor: JobCardActor, job: JobCard) {
  assertCanEdit(actor, job);
  if (!['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)) notEditable();
}

export function assertCanAccessNotes(actor: JobCardActor, job: JobCard) {
  assertSameOrganization(actor, job.organizationId);
  if (actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();
}

export function assertCanAddNote(actor: JobCardActor, job: JobCard) {
  assertCanAccessNotes(actor, job);
  if (job.type === 'SALES_MEETING'
    && !['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)) notEditable();
}

export function assertCanTransition(
  actor: JobCardActor,
  job: JobCard,
  command: LifecycleCommand,
  reason?: string,
) {
  assertSameOrganization(actor, job.organizationId);
  if (actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();
  if (job.status === 'COMPLETED' || job.status === 'CANCELLED') {
    throw new AppError('INVALID_TRANSITION', 409, 'JobCard bu geçiş için uygun durumda değil.');
  }
  if (actor.role === 'STAFF' && ['APPROVE', 'REQUEST_REVISION'].includes(command)) {
    forbidden();
  }
  if (actor.role === 'STAFF' && command === 'CANCEL' && job.status !== 'WAITING_APPROVAL') {
    forbidden();
  }
  if (command === 'WITHDRAW_FROM_APPROVAL' && actor.role !== 'STAFF') forbidden();
  const allowedSources: Record<LifecycleCommand, readonly JobCard['status'][]> = {
    PLAN: ['NEW'],
    START: ['NEW', 'PLANNED'],
    SUBMIT_FOR_APPROVAL: ['IN_PROGRESS'],
    APPROVE: ['WAITING_APPROVAL'],
    REQUEST_REVISION: ['WAITING_APPROVAL'],
    WITHDRAW_FROM_APPROVAL: ['WAITING_APPROVAL'],
    RESUME: ['REVISION_REQUESTED'],
    CANCEL: ['NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'],
  };
  if (!allowedSources[command].includes(job.status)) {
    throw new AppError('INVALID_TRANSITION', 409, 'JobCard bu geçiş için uygun durumda değil.');
  }
  if (command === 'REQUEST_REVISION' && !reason?.trim()) {
    throw new AppError('REVISION_REASON_REQUIRED', 400, 'Düzeltme nedeni zorunludur.');
  }
  if (command === 'CANCEL' && !reason?.trim()) {
    throw new AppError('CANCEL_REASON_REQUIRED', 400, 'İptal nedeni zorunludur.');
  }
}

export function assertDeliveryReadyForSubmission(job: JobCard, items: DeliveryItem[]) {
  if (
    job.type !== 'PRODUCT_DELIVERY' ||
    !job.customerId ||
    !job.assignedTo ||
    items.length === 0 ||
    items.some((item) =>
      !item.productId ||
      !DELIVERY_PURPOSES.includes(item.deliveryPurpose) ||
      !(item.deliveredAt instanceof Date) ||
      Number.isNaN(item.deliveredAt.getTime()) ||
      !Number.isFinite(item.quantity) ||
      item.quantity <= 0
    )
  ) {
    throw new AppError(
      'DELIVERY_NOT_READY',
      400,
      'Ürün teslimi onaya gönderilmek için gerekli bilgileri içermiyor.',
    );
  }
}
