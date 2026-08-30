-- U3: distinguish disposable/pristine users from history-bearing users.
--
-- User deletion itself is implemented as an ADMIN-only, transactionally
-- guarded service operation. This migration only extends the audit vocabulary;
-- it performs no user cleanup and does not alter existing business rows.

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_event_type_check;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
    CHECK (event_type IN (
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
      'DEMO_DATASET_PURGED'
    ));
