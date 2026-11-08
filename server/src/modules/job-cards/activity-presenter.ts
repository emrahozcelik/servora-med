import type { ActivityRecord } from './repository.js';
import {
  DELIVERY_PURPOSES,
  JOB_CARD_ENGAGEMENT_KINDS,
  JOB_CARD_PRIORITIES,
  JOB_CARD_STATUSES,
  MEETING_DETAIL_FIELDS,
  type DeliveryPurpose,
  type JobCardActivityDetails,
  type JobCardActivityDto,
  type JobCardActivityStatus,
  type JobCardEngagementKind,
  type JobCardPriority,
} from './types.js';

type JsonRecord = Record<string, unknown>;

/** Durable v1 audits retain NUMERIC scale; never round historical fractions. */
function saleCount(value: unknown): string | null {
  return typeof value === 'string' && /^[1-9]\d{0,8}\.000$/.test(value)
    ? value.slice(0, -4) : null;
}

/**
 * Reader gates for response keys that only opted-in bundles understand.
 * `includeSubmitLocationCapability` gates the Slice 2 comparison evidence;
 * `includeMetContactCapability` gates the Slice 3 met-contact chip on meeting
 * activity, because previous bundles reject unknown changed-field names.
 */
export type ActivityPresentationOptions = {
  includeSaleCapability?: boolean;
  includeSubmitLocationCapability?: boolean;
  includeMetContactCapability?: boolean;
};
type LifecycleEvent =
  | 'JOB_PLANNED'
  | 'JOB_ACCEPTED'
  | 'JOB_STARTED'
  | 'JOB_SUBMITTED_FOR_APPROVAL'
  | 'JOB_APPROVED'
  | 'JOB_REVISION_REQUESTED'
  | 'JOB_APPROVAL_WITHDRAWN'
  | 'JOB_RESUMED'
  | 'JOB_CANCELLED'
  | 'JOB_INVALIDATED';

const ACTIVITY_STATUSES: readonly JobCardActivityStatus[] = [...JOB_CARD_STATUSES, 'PLANNED'];

const LIFECYCLE_TRANSITIONS: Record<
  LifecycleEvent,
  ReadonlyArray<readonly [JobCardActivityStatus, JobCardActivityStatus]>
