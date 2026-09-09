import { createHash } from 'node:crypto';

import type {
  ApproveFollowUpInput,
  FollowUpProposalInput,
  PatchMeetingDetailsInput,
} from './types.js';
import type { StartLocationCapture } from './start-location-input.js';
import type { JobActionLocationCapture } from './location-types.js';
import { normalizeExpiryDate } from './delivery-input.js';

/** Resolved captures carry provider metadata; request identity reads core fields only. */
export type LifecycleLocationCapture = StartLocationCapture | JobActionLocationCapture;

/**
 * SSOT for JobCard critical-action request identity.
 *
 * processed_actions idempotency keys are (organizationId, userId,
 * clientActionId, operationKey). The request hash binds that key to the
 * NORMALIZED SEMANTIC INTENT of the request so the same key can never replay
 * a completed result for different request content (audit AUDIT-0).
 *
 * Rules:
 * - Hash only client request intent that has been normalized with the same
 *   parsers/normalizers the mutation itself applies (trimmed strings,
 *   canonical ISO instants, normalized nulls).
 * - Never hash clientActionId (already part of the uniqueness key),
 *   requestTime, generated UUIDs, database state, server-derived timestamps,
 *   reverse-geocoder/provider output, or auto-resolved proposal slots.
 * - The operation version tag lives INSIDE the hash payload; it must never
 *   change processed_actions.operation_key namespaces.
 * - Stored request_hash is a one-way SHA-256 digest; raw notes/reasons/
 *   coordinates are never persisted or logged through it.
 */

export const JOB_CARD_CREATE_REQUEST_VERSION = 'JOB_CARD_CREATE:v1';
export const PRODUCT_DELIVERY_CREATE_REQUEST_VERSION = 'PRODUCT_DELIVERY_CREATE:v1';
export const JOB_FOLLOW_UP_CREATE_REQUEST_VERSION = 'JOB_FOLLOW_UP_CREATE:v1';
export const MEETING_DETAILS_UPDATE_REQUEST_VERSION = 'MEETING_DETAILS_UPDATE:v1';
export const DELIVERY_ITEM_CREATE_REQUEST_VERSION = 'DELIVERY_ITEM_CREATE:v1';
export const JOB_NOTE_ADD_REQUEST_VERSION = 'JOB_NOTE_ADD:v1';
export const JOB_CARD_LIFECYCLE_REQUEST_VERSION = 'JOB_CARD_LIFECYCLE:v1';

