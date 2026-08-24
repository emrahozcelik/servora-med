-- R3A: JobCard INVALIDATED is a terminal administrative state. Historical
-- business rows and their child records remain intact; only operational
-- eligibility changes.

ALTER TABLE job_cards
  ADD COLUMN invalidated_at TIMESTAMPTZ NULL,
  ADD COLUMN invalidated_by UUID NULL,
  ADD COLUMN invalidation_reason_code VARCHAR(40) NULL;

ALTER TABLE job_cards
  DROP CONSTRAINT job_cards_status_check,
  ADD CONSTRAINT job_cards_status_check CHECK (status IN (
    'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
    'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED', 'INVALIDATED'
  )),
  ADD CONSTRAINT job_cards_organization_invalidated_by_fk
    FOREIGN KEY (organization_id, invalidated_by)
    REFERENCES users (organization_id, id),
  ADD CONSTRAINT job_cards_invalidation_reason_code_check
    CHECK (invalidation_reason_code IS NULL OR invalidation_reason_code IN (
      'DUPLICATE', 'WRONG_CUSTOMER', 'CREATED_BY_MISTAKE',
      'TRAINING_OR_TEST_RECORD', 'OTHER'
    )),
  ADD CONSTRAINT job_cards_invalidation_fields_check
    CHECK (
      (
        status = 'INVALIDATED'
        AND invalidated_at IS NOT NULL
        AND invalidated_by IS NOT NULL
        AND invalidation_reason_code IS NOT NULL
      )
      OR (
        status <> 'INVALIDATED'
        AND invalidated_at IS NULL
        AND invalidated_by IS NULL
        AND invalidation_reason_code IS NULL
      )
    );

ALTER TABLE job_card_activity_logs
  DROP CONSTRAINT job_card_activity_logs_event_type_check,
  ADD CONSTRAINT job_card_activity_logs_event_type_check CHECK (event_type IN (
    'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_ACCEPTED', 'JOB_STARTED',
    'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
    'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_INVALIDATED', 'JOB_FIELDS_UPDATED',
    'DELIVERY_ITEM_ADDED', 'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED',
    'NOTE_ADDED', 'MEETING_DETAILS_UPDATED', 'JOB_APPROVAL_WITHDRAWN'
  ));

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
        'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED', 'INVALIDATED'
      )
      AND context IS NOT NULL
      AND context IN (
        'GENERAL',
        'SUBMIT_FOR_APPROVAL',
        'APPROVE',
        'REQUEST_REVISION',
        'CANCEL',
        'INVALIDATE'
      )
      AND related_activity_id IS NOT NULL
    )
  );

ALTER TABLE realtime_events
  DROP CONSTRAINT realtime_events_event_type_check,
  ADD CONSTRAINT realtime_events_event_type_check CHECK (event_type IN (
    'job.created',
    'job.assignment_changed',
    'job.accepted',
    'job.started',
    'job.submitted_for_approval',
    'job.approved',
    'job.revision_requested',
    'job.cancelled',
    'job.invalidated',
    'job.updated',
    'calendar.created',
    'calendar.updated',
    'calendar.cancelled',
    'calendar.reminder_due',
    'message.sent',
    'conversation.created',
    'confidential-note.created',
    'conversation.participants_changed'
  ));

ALTER TABLE in_app_notifications
  DROP CONSTRAINT in_app_notifications_kind_check,
  ADD CONSTRAINT in_app_notifications_kind_check CHECK (kind IN (
    'job.assigned',
    'job.reassigned',
    'job.awaiting_approval',
    'job.approved',
    'job.revision_requested',
    'job.cancelled',
    'job.invalidated',
    'job.note_added',
    'calendar.assigned',
    'calendar.rescheduled',
    'calendar.cancelled',
    'calendar.reminder',
    'message.received'
  ));

ALTER TABLE processed_actions
  ADD COLUMN request_hash VARCHAR(64) NULL,
  ADD CONSTRAINT processed_actions_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_subject_type_check,
  DROP CONSTRAINT audit_events_event_type_check;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_subject_type_check
    CHECK (subject_type IN (
      'USER', 'STAFF_PROFILE', 'CUSTOMER', 'CONTACT', 'PRODUCT',
      'STAFF_CONFIDENTIAL_NOTE', 'BACKUP_RUN', 'BACKUP_POLICY', 'JOB_CARD'
    )),
  ADD CONSTRAINT audit_events_event_type_check
    CHECK (event_type IN (
      'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED',
      'USER_DEACTIVATED', 'USER_PASSWORD_RESET',
      'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED',
      'CUSTOMER_CREATED', 'CUSTOMER_FIELDS_UPDATED',
      'CUSTOMER_ASSIGNEE_CHANGED', 'CUSTOMER_ACTIVATED',
      'CUSTOMER_DEACTIVATED', 'CONTACT_CREATED',
      'CONTACT_FIELDS_UPDATED', 'CONTACT_MADE_PRIMARY',
      'CONTACT_ACTIVATED', 'CONTACT_DEACTIVATED',
      'PRODUCT_CREATED', 'PRODUCT_FIELDS_UPDATED',
      'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED',
      'CUSTOMER_DELETED', 'PRODUCT_DELETED',
      'STAFF_CONFIDENTIAL_NOTE_CREATED',
      'BACKUP_REQUESTED', 'BACKUP_POLICY_UPDATED',
      'BACKUP_STARTED', 'BACKUP_VERIFIED',
      'BACKUP_COMPLETED', 'BACKUP_FAILED',
      'JOB_CARD_INVALIDATED'
    ));
