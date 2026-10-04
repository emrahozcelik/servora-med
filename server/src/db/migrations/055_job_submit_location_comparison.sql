-- Slice 2: persist the advisory SUBMIT-vs-START comparison evidence on the
-- JOB_SUBMITTED_FOR_APPROVAL action-location row. All columns are nullable so
-- legacy Slice-1 rows (START rows, unavailable captures, no-reference
-- submits) stay valid without a backfill. Comparison is advisory only: it
-- never blocks SUBMIT_FOR_APPROVAL; the application enforces that.
--
-- An UNRELIABLE outcome keeps the computed raw distance for audit value; the
-- product must never treat that distance as DIFFERENT (see service policy).

ALTER TABLE job_action_locations
  ADD COLUMN reference_activity_id UUID NULL,
  ADD COLUMN distance_meters NUMERIC(12,3) NULL,
  ADD COLUMN comparison_outcome VARCHAR(20) NULL;

ALTER TABLE job_action_locations
  ADD CONSTRAINT job_action_locations_comparison_outcome_check CHECK (
    comparison_outcome IS NULL OR comparison_outcome IN (
      'MATCH',
      'DIFFERENT',
      'UNRELIABLE'
    )
  );

-- Outcome, reference and distance travel together: a classified row always
-- names the exact START activity it was compared against and the
-- server-computed distance; unclassified rows carry none of the three.
ALTER TABLE job_action_locations
  ADD CONSTRAINT job_action_locations_comparison_coherence_check CHECK (
    (
      comparison_outcome IS NULL
      AND reference_activity_id IS NULL
      AND distance_meters IS NULL
    )
    OR (
      comparison_outcome IS NOT NULL
      AND reference_activity_id IS NOT NULL
      AND distance_meters IS NOT NULL
    )
  );

-- Comparison evidence only exists on SUBMIT rows. START rows never carry it.
ALTER TABLE job_action_locations
  ADD CONSTRAINT job_action_locations_comparison_action_check CHECK (
    comparison_outcome IS NULL OR action = 'JOB_SUBMITTED_FOR_APPROVAL'
  );

ALTER TABLE job_action_locations
  ADD CONSTRAINT job_action_locations_distance_check CHECK (
    distance_meters IS NULL OR distance_meters >= 0
  );
