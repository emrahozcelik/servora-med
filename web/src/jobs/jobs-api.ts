import {
  ApiError, boolean, items, json, nullableString, number, object, request, string,
} from '../services/api';
import type { StartLocationCapture } from './start-location-capture.js';

export const JOB_CARD_STATUSES = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
  'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED', 'INVALIDATED',
] as const;
export const ACTIVE_JOB_CARD_STATUSES = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
] as const;
export const JOB_CARD_INVALIDATION_REASON_CODES = [
  'DUPLICATE', 'WRONG_CUSTOMER', 'CREATED_BY_MISTAKE', 'TRAINING_OR_TEST_RECORD', 'OTHER',
] as const;
export type JobCardInvalidationReasonCode = (typeof JOB_CARD_INVALIDATION_REASON_CODES)[number];
/** Active statuses plus legacy PLANNED retained only for historical activity presentation. */
export const JOB_CARD_ACTIVITY_STATUSES = [...JOB_CARD_STATUSES, 'PLANNED'] as const;
export const JOB_CARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const DELIVERY_PURPOSES = ['SALE', 'SAMPLE', 'CONSIGNMENT', 'RETURN', 'OTHER'] as const;
export const JOB_CARD_TYPES = ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING'] as const;
export const JOB_CARD_ENGAGEMENT_KINDS = [
  'SALES_MEETING',
  'CUSTOMER_VISIT',
  'PRODUCT_DEMO',
  'TRAINING',
  'FOLLOW_UP',
  'OTHER',
] as const;
export const MEETING_OUTCOMES = [
  'POSITIVE', 'FOLLOW_UP_REQUIRED', 'NO_DECISION', 'NOT_INTERESTED',
] as const;
export const UNSUCCESSFUL_VISIT_REASON_CODES = [
  'CONTACT_NOT_AVAILABLE',
  'CONTACT_BUSY',
  'CUSTOMER_UNREACHABLE',
  'REQUESTED_LATER',
  'OTHER',
] as const;
export const MEETING_DETAIL_FIELDS = [
  'meetingAt', 'outcome', 'unsuccessfulReason', 'meetingSummary', 'nextFollowUpAt',
] as const;
export const JOB_CARD_STATUS_FILTERS = [
  'active', 'closed', 'all', ...JOB_CARD_STATUSES,
] as const;
export const LIFECYCLE_COMMANDS = [
  'ACCEPT_ASSIGNMENT', 'START', 'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION',
  'WITHDRAW_FROM_APPROVAL', 'RESUME', 'CANCEL',
] as const;
export const USER_ROLES = ['ADMIN', 'MANAGER', 'STAFF'] as const;
export const JOB_CARD_OPERATIONAL_NOTE_CONTEXTS = [
  'GENERAL', 'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION', 'CANCEL', 'INVALIDATE',
] as const;
export type LifecycleCommand = (typeof LIFECYCLE_COMMANDS)[number];
export type JobCardOperationalNoteContext = (typeof JOB_CARD_OPERATIONAL_NOTE_CONTEXTS)[number];
export const JOB_WORKFLOW_ACTIONS = [
  'EDIT_JOB_FIELDS', 'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT',
  'EDIT_MEETING_RESULT', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE',
] as const;
export type JobWorkflowAction = (typeof JOB_WORKFLOW_ACTIONS)[number];
export const SUBMISSION_REQUIREMENT_CODES = [
  'CUSTOMER_ELIGIBLE', 'ASSIGNEE_ELIGIBLE', 'DELIVERY_ITEM_PRESENT',
  'DELIVERY_ITEMS_VALID', 'TASK_TITLE_VALID', 'MEETING_TIME_VALID',
  'MEETING_OUTCOME_VALID', 'MEETING_SUMMARY_PRESENT', 'UNSUCCESSFUL_REASON_PRESENT',
  'FOLLOW_UP_TIME_VALID',
] as const;

