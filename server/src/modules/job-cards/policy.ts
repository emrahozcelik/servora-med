import { AppError } from '../../errors/index.js';
import { isManagementRole } from '../auth/types.js';
import { isAssignmentOfferJobType } from './assignment-offer-policy.js';
import {
  DELIVERY_PURPOSES,
  type TERMINAL_JOB_CARD_STATUSES,
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

export function isTerminalJobStatus(
  status: JobCardStatus,
): status is (typeof TERMINAL_JOB_CARD_STATUSES)[number] {
  return status === 'COMPLETED' || status === 'CANCELLED' || status === 'INVALIDATED';
}

/**
 * Compile-time exhaustiveness guard for a JobCard type or status decision.
 * A new union member fails the build until every decision point handles it
 * explicitly; the throw only documents the unreachable runtime state.
 */
export function assertNeverJobCardValue(value: never, kind: 'type' | 'status'): never {
  throw new Error(`Unhandled JobCard ${kind}: ${String(value)}`);
}

/**
 * JOB-010 §1a: `PRODUCT_DELIVERY` and `SALES_MEETING` may START this long
 * before their planned instant. Earlier needs a valid management early-start
 * authorization (or a reschedule). Other types keep the plain
 * `requestTime >= scheduledAt` rule.
 */
export const EARLY_START_TOLERANCE_MS = 30 * 60 * 1000;

function acceptsEarlyStart(type: JobCard['type']): boolean {
  return type === 'PRODUCT_DELIVERY' || type === 'SALES_MEETING';
}

/**
 * JOB-010 §1: acceptance is a commitment made before work, so it is no longer
 * gated by `scheduledAt`. JOB-010 §1a: START keeps a planned-time floor that is
 * widened by the 30-minute tolerance for interval jobs and bypassed entirely
 * by a valid early-start authorization.
 */
function timeEligible(
  command: LifecycleCommand,
  job: JobPermissionSubject,
  requestTime: Date,
): boolean {
  if (command !== 'START' || job.scheduledAt == null) return true;
  if (job.earlyStartAuthorized === true && acceptsEarlyStart(job.type)) return true;
  const earliest = acceptsEarlyStart(job.type)
    ? Date.parse(job.scheduledAt) - EARLY_START_TOLERANCE_MS
    : Date.parse(job.scheduledAt);
  return requestTime.getTime() >= earliest;
}

/**
 * JOB-010 release 2b: the assignment acceptance window is activated by one
 * flag. Absent means off, so every caller that cannot prove activation keeps
 * the release 2a rules.
 */
export type LifecyclePolicyFlags = {
  assignmentWindowEnabled?: boolean;
};

export function getAllowedLifecycleCommands(
  actor: JobCardActor,
  job: JobPermissionSubject,
  requestTime = new Date(),
  flags: LifecyclePolicyFlags = {},
): LifecycleCommand[] {
  if (!actorCanReachJob(actor, job)
    || isTerminalJobStatus(job.status)) return [];
  // Terminal statuses returned above; the narrowed capture lets the dispatch
  // below prove every remaining status is handled explicitly.
  const status = job.status;
  const assignmentWindowEnabled = flags.assignmentWindowEnabled === true;
  // JOB-010 §2: a job is in the window only when it is a planned
  // PRODUCT_DELIVERY / SALES_MEETING *and* at least one offer was recorded.
  // Everything else keeps the release 2a rules unchanged, even if a stale
  // offer fact reaches the policy.
  const offer = assignmentWindowEnabled
    && job.assignmentOffer != null
    && isAssignmentOfferJobType(job.type)
    && job.scheduledAt != null
    ? job.assignmentOffer
    : null;
  // JOB-010 §4/§5: only the Staff member the offer was addressed to answers
  // it, and only before the deadline (equality is late). Release needs the
  // ACCEPTED offer that recorded the acceptance being handed back.
  const mayAnswerOffer = offer !== null
    && offer.state === 'OPEN'
    && offer.assigneeUserId === actor.id
    && requestTime.valueOf() < Date.parse(offer.acceptanceDueAt);
  const mayReleaseOffer = offer !== null
    && offer.state === 'ACCEPTED'
    && offer.assigneeUserId === actor.id;
  const commands = (() => {
    if (status === 'NEW') {
      if (actor.role !== 'STAFF') return ['CANCEL'];
      // JOB-010 §5: in the window Staff answer the offer; without an open
      // offer they wait for management (no accept, no cancel).
      if (offer !== null) {
        return mayAnswerOffer ? ['ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT'] : [];
      }
      return ['ACCEPT_ASSIGNMENT', 'CANCEL'];
    }
    if (status === 'ACCEPTED') {
      if (actor.role === 'STAFF' && actor.id === job.assignedTo) {
        // SALE-002 (R9, accepted Q1): a SALE may be submitted straight from
        // ACCEPTED. START asks for location evidence a recorded agreement has
        // no meaning for, so it stays optional instead of a mandatory step.
        const saleSubmit: LifecycleCommand[] = job.type === 'SALE'
          ? ['SUBMIT_FOR_APPROVAL']
          : [];
        if (offer === null) return ['START', ...saleSubmit, 'CANCEL'];
        // JOB-010 §5: release is available while the latest offer is the
        // acceptance itself.
        return mayReleaseOffer
          ? ['START', ...saleSubmit, 'RELEASE_ASSIGNMENT']
          : ['START', ...saleSubmit];
      }
      return ['CANCEL'];
    }
    if (status === 'IN_PROGRESS') return ['SUBMIT_FOR_APPROVAL', 'CANCEL'];
    if (status === 'REVISION_REQUESTED') return ['RESUME', 'CANCEL'];
    if (status === 'WAITING_APPROVAL') {
      return isManagementRole(actor.role)
        ? ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL']
        : ['WITHDRAW_FROM_APPROVAL', 'CANCEL'];
    }
    return assertNeverJobCardValue(status, 'status');
  })() as LifecycleCommand[];
  return commands.filter((command) => timeEligible(command, job, requestTime)
    && !(command === 'CANCEL' && actor.role === 'STAFF'
      && (assignmentWindowEnabled || job.type === 'WEEKLY_REPORT')));
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
    // JOB-006 item 6: assignment-stage notes (NEW/ACCEPTED) are open to the
    // assigned Staff member for every type; execution stages stay unchanged.
    if (
      job.status !== 'INVALIDATED'
      && (
      isManagementRole(actor.role)
      || ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)
      )
    ) {
      actions.push('ADD_NOTE');
    }
  };
  /**
   * JOB-010 release 2a (D1): the assigned Staff member may always raise a
   * change/termination request on an active job, but only one at a time.
   * Management sees the decision action only while a request is open. Both
   * facts are server-computed; an absent flag means "no open request".
   */
  const addChangeRequestActions = () => {
    if (actor.role === 'STAFF') {
      if (actor.id === job.assignedTo && !terminal && job.hasOpenChangeRequest !== true) {
        actions.push('REQUEST_CHANGE');
      }
      return;
    }
    if (job.hasOpenChangeRequest === true) actions.push('RESOLVE_CHANGE_REQUEST');
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
    addChangeRequestActions();
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
  addChangeRequestActions();
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
  if (!isManagementRole(actor.role)) forbidden();
}

