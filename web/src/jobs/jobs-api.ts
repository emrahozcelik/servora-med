import {
  ApiError, boolean, items, json, nullableString, number, object, request, string,
} from '../services/api';
import type { StartLocationCapture } from './start-location-capture.js';

export const JOB_CARD_STATUSES = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
  'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED',
] as const;
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
export const MEETING_DETAIL_FIELDS = [
  'meetingAt', 'outcome', 'meetingSummary', 'nextFollowUpAt',
] as const;
export const JOB_CARD_STATUS_FILTERS = [
  'active', 'closed', 'all', ...JOB_CARD_STATUSES,
] as const;
export const LIFECYCLE_COMMANDS = [
  'ACCEPT_ASSIGNMENT', 'START', 'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION',
  'WITHDRAW_FROM_APPROVAL', 'RESUME', 'CANCEL',
] as const;
export type LifecycleCommand = (typeof LIFECYCLE_COMMANDS)[number];
export const JOB_WORKFLOW_ACTIONS = [
  'EDIT_JOB_FIELDS', 'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT',
  'EDIT_MEETING_RESULT', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE',
] as const;
export type JobWorkflowAction = (typeof JOB_WORKFLOW_ACTIONS)[number];
export const SUBMISSION_REQUIREMENT_CODES = [
  'CUSTOMER_ELIGIBLE', 'ASSIGNEE_ELIGIBLE', 'DELIVERY_ITEM_PRESENT',
  'DELIVERY_ITEMS_VALID', 'TASK_TITLE_VALID', 'MEETING_TIME_VALID',
  'MEETING_OUTCOME_VALID', 'MEETING_SUMMARY_PRESENT', 'FOLLOW_UP_TIME_VALID',
] as const;

export type JobCardStatus = (typeof JOB_CARD_STATUSES)[number];
export type JobCardActivityStatus = (typeof JOB_CARD_ACTIVITY_STATUSES)[number];
export type JobCardStatusFilter = (typeof JOB_CARD_STATUS_FILTERS)[number];
export type JobCardPriority = (typeof JOB_CARD_PRIORITIES)[number];
export type DeliveryPurpose = (typeof DELIVERY_PURPOSES)[number];
export type JobCardType = (typeof JOB_CARD_TYPES)[number];
export type JobCardEngagementKind = (typeof JOB_CARD_ENGAGEMENT_KINDS)[number];
export type MeetingOutcome = (typeof MEETING_OUTCOMES)[number];
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
};
export type JobWorkflowContext = {
  allowedCommands: LifecycleCommand[];
  allowedActions: JobWorkflowAction[];
  startLocationCaptureEnabled: boolean;
  lifecycle: JobLifecycleFacts;
  submissionReadiness: SubmissionReadiness | null;
};
export type JobCard = {
  id: string; organizationId: string; type: JobCardType; status: JobCardStatus;
  version: number; title: string; description: string | null; customerId: string | null;
  contactId: string | null; assignedTo: string; createdBy: string; priority: JobCardPriority;
  dueDate: string | null; scheduledAt: string | null;
  engagementKind: JobCardEngagementKind | null;
  assignee: RelatedName;
  customer: RelatedName | null; contact: RelatedName | null; workflowContext: JobWorkflowContext;
};
export type JobCardCreateInput =
  | { clientActionId: string; type: 'PRODUCT_DELIVERY'; title: string; customerId: string;
    assignedTo: string; scheduledAt: string; description?: string | null; contactId?: string | null;
    priority?: JobCardPriority; dueDate?: string | null }
  | { clientActionId: string; type: 'GENERAL_TASK'; title: string; assignedTo: string;
    description?: string | null; customerId?: string | null; contactId?: string | null;
    priority?: JobCardPriority; dueDate?: string | null; scheduledAt?: string | null }
  | { clientActionId: string; type: 'SALES_MEETING'; title: string; customerId: string;
    assignedTo: string; scheduledAt: string; engagementKind: JobCardEngagementKind;
    dueDate?: string | null; description?: string | null;
    contactId?: string | null; priority?: JobCardPriority };
