ALTER TABLE job_card_activity_logs
  ADD CONSTRAINT job_card_activity_logs_org_job_id_unique
  UNIQUE (organization_id, job_card_id, id);

ALTER TABLE job_card_notes
  ADD COLUMN author_name_snapshot TEXT,
  ADD COLUMN author_role_snapshot VARCHAR(20),
  ADD COLUMN workflow_stage VARCHAR(30),
  ADD COLUMN context VARCHAR(40),
  ADD COLUMN related_activity_id UUID,
  ADD COLUMN record_version SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE job_card_notes
  ADD CONSTRAINT job_card_notes_record_version_check
  CHECK (
    (
      record_version = 0
      AND author_name_snapshot IS NULL
      AND author_role_snapshot IS NULL
      AND workflow_stage IS NULL
      AND context IS NULL
      AND related_activity_id IS NULL
    )
    OR
    (
      record_version = 1
      AND length(trim(author_name_snapshot)) > 0
      AND author_role_snapshot IN ('ADMIN', 'MANAGER', 'STAFF')
      AND workflow_stage IN (
        'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
        'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED'
      )
      AND context = 'GENERAL'
      AND related_activity_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT job_card_notes_related_activity_fk
  FOREIGN KEY (organization_id, job_card_id, related_activity_id)
  REFERENCES job_card_activity_logs (organization_id, job_card_id, id)
  ON DELETE RESTRICT;

ALTER TABLE job_card_notes
  ALTER COLUMN record_version SET DEFAULT 1;

CREATE INDEX job_card_notes_org_job_time_idx
  ON job_card_notes (organization_id, job_card_id, created_at DESC, id DESC);
