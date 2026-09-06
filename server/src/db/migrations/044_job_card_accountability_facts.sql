-- FOUNDATION-2: immutable JobCard accountability facts.
--
-- One row per authoritative lifecycle occurrence that later mutations could
-- otherwise erase or overwrite:
--
--   STARTED    the actual start occurrence: responsible assignee, governing
--              schedule revision, and START actor frozen at START time
--              (job_cards.started_at is frozen, but assigned_to is mutable).
--   SUBMITTED  each completion claim: staff_completed_* columns are
--              overwritten by every SUBMIT_FOR_APPROVAL, so seq_no preserves
--              the first claim and every later claim.
--
-- Facts complement job_card_activity_logs and the Foundation-1 history tables;
-- they do not replace them. No schedule-change or reassignment facts are
-- stored here: schedule revisions and assignment history already answer those
-- questions. No scanner/overdue facts are stored here either; those belong to
-- a future OVR slice.
--
-- Pre-044 history is UNKNOWN / NOT FABRICATED: no historical facts are
-- reconstructed from activity JSONB or current JobCard timestamps. Absence of
-- a fact before 044 activation is not evidence that the event did not occur.
--
-- No trigger is used; immutability is application discipline and the
-- authorized demo purge is the explicit deletion exception (fact rows are
-- deleted before their JobCard rows by the purge plan).

CREATE TABLE job_card_accountability_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  fact_type VARCHAR(40) NOT NULL
    CHECK (fact_type IN ('STARTED', 'SUBMITTED')),
  seq_no INTEGER NOT NULL CHECK (seq_no >= 1),
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schedule_revision_no INTEGER NOT NULL CHECK (schedule_revision_no >= 1),
  responsible_user_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  source_activity_id UUID NOT NULL,
  CONSTRAINT job_card_accountability_facts_started_seq_check
    CHECK (fact_type <> 'STARTED' OR seq_no = 1),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, job_card_id, fact_type, seq_no),
  UNIQUE (organization_id, job_card_id, source_activity_id),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, job_card_id, schedule_revision_no)
    REFERENCES job_card_schedule_revisions (organization_id, job_card_id, revision_no)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, responsible_user_id)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, job_card_id, source_activity_id)
    REFERENCES job_card_activity_logs (organization_id, job_card_id, id)
    ON DELETE RESTRICT
);

-- Minimal supporting key for the tenant/job-safe activity linkage above.
-- (organization_id, job_card_id, id) is a superset of the activity primary
-- key, so this constraint is always satisfiable and changes no data.
ALTER TABLE job_card_activity_logs
  ADD CONSTRAINT job_card_activity_logs_org_job_id_key
  UNIQUE (organization_id, job_card_id, id);

CREATE INDEX job_card_accountability_facts_job_time_idx
  ON job_card_accountability_facts (organization_id, job_card_id, occurred_at DESC, id DESC);

-- Fail closed when the zero-backfill contract is violated. The migration runs
-- in a single transaction, so any assertion failure leaves no partial state.

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM job_card_accountability_facts) <> 0 THEN
    RAISE EXCEPTION 'job_card_accountability_facts must start empty: historical facts are never backfilled';
  END IF;
END $$;
