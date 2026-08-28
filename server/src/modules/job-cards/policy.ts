import { AppError } from '../../errors/index.js';
import {
  DELIVERY_PURPOSES,
  type DeliveryItem,
  type JobCard,
  type JobCardActor,
  type JobCardAssignee,
  type JobCardStatus,
  type FollowUpSourceAccess,
  type JobPermissionSubject,
  type JobWorkflowAction,
  type LifecycleCommand,
} from './types.js';

function forbidden(): never {
  throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
}

export function assertCanInvalidate(actor: JobCardActor) {
  if (actor.role !== 'ADMIN') forbidden();
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

export function isTerminalJobStatus(status: JobCardStatus): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED' || status === 'INVALIDATED';
}

export function getAllowedLifecycleCommands(
  actor: JobCardActor,
  job: JobPermissionSubject,
  requestTime = new Date(),
): LifecycleCommand[] {
  if (!actorCanReachJob(actor, job)
    || isTerminalJobStatus(job.status)) return [];
  const timeEligible = (command: LifecycleCommand) => {
    if (!['ACCEPT_ASSIGNMENT', 'START'].includes(command) || job.scheduledAt == null) {
      return true;
    }
    return requestTime.getTime() >= Date.parse(job.scheduledAt);
  };
  const commands = (() => {
    if (job.status === 'NEW') {
      return actor.role === 'STAFF' ? ['ACCEPT_ASSIGNMENT', 'CANCEL'] : ['CANCEL'];
    }
    if (job.status === 'ACCEPTED') {
      return actor.role === 'STAFF' && actor.id === job.assignedTo
        ? ['START', 'CANCEL']
        : ['CANCEL'];
    }
    if (job.status === 'IN_PROGRESS') return ['SUBMIT_FOR_APPROVAL', 'CANCEL'];
    if (job.status === 'REVISION_REQUESTED') return ['RESUME', 'CANCEL'];
    return actor.role === 'STAFF'
      ? ['WITHDRAW_FROM_APPROVAL', 'CANCEL']
      : ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'];
  })() as LifecycleCommand[];
  return commands.filter(timeEligible);
}

export function getAllowedJobActions(
  actor: JobCardActor,
  job: JobPermissionSubject,
): JobWorkflowAction[] {
  if (!actorCanReachJob(actor, job)) return [];
  const actions: JobWorkflowAction[] = [];
  const terminal = isTerminalJobStatus(job.status);
  if (!terminal && job.status !== 'WAITING_APPROVAL') actions.push('EDIT_JOB_FIELDS');
  const addNoteActions = () => {
    actions.push('VIEW_NOTES');
    if (
      job.status !== 'INVALIDATED'
      && (
      actor.role !== 'STAFF'
      || ['ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)
      )
    ) {
      actions.push('ADD_NOTE');
    }
  };
  if (job.type !== 'SALES_MEETING') {
    addNoteActions();
    if (
      job.type === 'PRODUCT_DELIVERY'
      && !terminal
      && ['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)
    ) {
      actions.push('EDIT_DELIVERY_ACTUAL_TIME');
    }
    return actions;
  }
  if (job.status === 'WAITING_APPROVAL'
    && getAllowedLifecycleCommands(actor, job).includes('WITHDRAW_FROM_APPROVAL')) {
    actions.push('WITHDRAW_AND_EDIT_JOB_FIELDS');
  }
  if (!['NEW', 'ACCEPTED'].includes(job.status)) {
    actions.push('VIEW_MEETING_RESULT');
  }
  if (['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)) {
    actions.push('EDIT_MEETING_RESULT');
  }
  addNoteActions();
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

export function assertCanCreateFollowUp(actor: JobCardActor) {
  if (actor.role === 'STAFF') forbidden();
}

export function assertCanListFollowUps(actor: JobCardActor) {
  if (actor.role === 'STAFF') forbidden();
}

export function assertFollowUpSourceEligible(job: Pick<JobCard, 'status'>) {
  if (job.status !== 'COMPLETED') {
    throw new AppError(
      'FOLLOW_UP_SOURCE_NOT_COMPLETED',
      409,
      'Takip işi yalnız tamamlanmış bir JobCard üzerinden oluşturulabilir.',
    );
  }
}

export function resolveSourceAccess(
  actor: JobCardActor,
  source: Pick<JobCard, 'organizationId' | 'assignedTo'>,
): FollowUpSourceAccess {
  return actor.organizationId === source.organizationId
    && (actor.role !== 'STAFF' || actor.id === source.assignedTo)
    ? 'FULL'
    : 'RESTRICTED';
}

export function assertProductDeliveryJob(job: Pick<JobCard, 'type'>) {
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
export const assertCanEditDeliveryActualTime = (actor: JobCardActor, job: JobCard) =>
  assertAllowedJobAction(actor, job, 'EDIT_DELIVERY_ACTUAL_TIME');
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
  requestTime = new Date(),
) {
  assertSameOrganization(actor, job.organizationId);
  if (actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();
  if (isTerminalJobStatus(job.status)) invalidTransition();
  if (actor.role === 'STAFF' && ['APPROVE', 'REQUEST_REVISION'].includes(command)) forbidden();
  if (command === 'ACCEPT_ASSIGNMENT' && actor.role !== 'STAFF') forbidden();
  if (!getAllowedLifecycleCommands(actor, job, requestTime).includes(command)) invalidTransition();
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
