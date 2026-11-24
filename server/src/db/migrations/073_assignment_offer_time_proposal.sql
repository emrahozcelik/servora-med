-- JOB-012: a Staff time proposal on a declined or released assignment.
--
-- JOB-010 lets Staff decline or release an assignment before management acts.
-- JOB-012 lets that answer carry one alternative time when the reason is a
-- schedule conflict, so management can confirm the proposed time instead of
-- guessing one. The customer time stays management-owned: Staff only propose,
-- management confirms (or ignores the proposal and reschedules freely).
--
-- Additive only: three nullable columns, their CHECKs, one producer value in the
-- existing opened_reason vocabulary, and no DML/backfill. Every existing row
-- keeps `proposed_scheduled_at = NULL` and `proposal_accepted_at/by = NULL`,
-- which the new CHECKs already accept. The proposing Staff member never sets
-- the acceptance pair; it is written once, by the management confirmation.
--
-- The proposed interval is derived, never stored:
--   [proposed, proposed + D)
-- where D is the job's persisted planned duration (`scheduled_ends_at -
-- scheduled_at`), or the canonical duration of the type (60 min SALES_MEETING,
-- 30 min PRODUCT_DELIVERY) when either bound is null.

ALTER TABLE job_card_assignment_offers
  -- The Staff proposal as answered, stored on the offer the answer closed. It
  -- exists only on a SCHEDULE_CONFLICT decline/release: no other reason may
  -- carry a time.
  ADD COLUMN proposed_scheduled_at TIMESTAMPTZ,
  -- Set once, in the same transaction as the acceptance it proves. The pair is
  -- written atomically, so an accepted proposal is never half-recorded.
  ADD COLUMN proposal_accepted_at TIMESTAMPTZ,
  ADD COLUMN proposal_accepted_by UUID,
  ADD CONSTRAINT job_card_assignment_offers_proposal_state_check CHECK (
    proposed_scheduled_at IS NULL
    OR (state IN ('DECLINED', 'RELEASED') AND close_reason = 'SCHEDULE_CONFLICT')
  ),
  ADD CONSTRAINT job_card_assignment_offers_proposal_actor_check CHECK (
    (proposal_accepted_at IS NULL) = (proposal_accepted_by IS NULL)
  ),
  -- A confirmation is only representable for an offer that carries a proposal.
  ADD CONSTRAINT job_card_assignment_offers_proposal_requires_check CHECK (
    proposal_accepted_at IS NULL OR proposed_scheduled_at IS NOT NULL
  ),
  ADD CONSTRAINT job_card_assignment_offers_proposal_accepted_by_fk
    FOREIGN KEY (organization_id, proposal_accepted_by)
    REFERENCES users (organization_id, id),
  -- The confirmation opens its own offer, already accepted: the proposer
  -- accepted by proposing, so no second Staff acceptance is asked for. The list
  -- is the complete 071 vocabulary plus the new reason; no existing value is
  -- dropped or renamed.
  DROP CONSTRAINT job_card_assignment_offers_opened_reason_check,
  ADD CONSTRAINT job_card_assignment_offers_opened_reason_check CHECK (opened_reason IN (
    'CREATE',
    'REASSIGN',
    'RESCHEDULE',
    'FOLLOW_UP_CREATE',
    'APPROVE_FOLLOW_UP',
    'CANCEL_REPLACEMENT',
    'OFFBOARDING_TRANSFER',
    'REOFFER',
    'SALE_APPROVAL',
    'PROPOSAL_ACCEPTED'
  ));

-- Fail clearly if the accepted shape is not in place: a partially applied or
-- hand-edited database must not pass silently.
DO $$
BEGIN
  IF (SELECT COUNT(*)
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'job_card_assignment_offers'
         AND (
           (column_name = 'proposed_scheduled_at' AND data_type = 'timestamp with time zone')
           OR (column_name = 'proposal_accepted_at' AND data_type = 'timestamp with time zone')
           OR (column_name = 'proposal_accepted_by' AND data_type = 'uuid')
         )) <> 3 THEN
    RAISE EXCEPTION 'job_card_assignment_offers must carry the three JOB-012 proposal columns';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_proposal_state_check'
       AND pg_get_constraintdef(oid) LIKE '%SCHEDULE_CONFLICT%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers_proposal_state_check must restrict proposals to a schedule-conflict answer';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_proposal_actor_check'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers_proposal_actor_check must pair the confirmation actor with its instant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_proposal_requires_check'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers_proposal_requires_check must require a proposal for a confirmation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_opened_reason_check'
       AND pg_get_constraintdef(oid) LIKE '%PROPOSAL_ACCEPTED%'
       AND pg_get_constraintdef(oid) LIKE '%SALE_APPROVAL%'
       AND pg_get_constraintdef(oid) LIKE '%OFFBOARDING_TRANSFER%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers opened_reason CHECK must accept PROPOSAL_ACCEPTED and keep the complete vocabulary';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_closure_check'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers must keep its paired close-fact CHECK';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_proposal_accepted_by_fk'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers proposal actor must reference users';
  END IF;
END
$$;
