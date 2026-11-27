-- RESCUE-002: a typed suggested solution on a declined or released assignment.
--
-- JOB-010 lets Staff decline or release an assignment before management acts.
-- RESCUE-002 lets that answer name one of five solutions next to the reason, so
-- management can act on a typed proposal instead of guessing. A suggestion
-- never authorizes a mutation; management still decides.
--
-- The JOB-012 time proposal is tied to `RESCHEDULE_SELF`, independent of the
-- decline reason. The legacy path (no suggestion) keeps the 073 rule: a time is
-- representable only with `SCHEDULE_CONFLICT`.
--
-- Additive only: one nullable column, its CHECKs, the widened close-reason
-- vocabularies and no DML/backfill. Every existing row keeps
-- `suggested_solution = NULL` and its 073 proposal shape, which the new CHECKs
-- already accept.

-- Fail clearly if the expected 073/065 shape is not in place before changing it:
-- a partially applied or hand-edited database must not pass silently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'job_card_assignment_offers'
       AND column_name = 'proposed_scheduled_at'
       AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers must carry the 073 proposed_scheduled_at column';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'job_card_assignment_offers'
       AND column_name = 'suggested_solution'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers.suggested_solution already exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_proposal_state_check'
       AND pg_get_constraintdef(oid) LIKE '%proposed_scheduled_at IS NULL%'
       AND pg_get_constraintdef(oid) LIKE '%state%'
       AND pg_get_constraintdef(oid) LIKE '%DECLINED%'
       AND pg_get_constraintdef(oid) LIKE '%RELEASED%'
       AND pg_get_constraintdef(oid) LIKE '%close_reason%SCHEDULE_CONFLICT%'
       AND pg_get_constraintdef(oid) NOT LIKE '%suggested_solution%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers_proposal_state_check must be the expected 073 shape before RESCUE-002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_close_reason_check'
       AND pg_get_constraintdef(oid) LIKE '%MISSING_STOCK_OR_EQUIPMENT%'
       AND pg_get_constraintdef(oid) NOT LIKE '%OUT_OF_TOWN%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers_close_reason_check must be the expected 065 shape before RESCUE-002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_closure_check'
       AND pg_get_constraintdef(oid) LIKE '%SCHEDULE_CONFLICT%'
       AND pg_get_constraintdef(oid) NOT LIKE '%CUSTOMER_POSTPONED%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers_closure_check must be the expected 065 shape before RESCUE-002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_proposal_actor_check'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_proposal_requires_check'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers must keep the 073 proposal actor and requires CHECKs';
  END IF;
END
$$;

ALTER TABLE job_card_assignment_offers
  -- The typed solution the answering Staff member proposed. It exists only on
  -- an answer that closed the offer; an open offer never carries one.
  ADD COLUMN suggested_solution TEXT,
  ADD CONSTRAINT job_card_assignment_offers_suggested_solution_check CHECK (
    suggested_solution IS NULL OR suggested_solution IN (
      'RESCHEDULE_SELF',
      'REASSIGN',
      'CORRECT_DETAILS',
      'CANCEL_REQUEST',
      'MANAGEMENT_DECIDES'
    )
  ),
  ADD CONSTRAINT job_card_assignment_offers_suggested_solution_state_check CHECK (
    suggested_solution IS NULL OR state IN ('DECLINED', 'RELEASED')
  ),
  -- The complete 065 vocabulary plus the three RESCUE-002 reason codes; no
  -- existing value is dropped or renamed.
  DROP CONSTRAINT job_card_assignment_offers_close_reason_check,
  ADD CONSTRAINT job_card_assignment_offers_close_reason_check CHECK (
    close_reason IS NULL OR close_reason IN (
      'SCHEDULE_CONFLICT',
      'ON_LEAVE',
      'TOO_FAR',
      'MISSING_STOCK_OR_EQUIPMENT',
      'OTHER',
      'OUT_OF_TOWN',
      'CUSTOMER_POSTPONED',
      'WRONG_PRODUCT',
      'REASSIGNED',
      'RESCHEDULED',
      'CANCELLED',
      'INVALIDATED',
      'OFFBOARDING_TRANSFER',
      'PLANNED_WINDOW_PASSED'
    )
  ),
  -- Same complete closure shape as 065, with the three new decline/release
  -- reason codes in the DECLINED/RELEASED branch.
  DROP CONSTRAINT job_card_assignment_offers_closure_check,
  ADD CONSTRAINT job_card_assignment_offers_closure_check CHECK (
    (
      state = 'OPEN'
      AND closed_at IS NULL
      AND closed_by IS NULL
      AND close_reason IS NULL
      AND close_text IS NULL
    ) OR (
      state IN ('ACCEPTED', 'DECLINED', 'RELEASED', 'EXPIRED', 'WITHDRAWN')
      AND closed_at IS NOT NULL
      AND (closed_by IS NULL) = (state = 'EXPIRED')
      AND (
        (
          state IN ('DECLINED', 'RELEASED')
          AND close_reason IN (
            'SCHEDULE_CONFLICT',
            'ON_LEAVE',
            'TOO_FAR',
            'MISSING_STOCK_OR_EQUIPMENT',
            'OTHER',
            'OUT_OF_TOWN',
            'CUSTOMER_POSTPONED',
            'WRONG_PRODUCT'
          )
          AND close_text IS NOT NULL
        ) OR (
          state = 'WITHDRAWN'
          AND close_reason IN (
            'REASSIGNED',
            'RESCHEDULED',
            'CANCELLED',
            'INVALIDATED',
            'OFFBOARDING_TRANSFER',
            'PLANNED_WINDOW_PASSED'
          )
          AND close_text IS NULL
        ) OR (
          state IN ('ACCEPTED', 'EXPIRED')
          AND close_reason IS NULL
          AND close_text IS NULL
        )
      )
    )
  ),
  -- JOB-012 x RESCUE-002: a proposal is representable on an answer exactly
  -- when the answer suggests RESCHEDULE_SELF, or on a legacy answer whose
  -- reason is SCHEDULE_CONFLICT with no typed suggestion. The explicit
  -- `IS TRUE` keeps a NULL suggestion from satisfying the CHECK by SQL
  -- three-valued logic (the contract's bare expression would accept a legacy
  -- non-conflict answer with a time).
  DROP CONSTRAINT job_card_assignment_offers_proposal_state_check,
  ADD CONSTRAINT job_card_assignment_offers_proposal_state_check CHECK (
    proposed_scheduled_at IS NULL
    OR (
      state IN ('DECLINED', 'RELEASED')
      AND (
        suggested_solution = 'RESCHEDULE_SELF'
        OR (suggested_solution IS NULL AND close_reason = 'SCHEDULE_CONFLICT')
      ) IS TRUE
    )
  ),
  -- RESCHEDULE_SELF promises a concrete alternative time; a bare suggestion is
  -- not a usable proposal for management.
  ADD CONSTRAINT job_card_assignment_offers_reschedule_proposal_check CHECK (
    suggested_solution IS DISTINCT FROM 'RESCHEDULE_SELF'
    OR proposed_scheduled_at IS NOT NULL
  );

