import { createHash } from 'node:crypto';

import type {
  ApproveFollowUpInput,
  FollowUpProposalInput,
  PatchMeetingDetailsInput,
} from './types.js';
import type { StartLocationCapture } from './start-location-input.js';
import type { FollowUpCancelContinuity } from './follow-up-policy.js';
import type { JobActionLocationCapture } from './location-types.js';
import { normalizeExpiryDate } from './delivery-input.js';
import type { SaleApprovalDeliveryInput } from './sale-approval-delivery-input.js';

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
export const EARLY_START_AUTHORIZATION_REQUEST_VERSION = 'EARLY_START_AUTHORIZATION:v1';
export const JOB_CHANGE_REQUEST_CREATE_REQUEST_VERSION = 'JOB_CHANGE_REQUEST_CREATE:v1';
export const JOB_CHANGE_REQUEST_RESOLVE_REQUEST_VERSION = 'JOB_CHANGE_REQUEST_RESOLVE:v1';
export const JOB_ASSIGNMENT_REOFFER_REQUEST_VERSION = 'JOB_ASSIGNMENT_REOFFER:v1';
export const JOB_ASSIGNMENT_ACCEPT_PROPOSAL_REQUEST_VERSION =
  'JOB_ASSIGNMENT_ACCEPT_PROPOSAL:v1';

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
  /** JOB-009; omitted when absent so existing request hashes stay stable. */
  cancelContinuity?: FollowUpCancelContinuity | null;
  /**
   * JOB-010 release 2b: the deferred Staff decline/release reason. Omitted
   * when absent so every pre-2b lifecycle hash stays byte-identical. JOB-012
   * adds the optional proposed time, hashed only when the answer carries one.
   */
  assignmentReason?: {
    code: string;
    text: string;
    proposedScheduledAt?: string | null;
  } | null;
  /**
   * OVR-5b (§3.8): the normalized management correction deadline of a
   * REQUEST_REVISION. Omitted when the client did not send it, so every
   * receipt recorded before this release keeps replaying byte-identically.
   */
  correctionDueAt?: string | null;
  /**
   * SALE-002 §5.4: the normalized sale-approval delivery. Present only when the
   * client sent one, so every hash recorded before S3 stays byte-identical.
   */
  delivery?: SaleApprovalDeliveryInput | null;
};

/**
 * SALE-002 §4.5/§5.4: the delivery payload in canonical form. Item lines keep
 * request order (only product locks are sorted), instants are canonical, the
 * note is trimmed, the purpose is the resolved one. Optional members the
 * client omitted stay omitted (`assignedTo`, `pastStartAcknowledgement`); the
 * key order is fixed because the digest is a JSON string.
 */
function normalizedSaleApprovalDelivery(delivery: SaleApprovalDeliveryInput): unknown {
  return {
    ...(delivery.assignedTo === undefined ? {} : { assignedTo: delivery.assignedTo }),
    scheduledAt: canonicalInstantValue(delivery.scheduledAt),
    scheduledEndsAt: canonicalInstantValue(delivery.scheduledEndsAt),
    deliveryPurpose: delivery.deliveryPurpose,
    note: trimmedTextOrNull(delivery.note),
    items: delivery.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    })),
    ...pastStartAcknowledgementIntent(delivery.pastStartAcknowledgement),
  };
}

