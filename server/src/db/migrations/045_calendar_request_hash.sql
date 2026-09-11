-- B2-CAL: bind calendar manual-event idempotency keys to the caller's semantic
-- request. The (organization_id, actor_user_id, client_action_id, action) key
-- alone cannot distinguish a retry from a reused key with changed target,
-- payload, or expectedVersion, so each processed action now stores a SHA-256
-- digest of its normalized semantic intent (see
-- server/src/modules/calendar/request-hash.ts).
--
-- Nullable for backward compatibility: rows predating request identity carry
-- NULL and MUST fail closed as CLIENT_ACTION_REUSED on replay lookup. Never
-- backfill hashes from resulting calendar state; the original caller request
-- may not be reconstructable.

ALTER TABLE calendar_event_activity_logs
  ADD COLUMN request_hash VARCHAR(64) NULL,
  ADD CONSTRAINT calendar_event_activity_logs_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