/** Deterministic one-way digest of an explicitly ordered identity object. */
export function hashRequestIdentity(identity: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** Best-effort canonical instant: never throws; invalid values stay raw. */
function canonicalInstantValue(value: unknown): unknown {
  if (value instanceof Date) {
    return Number.isNaN(value.valueOf()) ? String(value) : value.toISOString();
  }
  if (typeof value !== 'string' || value === '') return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
}

function trimmedTextOrNull(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  return value.trim() || null;
}

/**
 * Normalized follow-up proposal intent. `scheduledAt` absence is semantic
 * (system auto-scheduling) and hashed as the stable 'AUTO' marker; the
 * auto-resolved slot itself is database-dependent and never hashed.
 */
function normalizedProposalIntent(
  proposal: FollowUpProposalInput | undefined | null,
): unknown {
  if (proposal === undefined || proposal === null) return null;
  if (typeof proposal !== 'object') return { malformed: typeof proposal };
  return {
    scheduledAt: proposal.scheduledAt === undefined
      ? 'AUTO'
      : canonicalInstantValue(proposal.scheduledAt),
    type: typeof proposal.type === 'string' ? proposal.type : null,
    assignedTo: typeof proposal.assignedTo === 'string' ? proposal.assignedTo : null,
    followUpInstructions: trimmedTextOrNull(proposal.followUpInstructions),
  };
}

/** Normalized manager approval follow-up intent. */
function normalizedApproveIntent(
  followUp: ApproveFollowUpInput | undefined | null,
): unknown {
  if (followUp === undefined || followUp === null) return null;
  if (typeof followUp !== 'object') return { malformed: typeof followUp };
  const base = normalizedProposalIntent(followUp) as Record<string, unknown> | null;
  if (base === null || base.malformed !== undefined) return base;
  return {
    ...base,
    // normalizePriority treats undefined as 'normal'; dueDate undefined and
    // null both normalize to null.
    priority: typeof followUp.priority === 'string' ? followUp.priority : 'normal',
    dueDate: canonicalInstantValue(followUp.dueDate ?? null),
    overrideReason: trimmedTextOrNull(followUp.overrideReason),
  };
}

/**
 * Normalized START location-capture intent. Core capture semantics only:
 * reverse-geocoder output and provider metadata are execution results and
 * never participate in request identity.
 */
function normalizedLocationIntent(
  capture: LifecycleLocationCapture | null | undefined,
): unknown {
  if (capture === null || capture === undefined) return null;
  if (capture.outcome === 'CAPTURED') {
    return {
      outcome: 'CAPTURED',
      latitude: capture.latitude,
      longitude: capture.longitude,
      accuracyMeters: capture.accuracyMeters,
      capturedAt: canonicalInstantValue(capture.capturedAt),
    };
  }
  return { outcome: 'UNAVAILABLE', reason: capture.reason };
}

export type LifecycleRequestIdentity = {
  command: string;
  jobCardId: string;
  expectedVersion: number;
  note: string | null;
  revisionReason: string | null;
  cancelReason: string | null;
  followUpProposal?: FollowUpProposalInput | null;
  approveFollowUp?: ApproveFollowUpInput | null;
  locationCapture?: LifecycleLocationCapture | null;
};

export function lifecycleRequestHash(identity: LifecycleRequestIdentity): string {
  return hashRequestIdentity({
    operation: JOB_CARD_LIFECYCLE_REQUEST_VERSION,
    jobCardId: identity.jobCardId,
    command: identity.command,
    expectedVersion: identity.expectedVersion,
    note: identity.note,
    revisionReason: identity.revisionReason,
    cancelReason: identity.cancelReason,
    followUpProposal: normalizedProposalIntent(identity.followUpProposal),
    approveFollowUp: normalizedApproveIntent(identity.approveFollowUp),
    location: normalizedLocationIntent(identity.locationCapture),
  });
}

export const MEETING_PATCH_FIELDS = [
  'meetingAt', 'outcome', 'unsuccessfulReason', 'meetingSummary', 'nextFollowUpAt',
] as const;

/**
 * Canonical representation of the EXPLICIT meeting-details patch. Field
 * presence is semantic: omitted fields are absent from the payload while
 * explicitly-set values (including null) are serialized. Values are already
 * normalized by parseMeetingDetailsPatch.
 */
export function meetingDetailsUpdateRequestHash(
  jobCardId: string,
  input: PatchMeetingDetailsInput,
): string {
  const patch: Record<string, unknown> = {};
  for (const field of MEETING_PATCH_FIELDS) {
    if (Object.hasOwn(input, field)) patch[field] = input[field];
  }
  return hashRequestIdentity({
    operation: MEETING_DETAILS_UPDATE_REQUEST_VERSION,
    jobCardId,
    expectedVersion: input.expectedVersion,
    patch,
  });
}

export function noteAddRequestHash(
  jobCardId: string,
  normalized: { note: string; invoiceNumber: string | null },
): string {
  return hashRequestIdentity({
    operation: JOB_NOTE_ADD_REQUEST_VERSION,
    jobCardId,
    note: normalized.note,
    invoiceNumber: normalized.invoiceNumber,
  });
}

/** Full normalized JobCard create intent (clientActionId excluded per contract). */
export function jobCardCreateRequestHash(input: Record<string, unknown>): string {
  return hashRequestIdentity({
    operation: JOB_CARD_CREATE_REQUEST_VERSION,
    type: input.type,
    title: input.title,
    description: input.description ?? null,
    customerId: input.customerId ?? null,
    contactId: input.contactId ?? null,
    assignedTo: input.assignedTo ?? null,
    priority: input.priority,
    dueDate: input.dueDate ?? null,
    scheduledAt: input.scheduledAt ?? null,
    scheduledEndsAt: input.scheduledEndsAt ?? null,
    engagementKind: input.engagementKind ?? null,
    overrideReason: input.overrideReason ?? null,
  });
}

export function productDeliveryCreateRequestHash(input: Record<string, unknown>): string {
  return hashRequestIdentity({
    operation: PRODUCT_DELIVERY_CREATE_REQUEST_VERSION,
    type: input.type,
    title: input.title,
    description: input.description ?? null,
    customerId: input.customerId ?? null,
    contactId: input.contactId ?? null,
    assignedTo: input.assignedTo ?? null,
    priority: input.priority,
    dueDate: input.dueDate ?? null,
    scheduledAt: input.scheduledAt ?? null,
    scheduledEndsAt: input.scheduledEndsAt ?? null,
    overrideReason: input.overrideReason ?? null,
    deliveryPurpose: input.deliveryPurpose,
    deliveryNote: input.deliveryNote ?? null,
    items: input.items,
  });
}

export function followUpCreateRequestHash(
  sourceJobCardId: string,
  input: Record<string, unknown>,
): string {
  return hashRequestIdentity({
    operation: JOB_FOLLOW_UP_CREATE_REQUEST_VERSION,
    sourceJobCardId,
    type: input.type,
    title: input.title,
    followUpInstructions: input.followUpInstructions,
    scheduledAt: input.scheduledAt ?? null,
    assignedTo: input.assignedTo ?? null,
    priority: input.priority,
    dueDate: input.dueDate ?? null,
    contactId: input.contactId ?? null,
    engagementKind: input.engagementKind ?? null,
    overrideReason: input.overrideReason ?? null,
  });
}

/**
 * Normalized delivery-item create intent. Mirrors the exact normalization
 * deliveryRecord applies (deliveredAt → canonical Date, lot/serial/note
 * trimmed-or-null, canonical expiryDate-or-null) so semantically
 * equivalent requests hash identically.
 */
export function deliveryItemCreateRequestHash(
  jobCardId: string,
  input: Record<string, unknown>,
): string {
  const deliveredAt = input.deliveredAt ?? null;
  return hashRequestIdentity({
    operation: DELIVERY_ITEM_CREATE_REQUEST_VERSION,
    jobCardId,
    expectedVersion: input.expectedVersion,
    productId: input.productId,
    deliveryPurpose: input.deliveryPurpose,
    deliveredAt: deliveredAt === null ? null : canonicalInstantValue(deliveredAt),
    quantity: input.quantity,
    lotNo: trimmedTextOrNull(input.lotNo),
    serialNo: trimmedTextOrNull(input.serialNo),
    expiryDate: normalizeExpiryDate(input.expiryDate),
    deliveryNote: trimmedTextOrNull(input.deliveryNote),
  });
}