/** Present-only member shared by the single and the pair lifecycle identity. */
function saleApprovalDeliveryIntent(
  delivery: SaleApprovalDeliveryInput | null | undefined,
): Record<string, unknown> {
  return delivery === undefined || delivery === null
    ? {}
    : { delivery: normalizedSaleApprovalDelivery(delivery) };
}

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
    ...(identity.cancelContinuity
      ? {
        cancelContinuity: identity.cancelContinuity.decision === 'RESCHEDULE'
          ? { decision: 'RESCHEDULE', scheduledAt: identity.cancelContinuity.scheduledAt }
          : { decision: 'END_CYCLE', endReason: identity.cancelContinuity.endReason },
      }
      : {}),
    ...(identity.assignmentReason
      ? {
        assignmentReason: {
          code: identity.assignmentReason.code,
          text: identity.assignmentReason.text.trim(),
          // JOB-012: present only when the answer proposed a time, so every
          // pre-JOB-012 decline/release hash stays byte-identical.
          ...(identity.assignmentReason.proposedScheduledAt
            ? {
              proposedScheduledAt: canonicalInstantValue(
                identity.assignmentReason.proposedScheduledAt,
              ),
            }
            : {}),
        },
      }
      : {}),
    // OVR-5b (§3.8): present only when the client sent it; absent keeps every
    // pre-5b REQUEST_REVISION hash identical.
    ...(identity.correctionDueAt !== undefined && identity.correctionDueAt !== null
      ? { correctionDueAt: canonicalInstantValue(identity.correctionDueAt) }
      : {}),
    ...saleApprovalDeliveryIntent(identity.delivery),
  });
}

/**
 * SALE-002 §4.5: the coordinated visit+sale request identity. Both cards are
 * part of it — the same `clientActionId` applied to a *different* linked sale,
 * a different expected version, note, proposal or location is a different
 * request (`409 CLIENT_ACTION_REUSED`, never a silent act on the new card).
 *
 * The discriminator is the pair operation (`<PAIR_OPERATION>:v1`), so a pair
 * receipt can never collide with the single-card lifecycle identity of either
 * member card. Optional members are present only when sent, exactly like the
 * sale-create contract: an absent key is not an explicit null.
 */
export type SalePairLifecycleRequestIdentity = {
  /** `JOB_SUBMIT_FOR_APPROVAL_PAIR`, `JOB_APPROVE_PAIR`, ... (§4.5). */
  pairOperation: string;
  visitId: string;
  visitExpectedVersion: number;
  saleId: string;
  saleExpectedVersion: number;
  note: string | null;
  revisionReason: string | null;
  followUpProposal?: FollowUpProposalInput | null;
  /** The manager's approval follow-up override; same normalization as single-card. */
  approveFollowUp?: ApproveFollowUpInput | null;
  locationCapture?: LifecycleLocationCapture | null;
  /**
   * OVR-5b: the REQUEST_REVISION correction deadline. Present-only, so every
   * pair hash recorded without it stays byte-identical.
   */
  correctionDueAt?: string | null;
  /**
   * SALE-002 §5.4: the normalized delivery payload. Present-only, so an S2
   * receipt (no delivery input) keeps replaying byte-identically.
   */
  delivery?: SaleApprovalDeliveryInput | null;
};

export function salePairLifecycleRequestHash(identity: SalePairLifecycleRequestIdentity): string {
  return hashRequestIdentity({
    operation: `${identity.pairOperation}:v1`,
    pairOperation: identity.pairOperation,
    visitId: identity.visitId,
    visitExpectedVersion: identity.visitExpectedVersion,
    saleId: identity.saleId,
    saleExpectedVersion: identity.saleExpectedVersion,
    note: identity.note,
    revisionReason: identity.revisionReason,
    followUpProposal: normalizedProposalIntent(identity.followUpProposal),
    // Present only when sent, so pair hashes recorded before these members
    // existed stay byte-identical (an absent key is not an explicit null).
    ...(identity.approveFollowUp !== undefined && identity.approveFollowUp !== null
      ? { approveFollowUp: normalizedApproveIntent(identity.approveFollowUp) }
      : {}),
    location: normalizedLocationIntent(identity.locationCapture),
    ...(identity.correctionDueAt !== undefined && identity.correctionDueAt !== null
      ? { correctionDueAt: canonicalInstantValue(identity.correctionDueAt) }
      : {}),
    ...saleApprovalDeliveryIntent(identity.delivery),
  });
}

