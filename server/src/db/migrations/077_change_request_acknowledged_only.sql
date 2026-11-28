-- RESCUE-003/B: neutral acknowledgement resolution (`ACKNOWLEDGED_ONLY`) on
-- Staff change/termination requests.
--
-- A manager or admin can close an OPEN request by recording and acknowledging
-- the proposal with a mandatory note (1-2000 trimmed characters), leaving the
-- JobCard, assignment offer, overdue incidents and their attribution intact.
-- OVR-7 keeps excluding it via its positive allowlist.
--
-- Additive only: widens the two request CHECK constraints with zero
-- DML/backfill. Every existing OPEN and CLOSED row already satisfies both
-- constraints.

DO $$
BEGIN
  IF to_regclass('job_card_change_requests') IS NULL THEN
    RAISE EXCEPTION 'job_card_change_requests table must exist before 077';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'job_card_change_requests'
       AND column_name = 'resolution'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'job_card_change_requests'
       AND column_name = 'resolution_note'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'job_card_change_requests'
       AND column_name = 'linked_job_card_id'
  ) THEN
    RAISE EXCEPTION 'job_card_change_requests must carry resolution, resolution_note, and linked_job_card_id columns before 077';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_change_requests'::regclass
       AND conname = 'job_card_change_requests_resolution_check'
       AND pg_get_constraintdef(oid) = $def_resolution$CHECK (((resolution IS NULL) OR ((resolution)::text = ANY ((ARRAY['CANCELLED'::character varying, 'CORRECTED'::character varying, 'RESCHEDULED'::character varying, 'LINKED_JOB_CREATED'::character varying, 'REJECTED'::character varying, 'SUPERSEDED'::character varying])::text[]))))$def_resolution$
  ) THEN
    RAISE EXCEPTION 'job_card_change_requests_resolution_check must match the exact 064 definition before 077';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_change_requests'::regclass
       AND conname = 'job_card_change_requests_closure_check'
       AND pg_get_constraintdef(oid) = $def_closure$CHECK (((((state)::text = 'OPEN'::text) AND (resolution IS NULL) AND (resolved_at IS NULL) AND (resolved_by IS NULL) AND (resolution_note IS NULL) AND (linked_job_card_id IS NULL)) OR (((state)::text = 'CLOSED'::text) AND (resolution IS NOT NULL) AND (resolved_at IS NOT NULL) AND (((resolution)::text <> 'REJECTED'::text) OR (resolution_note IS NOT NULL)) AND ((linked_job_card_id IS NULL) OR (((resolution)::text = 'LINKED_JOB_CREATED'::text) AND (linked_job_card_id <> job_card_id))))))$def_closure$
  ) THEN
    RAISE EXCEPTION 'job_card_change_requests_closure_check must match the exact 064 definition before 077';
  END IF;
END
$$;

ALTER TABLE job_card_change_requests
  DROP CONSTRAINT job_card_change_requests_resolution_check,
  ADD CONSTRAINT job_card_change_requests_resolution_check CHECK (
    resolution IS NULL OR resolution IN (
      'CANCELLED',
      'CORRECTED',
      'RESCHEDULED',
      'LINKED_JOB_CREATED',
      'REJECTED',
      'SUPERSEDED',
      'ACKNOWLEDGED_ONLY'
    )
  ),
  DROP CONSTRAINT job_card_change_requests_closure_check,
  ADD CONSTRAINT job_card_change_requests_closure_check CHECK (
    (
      state = 'OPEN'
      AND resolution IS NULL
      AND resolved_at IS NULL
      AND resolved_by IS NULL
      AND resolution_note IS NULL
      AND linked_job_card_id IS NULL
    ) OR (
      state = 'CLOSED'
      AND resolution IS NOT NULL
      AND resolved_at IS NOT NULL
      AND (resolution NOT IN ('REJECTED', 'ACKNOWLEDGED_ONLY') OR resolution_note IS NOT NULL)
      AND (linked_job_card_id IS NULL OR (
        resolution = 'LINKED_JOB_CREATED' AND linked_job_card_id <> job_card_id
      ))
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_change_requests'::regclass
       AND conname = 'job_card_change_requests_resolution_check'
       AND pg_get_constraintdef(oid) LIKE '%ACKNOWLEDGED_ONLY%'
       AND pg_get_constraintdef(oid) LIKE '%CANCELLED%'
       AND pg_get_constraintdef(oid) LIKE '%CORRECTED%'
       AND pg_get_constraintdef(oid) LIKE '%RESCHEDULED%'
       AND pg_get_constraintdef(oid) LIKE '%LINKED_JOB_CREATED%'
       AND pg_get_constraintdef(oid) LIKE '%REJECTED%'
       AND pg_get_constraintdef(oid) LIKE '%SUPERSEDED%'
  ) THEN
    RAISE EXCEPTION 'job_card_change_requests_resolution_check must accept ACKNOWLEDGED_ONLY and keep the 064 vocabulary';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_change_requests'::regclass
       AND conname = 'job_card_change_requests_closure_check'
       AND pg_get_constraintdef(oid) LIKE '%ACKNOWLEDGED_ONLY%'
       AND pg_get_constraintdef(oid) LIKE '%REJECTED%'
       AND pg_get_constraintdef(oid) LIKE '%LINKED_JOB_CREATED%'
  ) THEN
    RAISE EXCEPTION 'job_card_change_requests_closure_check must require resolution_note for REJECTED and ACKNOWLEDGED_ONLY';
  END IF;
END
$$;
