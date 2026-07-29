-- Expand operational note context values to include transition-scoped contexts.
-- Must preserve the existing v0/v1 record-version invariant.
ALTER TABLE job_card_notes
  DROP CONSTRAINT job_card_notes_record_version_check;

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
      AND author_name_snapshot IS NOT NULL
      AND length(trim(author_name_snapshot)) > 0
      AND author_role_snapshot IS NOT NULL
      AND author_role_snapshot IN ('ADMIN', 'MANAGER', 'STAFF')
      AND workflow_stage IS NOT NULL
      AND workflow_stage IN (
        'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
        'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED'
      )
      AND context IS NOT NULL
      AND context IN (
        'GENERAL',
        'SUBMIT_FOR_APPROVAL',
        'APPROVE',
        'REQUEST_REVISION',
        'CANCEL'
      )
      AND related_activity_id IS NOT NULL
    )
  );