export type PersistedJobCardListItem = {
  id: string; type: JobCardType; status: JobCardStatus; version: number; title: string;
  priority: JobCardPriority; dueDate: string | null; scheduledAt: string | null;
  engagementKind: JobCardEngagementKind | null;
  createdAt: string; updatedAt: string; staffCompletedAt: string | null;
  customer: RelatedName | null; contact: RelatedName | null; assignee: RelatedName;
  deliveryItemCount: number;
};
export type JobCardListItem = PersistedJobCardListItem & {
  allowedCommands: LifecycleCommand[];
};
export type JobCardBoard = {
  columns: Record<'NEW' | 'ACCEPTED' | 'IN_PROGRESS' | 'WAITING_APPROVAL' | 'REVISION_REQUESTED', {
    items: JobCardListItem[]; count: number;
  }>;
  closedCounts: { COMPLETED: number; CANCELLED: number };
};
export type JobCardNote = {
  id: string; jobCardId: string; note: string; author: RelatedName; createdAt: string;
};
export type JobCardActivityDetails =
  | {
      kind: 'STATUS_TRANSITION';
      fromStatus: JobCardActivityStatus;
      toStatus: JobCardActivityStatus;
      reason: string | null;
      startLocation?:
        | { outcome: 'CAPTURED'; approximateLabel: string | null; accuracyMeters: number; capturedAt: string }
        | { outcome: 'UNAVAILABLE'; reason: 'PERMISSION_DENIED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED' | 'UNKNOWN' };
    }
  | { kind: 'FIELDS_UPDATED'; changedFields: Array<'title' | 'description' | 'customer' | 'contact' | 'assignee' | 'priority' | 'dueDate' | 'engagementKind'> }
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
  meetingSummary: string | null; nextFollowUpAt: string | null; jobCardVersion: number;
};
export type PatchMeetingDetailsInput = {
  clientActionId: string; expectedVersion: number; meetingAt?: string | null;
  outcome?: MeetingOutcome | null; meetingSummary?: string | null;
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
  engagementKind?: JobCardEngagementKind;
};