> = {
  JOB_PLANNED: [['NEW', 'PLANNED']],
  JOB_ACCEPTED: [['NEW', 'ACCEPTED']],
  JOB_STARTED: [['ACCEPTED', 'IN_PROGRESS'], ['PLANNED', 'IN_PROGRESS']],
  JOB_SUBMITTED_FOR_APPROVAL: [['IN_PROGRESS', 'WAITING_APPROVAL']],
  JOB_APPROVED: [['WAITING_APPROVAL', 'COMPLETED']],
  JOB_REVISION_REQUESTED: [['WAITING_APPROVAL', 'REVISION_REQUESTED']],
  JOB_APPROVAL_WITHDRAWN: [['WAITING_APPROVAL', 'IN_PROGRESS']],
  JOB_RESUMED: [['REVISION_REQUESTED', 'IN_PROGRESS']],
  JOB_CANCELLED: [
    ['NEW', 'CANCELLED'],
    ['ACCEPTED', 'CANCELLED'],
    ['PLANNED', 'CANCELLED'],
    ['IN_PROGRESS', 'CANCELLED'],
    ['REVISION_REQUESTED', 'CANCELLED'],
    ['WAITING_APPROVAL', 'CANCELLED'],
  ],
  JOB_INVALIDATED: [
    ['NEW', 'INVALIDATED'],
    ['ACCEPTED', 'INVALIDATED'],
    ['IN_PROGRESS', 'INVALIDATED'],
    ['WAITING_APPROVAL', 'INVALIDATED'],
    ['REVISION_REQUESTED', 'INVALIDATED'],
    ['COMPLETED', 'INVALIDATED'],
    ['CANCELLED', 'INVALIDATED'],
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
  ['scheduledAt', 'scheduledAt'],
  ['scheduledEndsAt', 'scheduledEndsAt'],
  ['engagementKind', 'engagementKind'],
] as const;

function jsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function isStatus(value: unknown): value is JobCardActivityStatus {
  return ACTIVITY_STATUSES.includes(value as JobCardActivityStatus);
}

function validFieldValue(field: string, value: unknown) {
  if (field === 'priority') return JOB_CARD_PRIORITIES.includes(value as JobCardPriority);
  if (field === 'engagementKind') {
    return JOB_CARD_ENGAGEMENT_KINDS.includes(value as JobCardEngagementKind);
  }
  if (field === 'description' || field === 'customerId' || field === 'contactId'
    || field === 'dueDate') return value === null || typeof value === 'string';
  return typeof value === 'string';
}

function statusDetails(
  eventType: LifecycleEvent,
  oldValue: unknown,
  newValue: unknown,
  metadata: unknown,
  startLocation: ActivityRecord['startLocation'],
  options?: { includeSubmitLocationCapability?: boolean },
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
  const safeStartLocation = eventType === 'JOB_STARTED' && startLocation != null
    ? startLocation.outcome === 'CAPTURED'
      ? {
          outcome: 'CAPTURED' as const,
          approximateLabel: startLocation.approximateLabel,
          accuracyMeters: startLocation.accuracyMeters,
          capturedAt: startLocation.capturedAt.toISOString(),
          geocodingProvider: startLocation.geocodingProvider === 'GOOGLE'
            ? 'GOOGLE' as const
            : null,
        }
      : { outcome: 'UNAVAILABLE' as const, reason: startLocation.reason }
    : undefined;
  // Slice 1: the SUBMIT snapshot reuses the START privacy boundary (no raw
  // coordinates) and presentation shape under its own key. No comparison.
  const safeSubmitLocation = eventType === 'JOB_SUBMITTED_FOR_APPROVAL' && startLocation != null
    ? startLocation.outcome === 'CAPTURED'
      ? {
          outcome: 'CAPTURED' as const,
          approximateLabel: startLocation.approximateLabel,
          accuracyMeters: startLocation.accuracyMeters,
          capturedAt: startLocation.capturedAt.toISOString(),
          geocodingProvider: startLocation.geocodingProvider === 'GOOGLE'
            ? 'GOOGLE' as const
            : null,
        }
      : { outcome: 'UNAVAILABLE' as const, reason: startLocation.reason }
    : undefined;
  return {
    kind: 'STATUS_TRANSITION',
    fromStatus: oldRecord.status,
    toStatus: newRecord.status,
    reason,
    ...(safeStartLocation ? { startLocation: safeStartLocation } : {}),
    ...(safeSubmitLocation ? { submitLocation: safeSubmitLocation } : {}),
    // Slice 2: advisory comparison rides the gated reader contract like the
    // SUBMIT capability flag. Omitted without opt-in so previous bundles
    // keep parsing activity details; reference identity stays server-side.
    ...(options?.includeSubmitLocationCapability
      && eventType === 'JOB_SUBMITTED_FOR_APPROVAL'
      && startLocation?.outcome === 'CAPTURED'
      && startLocation.comparison
      ? {
          submitComparison: {
            outcome: startLocation.comparison.outcome,
            distanceMeters: startLocation.comparison.distanceMeters,
          },
        }
      : {}),
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

function meetingDetails(
  metadata: unknown,
  options?: ActivityPresentationOptions,
): JobCardActivityDetails {
  const record = jsonRecord(metadata);
  if (!record || !Array.isArray(record.changedFields)) return { kind: 'NONE' };
  const persisted = new Set(record.changedFields.filter(
    (field): field is (typeof MEETING_DETAIL_FIELDS)[number] =>
      MEETING_DETAIL_FIELDS.includes(field as (typeof MEETING_DETAIL_FIELDS)[number]),
  ));
  // Slice 3 reader gate: the met-contact chip is only serialized for readers
  // that opt in. An event whose only change was the met contact degrades to a
  // plain fact for previous bundles instead of an unknown field name.
  const changedFields = MEETING_DETAIL_FIELDS.filter((field) => persisted.has(field)
    && (options?.includeMetContactCapability === true || field !== 'metContactId'));
  return changedFields.length > 0
    ? { kind: 'MEETING_DETAILS', changedFields }
    : { kind: 'NONE' };
}

function details(
  record: ActivityRecord,
  options?: ActivityPresentationOptions,
): JobCardActivityDetails {
  switch (record.eventType) {
    case 'SALE_FROM_VISIT_CREATED':
      // Related-card identities are independently scoped by the relation reader.
      return options?.includeSaleCapability ? { kind: 'SALE_RELATION' } : { kind: 'NONE' };
    case 'SALE_DETAILS_UPDATED':
      if (!options?.includeSaleCapability) return { kind: 'NONE' };
      return { kind: 'SALE_DETAILS', changedFields: [
        ...(jsonRecord(record.oldValue)?.soldAt !== jsonRecord(record.newValue)?.soldAt ? ['soldAt' as const] : []),
        ...(jsonRecord(record.oldValue)?.saleContactId !== jsonRecord(record.newValue)?.saleContactId ? ['saleContact' as const] : []),
      ] };
    case 'SALE_ITEM_ADDED':
    case 'SALE_ITEM_UPDATED':
    case 'SALE_ITEM_REMOVED': {
      if (!options?.includeSaleCapability) return { kind: 'NONE' };
      const value = jsonRecord(record.eventType === 'SALE_ITEM_REMOVED' ? record.oldValue : record.newValue);
      const quantity = saleCount(value?.quantity);
      if (!value || typeof value.id !== 'string' || typeof value.productNameSnapshot !== 'string'
        || quantity === null) return { kind: 'NONE' };
      const previous = jsonRecord(record.oldValue)?.quantity;
      return { kind: 'SALE_ITEM', operation: record.eventType === 'SALE_ITEM_ADDED' ? 'ADDED'
        : record.eventType === 'SALE_ITEM_UPDATED' ? 'UPDATED' : 'REMOVED',
        itemId: value.id, productName: value.productNameSnapshot, quantity,
        previousQuantity: saleCount(previous) };
    }
    case 'JOB_CREATED':
    case 'WEEKLY_REPORT_REMOVED': return { kind: 'NONE' };
    // OVR-4 reminder facts carry their semantics in metadata (incident,
    // episode, target, sentAt); the timeline renders them as plain facts.
    case 'JOB_SUBMISSION_REMINDER_SENT':
    case 'JOB_SUBMISSION_AUTO_REMINDER_SENT':
    case 'JOB_SUBMISSION_AUTO_ESCALATION_SENT':
      return { kind: 'NONE' };
    case 'JOB_ASSIGNED':
    case 'JOB_FIELDS_UPDATED':
      return fieldDetails(record.eventType, record.oldValue, record.newValue);
    case 'JOB_PLANNED':
    case 'JOB_ACCEPTED':
    case 'JOB_STARTED':
    case 'JOB_SUBMITTED_FOR_APPROVAL':
    case 'JOB_APPROVED':
    case 'JOB_REVISION_REQUESTED':
    case 'JOB_APPROVAL_WITHDRAWN':
    case 'JOB_RESUMED':
    case 'JOB_CANCELLED':
    case 'JOB_INVALIDATED':
      return statusDetails(
        record.eventType,
        record.oldValue,
        record.newValue,
        record.metadata,
        record.startLocation,
        options,
      );
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
      return meetingDetails(record.metadata, options);
  }
}

export function presentActivity(
  record: ActivityRecord,
  options?: ActivityPresentationOptions,
): JobCardActivityDto {
  return {
    id: record.id,
    jobCardId: record.jobCardId,
    eventType: record.eventType,
    actor: record.actorId !== null && typeof record.actorName === 'string'
      ? { id: record.actorId, name: record.actorName }
      : null,
    details: details(record, options),
    createdAt: record.createdAt.toISOString(),
  };
}
