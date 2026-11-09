-- Weekly Report removal preserves history while releasing the current Staff/week.
ALTER TABLE weekly_reports
  ADD COLUMN removed_at TIMESTAMPTZ,
  ADD COLUMN removed_by UUID,
  ADD COLUMN removal_reason TEXT,
  ADD CONSTRAINT weekly_reports_removal_actor_fk
    FOREIGN KEY (organization_id, removed_by) REFERENCES users (organization_id, id),
  ADD CONSTRAINT weekly_reports_removal_check CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND removal_reason IS NULL)
    OR (removed_at IS NOT NULL AND isfinite(removed_at) AND removed_by IS NOT NULL
      AND removal_reason IS NOT NULL AND char_length(trim(removal_reason)) BETWEEN 1 AND 2000)
  );

ALTER TABLE weekly_reports
  DROP CONSTRAINT weekly_reports_organization_id_staff_user_id_period_start_key;
CREATE UNIQUE INDEX weekly_reports_current_staff_week_key
  ON weekly_reports (organization_id, staff_user_id, period_start)
  WHERE removed_at IS NULL;

ALTER TABLE job_card_activity_logs
  DROP CONSTRAINT job_card_activity_logs_event_type_check,
  ADD CONSTRAINT job_card_activity_logs_event_type_check CHECK (event_type IN (
    'WEEKLY_REPORT_REMOVED',
    'JOB_CREATED',
    'JOB_ASSIGNED',
    'JOB_PLANNED',
    'JOB_ACCEPTED',
    'JOB_STARTED',
    'JOB_SUBMITTED_FOR_APPROVAL',
    'JOB_APPROVED',
    'JOB_REVISION_REQUESTED',
    'JOB_RESUMED',
    'JOB_CANCELLED',
    'JOB_INVALIDATED',
    'JOB_FIELDS_UPDATED',
    'DELIVERY_ITEM_ADDED',
    'DELIVERY_ITEM_UPDATED',
    'DELIVERY_ITEM_REMOVED',
    'NOTE_ADDED',
    'MEETING_DETAILS_UPDATED',
    'JOB_APPROVAL_WITHDRAWN',
    'JOB_SUBMISSION_REMINDER_SENT',
    'JOB_SUBMISSION_AUTO_REMINDER_SENT',
    'JOB_SUBMISSION_AUTO_ESCALATION_SENT',
    'SALE_FROM_VISIT_CREATED',
    'SALE_DETAILS_UPDATED',
    'SALE_ITEM_ADDED',
    'SALE_ITEM_UPDATED',
    'SALE_ITEM_REMOVED'
  ));

ALTER TABLE audit_events DROP CONSTRAINT audit_events_event_type_check, ADD CONSTRAINT audit_events_event_type_check
    CHECK (event_type IN (
      'WEEKLY_REPORT_REMOVED',
      'USER_CREATED', 'USER_DELETED', 'USER_ROLE_CHANGED',
      'USER_ACTIVATED', 'USER_DEACTIVATED', 'USER_PASSWORD_RESET',
      'USER_OFFBOARDED', 'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED',
      'CUSTOMER_CREATED', 'CUSTOMER_FIELDS_UPDATED',
      'CUSTOMER_ASSIGNEE_CHANGED', 'CUSTOMER_ACTIVATED',
      'CUSTOMER_DEACTIVATED', 'CONTACT_CREATED',
      'CONTACT_FIELDS_UPDATED', 'CONTACT_MADE_PRIMARY',
      'CONTACT_ACTIVATED', 'CONTACT_DEACTIVATED', 'CONTACT_DELETED',
      'PRODUCT_CREATED', 'PRODUCT_FIELDS_UPDATED',
      'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED',
      'CUSTOMER_DELETED', 'PRODUCT_DELETED',
      'STAFF_CONFIDENTIAL_NOTE_CREATED',
      'BACKUP_REQUESTED', 'BACKUP_POLICY_UPDATED',
      'BACKUP_STARTED', 'BACKUP_VERIFIED',
      'BACKUP_COMPLETED', 'BACKUP_FAILED',
      'JOB_CARD_INVALIDATED', 'DEMO_DATASET_CREATED',
      'DEMO_DATASET_PURGED',
      'CUSTOMER_DUPLICATE_REVIEW_DECIDED',
      'CUSTOMER_DUPLICATE_REVIEW_REOPENED'
    ));