export type JobCardStatus = (typeof JOB_CARD_STATUSES)[number];
export type JobCardActivityStatus = (typeof JOB_CARD_ACTIVITY_STATUSES)[number];
export type JobCardStatusFilter = (typeof JOB_CARD_STATUS_FILTERS)[number];
export type JobCardPriority = (typeof JOB_CARD_PRIORITIES)[number];
export type DeliveryPurpose = (typeof DELIVERY_PURPOSES)[number];
export type JobCardType = (typeof JOB_CARD_TYPES)[number];
export type JobCardEngagementKind = (typeof JOB_CARD_ENGAGEMENT_KINDS)[number];
export type MeetingOutcome = (typeof MEETING_OUTCOMES)[number];
export type UnsuccessfulVisitReasonCode = (typeof UNSUCCESSFUL_VISIT_REASON_CODES)[number];
export type MeetingDetailField = (typeof MEETING_DETAIL_FIELDS)[number];
export type Paginated<T> = { items: T[]; total: number; limit: number; offset: number };
export type RelatedName = { id: string; name: string };
export type SubmissionRequirement = {
  code: (typeof SUBMISSION_REQUIREMENT_CODES)[number];
  state: 'met' | 'missing' | 'invalid';
  field?: string;
};
export type SubmissionReadiness = {
  evaluatedAt: string;
  ready: boolean;
  items: SubmissionRequirement[];
};
export type JobLifecycleFacts = {
  createdAt: string;
  acceptedAt: string | null;
  acceptedBy: RelatedName | null;
  startedAt: string | null;
  submittedAt: string | null;
  submittedBy: RelatedName | null;
  submissionNote: string | null;
  approvedAt: string | null;
  approvedBy: RelatedName | null;
  approvalNote: string | null;
  revisionRequestedAt: string | null;
  revisionRequestedBy: RelatedName | null;
  revisionReason: string | null;
  cancelledAt: string | null;
  cancelledBy: RelatedName | null;
  cancelReason: string | null;
  cancelledFromStatus: JobCardStatus | null;
  invalidatedAt?: string | null;
  invalidatedBy?: RelatedName | null;
  invalidationReasonCode?: JobCardInvalidationReasonCode | null;
  invalidatedFromStatus?: JobCardStatus | null;
};
export type JobWorkflowContext = {
  allowedCommands: LifecycleCommand[];
  allowedActions: JobWorkflowAction[];
  startLocationCaptureEnabled: boolean;
  lifecycle: JobLifecycleFacts;
  submissionReadiness: SubmissionReadiness | null;
};
export type FollowUpSourceSummary = {
  sourceType: JobCardType;
  sourcePlannedAt: string | null;
  sourceOccurredAt: string | null;
  sourceCompletedAt: string;
  customer: RelatedName | null;
  contact: RelatedName | null;
  outcome: MeetingOutcome | null;
};
export type JobCardFollowUpContext = {
  sourceJobCardId: string;
  followUpInstructions: string;
  sourceAccess: 'FULL' | 'RESTRICTED';
  sourceJobPath: string | null;
  sourceSummary: FollowUpSourceSummary;
};
export type FollowUpProposalOrigin = 'SYSTEM' | 'STAFF_ADJUSTED';
export type FollowUpProposal = {
  scheduledAt: string;
  type: JobCardType;
  assignedTo: string;
  followUpInstructions: string;
  origin: FollowUpProposalOrigin;
  proposedBy: RelatedName;
};
export type CustomerScheduleLevel = 'CLEAR' | 'WARNING' | 'CONFLICT' | 'FREQUENCY_EXCEEDED';
export type CustomerScheduleConflictDetail = {
  jobCardId: string;
  title: string;
  scheduledAt: string;
  type: JobCardType;
  status: string;
  assignee: RelatedName;
  jobPath: string;
};
export type RecentVisitSummary = {
  occurredAt: string;
  jobType: JobCardType;
  title: string;
  staffName: string;
  resultSummary: string | null;
};
export type CustomerScheduleEvaluation = {
  level: CustomerScheduleLevel;
  safeMessage: string | null;
  conflicts: CustomerScheduleConflictDetail[];
  recentVisit: RecentVisitSummary | null;
  suggestedAlternativeAt: string | null;
};
export type AvailableSlotsInput = {
  type: 'SALES_MEETING' | 'PRODUCT_DELIVERY';
  customerId: string;
  assignedTo: string;
  scheduledAt: string;
  scheduledEndsAt?: string;
  jobCardId?: string | null;
};
export type AvailableSlot = { startsAt: string; endsAt: string };
export type AvailableSlotsResponse = { slots: AvailableSlot[] };
export type FollowUpSuggestion = {
  scheduledAt: string | null;
  type: JobCardType;
  assignedTo: string;
  followUpInstructions: string;
  evaluation: CustomerScheduleEvaluation;
};
export type JobCard = {
  id: string; organizationId: string; organizationTimezone?: string;
  type: JobCardType; status: JobCardStatus;
  version: number; title: string; description: string | null; customerId: string | null;
  contactId: string | null; assignedTo: string; createdBy: string; priority: JobCardPriority;
  dueDate: string | null; scheduledAt: string | null; scheduledEndsAt?: string | null;
  engagementKind: JobCardEngagementKind | null;
  invalidatedAt?: string | null;
  invalidatedBy?: string | null;
  invalidationReasonCode?: JobCardInvalidationReasonCode | null;
  assignee: RelatedName;
  customer: RelatedName | null; contact: RelatedName | null; workflowContext: JobWorkflowContext;
  followUpContext: JobCardFollowUpContext | null;
  followUpProposal: FollowUpProposal | null;
};
type FollowUpCreateCommon = {
  clientActionId: string;
  title: string;
  followUpInstructions: string;
  scheduledAt: string | null;
  assignedTo: string;
  priority: JobCardPriority;
  dueDate: string | null;
  contactId: string | null;
  overrideReason?: string | null;
};
export type FollowUpCreateInput = FollowUpCreateCommon & (
  | { type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK' }
  | { type: 'SALES_MEETING'; engagementKind: JobCardEngagementKind }
);
export type JobCardCreateInput =
  | { clientActionId: string; type: 'PRODUCT_DELIVERY'; title: string; customerId: string;
    assignedTo: string; scheduledAt: string; scheduledEndsAt?: string;
    description?: string | null;
    priority?: JobCardPriority; dueDate?: string | null; overrideReason?: string | null }
  | { clientActionId: string; type: 'GENERAL_TASK'; title: string; assignedTo: string;
    description?: string | null; customerId?: string | null; contactId?: string | null;
    priority?: JobCardPriority; dueDate?: string | null; scheduledAt?: string | null }
  | { clientActionId: string; type: 'SALES_MEETING'; title: string; customerId: string;
    assignedTo: string; scheduledAt: string; scheduledEndsAt?: string;
    engagementKind: JobCardEngagementKind;
    dueDate?: string | null; description?: string | null;
    contactId?: string | null; priority?: JobCardPriority; overrideReason?: string | null };
export type ProductDeliveryCreateInput = {
  clientActionId: string; type: 'PRODUCT_DELIVERY'; title: string; customerId: string;
  assignedTo: string; scheduledAt: string; scheduledEndsAt?: string;
  description?: string | null; priority?: JobCardPriority; dueDate?: string | null;
  overrideReason?: string | null; deliveryPurpose: DeliveryPurpose;
  deliveryNote?: string | null;
  items: Array<{ productId: string; quantity: number }>;
};
export type PersistedJobCardListItem = {
  id: string; type: JobCardType; status: JobCardStatus; version: number; title: string;
  priority: JobCardPriority; dueDate: string | null; scheduledAt: string | null;
  scheduledEndsAt?: string | null;
  engagementKind: JobCardEngagementKind | null;
  createdAt: string; updatedAt: string; staffCompletedAt: string | null;
  customer: RelatedName | null; contact: RelatedName | null; assignee: RelatedName;
  deliveryItemCount: number;
};
export type JobCardListItem = PersistedJobCardListItem & {
  allowedCommands: LifecycleCommand[];
};
export type FollowUpListItem = JobCardListItem & {
  followUp: { sourceJobCardId: string } | null;
};
export type JobCardBoard = {
  columns: Record<'NEW' | 'ACCEPTED' | 'IN_PROGRESS' | 'WAITING_APPROVAL' | 'REVISION_REQUESTED', {
    items: JobCardListItem[]; count: number;
  }>;
  closedCounts: { COMPLETED: number; CANCELLED: number };
};
type JobCardNoteBase = {
  id: string; jobCardId: string; note: string;
  invoiceNumber: string | null; createdAt: string;
};
export type JobCardNote = JobCardNoteBase & (
  | {
      recordVersion: 0;
      author: RelatedName & { role: null; source: 'LEGACY_CURRENT' };
      workflowStage: null;
      context: null;
      relatedActivityId: null;
    }
  | {
      recordVersion: 1;
      author: RelatedName & {
        role: (typeof USER_ROLES)[number];
        source: 'SNAPSHOT';
      };
      workflowStage: JobCardStatus;
      context: JobCardOperationalNoteContext;
      relatedActivityId: string;
    }
);
export type JobCardNoteCursor = { createdAt: string; id: string };
export type JobCardNotePage = {
  items: JobCardNote[];
  limit: number;
  nextCursor: JobCardNoteCursor | null;
};
export type JobCardActivityDetails =
  | {
      kind: 'STATUS_TRANSITION';
      fromStatus: JobCardActivityStatus;
      toStatus: JobCardActivityStatus;
      reason: string | null;
      startLocation?:
        | {
            outcome: 'CAPTURED';
            approximateLabel: string | null;
            accuracyMeters: number;
            capturedAt: string;
            geocodingProvider: 'GOOGLE' | null;
          }
        | { outcome: 'UNAVAILABLE'; reason: 'PERMISSION_DENIED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED' | 'UNKNOWN' };
    }
  | { kind: 'FIELDS_UPDATED'; changedFields: Array<'title' | 'description' | 'customer' | 'contact' | 'assignee' | 'priority' | 'dueDate' | 'scheduledAt' | 'scheduledEndsAt' | 'engagementKind'> }
  | { kind: 'DELIVERY_ITEM'; operation: 'ADDED' | 'UPDATED' | 'REMOVED'; itemId: string; purpose: DeliveryPurpose | null; quantity: number | null }
  | { kind: 'NOTE'; noteId: string }
  | { kind: 'MEETING_DETAILS'; changedFields: MeetingDetailField[] }
  | { kind: 'NONE' };
export type JobCardActivity = {
  id: string; jobCardId: string; eventType: string; actor: RelatedName | null;
  details: JobCardActivityDetails; createdAt: string;
};
export type DeliveryItem = {
  id: string; organizationId: string; jobCardId: string; productId: string;
  deliveryPurpose: DeliveryPurpose; deliveredAt: string | null; quantity: number; unit: string | null;
  productNameSnapshot: string; productSkuSnapshot: string | null; productModelSnapshot: string | null;
  lotNo: string | null; serialNo: string | null; expiryDate: string | null; deliveryNote: string | null;
};
export type MeetingDetails = {
  jobCardId: string; meetingAt: string | null; outcome: MeetingOutcome | null;
  unsuccessfulReason: UnsuccessfulVisitReasonCode | null;
  meetingSummary: string | null; nextFollowUpAt: string | null; jobCardVersion: number;
};
export type PatchMeetingDetailsInput = {
  clientActionId: string; expectedVersion: number; meetingAt?: string | null;
  outcome?: MeetingOutcome | null; unsuccessfulReason?: UnsuccessfulVisitReasonCode | null;
  meetingSummary?: string | null;
  nextFollowUpAt?: string | null;
};
export type PatchJobCardInput = {
  expectedVersion: number;
  title?: string;
  description?: string | null;
  customerId?: string | null;
  contactId?: string | null;
  assignedTo?: string;
  priority?: JobCardPriority;
  dueDate?: string | null;
  scheduledAt?: string | null;
  scheduledEndsAt?: string | null;
  engagementKind?: JobCardEngagementKind;
  overrideReason?: string | null;
};

export type JobCardListFilters = Partial<{
  q: string; status: JobCardStatusFilter; type: JobCardType; assignedTo: string;
  customerId: string; priority: JobCardPriority; dueBefore: string; dueAfter: string;
  overdue: true; limit: number; offset: number;
}>;
export type JobCardBoardFilters = Omit<JobCardListFilters, 'status' | 'offset' | 'overdue'>;
type DeliveryInput = {
  expectedVersion: number; productId: string; deliveryPurpose: DeliveryPurpose;
  deliveredAt: string | null;
  quantity: number; lotNo?: string | null; serialNo?: string | null; expiryDate?: string | null;
  deliveryNote?: string | null;
};
type LifecycleInput = { clientActionId: string; expectedVersion: number };
export type JobCardInvalidationInput = {
  clientActionId: string;
  expectedVersion: number;
  reasonCode: JobCardInvalidationReasonCode;
  note?: string | null;
};
export type StartJobCardInput = LifecycleInput & { locationCapture?: StartLocationCapture };
export type FollowUpProposalInput = {
  scheduledAt: string;
  type: JobCardType;
  assignedTo: string;
  followUpInstructions: string;
};

export type ApproveFollowUpInput = FollowUpProposalInput & {
  priority?: JobCardPriority;
  dueDate?: string | null;
  overrideReason?: string;
};

function invalid(field: string): never {
  throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
}
function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const parsed = string(value, field);
  if (!allowed.includes(parsed as T)) invalid(field);
  return parsed as T;
}
function array(value: unknown, field: string) {
  if (!Array.isArray(value)) invalid(field);
  return value;
}
function exactObject(value: unknown, field: string, keys: readonly string[]) {
  const parsed = object(value);
  if (Object.keys(parsed).some((key) => !keys.includes(key))) invalid(field);
  return parsed;
}
function count(value: unknown, field: string) {
  const parsed = number(value, field);
  if (!Number.isInteger(parsed) || parsed < 0) invalid(field);
  return parsed;
}
function positiveCount(value: unknown, field: string) {
  const parsed = count(value, field);
  if (parsed < 1) invalid(field);
  return parsed;
}
function positiveFiniteNumber(value: unknown, field: string) {
  const parsed = number(value, field);
  if (parsed <= 0) invalid(field);
  return parsed;
}
function related(value: unknown, field: string): RelatedName {
  const v = object(value);
  return { id: string(v.id, `${field}.id`), name: string(v.name, `${field}.name`) };
}
function nullableRelated(value: unknown, field: string) {
  return value === null ? null : related(value, field);
}
function canonicalInstant(value: unknown, field: string) {
  const parsed = string(value, field);
  const instant = new Date(parsed);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || Number.isNaN(instant.valueOf()) || instant.toISOString() !== parsed) invalid(field);
  return parsed;
}
function nullableCanonicalInstant(value: unknown, field: string) {
  return value === null ? null : canonicalInstant(value, field);
}
function uniqueValues<T extends string>(values: T[], field: string) {
  if (new Set(values).size !== values.length) invalid(field);
  return values;
}
function parseCancelledFromStatus(value: unknown, field: string): JobCardStatus | null {
  if (value === null) return null;
  const status = oneOf(value, field, JOB_CARD_STATUSES);
  if (status === 'COMPLETED' || status === 'CANCELLED') invalid(field);
  return status;
}
function parseInvalidatedFromStatus(value: unknown, field: string): JobCardStatus | null {
  return value === null ? null : oneOf(value, field, JOB_CARD_STATUSES);
}
function parseLifecycleFacts(value: unknown): JobLifecycleFacts {
  const v = exactObject(value, 'lifecycle', [
    'createdAt', 'acceptedAt', 'acceptedBy', 'startedAt', 'submittedAt', 'submittedBy',
    'submissionNote', 'approvedAt', 'approvedBy', 'approvalNote', 'revisionRequestedAt',
    'revisionRequestedBy', 'revisionReason', 'cancelledAt', 'cancelledBy', 'cancelReason',
    'cancelledFromStatus', 'invalidatedAt', 'invalidatedBy', 'invalidationReasonCode',
    'invalidatedFromStatus',
  ]);
  return {
    createdAt: canonicalInstant(v.createdAt, 'createdAt'),
    acceptedAt: nullableCanonicalInstant(v.acceptedAt, 'acceptedAt'),
    acceptedBy: nullableRelated(v.acceptedBy, 'acceptedBy'),
    startedAt: nullableCanonicalInstant(v.startedAt, 'startedAt'),
    submittedAt: nullableCanonicalInstant(v.submittedAt, 'submittedAt'),
    submittedBy: nullableRelated(v.submittedBy, 'submittedBy'),
    submissionNote: nullableString(v.submissionNote, 'submissionNote'),
    approvedAt: nullableCanonicalInstant(v.approvedAt, 'approvedAt'),
    approvedBy: nullableRelated(v.approvedBy, 'approvedBy'),
    approvalNote: nullableString(v.approvalNote, 'approvalNote'),
    revisionRequestedAt: nullableCanonicalInstant(v.revisionRequestedAt, 'revisionRequestedAt'),
    revisionRequestedBy: nullableRelated(v.revisionRequestedBy, 'revisionRequestedBy'),
    revisionReason: nullableString(v.revisionReason, 'revisionReason'),
    cancelledAt: nullableCanonicalInstant(v.cancelledAt, 'cancelledAt'),
    cancelledBy: nullableRelated(v.cancelledBy, 'cancelledBy'),
    cancelReason: nullableString(v.cancelReason, 'cancelReason'),
    cancelledFromStatus: parseCancelledFromStatus(v.cancelledFromStatus, 'cancelledFromStatus'),
    invalidatedAt: v.invalidatedAt === undefined ? null : nullableCanonicalInstant(v.invalidatedAt, 'invalidatedAt'),
    invalidatedBy: v.invalidatedBy === undefined ? null : nullableRelated(v.invalidatedBy, 'invalidatedBy'),
    invalidationReasonCode: v.invalidationReasonCode === undefined || v.invalidationReasonCode === null
      ? null : oneOf(v.invalidationReasonCode, 'invalidationReasonCode', JOB_CARD_INVALIDATION_REASON_CODES),
    invalidatedFromStatus: v.invalidatedFromStatus === undefined
      ? null : parseInvalidatedFromStatus(v.invalidatedFromStatus, 'invalidatedFromStatus'),
  };
}
function parseRequirement(value: unknown): SubmissionRequirement {
  const v = object(value);
  const keys = Object.keys(v);
  if (keys.some((key) => !['code', 'state', 'field'].includes(key))) invalid('items');
  const requirement: SubmissionRequirement = {
    code: oneOf(v.code, 'code', SUBMISSION_REQUIREMENT_CODES),
    state: oneOf(v.state, 'state', ['met', 'missing', 'invalid'] as const),
  };
  if ('field' in v) requirement.field = string(v.field, 'field');
  return requirement;
}
function parseReadiness(value: unknown): SubmissionReadiness {
  const v = exactObject(value, 'submissionReadiness', ['evaluatedAt', 'ready', 'items']);
  if (typeof v.ready !== 'boolean') invalid('ready');
  const items = array(v.items, 'items').map(parseRequirement);
  uniqueValues(items.map((item) => item.code), 'items');
  return {
    evaluatedAt: canonicalInstant(v.evaluatedAt, 'evaluatedAt'),
    ready: v.ready,
    items,
  };
}
function parseWorkflowContext(value: unknown): JobWorkflowContext {
  const v = exactObject(value, 'workflowContext', [
    'allowedCommands', 'allowedActions', 'startLocationCaptureEnabled',
    'lifecycle', 'submissionReadiness',
  ]);
  const allowedCommands = uniqueValues(
    array(v.allowedCommands, 'allowedCommands').map((entry) =>
      oneOf(entry, 'allowedCommands', LIFECYCLE_COMMANDS)),
    'allowedCommands',
  );
  const allowedActions = uniqueValues(
    array(v.allowedActions, 'allowedActions').map((entry) =>
      oneOf(entry, 'allowedActions', JOB_WORKFLOW_ACTIONS)),
    'allowedActions',
  );
  return {
    allowedCommands,
    allowedActions,
    startLocationCaptureEnabled: v.startLocationCaptureEnabled === undefined
      ? false
      : boolean(v.startLocationCaptureEnabled, 'startLocationCaptureEnabled'),
    lifecycle: parseLifecycleFacts(v.lifecycle),
    submissionReadiness: v.submissionReadiness === null
      ? null
      : parseReadiness(v.submissionReadiness),
  };
}
function parseEngagementKind(value: unknown, type: JobCardType): JobCardEngagementKind | null {
  if (type === 'SALES_MEETING') {
    return oneOf(value, 'engagementKind', JOB_CARD_ENGAGEMENT_KINDS);
  }
  if (value !== null && value !== undefined) {
    throw new ApiError(0, 'INVALID_RESPONSE', 'Yanıtta engagementKind alanı geçersiz.');
  }
  return null;
}
function parseFollowUpSourceSummary(value: unknown): FollowUpSourceSummary {
  const v = exactObject(value, 'sourceSummary', [
    'sourceType', 'sourcePlannedAt', 'sourceOccurredAt', 'sourceCompletedAt',
    'customer', 'contact', 'outcome',
  ]);
  return {
    sourceType: oneOf(v.sourceType, 'sourceType', JOB_CARD_TYPES),
    sourcePlannedAt: nullableCanonicalInstant(v.sourcePlannedAt, 'sourcePlannedAt'),
    sourceOccurredAt: nullableCanonicalInstant(v.sourceOccurredAt, 'sourceOccurredAt'),
    sourceCompletedAt: canonicalInstant(v.sourceCompletedAt, 'sourceCompletedAt'),
    customer: nullableRelated(v.customer, 'customer'),
    contact: nullableRelated(v.contact, 'contact'),
    outcome: v.outcome === null ? null : oneOf(v.outcome, 'outcome', MEETING_OUTCOMES),
  };
}
function parseFollowUpContext(value: unknown): JobCardFollowUpContext | null {
  if (value === null) return null;
  const v = exactObject(value, 'followUpContext', [
    'sourceJobCardId', 'followUpInstructions', 'sourceAccess', 'sourceJobPath',
    'sourceSummary',
  ]);
  const sourceAccess = oneOf(v.sourceAccess, 'sourceAccess', ['FULL', 'RESTRICTED'] as const);
  const sourceJobPath = nullableString(v.sourceJobPath, 'sourceJobPath');
  if (sourceAccess === 'FULL') {
    if (!sourceJobPath || !/^\/jobs\/[^/?#]+$/.test(sourceJobPath)) invalid('sourceJobPath');
  } else if (sourceJobPath !== null) invalid('sourceJobPath');
  return {
    sourceJobCardId: string(v.sourceJobCardId, 'sourceJobCardId'),
    followUpInstructions: string(v.followUpInstructions, 'followUpInstructions'),
    sourceAccess,
    sourceJobPath,
    sourceSummary: parseFollowUpSourceSummary(v.sourceSummary),
  };
}
function parseFollowUpProposal(value: unknown): FollowUpProposal | null {
  if (value === null) return null;
  const v = exactObject(value, 'followUpProposal', [
    'scheduledAt', 'type', 'assignedTo', 'followUpInstructions', 'origin', 'proposedBy',
  ]);
  return {
    scheduledAt: canonicalInstant(v.scheduledAt, 'followUpProposal.scheduledAt'),
    type: oneOf(v.type, 'followUpProposal.type', JOB_CARD_TYPES),
    assignedTo: string(v.assignedTo, 'followUpProposal.assignedTo'),
    followUpInstructions: string(v.followUpInstructions, 'followUpProposal.followUpInstructions'),
    origin: oneOf(v.origin, 'followUpProposal.origin', ['SYSTEM', 'STAFF_ADJUSTED'] as const),
    proposedBy: related(v.proposedBy, 'followUpProposal.proposedBy'),
  };
}
function parseCustomerScheduleEvaluation(value: unknown): CustomerScheduleEvaluation {
  const v = exactObject(value, 'evaluation', [
    'level', 'safeMessage', 'conflicts', 'recentVisit', 'suggestedAlternativeAt',
  ]);
  return {
    level: oneOf(v.level, 'evaluation.level', ['CLEAR', 'WARNING', 'CONFLICT', 'FREQUENCY_EXCEEDED'] as const),
    safeMessage: nullableString(v.safeMessage, 'evaluation.safeMessage'),
    conflicts: array(v.conflicts, 'evaluation.conflicts').map((entry) => {
      const c = exactObject(entry, 'conflict', [
        'jobCardId', 'title', 'scheduledAt', 'type', 'status', 'assignee', 'jobPath',
      ]);
      return {
        jobCardId: string(c.jobCardId, 'conflict.jobCardId'),
        title: string(c.title, 'conflict.title'),
        scheduledAt: canonicalInstant(c.scheduledAt, 'conflict.scheduledAt'),
        type: oneOf(c.type, 'conflict.type', JOB_CARD_TYPES),
        status: string(c.status, 'conflict.status'),
        assignee: related(c.assignee, 'conflict.assignee'),
        jobPath: string(c.jobPath, 'conflict.jobPath'),
      };
    }),
    recentVisit: v.recentVisit === null ? null : (() => {
      const r = exactObject(v.recentVisit, 'recentVisit', [
        'occurredAt', 'jobType', 'title', 'staffName', 'resultSummary',
      ]);
      return {
        occurredAt: canonicalInstant(r.occurredAt, 'recentVisit.occurredAt'),
        jobType: oneOf(r.jobType, 'recentVisit.jobType', JOB_CARD_TYPES),
        title: string(r.title, 'recentVisit.title'),
        staffName: string(r.staffName, 'recentVisit.staffName'),
        resultSummary: nullableString(r.resultSummary, 'recentVisit.resultSummary'),
      };
    })(),
    suggestedAlternativeAt: nullableCanonicalInstant(
      v.suggestedAlternativeAt,
      'evaluation.suggestedAlternativeAt',
    ),
  };
}

function parseAvailableSlotsResponse(value: unknown): AvailableSlotsResponse {
  const root = exactObject(value, 'availableSlots', ['slots']);
  if (!Array.isArray(root.slots)) invalid('slots');
  return {
    slots: root.slots.map((raw, index) => {
      const slot = exactObject(raw, `slots[${index}]`, ['startsAt', 'endsAt']);
      const startsAt = canonicalInstant(slot.startsAt, `slots[${index}].startsAt`);
      const endsAt = canonicalInstant(slot.endsAt, `slots[${index}].endsAt`);
      if (Date.parse(endsAt) <= Date.parse(startsAt)) invalid(`slots[${index}]`);
      return { startsAt, endsAt };
    }),
  };
}
export function parseFollowUpSuggestion(value: unknown): FollowUpSuggestion {
  const v = exactObject(value, 'followUpSuggestion', [
    'scheduledAt', 'type', 'assignedTo', 'followUpInstructions', 'evaluation',
  ]);
  return {
    scheduledAt: nullableCanonicalInstant(v.scheduledAt, 'scheduledAt'),
    type: oneOf(v.type, 'type', JOB_CARD_TYPES),
    assignedTo: string(v.assignedTo, 'assignedTo'),
    followUpInstructions: string(v.followUpInstructions, 'followUpInstructions'),
    evaluation: parseCustomerScheduleEvaluation(v.evaluation),
  };
}
function parseJobCard(value: unknown): JobCard {
  const v = object(value);
  if ('sourceJobCardId' in v || 'followUpInstructions' in v) invalid('jobCard');
  if (!('followUpContext' in v)) invalid('followUpContext');
  const type = oneOf(v.type, 'type', JOB_CARD_TYPES);
  return {
    id: string(v.id, 'id'), organizationId: string(v.organizationId, 'organizationId'),
    ...(v.organizationTimezone === undefined ? {} : {
      organizationTimezone: string(v.organizationTimezone, 'organizationTimezone'),
    }),
    type,
    status: oneOf(v.status, 'status', JOB_CARD_STATUSES), version: positiveCount(v.version, 'version'),
    title: string(v.title, 'title'), description: nullableString(v.description, 'description'),
    customerId: nullableString(v.customerId, 'customerId'), contactId: nullableString(v.contactId, 'contactId'),
    assignedTo: string(v.assignedTo, 'assignedTo'), createdBy: string(v.createdBy, 'createdBy'),
    priority: oneOf(v.priority, 'priority', JOB_CARD_PRIORITIES), dueDate: nullableString(v.dueDate, 'dueDate'),
    scheduledAt: nullableCanonicalInstant(v.scheduledAt, 'scheduledAt'),
    ...(v.scheduledEndsAt === undefined ? {} : {
      scheduledEndsAt: nullableCanonicalInstant(v.scheduledEndsAt, 'scheduledEndsAt'),
    }),
    engagementKind: parseEngagementKind(v.engagementKind, type),
    invalidatedAt: v.invalidatedAt === undefined ? null : nullableCanonicalInstant(v.invalidatedAt, 'invalidatedAt'),
    invalidatedBy: v.invalidatedBy === undefined || v.invalidatedBy === null ? null : string(v.invalidatedBy, 'invalidatedBy'),
    invalidationReasonCode: v.invalidationReasonCode === undefined || v.invalidationReasonCode === null
      ? null : oneOf(v.invalidationReasonCode, 'invalidationReasonCode', JOB_CARD_INVALIDATION_REASON_CODES),
    assignee: related(v.assignee, 'assignee'), customer: nullableRelated(v.customer, 'customer'),
    contact: nullableRelated(v.contact, 'contact'),
    workflowContext: parseWorkflowContext(v.workflowContext),
    followUpContext: parseFollowUpContext(v.followUpContext),
    followUpProposal: 'followUpProposal' in v
      ? parseFollowUpProposal(v.followUpProposal)
      : null,
  };
}
export function parsePersistedJobCardListItem(value: unknown): PersistedJobCardListItem {
  const v = object(value);
  const type = oneOf(v.type, 'type', JOB_CARD_TYPES);
  return {
    id: string(v.id, 'id'), type,
    status: oneOf(v.status, 'status', JOB_CARD_STATUSES), version: positiveCount(v.version, 'version'),
    title: string(v.title, 'title'), priority: oneOf(v.priority, 'priority', JOB_CARD_PRIORITIES),
    dueDate: nullableString(v.dueDate, 'dueDate'),
    scheduledAt: nullableCanonicalInstant(v.scheduledAt, 'scheduledAt'),
    ...(v.scheduledEndsAt === undefined ? {} : {
      scheduledEndsAt: nullableCanonicalInstant(v.scheduledEndsAt, 'scheduledEndsAt'),
    }),
    engagementKind: parseEngagementKind(v.engagementKind, type),
    createdAt: string(v.createdAt, 'createdAt'),
    updatedAt: string(v.updatedAt, 'updatedAt'), staffCompletedAt: nullableString(v.staffCompletedAt, 'staffCompletedAt'),
    customer: nullableRelated(v.customer, 'customer'), contact: nullableRelated(v.contact, 'contact'),
    assignee: related(v.assignee, 'assignee'), deliveryItemCount: count(v.deliveryItemCount, 'deliveryItemCount'),
  };
}
export function parseJobCardListItem(value: unknown): JobCardListItem {
  const v = object(value);
  return {
    ...parsePersistedJobCardListItem(value),
    allowedCommands: uniqueValues(
      array(v.allowedCommands, 'allowedCommands').map((entry) =>
        oneOf(entry, 'allowedCommands', LIFECYCLE_COMMANDS)),
      'allowedCommands',
    ),
  };
}
export function parseFollowUpListItem(value: unknown): FollowUpListItem {
  const v = object(value);
  const followUp = v.followUp === null ? null : exactObject(v.followUp, 'followUp', ['sourceJobCardId']);
  return {
    ...parseJobCardListItem(value),
    followUp: followUp === null
      ? null
      : { sourceJobCardId: string(followUp.sourceJobCardId, 'sourceJobCardId') },
  };
}
function parsePage<T>(value: unknown, parser: (entry: unknown) => T): Paginated<T> {
  const v = object(value);
  return {
    items: items(v).map(parser), total: count(v.total, 'total'),
    limit: positiveCount(v.limit, 'limit'), offset: count(v.offset, 'offset'),
  };
}
function parseColumn(value: unknown) {
  const v = object(value);
  return { items: array(v.items, 'items').map(parseJobCardListItem), count: count(v.count, 'count') };
}
function parseBoard(value: unknown): JobCardBoard {
  const v = object(value); const columns = object(v.columns); const closed = object(v.closedCounts);
  return {
    columns: {
      NEW: parseColumn(columns.NEW), ACCEPTED: parseColumn(columns.ACCEPTED),
      IN_PROGRESS: parseColumn(columns.IN_PROGRESS), WAITING_APPROVAL: parseColumn(columns.WAITING_APPROVAL),
      REVISION_REQUESTED: parseColumn(columns.REVISION_REQUESTED),
    },
    closedCounts: { COMPLETED: count(closed.COMPLETED, 'COMPLETED'), CANCELLED: count(closed.CANCELLED, 'CANCELLED') },
  };
}
function parseNote(value: unknown): JobCardNote {
  const v = object(value);
  const base = {
    id: string(v.id, 'id'),
    jobCardId: string(v.jobCardId, 'jobCardId'),
    note: string(v.note, 'note'),
    invoiceNumber: v.invoiceNumber === null || v.invoiceNumber === undefined
      ? null : string(v.invoiceNumber, 'invoiceNumber'),
    createdAt: string(v.createdAt, 'createdAt'),
  };
  const author = object(v.author);
  const identity = {
    id: string(author.id, 'author.id'),
    name: string(author.name, 'author.name'),
  };
  if (v.recordVersion === undefined || v.recordVersion === 0) {
    return {
      ...base,
      recordVersion: 0,
      author: { ...identity, role: null, source: 'LEGACY_CURRENT' },
      workflowStage: null,
      context: null,
      relatedActivityId: null,
    };
  }
  if (v.recordVersion !== 1) {
    throw new ApiError(0, 'INVALID_RESPONSE', 'Not kayıt sürümü geçersiz.');
  }
  return {
    ...base,
    recordVersion: 1,
    author: {
      ...identity,
      role: oneOf(author.role, 'author.role', USER_ROLES),
      source: oneOf(author.source, 'author.source', ['SNAPSHOT'] as const),
    },
    workflowStage: oneOf(v.workflowStage, 'workflowStage', JOB_CARD_STATUSES),
    context: oneOf(v.context, 'context', JOB_CARD_OPERATIONAL_NOTE_CONTEXTS),
    relatedActivityId: string(v.relatedActivityId, 'relatedActivityId'),
  };
}

function parseNotePage(value: unknown): JobCardNotePage {
  const v = object(value);
  const cursor = v.nextCursor === null ? null : object(v.nextCursor);
  return {
    items: items(v).map(parseNote),
    limit: positiveCount(v.limit, 'limit'),
    nextCursor: cursor === null
      ? null
      : {
          createdAt: string(cursor.createdAt, 'nextCursor.createdAt'),
          id: string(cursor.id, 'nextCursor.id'),
        },
  };
}
function parseDetails(value: unknown): JobCardActivityDetails {
  const v = object(value); const kind = string(v.kind, 'details.kind');
  if (kind === 'NONE') return { kind };
  if (kind === 'STATUS_TRANSITION') {
    const detail = exactObject(v, 'details', [
      'kind', 'fromStatus', 'toStatus', 'reason', 'startLocation',
    ]);
    let startLocation: Extract<JobCardActivityDetails, { kind: 'STATUS_TRANSITION' }>['startLocation'];
    if (detail.startLocation !== undefined) {
      const location = object(detail.startLocation);
      const outcome = oneOf(location.outcome, 'startLocation.outcome', ['CAPTURED', 'UNAVAILABLE'] as const);
      if (outcome === 'CAPTURED') {
        const captured = exactObject(location, 'startLocation', [
          'outcome', 'approximateLabel', 'accuracyMeters', 'capturedAt', 'geocodingProvider',
        ]);
        const provider = captured.geocodingProvider === null
          ? null
          : oneOf(captured.geocodingProvider, 'geocodingProvider', ['GOOGLE'] as const);
        startLocation = {
          outcome,
          approximateLabel: nullableString(captured.approximateLabel, 'approximateLabel'),
          accuracyMeters: positiveFiniteNumber(captured.accuracyMeters, 'accuracyMeters'),
          capturedAt: canonicalInstant(captured.capturedAt, 'capturedAt'),
          geocodingProvider: provider,
        };
      } else {
        const unavailable = exactObject(location, 'startLocation', ['outcome', 'reason']);
        startLocation = {
          outcome,
          reason: oneOf(unavailable.reason, 'reason', [
            'PERMISSION_DENIED', 'POSITION_UNAVAILABLE', 'TIMEOUT', 'UNSUPPORTED', 'UNKNOWN',
          ] as const),
        };
      }
    }
    return {
      kind,
      fromStatus: oneOf(detail.fromStatus, 'fromStatus', JOB_CARD_ACTIVITY_STATUSES),
      toStatus: oneOf(detail.toStatus, 'toStatus', JOB_CARD_ACTIVITY_STATUSES),
      reason: nullableString(detail.reason, 'reason'),
      ...(startLocation ? { startLocation } : {}),
    };
  }
  if (kind === 'FIELDS_UPDATED') return { kind, changedFields: array(v.changedFields, 'changedFields').map((field) =>
    oneOf(field, 'changedFields', ['title', 'description', 'customer', 'contact', 'assignee', 'priority', 'dueDate', 'scheduledAt', 'scheduledEndsAt', 'engagementKind'] as const)) };
  if (kind === 'DELIVERY_ITEM') return { kind,
    operation: oneOf(v.operation, 'operation', ['ADDED', 'UPDATED', 'REMOVED'] as const),
    itemId: string(v.itemId, 'itemId'),
    purpose: v.purpose === null ? null : oneOf(v.purpose, 'purpose', DELIVERY_PURPOSES),
    quantity: v.quantity === null ? null : positiveFiniteNumber(v.quantity, 'quantity') };
  if (kind === 'NOTE') return { kind, noteId: string(v.noteId, 'noteId') };
  if (kind === 'MEETING_DETAILS') {
    const detail = exactObject(v, 'details', ['kind', 'changedFields']);
    const changedFields = array(detail.changedFields, 'changedFields').map((field) =>
      oneOf(field, 'changedFields', MEETING_DETAIL_FIELDS));
    if (changedFields.length === 0 || changedFields.some((field, index) =>
      MEETING_DETAIL_FIELDS.indexOf(field) <= (index === 0
        ? -1 : MEETING_DETAIL_FIELDS.indexOf(changedFields[index - 1]!)))) invalid('changedFields');
    return { kind, changedFields };
  }
  return invalid('details.kind');
}
const RAW_ACTIVITY_KEYS = ['oldValue', 'newValue', 'metadata', 'clientActionId', 'actorId'];
function parseActivity(value: unknown): JobCardActivity {
  const v = object(value);
  if (RAW_ACTIVITY_KEYS.some((key) => key in v)) invalid('activity');
  return { id: string(v.id, 'id'), jobCardId: string(v.jobCardId, 'jobCardId'),
    eventType: string(v.eventType, 'eventType'), actor: nullableRelated(v.actor, 'actor'),
    details: parseDetails(v.details), createdAt: string(v.createdAt, 'createdAt') };
}
function parseDelivery(value: unknown): DeliveryItem {
  const v = object(value);
  return { id: string(v.id, 'id'), organizationId: string(v.organizationId, 'organizationId'),
    jobCardId: string(v.jobCardId, 'jobCardId'), productId: string(v.productId, 'productId'),
    deliveryPurpose: oneOf(v.deliveryPurpose, 'deliveryPurpose', DELIVERY_PURPOSES),
    deliveredAt: v.deliveredAt === null ? null : string(v.deliveredAt, 'deliveredAt'),
    quantity: positiveFiniteNumber(v.quantity, 'quantity'),
    unit: nullableString(v.unit, 'unit'), productNameSnapshot: string(v.productNameSnapshot, 'productNameSnapshot'),
    productSkuSnapshot: nullableString(v.productSkuSnapshot, 'productSkuSnapshot'),
    productModelSnapshot: nullableString(v.productModelSnapshot, 'productModelSnapshot'),
    lotNo: nullableString(v.lotNo, 'lotNo'), serialNo: nullableString(v.serialNo, 'serialNo'),
    expiryDate: nullableString(v.expiryDate, 'expiryDate'), deliveryNote: nullableString(v.deliveryNote, 'deliveryNote') };
}
function parseDeliveryMutation(value: unknown) {
  const v = object(value);
  return { item: parseDelivery(v.item), jobCardVersion: positiveCount(v.jobCardVersion, 'jobCardVersion') };
}
function parseProductDeliveryCreate(value: unknown) {
  const v = exactObject(value, 'productDeliveryCreate', ['jobCardId', 'version']);
  return { jobCardId: string(v.jobCardId, 'jobCardId'), version: positiveCount(v.version, 'version') };
}
export function parseMeetingDetails(value: unknown): MeetingDetails {
  const v = exactObject(value, 'meetingDetails', [
    'jobCardId', 'meetingAt', 'outcome', 'unsuccessfulReason', 'meetingSummary', 'nextFollowUpAt',
    'jobCardVersion',
  ]);
  return {
    jobCardId: string(v.jobCardId, 'jobCardId'),
    meetingAt: nullableCanonicalInstant(v.meetingAt, 'meetingAt'),
    outcome: v.outcome === null ? null : oneOf(v.outcome, 'outcome', MEETING_OUTCOMES),
    unsuccessfulReason: v.unsuccessfulReason === undefined || v.unsuccessfulReason === null
      ? null
      : oneOf(v.unsuccessfulReason, 'unsuccessfulReason', UNSUCCESSFUL_VISIT_REASON_CODES),
    meetingSummary: nullableString(v.meetingSummary, 'meetingSummary'),
    nextFollowUpAt: nullableCanonicalInstant(v.nextFollowUpAt, 'nextFollowUpAt'),
    jobCardVersion: positiveCount(v.jobCardVersion, 'jobCardVersion'),
  };
}
function query(filters: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value));
  const encoded = params.toString(); return encoded ? `?${encoded}` : '';
}
const segment = (value: string) => encodeURIComponent(value);
const jobPath = (id: string) => `/api/job-cards/${segment(id)}`;

