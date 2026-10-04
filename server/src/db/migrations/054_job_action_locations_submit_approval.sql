-- Slice 1: allow the append-only action-scoped location evidence to be linked
-- to the JOB_SUBMITTED_FOR_APPROVAL lifecycle activity in addition to
-- JOB_STARTED. Existing rows and constraints are preserved; no backfill.
-- Comparison evidence (reference/distance/outcome) is explicitly out of scope.

ALTER TABLE job_action_locations
  DROP CONSTRAINT job_action_locations_action_check;

ALTER TABLE job_action_locations
  ADD CONSTRAINT job_action_locations_action_check CHECK (
    action IN ('JOB_STARTED', 'JOB_SUBMITTED_FOR_APPROVAL')
  );
