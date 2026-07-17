import type { ActivityRecord } from './repository.js';
import {
  DELIVERY_PURPOSES,
  JOB_CARD_PRIORITIES,
  JOB_CARD_STATUSES,
  MEETING_DETAIL_FIELDS,
  type DeliveryPurpose,
  type JobCardActivityDetails,
  type JobCardActivityDto,
  type JobCardPriority,
  type JobCardStatus,
} from './types.js';

type JsonRecord = Record<string, unknown>;
type LifecycleEvent =
  | 'JOB_PLANNED'
  | 'JOB_STARTED'
  | 'JOB_SUBMITTED_FOR_APPROVAL'
  | 'JOB_APPROVED'
  | 'JOB_REVISION_REQUESTED'
  | 'JOB_APPROVAL_WITHDRAWN'
  | 'JOB_RESUMED'
  | 'JOB_CANCELLED';

const LIFECYCLE_TRANSITIONS: Record<LifecycleEvent, ReadonlyArray<readonly [JobCardStatus, JobCardStatus]>> = {
  JOB_PLANNED: [['NEW', 'PLANNED']],
  JOB_STARTED: [['NEW', 'IN_PROGRESS'], ['PLANNED', 'IN_PROGRESS']],
  JOB_SUBMITTED_FOR_APPROVAL: [['IN_PROGRESS', 'WAITING_APPROVAL']],
  JOB_APPROVED: [['WAITING_APPROVAL', 'COMPLETED']],
  JOB_REVISION_REQUESTED: [['WAITING_APPROVAL', 'REVISION_REQUESTED']],
  JOB_APPROVAL_WITHDRAWN: [['WAITING_APPROVAL', 'IN_PROGRESS']],
  JOB_RESUMED: [['REVISION_REQUESTED', 'IN_PROGRESS']],
  JOB_CANCELLED: [
    ['NEW', 'CANCELLED'],
    ['PLANNED', 'CANCELLED'],
    ['IN_PROGRESS', 'CANCELLED'],
    ['REVISION_REQUESTED', 'CANCELLED'],
    ['WAITING_APPROVAL', 'CANCELLED'],
  ],
};

const FIELD_MAPPINGS = [
  ['title', 'title'],
  ['description', 'description'],
  ['customerId', 'customer'],
  ['contactId', 'contact'],
  ['assignedTo', 'assignee'],
  ['priority', 'priority'],
  ['dueDate', 'dueDate'],
] as const;

function jsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function isStatus(value: unknown): value is JobCardStatus {
  return JOB_CARD_STATUSES.includes(value as JobCardStatus);
}

function validFieldValue(field: string, value: unknown) {
  if (field === 'priority') return JOB_CARD_PRIORITIES.includes(value as JobCardPriority);
  if (field === 'description' || field === 'customerId' || field === 'contactId'
    || field === 'dueDate') return value === null || typeof value === 'string';
  return typeof value === 'string';
}

function statusDetails(
  eventType: LifecycleEvent,
  oldValue: unknown,
  newValue: unknown,
  metadata: unknown,
): JobCardActivityDetails {
  const oldRecord = jsonRecord(oldValue);
  const newRecord = jsonRecord(newValue);
  if (!oldRecord || !newRecord || !isStatus(oldRecord.status) || !isStatus(newRecord.status)) {
    return { kind: 'NONE' };
  }
  if (!LIFECYCLE_TRANSITIONS[eventType]
    .some(([fromStatus, toStatus]) => fromStatus === oldRecord.status && toStatus === newRecord.status)) {
    return { kind: 'NONE' };
  }
  const metadataRecord = jsonRecord(metadata);
  const reason = (eventType === 'JOB_REVISION_REQUESTED' || eventType === 'JOB_CANCELLED')
    && typeof metadataRecord?.reason === 'string' && metadataRecord.reason.trim()
    ? metadataRecord.reason.trim()
    : null;
  return {
    kind: 'STATUS_TRANSITION',
    fromStatus: oldRecord.status,
    toStatus: newRecord.status,
    reason,
  };
}

