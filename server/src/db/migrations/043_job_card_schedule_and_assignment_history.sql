-- FOUNDATION-1: immutable JobCard schedule revision history and assignment
-- history.
--
-- Two append-only, organization-scoped, JobCard-scoped tables give every
-- JobCard an authoritative, identity-stable scheduling and ownership history:
--
--   job_card_schedule_revisions  one row per authoritative schedule state
--                                (create + every schedule-changing mutation)
--   job_card_assignment_history  one row per authoritative assigned_to state
--
-- Pre-baseline history is UNKNOWN / NOT FABRICATED: existing JobCards receive
-- exactly one BASELINE revision and one BASELINE assignment row snapshotting
-- their current values. No historical revisions are reconstructed from
-- activity JSONB. `created_at`/`changed_at` on BASELINE rows is the migration
-- execution time, never a fabricated historical instant; `source = 'BASELINE'`
-- tells consumers the row is not a historical creation record.
--
-- Foundation tables supplement job_card_activity_logs; they do not replace
-- them. No trigger is used; immutability is application discipline and the
-- authorized demo purge is the explicit deletion exception (history rows are
-- deleted before their JobCard rows by the purge plan).

CREATE TABLE job_card_schedule_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  scheduled_at TIMESTAMPTZ,
  scheduled_ends_at TIMESTAMPTZ,
  due_date DATE,
  organization_timezone VARCHAR(64) NOT NULL,
  source VARCHAR(20) NOT NULL
    CHECK (source IN ('CREATE', 'RESCHEDULE', 'FOLLOW_UP_CREATE', 'BASELINE')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, job_card_id, revision_no),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by)
    REFERENCES users (organization_id, id),
  CONSTRAINT job_card_schedule_revisions_interval_check
    CHECK (
      scheduled_ends_at IS NULL
      OR (scheduled_at IS NOT NULL AND scheduled_ends_at > scheduled_at)
    )
);

CREATE TABLE job_card_assignment_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  from_user_id UUID,
  to_user_id UUID NOT NULL,
  changed_by UUID,
  source VARCHAR(20) NOT NULL
    CHECK (source IN ('CREATE', 'PATCH_REASSIGN', 'OFFBOARDING', 'FOLLOW_UP_CREATE', 'BASELINE')),
  changed_at TIMESTAMPTZ NOT NULL,
  activity_id UUID,
  FOREIGN KEY (activity_id)
    REFERENCES job_card_activity_logs(id),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, from_user_id)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, to_user_id)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, changed_by)
    REFERENCES users (organization_id, id),
  CONSTRAINT job_card_assignment_history_change_check
    CHECK (from_user_id IS NULL OR from_user_id <> to_user_id)
);

CREATE INDEX job_card_assignment_history_job_time_idx
  ON job_card_assignment_history (organization_id, job_card_id, changed_at DESC, id DESC);

-- Baseline backfill: one authoritative revision #1 + one baseline assignment
-- row per existing JobCard, snapshotting current values with the current
-- organization timezone. NOW() is the migration execution instant; the
-- BASELINE source tag marks these rows as not-historical-creation records.

INSERT INTO job_card_schedule_revisions
  (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
   due_date, organization_timezone, source, created_by, created_at)
SELECT
  j.organization_id, j.id, 1, j.scheduled_at, j.scheduled_ends_at,
  j.due_date, o.timezone, 'BASELINE', NULL, NOW()
FROM job_cards j
JOIN organizations o ON o.id = j.organization_id;

INSERT INTO job_card_assignment_history
  (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at, activity_id)
SELECT
  j.organization_id, j.id, NULL, j.assigned_to, NULL, 'BASELINE', NOW(), NULL
FROM job_cards j;

-- Fail closed when baseline cardinality is wrong. The migration runs in a
-- single transaction, so any assertion failure leaves no partial state.

DO $$
BEGIN
  IF (
    SELECT COUNT(*) FROM job_cards j
    WHERE (
      SELECT COUNT(*) FROM job_card_schedule_revisions r
      WHERE r.organization_id = j.organization_id
        AND r.job_card_id = j.id
        AND r.revision_no = 1
        AND r.source = 'BASELINE'
    ) <> 1
  ) <> 0 THEN
    RAISE EXCEPTION 'job_card_schedule_revisions baseline cardinality violation: every JobCard must have exactly one BASELINE revision #1';
  END IF;
  IF (
    SELECT COUNT(*) FROM (
      SELECT organization_id, job_card_id
      FROM job_card_schedule_revisions
      GROUP BY organization_id, job_card_id, revision_no
      HAVING COUNT(*) > 1
    ) duplicates
  ) <> 0 THEN
    RAISE EXCEPTION 'job_card_schedule_revisions duplicate (organization_id, job_card_id, revision_no)';
  END IF;
  IF (
    SELECT COUNT(*) FROM job_cards j
    WHERE (
      SELECT COUNT(*) FROM job_card_assignment_history a
      WHERE a.organization_id = j.organization_id
        AND a.job_card_id = j.id
        AND a.source = 'BASELINE'
    ) <> 1
  ) <> 0 THEN
    RAISE EXCEPTION 'job_card_assignment_history baseline cardinality violation: every JobCard must have exactly one BASELINE assignment row';
  END IF;
  IF (
    SELECT COUNT(*) FROM job_card_schedule_revisions r
    WHERE NOT EXISTS (
      SELECT 1 FROM job_cards j
      WHERE j.organization_id = r.organization_id AND j.id = r.job_card_id
    )
  ) <> 0 THEN
    RAISE EXCEPTION 'job_card_schedule_revisions contains rows without a JobCard';
  END IF;
  IF (
    SELECT COUNT(*) FROM job_card_assignment_history a
    WHERE NOT EXISTS (
      SELECT 1 FROM job_cards j
      WHERE j.organization_id = a.organization_id AND j.id = a.job_card_id
    )
  ) <> 0 THEN
    RAISE EXCEPTION 'job_card_assignment_history contains rows without a JobCard';
  END IF;
END $$;