export const listJobCards = async (filters: JobCardListFilters = {}) => parsePage(
  await request(`/api/job-cards${query(filters)}`), parseJobCardListItem,
);
export const getJobCardBoard = async (filters: JobCardBoardFilters = {}) =>
  parseBoard(await request(`/api/job-cards/board${query(filters)}`));
export const listJobCardBoard = getJobCardBoard;
export const getJobCard = async (id: string) => parseJobCard(await request(jobPath(id)));
export const createJobCard = async (input: JobCardCreateInput) =>
  parseJobCard(await request('/api/job-cards', json('POST', input)));
export const createProductDelivery = async (input: ProductDeliveryCreateInput) =>
  parseProductDeliveryCreate(await request('/api/job-cards/product-deliveries', json('POST', input)));
export const createFollowUp = async (sourceId: string, input: FollowUpCreateInput) =>
  parseJobCard(await request(`${jobPath(sourceId)}/follow-ups`, json('POST', input)));
export const listFollowUps = async (
  sourceId: string,
  page: Partial<{ limit: number; offset: number }> = {},
) => parsePage(
  await request(`${jobPath(sourceId)}/follow-ups${query(page)}`),
  parseFollowUpListItem,
);
export const patchJobCard = async (id: string, input: PatchJobCardInput): Promise<JobCard & { assignmentTransitionId: string | null }> => {
  const raw = await request(jobPath(id), json('PATCH', input));
  const parsed = parseJobCard(raw);
  const v = raw as Record<string, unknown>;
  return {
    ...parsed,
    assignmentTransitionId: typeof v.assignmentTransitionId === 'string'
      ? v.assignmentTransitionId
      : null,
  };
};
export const getMeetingDetails = async (id: string) =>
  parseMeetingDetails(await request(`${jobPath(id)}/meeting-details`));
