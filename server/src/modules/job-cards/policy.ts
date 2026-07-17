import { AppError } from '../../errors/index.js';
import {
  DELIVERY_PURPOSES,
  type DeliveryItem,
  type JobCard,
  type JobCardActor,
  type JobCardAssignee,
  type JobPermissionSubject,
  type JobWorkflowAction,
  type LifecycleCommand,
} from './types.js';

function forbidden(): never {
  throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
}

function notEditable(): never {
  throw new AppError('JOB_NOT_EDITABLE', 409, 'JobCard bu durumda düzenlenemez.');
}

function invalidTransition(): never {
  throw new AppError('INVALID_TRANSITION', 409, 'JobCard bu geçiş için uygun durumda değil.');
}

function assertSameOrganization(actor: JobCardActor, organizationId: string) {
  if (actor.organizationId !== organizationId) forbidden();
}

function actorCanReachJob(actor: JobCardActor, job: JobPermissionSubject) {
  return actor.organizationId === job.organizationId
    && (actor.role !== 'STAFF' || actor.id === job.assignedTo);
}

export function getAllowedLifecycleCommands(
  actor: JobCardActor,
  job: JobPermissionSubject,
): LifecycleCommand[] {
  if (!actorCanReachJob(actor, job)
    || job.status === 'COMPLETED' || job.status === 'CANCELLED') return [];
  if (job.status === 'NEW') return ['PLAN', 'START', 'CANCEL'];
  if (job.status === 'PLANNED') return ['START', 'CANCEL'];
  if (job.status === 'IN_PROGRESS') return ['SUBMIT_FOR_APPROVAL', 'CANCEL'];
  if (job.status === 'REVISION_REQUESTED') return ['RESUME', 'CANCEL'];
  return actor.role === 'STAFF'
    ? ['WITHDRAW_FROM_APPROVAL', 'CANCEL']
    : ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'];
}

export function getAllowedJobActions(
  actor: JobCardActor,
  job: JobPermissionSubject,
): JobWorkflowAction[] {
  if (!actorCanReachJob(actor, job)) return [];
  const actions: JobWorkflowAction[] = [];
  const terminal = job.status === 'COMPLETED' || job.status === 'CANCELLED';
  if (!terminal && job.status !== 'WAITING_APPROVAL') actions.push('EDIT_JOB_FIELDS');
  if (job.type !== 'SALES_MEETING') {
    actions.push('VIEW_NOTES', 'ADD_NOTE');
    return actions;
  }
  if (job.status === 'WAITING_APPROVAL'
    && getAllowedLifecycleCommands(actor, job).includes('WITHDRAW_FROM_APPROVAL')) {
    actions.push('WITHDRAW_AND_EDIT_JOB_FIELDS');
  }
  if (!['NEW', 'PLANNED'].includes(job.status)) {
    actions.push('VIEW_MEETING_RESULT');
  }
  if (['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)) {
    actions.push('EDIT_MEETING_RESULT');
  }
  if (!['NEW', 'PLANNED'].includes(job.status)) actions.push('VIEW_NOTES');
  if (['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)) actions.push('ADD_NOTE');
  return actions;
}

export function assertAllowedJobAction(
  actor: JobCardActor,
  job: JobCard,
  action: Exclude<JobWorkflowAction, 'WITHDRAW_AND_EDIT_JOB_FIELDS'>,
) {
  assertSameOrganization(actor, job.organizationId);
  if (actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();
  if (!getAllowedJobActions(actor, job).includes(action)) notEditable();
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

export const assertCanEdit = (actor: JobCardActor, job: JobCard) =>
  assertAllowedJobAction(actor, job, 'EDIT_JOB_FIELDS');
export const assertCanEditMeetingResult = (actor: JobCardActor, job: JobCard) =>
  assertAllowedJobAction(actor, job, 'EDIT_MEETING_RESULT');
export const assertCanViewMeetingResult = (actor: JobCardActor, job: JobCard) =>
  assertAllowedJobAction(actor, job, 'VIEW_MEETING_RESULT');
export const assertCanAccessNotes = (actor: JobCardActor, job: JobCard) =>
  assertAllowedJobAction(actor, job, 'VIEW_NOTES');
export const assertCanAddNote = (actor: JobCardActor, job: JobCard) =>
  assertAllowedJobAction(actor, job, 'ADD_NOTE');

export function assertCanTransition(
  actor: JobCardActor,
  job: JobCard,
  command: LifecycleCommand,
  reason?: string,
) {
  assertSameOrganization(actor, job.organizationId);
  if (actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();
  if (job.status === 'COMPLETED' || job.status === 'CANCELLED') invalidTransition();
  if (actor.role === 'STAFF' && ['APPROVE', 'REQUEST_REVISION'].includes(command)) forbidden();
  if (!getAllowedLifecycleCommands(actor, job).includes(command)) invalidTransition();
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
