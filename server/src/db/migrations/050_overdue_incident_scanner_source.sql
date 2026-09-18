-- OVR-3: allow a clock-only scanner as an overdue-incident producer source.
--
-- A clock-only breach is materialized without any lifecycle mutation: an
-- already-existing, provable obligation becomes late purely because time
-- passed. That is a third producer next to the request-driven TRANSITION and
-- MUTATION paths, so the source contract grows by exactly one value.
--
-- Additive only:
--   * no new table and no new column (the request-time ordering evidence is
--     the existing 049 job_card_lifecycle_intents reservation, reused);
--   * no historical incident backfill: this migration executes no incident
--     DML, so the table keeps exactly the rows it already had;
--   * every other CHECK/FK/UNIQUE constraint on the table is retained;
--   * SCANNER rows are real breaches with the same identity, deadline,
--     accountability and recovery contract as request-driven rows. Source
--     describes the producer, never a weaker kind of history.

ALTER TABLE job_card_overdue_incidents
  DROP CONSTRAINT job_card_overdue_incidents_source_check,
  ADD CONSTRAINT job_card_overdue_incidents_source_check
    CHECK (source IN ('TRANSITION', 'MUTATION', 'SCANNER'));

-- Fail closed if the source contract did not actually widen: a partial
-- application must abort instead of leaving a scanner that cannot persist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_source_check'
       AND pg_get_constraintdef(oid) LIKE '%SCANNER%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents source CHECK must accept SCANNER';
  END IF;
END
$$;
