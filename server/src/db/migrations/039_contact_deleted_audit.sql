-- U1-K: allow pristine Contact hard-delete audit event.
--
-- Contacts currently support reversible activate/deactivate only.
-- U1-K introduces irreversible ADMIN-only hard-delete for contacts that
-- have never been referenced by any JobCard (pristine). The audit trail
-- must truthfully represent this operation, so we extend the audit
-- vocabulary with CONTACT_DELETED.
--
-- Additive only: every existing allowed event_type value is preserved exactly.
-- CONTACT_DELETED is appended after CONTACT_DEACTIVATED to match the
-- Contact lifecycle ordering used in 038.

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_event_type_check;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
    CHECK (event_type IN (
      'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED',
      'USER_DEACTIVATED', 'USER_PASSWORD_RESET', 'USER_OFFBOARDED',
      'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED',
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
      'JOB_CARD_INVALIDATED', 'DEMO_DATASET_CREATED'
    ));
