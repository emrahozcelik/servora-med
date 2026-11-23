-- OVR-2 invalidation closure: an authorized INVALIDATE ends every still-open
-- overdue obligation of the JobCard, reusing the OVR-5 ending family.
-- Accepted contract: `DECISIONS.md` OVR-2 (2026-11-20 addendum) and
-- `docs/features/overdue-correction-deadline-and-extension.md` §4 and §10.
--
-- Vocabulary only: the 066 ending columns are unchanged, the `end_reason` CHECK
-- gains `CARD_INVALIDATED`, and the all-or-none ending shape is redefined so a
-- card invalidation is representable without inventing a schedule revision.
--
-- Shape of one ended row:
--   DEADLINE_EXTENDED -> ended_at, actor, reason, note and the appended
--     schedule revision (the 066 definition, unchanged);
--   CARD_INVALIDATED  -> ended_at, actor and reason only. No revision proves a
--     new boundary, so `ended_by_schedule_revision_no` must stay NULL.
--
-- No row is backfilled or rewritten: the migration executes no DML. Cards
-- invalidated before this rule keep their open incidents exactly as they are
-- (the owner explicitly rejects evidence-less historical backfill), and the
-- lifecycle commands that already recover or materialize an incident
-- (CANCEL, START, SUBMIT_FOR_APPROVAL, APPROVE, revision, withdraw) are
-- unchanged.

ALTER TABLE job_card_overdue_incidents
  DROP CONSTRAINT job_card_overdue_incidents_ending_set_check,
  ADD CONSTRAINT job_card_overdue_incidents_ending_set_check
    CHECK (
      (
        ended_at IS NULL
        AND ended_by_user_id IS NULL
        AND end_reason IS NULL
        AND end_note IS NULL
        AND ended_by_schedule_revision_no IS NULL
      ) OR (
        ended_at IS NOT NULL
        AND ended_by_user_id IS NOT NULL
        AND end_reason = 'DEADLINE_EXTENDED'
        AND end_note IS NOT NULL
        AND ended_by_schedule_revision_no IS NOT NULL
      ) OR (
        ended_at IS NOT NULL
        AND ended_by_user_id IS NOT NULL
        AND end_reason = 'CARD_INVALIDATED'
        AND ended_by_schedule_revision_no IS NULL
      )
    ),
  DROP CONSTRAINT job_card_overdue_incidents_end_reason_check,
  ADD CONSTRAINT job_card_overdue_incidents_end_reason_check
    CHECK (end_reason IS NULL OR end_reason IN ('DEADLINE_EXTENDED', 'CARD_INVALIDATED'));

-- Fail closed: no row may already carry the new reason (no backfill), and both
-- constraints must actually exist with their accepted definitions. The tables
-- are not required to be empty.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM job_card_overdue_incidents
       WHERE end_reason = 'CARD_INVALIDATED') <> 0 THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must not be pre-populated with card invalidation endings';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_ending_set_check'
       AND pg_get_constraintdef(oid) LIKE '%DEADLINE_EXTENDED%'
       AND pg_get_constraintdef(oid) LIKE '%CARD_INVALIDATED%'
       AND pg_get_constraintdef(oid) LIKE '%ended_by_schedule_revision_no%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must keep the all-or-none ending shape with both reasons';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_end_reason_check'
       AND pg_get_constraintdef(oid) LIKE '%DEADLINE_EXTENDED%'
       AND pg_get_constraintdef(oid) LIKE '%CARD_INVALIDATED%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must accept the CARD_INVALIDATED reason';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_ending_exclusive_check'
       AND pg_get_constraintdef(oid) LIKE '%recovered_at%'
       AND pg_get_constraintdef(oid) LIKE '%ended_at%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must keep recovery and ending exclusive';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_ended_by_revision_fk'
       AND contype = 'f'
       AND pg_get_constraintdef(oid) LIKE '%ON DELETE RESTRICT%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must keep the ending revision binding';
  END IF;
END
$$;