export const patchMeetingDetails = async (id: string, input: PatchMeetingDetailsInput) =>
  parseMeetingDetails(await request(`${jobPath(id)}/meeting-details`, json('PATCH', input)));

export const listJobCardNotes = async (
  id: string,
  page: Partial<{ limit: number; before: JobCardNoteCursor | null }> = {},
) => parseNotePage(await request(`${jobPath(id)}/notes${query({
  limit: page.limit,
  beforeCreatedAt: page.before?.createdAt,
  beforeId: page.before?.id,
})}`));
export const addJobCardNote = async (id: string, input: {
  clientActionId: string; note: string; invoiceNumber?: string;
}) =>
  parseNote(await request(`${jobPath(id)}/notes`, json('POST', input)));
export const listActivity = async (id: string, page: Partial<{ limit: number; offset: number }> = {}) =>
  parsePage(await request(`${jobPath(id)}/activity${query(page)}`), parseActivity);
export const listJobCardActivity = listActivity;

export const listDeliveryItems = async (id: string) =>
  items(await request(`${jobPath(id)}/delivery-items`)).map(parseDelivery);
export const addDeliveryItem = async (id: string, input: DeliveryInput & { clientActionId: string }) =>
  parseDeliveryMutation(await request(`${jobPath(id)}/delivery-items`, json('POST', input)));