function fieldDetails(eventType: ActivityRecord['eventType'], oldValue: unknown, newValue: unknown): JobCardActivityDetails {
  const oldRecord = jsonRecord(oldValue);
  const newRecord = jsonRecord(newValue);
  if (!oldRecord || !newRecord) return { kind: 'NONE' };
  if (eventType === 'JOB_ASSIGNED') {
    return typeof oldRecord.assignedTo === 'string' && typeof newRecord.assignedTo === 'string'
      ? { kind: 'FIELDS_UPDATED', changedFields: ['assignee'] }
      : { kind: 'NONE' };
  }
  const changedFields: Array<(typeof FIELD_MAPPINGS)[number][1]> = [];
  for (const [internal, publicName] of FIELD_MAPPINGS) {
    if (!(internal in oldRecord) && !(internal in newRecord)) continue;
    if (!(internal in oldRecord) || !(internal in newRecord)
      || !validFieldValue(internal, oldRecord[internal])
      || !validFieldValue(internal, newRecord[internal])) return { kind: 'NONE' };
    changedFields.push(publicName);
  }
  return changedFields.length > 0 ? { kind: 'FIELDS_UPDATED', changedFields } : { kind: 'NONE' };
}

function deliveryDetails(
  eventType: 'DELIVERY_ITEM_ADDED' | 'DELIVERY_ITEM_UPDATED' | 'DELIVERY_ITEM_REMOVED',
  oldValue: unknown,
  newValue: unknown,
): JobCardActivityDetails {
  const value = jsonRecord(eventType === 'DELIVERY_ITEM_REMOVED' ? oldValue : newValue);
  if (!value || typeof value.itemId !== 'string' || !value.itemId.trim()
    || typeof value.quantity !== 'number' || !Number.isFinite(value.quantity)
    || value.quantity <= 0) {
    return { kind: 'NONE' };
  }
  let purpose: DeliveryPurpose | null = null;
  if (value.deliveryPurpose === undefined) {
    if (eventType !== 'DELIVERY_ITEM_REMOVED') return { kind: 'NONE' };
  } else {
    if (!DELIVERY_PURPOSES.includes(value.deliveryPurpose as DeliveryPurpose)) return { kind: 'NONE' };
    purpose = value.deliveryPurpose as DeliveryPurpose;
  }
  const operation = eventType === 'DELIVERY_ITEM_ADDED'
    ? 'ADDED' : eventType === 'DELIVERY_ITEM_UPDATED' ? 'UPDATED' : 'REMOVED';
  return {
    kind: 'DELIVERY_ITEM', operation, itemId: value.itemId,
    purpose, quantity: value.quantity,
  };
}

function meetingDetails(metadata: unknown): JobCardActivityDetails {
  const record = jsonRecord(metadata);
  if (!record || !Array.isArray(record.changedFields)) return { kind: 'NONE' };
  const persisted = new Set(record.changedFields.filter(
    (field): field is (typeof MEETING_DETAIL_FIELDS)[number] =>
      MEETING_DETAIL_FIELDS.includes(field as (typeof MEETING_DETAIL_FIELDS)[number]),
  ));
  const changedFields = MEETING_DETAIL_FIELDS.filter((field) => persisted.has(field));
  return changedFields.length > 0
    ? { kind: 'MEETING_DETAILS', changedFields }
    : { kind: 'NONE' };
}

function details(record: ActivityRecord): JobCardActivityDetails {
  switch (record.eventType) {
    case 'JOB_CREATED': return { kind: 'NONE' };
    case 'JOB_ASSIGNED':
    case 'JOB_FIELDS_UPDATED':
      return fieldDetails(record.eventType, record.oldValue, record.newValue);
    case 'JOB_PLANNED':
    case 'JOB_STARTED':
    case 'JOB_SUBMITTED_FOR_APPROVAL':
    case 'JOB_APPROVED':
    case 'JOB_REVISION_REQUESTED':
    case 'JOB_APPROVAL_WITHDRAWN':
    case 'JOB_RESUMED':
    case 'JOB_CANCELLED':
      return statusDetails(record.eventType, record.oldValue, record.newValue, record.metadata);
    case 'DELIVERY_ITEM_ADDED':
    case 'DELIVERY_ITEM_UPDATED':
    case 'DELIVERY_ITEM_REMOVED':
      return deliveryDetails(record.eventType, record.oldValue, record.newValue);
    case 'NOTE_ADDED': {
      const metadata = jsonRecord(record.metadata);
      return metadata && typeof metadata.noteId === 'string' && metadata.noteId.trim()
        ? { kind: 'NOTE', noteId: metadata.noteId }
        : { kind: 'NONE' };
    }
    case 'MEETING_DETAILS_UPDATED':
      return meetingDetails(record.metadata);
  }
}

export function presentActivity(record: ActivityRecord): JobCardActivityDto {
  return {
    id: record.id,
    jobCardId: record.jobCardId,
    eventType: record.eventType,
    actor: record.actorId !== null && typeof record.actorName === 'string'
      ? { id: record.actorId, name: record.actorName }
      : null,
    details: details(record),
    createdAt: record.createdAt.toISOString(),
  };
}
