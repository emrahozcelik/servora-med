-- CRM Slice 4A PR2: persistent duplicate review aggregate, append-only events,
-- and the narrow audit vocabulary extension. Additive only.
--
-- The Customer pair IDs are historical soft references, not live foreign keys:
-- deleting a Customer must not create a new pristine-delete blocker or cascade
-- review history. Every live read/command revalidates organization/BUSINESS.

CREATE TABLE customer_duplicate_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  customer_a_id UUID NOT NULL,
  customer_b_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_duplicate_reviews_canonical_pair_check
    CHECK (customer_a_id < customer_b_id),
  CONSTRAINT customer_duplicate_reviews_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT customer_duplicate_reviews_pair_unique
    UNIQUE (organization_id, customer_a_id, customer_b_id)
);

CREATE TABLE customer_duplicate_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  review_id UUID NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  event_kind VARCHAR(32) NOT NULL,
  resulting_status VARCHAR(32) NOT NULL,
  reason_code VARCHAR(48) NOT NULL,
  actor_user_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  evidence_schema_version SMALLINT NOT NULL
    CHECK (evidence_schema_version > 0),
  matching_rule_version VARCHAR(64) NOT NULL
    CHECK (matching_rule_version ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  evidence_key_id VARCHAR(32) NOT NULL
    CHECK (evidence_key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  evidence_digest BYTEA NOT NULL
    CHECK (octet_length(evidence_digest) = 32),
  matching_codes TEXT[] NOT NULL,
  conflicting_tax_numbers BOOLEAN NOT NULL,
  CONSTRAINT customer_duplicate_review_events_owner_fk
    FOREIGN KEY (organization_id, review_id)
    REFERENCES customer_duplicate_reviews (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT customer_duplicate_review_events_sequence_unique
    UNIQUE (organization_id, review_id, seq),
  CONSTRAINT customer_duplicate_review_events_codes_check CHECK (
    matching_codes <@ ARRAY[
      'SAME_NAME_AND_PHONE', 'SAME_NAME_AND_EMAIL',
      'SAME_NAME_AND_ADDRESS', 'SAME_PHONE', 'SAME_NAME'
    ]::text[]
  ),
  CONSTRAINT customer_duplicate_review_events_state_reason_check CHECK (
    (
      event_kind = 'DECISION_RECORDED'
      AND (
        (
          resulting_status = 'CONFIRMED_DUPLICATE'
          AND reason_code = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'
        )
        OR
        (
          resulting_status = 'DISMISSED'
          AND reason_code IN (
            'DISTINCT_BRANCH', 'DISTINCT_CUSTOMER',
            'SHARED_CONTACT_DETAILS', 'INSUFFICIENT_EVIDENCE'
          )
        )
      )
    )
    OR
    (
      event_kind = 'REVIEW_REOPENED'
      AND resulting_status = 'PENDING_REVIEW'
      AND reason_code = 'RECHECK_REQUESTED'
    )
  )
);

ALTER TABLE customer_duplicate_reviews
  ADD CONSTRAINT customer_duplicate_reviews_current_event_fk
  FOREIGN KEY (organization_id, id, version)
  REFERENCES customer_duplicate_review_events
    (organization_id, review_id, seq)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_subject_type_check,
  DROP CONSTRAINT audit_events_event_type_check;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_subject_type_check
    CHECK (subject_type IN (
      'USER', 'STAFF_PROFILE', 'CUSTOMER', 'CONTACT', 'PRODUCT',
      'STAFF_CONFIDENTIAL_NOTE', 'BACKUP_RUN', 'BACKUP_POLICY',
      'JOB_CARD', 'DEMO_DATASET', 'CUSTOMER_DUPLICATE_REVIEW'
    )),
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
      'DEMO_DATASET_PURGED',
      'CUSTOMER_DUPLICATE_REVIEW_DECIDED',
      'CUSTOMER_DUPLICATE_REVIEW_REOPENED'
    ));