export const patchDeliveryItem = async (id: string, itemId: string, input: { expectedVersion: number } & Partial<Omit<DeliveryInput, 'expectedVersion'>>) =>
  parseDeliveryMutation(await request(`${jobPath(id)}/delivery-items/${segment(itemId)}`, json('PATCH', input)));
export async function removeDeliveryItem(id: string, itemId: string, expectedVersion: number) {
  const v = object(await request(`${jobPath(id)}/delivery-items/${segment(itemId)}`, json('DELETE', { expectedVersion })));
  return { id: string(v.id, 'id'), jobCardVersion: positiveCount(v.jobCardVersion, 'jobCardVersion') };
}

const lifecycle = async (id: string, command: string, input: object) =>
  parseJobCard(await request(`${jobPath(id)}/${command}`, json('POST', input)));
export const acceptJobCard = (id: string, input: LifecycleInput) => lifecycle(id, 'accept', input);
export const startJobCard = (id: string, input: StartJobCardInput) => lifecycle(id, 'start', input);
export const submitJobCardForApproval = (id: string, input: LifecycleInput & { note: string; followUpProposal?: FollowUpProposalInput }) =>
  lifecycle(id, 'submit-for-approval', input);
export const approveJobCard = async (id: string, input: LifecycleInput & { note?: string; followUp?: ApproveFollowUpInput }) => {
  const raw = await request(`${jobPath(id)}/approve`, json('POST', input));
  const parsed = parseJobCard(raw);
  const v = raw as Record<string, unknown>;
  return {
    ...parsed,
    followUpJobCardId: typeof v.followUpJobCardId === 'string' ? v.followUpJobCardId : null,
  };
};
export const getFollowUpSuggestion = async (id: string, at?: string) =>
  parseFollowUpSuggestion(await request(`${jobPath(id)}/follow-up-suggestion${at === undefined ? '' : query({ at })}`));