export const MEETING_PATCH_FIELDS = [
  'meetingAt', 'outcome', 'unsuccessfulReason', 'meetingSummary', 'nextFollowUpAt', 'metContactId',
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

/** Normalized past-start acknowledgement: code plus its trimmed mandatory text. */
function normalizedPastStartAcknowledgement(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return { malformed: typeof value };
  const record = value as Record<string, unknown>;
  return {
    code: typeof record.code === 'string' ? record.code : null,
    text: trimmedTextOrNull(record.text),
  };
}

/**
 * JOB-010 release 2b: the acknowledgement participates in the request
 * identity only when it was supplied, so every pre-2b create request hash
 * stays byte-identical.
 */
function pastStartAcknowledgementIntent(value: unknown): Record<string, unknown> {
  const normalized = normalizedPastStartAcknowledgement(value);
  return normalized === null ? {} : { pastStartAcknowledgement: normalized };
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
    ...pastStartAcknowledgementIntent(input.pastStartAcknowledgement),
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
    ...pastStartAcknowledgementIntent(input.pastStartAcknowledgement),
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
    ...pastStartAcknowledgementIntent(input.pastStartAcknowledgement),
    // A follow-up carries delivery intent only when its initial batch was
    // supplied, so every other follow-up request hash (including pre-batch
    // delivery follow-ups in flight) stays byte-identical.
    ...(input.items !== undefined ? {
      deliveryPurpose: input.deliveryPurpose ?? null,
      deliveryNote: input.deliveryNote ?? null,
      items: input.items ?? null,
    } : {}),
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

/** JOB-010 §1a early-start grant: the job and the version it was granted against. */
export function earlyStartAuthorizationRequestHash(
  jobCardId: string,
  expectedVersion: number,
): string {
  return hashRequestIdentity({
    operation: EARLY_START_AUTHORIZATION_REQUEST_VERSION,
    jobCardId,
    expectedVersion,
  });
}

/**
 * JOB-010 release 2a: the normalized request intent (reason code plus the
 * already-trimmed mandatory text). It never touches the JobCard, so the job
 * identity and the intent are the whole request.
 */
export function changeRequestCreateRequestHash(
  jobCardId: string,
  normalized: { reasonCode: string; reasonText: string },
): string {
  return hashRequestIdentity({
    operation: JOB_CHANGE_REQUEST_CREATE_REQUEST_VERSION,
    jobCardId,
    reasonCode: normalized.reasonCode,
    reasonText: normalized.reasonText,
  });
}

/** JOB-010 release 2a: the normalized management decision on one request. */
export function changeRequestResolveRequestHash(
  jobCardId: string,
  changeRequestId: string,
  normalized: {
    resolution: string;
    note: string | null;
    linkedJobCardId: string | null;
  },
): string {
  return hashRequestIdentity({
    operation: JOB_CHANGE_REQUEST_RESOLVE_REQUEST_VERSION,
    jobCardId,
    changeRequestId,
    resolution: normalized.resolution,
    note: normalized.note,
    linkedJobCardId: normalized.linkedJobCardId,
  });
}

/**
 * JOB-010 release 2b: management re-offer intent. The acknowledgement is
 * part of the request identity (a re-offer with a different past-start
 * acknowledgement is a different request).
 */
export function reofferAssignmentRequestHash(
  jobCardId: string,
  expectedVersion: number,
  pastStartAcknowledgement: unknown,
): string {
  return hashRequestIdentity({
    operation: JOB_ASSIGNMENT_REOFFER_REQUEST_VERSION,
    jobCardId,
    expectedVersion,
    pastStartAcknowledgement: normalizedPastStartAcknowledgement(pastStartAcknowledgement),
  });
}

/**
 * JOB-012: management confirms one proposal. The job, the version it was
 * confirmed against and the offer that carries the proposal are the whole
 * request; the proposed instant itself is a persisted fact, not client input.
 */
export function acceptAssignmentProposalRequestHash(
  jobCardId: string,
  expectedVersion: number,
  offerId: string,
): string {
  return hashRequestIdentity({
    operation: JOB_ASSIGNMENT_ACCEPT_PROPOSAL_REQUEST_VERSION,
    jobCardId,
    expectedVersion,
    offerId,
  });
}
