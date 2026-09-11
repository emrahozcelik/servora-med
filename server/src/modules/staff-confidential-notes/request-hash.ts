import { AppError } from '../../errors/index.js';
import { hashRequestIdentity } from '../job-cards/critical-action-request-hash.js';

/**
 * SSOT for staff confidential-note request identity (B2-NOTE).
 *
 * processed_actions idempotency keys are (organizationId, userId,
 * clientActionId, operationKey) with the operation key already scoped per
 * note subject (`STAFF_CONFIDENTIAL_NOTE_CREATE:<subjectStaffUserId>`). The
 * request hash binds that key to the NORMALIZED SEMANTIC INTENT of the
 * request so the same key can never replay an earlier success for different
 * note content.
 *
 * Rules (mirroring job-cards/critical-action-request-hash.ts):
 * - Hash only the validated/normalized semantic intent: the operation
 *   version tag, the subject staff user id, and the note body AFTER the
 *   mutation's own normalization (boundedTrimmedString). Callers MUST hash
 *   the normalized body actually persisted, never the raw pre-normalization
 *   input, so whitespace-equivalent requests hash identically.
 * - Never hash clientActionId (already part of the uniqueness key), actor
 *   or organization identity (already part of the idempotency address),
 *   generated note ids, timestamps, database/current state, or audit/
 *   realtime results.
 * - The operation version tag lives INSIDE the hash payload; it must never
 *   change processed_actions.operation_key namespaces.
 * - Stored request_hash is a one-way SHA-256 digest; raw note bodies are
 *   never persisted or logged through it.
 */

export const STAFF_CONFIDENTIAL_NOTE_ADD_REQUEST_VERSION = 'STAFF_CONFIDENTIAL_NOTE_ADD:v1';

/** Full normalized confidential-note ADD intent (clientActionId excluded per contract). */
export function confidentialNoteAddRequestHash(
  subjectStaffUserId: string,
  normalizedBody: string,
): string {
  return hashRequestIdentity({
    operation: STAFF_CONFIDENTIAL_NOTE_ADD_REQUEST_VERSION,
    subjectStaffUserId,
    body: normalizedBody,
  });
}

/**
 * Established reused-action contract (canonical equivalent of job-cards'
 * assertCriticalActionRequestHash and calendar's assertCalendarRequestHash):
 * a reused idempotency key whose stored request identity is absent (legacy
 * NULL row) or differs from the caller's semantic request fails closed.
 * Never treats a legacy row as the same request: the original caller intent
 * may not be reconstructable.
 */
export function assertStaffConfidentialNoteRequestHash(
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