-- Fail clearly if the accepted shape is not in place after the change.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'job_card_assignment_offers'
       AND column_name = 'suggested_solution'
       AND data_type = 'text'
       AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers must carry the nullable suggested_solution column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_suggested_solution_check'
       AND pg_get_constraintdef(oid) LIKE '%RESCHEDULE_SELF%'
       AND pg_get_constraintdef(oid) LIKE '%REASSIGN%'
       AND pg_get_constraintdef(oid) LIKE '%CORRECT_DETAILS%'
       AND pg_get_constraintdef(oid) LIKE '%CANCEL_REQUEST%'
       AND pg_get_constraintdef(oid) LIKE '%MANAGEMENT_DECIDES%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers_suggested_solution_check must accept the complete five-solution vocabulary';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_suggested_solution_state_check'
       AND pg_get_constraintdef(oid) LIKE '%DECLINED%'
       AND pg_get_constraintdef(oid) LIKE '%RELEASED%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers_suggested_solution_state_check must restrict suggestions to an answered offer';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_close_reason_check'
       AND pg_get_constraintdef(oid) LIKE '%OUT_OF_TOWN%'
       AND pg_get_constraintdef(oid) LIKE '%CUSTOMER_POSTPONED%'
       AND pg_get_constraintdef(oid) LIKE '%WRONG_PRODUCT%'
       AND pg_get_constraintdef(oid) LIKE '%MISSING_STOCK_OR_EQUIPMENT%'
       AND pg_get_constraintdef(oid) LIKE '%PLANNED_WINDOW_PASSED%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers close_reason CHECK must accept the three new codes and keep the complete vocabulary';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_closure_check'
       AND pg_get_constraintdef(oid) LIKE '%OUT_OF_TOWN%'
       AND pg_get_constraintdef(oid) LIKE '%CUSTOMER_POSTPONED%'
       AND pg_get_constraintdef(oid) LIKE '%WRONG_PRODUCT%'
       AND pg_get_constraintdef(oid) LIKE '%OFFBOARDING_TRANSFER%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers closure CHECK must accept the three new decline/release codes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_proposal_state_check'
       AND pg_get_constraintdef(oid) LIKE '%RESCHEDULE_SELF%'
       AND pg_get_constraintdef(oid) LIKE '%SCHEDULE_CONFLICT%'
       AND pg_get_constraintdef(oid) LIKE '%DECLINED%'
       AND pg_get_constraintdef(oid) LIKE '%RELEASED%'
       AND pg_get_constraintdef(oid) LIKE '%IS TRUE%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers_proposal_state_check must tie proposals to RESCHEDULE_SELF or a legacy schedule conflict and stay null-safe';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_reschedule_proposal_check'
       AND pg_get_constraintdef(oid) LIKE '%RESCHEDULE_SELF%'
       AND pg_get_constraintdef(oid) LIKE '%proposed_scheduled_at IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers_reschedule_proposal_check must require a time for RESCHEDULE_SELF';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_proposal_actor_check'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_proposal_requires_check'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers must keep the 073 proposal actor and requires CHECKs';
  END IF;
END
$$;