export function assertCanListFollowUps(actor: JobCardActor) {
  if (!isManagementRole(actor.role)) forbidden();
}

/**
 * OVR-2: breach/accountability history is management-only. STAFF keeps its
 * existing self-scoped job reads; this guard only closes the new history
 * surface. Cross-org reads stay concealed as 404 by the service lookup.
 */
export function assertCanReadOverdueIncidentHistory(actor: JobCardActor) {
  if (!isManagementRole(actor.role)) forbidden();
}

/**
 * OVR-4: manual submission reminders are a management-only action. STAFF
 * callers are rejected with 403 before any lookup; cross-org jobs stay
 * concealed as 404 by the service lookup, exactly like the history surface.
 */
export function assertCanSendSubmissionReminder(actor: JobCardActor) {
  if (!isManagementRole(actor.role)) forbidden();
}

/**
 * JOB-010 §1a: granting an early-start authorization is a management power.
 * STAFF callers are rejected with 403 before any lookup; cross-org jobs stay
 * concealed as 404 by the service lookup.
 */
export function assertCanGrantEarlyStartAuthorization(actor: JobCardActor) {
  if (!isManagementRole(actor.role)) forbidden();
}

/**
 * JOB-010 release 2a (D1): the change/termination request is a Staff power.
 * The service additionally requires the caller to be the current assignee; a
 * non-Staff caller is rejected with 403 before any lookup, so the route never
 * leaks whether the job exists.
 */