export type JobCardListFilters = Partial<{
  q: string; status: JobCardStatusFilter; type: JobCardType; assignedTo: string;
  customerId: string; priority: JobCardPriority; dueBefore: string; dueAfter: string;
  limit: number; offset: number;
}>;
export type JobCardBoardFilters = Omit<JobCardListFilters, 'status' | 'offset'>;
type DeliveryInput = {
  expectedVersion: number; productId: string; deliveryPurpose: DeliveryPurpose;
  deliveredAt: string | null;
  quantity: number; lotNo?: string | null; serialNo?: string | null; expiryDate?: string | null;
  deliveryNote?: string | null;
};
type LifecycleInput = { clientActionId: string; expectedVersion: number };
export type StartJobCardInput = LifecycleInput & { locationCapture?: StartLocationCapture };

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
function parseLifecycleFacts(value: unknown): JobLifecycleFacts {
  const v = exactObject(value, 'lifecycle', [
    'createdAt', 'acceptedAt', 'acceptedBy', 'startedAt', 'submittedAt', 'submittedBy',
    'submissionNote', 'approvedAt', 'approvedBy', 'approvalNote', 'revisionRequestedAt',
    'revisionRequestedBy', 'revisionReason', 'cancelledAt', 'cancelledBy', 'cancelReason',
    'cancelledFromStatus',
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
function parseJobCard(value: unknown): JobCard {
  const v = object(value);
  const type = oneOf(v.type, 'type', JOB_CARD_TYPES);
  return {
    id: string(v.id, 'id'), organizationId: string(v.organizationId, 'organizationId'),
    type,
    status: oneOf(v.status, 'status', JOB_CARD_STATUSES), version: positiveCount(v.version, 'version'),
    title: string(v.title, 'title'), description: nullableString(v.description, 'description'),
    customerId: nullableString(v.customerId, 'customerId'), contactId: nullableString(v.contactId, 'contactId'),
    assignedTo: string(v.assignedTo, 'assignedTo'), createdBy: string(v.createdBy, 'createdBy'),
    priority: oneOf(v.priority, 'priority', JOB_CARD_PRIORITIES), dueDate: nullableString(v.dueDate, 'dueDate'),
    scheduledAt: nullableCanonicalInstant(v.scheduledAt, 'scheduledAt'),
    engagementKind: parseEngagementKind(v.engagementKind, type),
    assignee: related(v.assignee, 'assignee'), customer: nullableRelated(v.customer, 'customer'),
    contact: nullableRelated(v.contact, 'contact'),
    workflowContext: parseWorkflowContext(v.workflowContext),
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
  return { id: string(v.id, 'id'), jobCardId: string(v.jobCardId, 'jobCardId'), note: string(v.note, 'note'),
    author: related(v.author, 'author'), createdAt: string(v.createdAt, 'createdAt') };
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
          'outcome', 'approximateLabel', 'accuracyMeters', 'capturedAt',
        ]);
        startLocation = {
          outcome,
          approximateLabel: nullableString(captured.approximateLabel, 'approximateLabel'),
          accuracyMeters: positiveFiniteNumber(captured.accuracyMeters, 'accuracyMeters'),
          capturedAt: canonicalInstant(captured.capturedAt, 'capturedAt'),
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
    oneOf(field, 'changedFields', ['title', 'description', 'customer', 'contact', 'assignee', 'priority', 'dueDate', 'engagementKind'] as const)) };
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
export function parseMeetingDetails(value: unknown): MeetingDetails {
  const v = exactObject(value, 'meetingDetails', [
    'jobCardId', 'meetingAt', 'outcome', 'meetingSummary', 'nextFollowUpAt',
    'jobCardVersion',
  ]);
  return {
    jobCardId: string(v.jobCardId, 'jobCardId'),
    meetingAt: nullableCanonicalInstant(v.meetingAt, 'meetingAt'),
    outcome: v.outcome === null ? null : oneOf(v.outcome, 'outcome', MEETING_OUTCOMES),
    meetingSummary: nullableString(v.meetingSummary, 'meetingSummary'),
    nextFollowUpAt: nullableCanonicalInstant(v.nextFollowUpAt, 'nextFollowUpAt'),
    jobCardVersion: positiveCount(v.jobCardVersion, 'jobCardVersion'),
  };
}
function query(filters: Record<string, string | number | undefined>) {
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
export const patchJobCard = async (id: string, input: PatchJobCardInput) =>
  parseJobCard(await request(jobPath(id), json('PATCH', input)));
export const getMeetingDetails = async (id: string) =>
  parseMeetingDetails(await request(`${jobPath(id)}/meeting-details`));
export const patchMeetingDetails = async (id: string, input: PatchMeetingDetailsInput) =>
  parseMeetingDetails(await request(`${jobPath(id)}/meeting-details`, json('PATCH', input)));

export const listJobCardNotes = async (id: string, page: Partial<{ limit: number; offset: number }> = {}) =>
  parsePage(await request(`${jobPath(id)}/notes${query(page)}`), parseNote);
export const addJobCardNote = async (id: string, input: { clientActionId: string; note: string }) =>
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
export const submitJobCardForApproval = (id: string, input: LifecycleInput & { note?: string }) => lifecycle(id, 'submit-for-approval', input);
export const approveJobCard = (id: string, input: LifecycleInput & { note?: string }) => lifecycle(id, 'approve', input);
export const requestJobCardRevision = (id: string, input: LifecycleInput & { revisionReason: string }) => lifecycle(id, 'request-revision', input);
export const withdrawJobCardFromApproval = (id: string, input: LifecycleInput) => lifecycle(id, 'withdraw-from-approval', input);
export const resumeJobCard = (id: string, input: LifecycleInput) => lifecycle(id, 'resume', input);
export const cancelJobCard = (id: string, input: LifecycleInput & { cancelReason: string }) => lifecycle(id, 'cancel', input);
