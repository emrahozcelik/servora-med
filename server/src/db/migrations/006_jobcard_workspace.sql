CREATE TABLE job_card_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  author_id UUID NOT NULL,
  note TEXT NOT NULL CHECK (length(trim(note)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, author_id)
    REFERENCES users (organization_id, id)
);

CREATE INDEX job_card_notes_job_time_idx
  ON job_card_notes (job_card_id, created_at DESC, id DESC);
CREATE INDEX job_cards_organization_updated_idx
  ON job_cards (organization_id, updated_at DESC, id DESC);
CREATE INDEX job_cards_waiting_approval_idx
  ON job_cards (organization_id, staff_completed_at ASC, id ASC)
  WHERE status = 'WAITING_APPROVAL';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM job_cards WHERE status = 'PLANNED' AND planned_at IS NULL) THEN
    RAISE EXCEPTION 'Cannot add planned timestamp constraint: invalid JobCard rows exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM job_cards
    WHERE status IN ('IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED')
      AND started_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add started timestamp constraint: invalid JobCard rows exist';
  END IF;
END $$;

ALTER TABLE job_cards ADD CONSTRAINT job_cards_planned_status_timestamp_check
  CHECK (status <> 'PLANNED' OR planned_at IS NOT NULL);
ALTER TABLE job_cards ADD CONSTRAINT job_cards_started_status_timestamp_check
  CHECK (status NOT IN ('IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED')
    OR started_at IS NOT NULL);
