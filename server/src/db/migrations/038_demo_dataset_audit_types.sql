-- D1 audit repair: first-class Demo Dataset creation audit semantics.
--
-- The creation operation was previously recorded as USER_CREATED / USER,
-- which misclassifies a Demo Dataset creation as a user lifecycle event.
-- This migration extends the audit vocabulary with an explicit
-- DEMO_DATASET_CREATED event type and DEMO_DATASET subject type so the
-- audit trail truthfully represents the operation.
--
-- Additive only: every existing allowed value is preserved exactly.

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_subject_type_check,
  DROP CONSTRAINT audit_events_event_type_check;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_subject_type_check
    CHECK (subject_type IN (
      'USER', 'STAFF_PROFILE', 'CUSTOMER', 'CONTACT', 'PRODUCT',
      'STAFF_CONFIDENTIAL_NOTE', 'BACKUP_RUN', 'BACKUP_POLICY',
      'JOB_CARD', 'DEMO_DATASET'
    )),
  ADD CONSTRAINT audit_events_event_type_check
    CHECK (event_type IN (
      'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED',
      'USER_DEACTIVATED', 'USER_PASSWORD_RESET', 'USER_OFFBOARDED',
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
      'JOB_CARD_INVALIDATED', 'DEMO_DATASET_CREATED'
    ));