export type CustomerSchedulePreviewInput = {
  type: JobCardType;
  customerId: string | null;
  scheduledAt: string;
  jobCardId?: string | null;
};
export const previewCustomerSchedule = async (input: CustomerSchedulePreviewInput) =>
  parseCustomerScheduleEvaluation(
    await request('/api/job-cards/customer-schedule/evaluate', json('POST', input)),
  );
export const findAvailableSlots = async (input: AvailableSlotsInput) =>
  parseAvailableSlotsResponse(
    await request('/api/job-cards/available-slots', json('POST', input)),
  );
export const requestJobCardRevision = (id: string, input: LifecycleInput & { revisionReason: string }) => lifecycle(id, 'request-revision', input);
export const withdrawJobCardFromApproval = (id: string, input: LifecycleInput) => lifecycle(id, 'withdraw-from-approval', input);
export const resumeJobCard = (id: string, input: LifecycleInput) => lifecycle(id, 'resume', input);
export const cancelJobCard = (id: string, input: LifecycleInput & { cancelReason: string }) => lifecycle(id, 'cancel', input);

export const invalidateJobCard = async (
  id: string,
  input: JobCardInvalidationInput,
  expectedSourceStatus: JobCardStatus,
) => {
  const raw = await request(`${jobPath(id)}/invalidate`, json('POST', input));
  const parsed = parseJobCard(raw);
  if (parsed.id !== id
    || parsed.status !== 'INVALIDATED'
    || parsed.version !== input.expectedVersion + 1
    || parsed.invalidationReasonCode !== input.reasonCode
    || parsed.invalidatedAt === undefined
    || parsed.invalidatedAt === null
    || parsed.invalidatedBy === undefined
    || parsed.invalidatedBy === null
    || parsed.workflowContext.lifecycle.invalidatedFromStatus !== expectedSourceStatus
    || parsed.workflowContext.lifecycle.invalidationReasonCode !== input.reasonCode
    || parsed.workflowContext.lifecycle.invalidatedBy === null) {
    invalid('invalidation');
  }
  return parsed;
};
