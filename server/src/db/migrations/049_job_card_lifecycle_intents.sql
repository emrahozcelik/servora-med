-- Durable lifecycle reservations. Business time is sampled under the JobCard lock.
-- Identity and reservation timestamps never renew. COMPLETED receipts remain in
-- processed_actions and commit atomically with business effects and intent completion.
-- Expired/FAILED identities require a new client action key. No scanner/backfill.

CREATE TABLE job_card_lifecycle_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  user_id UUID NOT NULL,
  client_action_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  command VARCHAR(30) NOT NULL
    CHECK (command IN (
      'ACCEPT_ASSIGNMENT', 'START', 'SUBMIT_FOR_APPROVAL', 'APPROVE',
      'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'RESUME', 'CANCEL'
    )),
  request_hash TEXT
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
  state VARCHAR(20) NOT NULL
    CHECK (state IN ('PENDING', 'COMPLETED', 'FAILED')),
  reserved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_code VARCHAR(50),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Semantic intent identity: one row per critical action. Replays and
  -- competing request paths converge here instead of duplicating history.
  UNIQUE (organization_id, user_id, client_action_id, operation_key),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, user_id)
    REFERENCES users (organization_id, id),
  -- A reservation always carries a positive 60-second processing budget.
  CONSTRAINT job_card_lifecycle_intents_expiry_check
    CHECK (expires_at > reserved_at),
  -- Receipt is owned by processed_actions.
  CONSTRAINT job_card_lifecycle_intents_completed_pair_check
    CHECK (
      state <> 'COMPLETED'
      OR (completed_at IS NOT NULL AND failed_at IS NULL AND failure_code IS NULL)
    ),
  -- FAILED never becomes PENDING again.
  CONSTRAINT job_card_lifecycle_intents_failed_pair_check
    CHECK (
      state <> 'FAILED'
      OR (failed_at IS NOT NULL AND completed_at IS NULL AND failure_code IS NOT NULL)
    ),
  -- PENDING carries neither terminal instant.
  CONSTRAINT job_card_lifecycle_intents_pending_pair_check
    CHECK (
      state <> 'PENDING'
      OR (completed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL)
    )
);

-- Reservation/finalization reads by job; per-row intent locks are taken
-- via the UNIQUE identity after the JobCard lock.
CREATE INDEX job_card_lifecycle_intents_job_idx
  ON job_card_lifecycle_intents (organization_id, job_card_id);

-- Fail closed: intent history starts empty; history is never backfilled.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM job_card_lifecycle_intents) <> 0 THEN
    RAISE EXCEPTION 'job_card_lifecycle_intents must start empty (no historical backfill)';
  END IF;
END
$$;
