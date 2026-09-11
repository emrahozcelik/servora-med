import { AppError } from '../../errors/index.js';
import { hashRequestIdentity } from '../job-cards/critical-action-request-hash.js';
import type {
  ManualEventCancelInput,
  ManualEventCreateInput,
  ManualEventPatchInput,
} from './types.js';

/**
 * SSOT for manual calendar-event request identity (B2-CAL).
 *
 * calendar_event_activity_logs idempotency keys are (organizationId,
 * actorUserId, clientActionId, action). The request hash binds that key to the
 * NORMALIZED SEMANTIC INTENT of the caller's request so the same key can never
 * replay an earlier success for different request content.
 *
 * Rules (mirroring job-cards/critical-action-request-hash.ts):
 * - Hash only validated client request intent (validated/normalized values:
 *   trimmed strings, canonical ISO instants, normalized nulls).
 * - Never hash clientActionId (already part of the uniqueness key),
 *   server-generated timestamps, database/current state, resulting versions,
 *   or notification/realtime state.
 * - expectedVersion IS semantic for PATCH/CANCEL; the target eventId IS
 *   semantic for PATCH/CANCEL.
 * - For PATCH, field presence is semantic: omitted fields stay absent from the
 *   payload while explicitly supplied values (including null) are hashed.
 *   Callers MUST hash the caller's original patch BEFORE
 *   preserveManualEventDuration derives endsAt from persisted state.
 * - The operation version tag lives INSIDE the hash payload.
 * - Stored request_hash is a one-way SHA-256 digest; raw titles/reasons are
 *   never persisted or logged through it.
 */

export const MANUAL_EVENT_CREATE_REQUEST_VERSION = 'MANUAL_EVENT_CREATE:v1';
export const MANUAL_EVENT_PATCH_REQUEST_VERSION = 'MANUAL_EVENT_PATCH:v1';
export const MANUAL_EVENT_CANCEL_REQUEST_VERSION = 'MANUAL_EVENT_CANCEL:v1';

/** Explicit patch fields in stable order; presence is part of the identity. */
export const MANUAL_EVENT_PATCH_FIELDS = [
  'assignedUserId',
  'title',
  'description',
  'startsAt',
  'endsAt',
  'timezone',
] as const;

/** Full normalized manual-event create intent (clientActionId excluded per contract). */
export function manualEventCreateRequestHash(input: ManualEventCreateInput): string {
  return hashRequestIdentity({
    operation: MANUAL_EVENT_CREATE_REQUEST_VERSION,
    assignedUserId: input.assignedUserId,
    title: input.title,
    description: input.description,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    timezone: input.timezone,
  });
}

/**
 * Canonical representation of the EXPLICIT manual-event patch. Field presence
 * is semantic: omitted fields are absent while explicitly-set values
 * (including null) are serialized. Values are already normalized by
 * parseManualEventPatch. Pass the caller's original input, never the
 * duration-preserved form.
 */
export function manualEventPatchRequestHash(
  eventId: string,
  input: ManualEventPatchInput,
): string {
  const patch: Record<string, unknown> = {};
  for (const field of MANUAL_EVENT_PATCH_FIELDS) {
    if (Object.hasOwn(input, field)) patch[field] = input[field];
  }
  return hashRequestIdentity({
    operation: MANUAL_EVENT_PATCH_REQUEST_VERSION,
    eventId,
    expectedVersion: input.expectedVersion,
    patch,
  });
}

export function manualEventCancelRequestHash(
  eventId: string,
  input: ManualEventCancelInput,
): string {
  return hashRequestIdentity({
    operation: MANUAL_EVENT_CANCEL_REQUEST_VERSION,
    eventId,
    expectedVersion: input.expectedVersion,
    cancelReason: input.cancelReason,
  });
}

/**
 * Established reused-action contract (canonical equivalent of job-cards'
 * assertCriticalActionRequestHash): a reused idempotency key whose stored
 * request identity is absent (legacy NULL row) or differs from the caller's
 * semantic request fails closed. Never treats a legacy row as the same
 * request: the original caller intent may not be reconstructable.
 */
export function assertCalendarRequestHash(
  expected: string,
  stored: string | null | undefined,
) {
  if (stored !== expected) {
    throw new AppError(
      'CLIENT_ACTION_REUSED',
      409,
      'clientActionId farklı bir işlem içeriğiyle yeniden kullanılamaz.',
    );
  }
}