export function assertCanCreateChangeRequest(actor: JobCardActor) {
  if (actor.role !== 'STAFF') forbidden();
}

/**
 * JOB-010 release 2a: the management decision is MANAGER/ADMIN only. STAFF is
 * rejected with 403 before any lookup; cross-org jobs stay concealed as 404.
 */
export function assertCanResolveChangeRequest(actor: JobCardActor) {
  if (!isManagementRole(actor.role)) forbidden();
}

/**
 * JOB-010 release 2a: the open-request decision list is management-only for
 * the same reason as the OVR-4 lists — it exposes every Staff member's
 * requests across the organization.
 */
export function assertCanListOpenChangeRequests(actor: JobCardActor) {
  if (!isManagementRole(actor.role)) forbidden();
}

/**
 * JOB-010 release 2b: re-offering an assignment and the management
 * needs-action list are management powers. STAFF is rejected with 403 before
 * any lookup, so the route never leaks whether the job exists.
 */
export function assertCanReofferAssignment(actor: JobCardActor) {
  if (!isManagementRole(actor.role)) forbidden();
}

/**
 * JOB-012: confirming the time a Staff member proposed for an assignment is a
 * management power (Q2: the customer time stays management-owned). STAFF is
 * rejected with 403 before any lookup.
 */
export function assertCanAcceptAssignmentProposal(actor: JobCardActor) {
  if (!isManagementRole(actor.role)) forbidden();
}

export function assertCanListAssignmentOffersNeedingAction(actor: JobCardActor) {
  if (!isManagementRole(actor.role)) forbidden();
}

/**
 * OVR-6 §6.2: the unaccepted past-start list is management-only for the same
 * reason as the needs-action list. STAFF is rejected with 403 before any
 * lookup, so the route never leaks whether the job exists.
 */
export function assertCanListUnacceptedPastStart(actor: JobCardActor) {
  if (!isManagementRole(actor.role)) forbidden();
}

/**
 * OVR-4: the open-submission-late operational list is management-only for
 * the same reason as the incident history: it exposes cross-staff
 * accountability. STAFF visibility stays limited to its own jobs through
 * the per-job lateness snapshot.
 */
export function assertCanListOpenSubmissionLate(actor: JobCardActor) {
  if (!isManagementRole(actor.role)) forbidden();
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
  job: JobCard & Pick<JobPermissionSubject, 'assignmentOffer'>,
  command: LifecycleCommand,
  reason?: string,
  requestTime = new Date(),
  flags: LifecyclePolicyFlags = {},
) {
  assertSameOrganization(actor, job.organizationId);
  if (actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();
  if (isTerminalJobStatus(job.status)) invalidTransition();
  if (['APPROVE', 'REQUEST_REVISION'].includes(command) && !isManagementRole(actor.role)) {
    forbidden();
  }
  if (['ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT', 'RELEASE_ASSIGNMENT'].includes(command)
    && actor.role !== 'STAFF') forbidden();
  if (!getAllowedLifecycleCommands(actor, job, requestTime, flags).includes(command)) {
    invalidTransition();
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
