import { AppError } from '../../errors/index.js';
import { DELIVERY_PURPOSES, type DeliveryItem, type JobCard, type JobCardActor, type JobCardAssignee, type LifecycleCommand } from './types.js';

function forbidden(): never {
  throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
}

function assertSameOrganization(actor: JobCardActor, organizationId: string) {
  if (actor.organizationId !== organizationId) forbidden();
}

export function assertCanCreateForAssignee(actor: JobCardActor, assignee: JobCardAssignee) {
  assertSameOrganization(actor, assignee.organizationId);
  if (!assignee.isActive || assignee.role !== 'STAFF') forbidden();
  if (actor.role === 'STAFF' && actor.id !== assignee.id) forbidden();
}

export function assertCanEdit(actor: JobCardActor, job: JobCard) {
  assertSameOrganization(actor, job.organizationId);
  if (['WAITING_APPROVAL', 'COMPLETED', 'CANCELLED'].includes(job.status)) {
    throw new AppError('JOB_NOT_EDITABLE', 409, 'JobCard bu durumda düzenlenemez.');
  }
  if (actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();
}

export function assertCanTransition(
  actor: JobCardActor,
  job: JobCard,
  command: LifecycleCommand,
  revisionReason?: string,
) {
  assertSameOrganization(actor, job.organizationId);
  if (actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();

  if (command === 'APPROVE' || command === 'REQUEST_REVISION') {
    if (actor.role === 'STAFF') forbidden();
    if (job.status !== 'WAITING_APPROVAL') {
      throw new AppError('INVALID_TRANSITION', 409, 'JobCard bu geçiş için uygun durumda değil.');
    }
    if (command === 'REQUEST_REVISION' && !revisionReason?.trim()) {
      throw new AppError('REVISION_REASON_REQUIRED', 400, 'Düzeltme nedeni zorunludur.');
    }
    return;
  }

  const valid = command === 'START'
    ? job.status === 'NEW' || job.status === 'PLANNED'
    : job.status === 'IN_PROGRESS';
  if (!valid) {
    throw new AppError('INVALID_TRANSITION', 409, 'JobCard bu geçiş için uygun durumda değil.');
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
