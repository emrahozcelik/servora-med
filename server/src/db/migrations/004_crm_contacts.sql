ALTER TABLE customers
  DROP COLUMN notes,
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE customers
  ADD CONSTRAINT customers_tax_number_normalized_check CHECK (
    tax_number IS NULL OR (
      length(tax_number) > 0
      AND tax_number = upper(regexp_replace(trim(tax_number), '[[:space:]./-]+', '', 'g'))
    )
  );

CREATE UNIQUE INDEX customers_organization_tax_number_unique
  ON customers (organization_id, tax_number)
  WHERE tax_number IS NOT NULL;

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  customer_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL CHECK (length(trim(name)) > 0),
  title VARCHAR(255),
  phone VARCHAR(50),
  email VARCHAR(255),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES customers (organization_id, id)
);

CREATE UNIQUE INDEX contacts_one_active_primary_per_customer
  ON contacts (organization_id, customer_id)
  WHERE is_primary = TRUE AND is_active = TRUE;

CREATE INDEX contacts_organization_customer_idx
  ON contacts (organization_id, customer_id);
CREATE INDEX contacts_organization_customer_active_idx
  ON contacts (organization_id, customer_id, is_active);
CREATE INDEX contacts_organization_name_idx
  ON contacts (organization_id, name);

ALTER TABLE job_cards ADD COLUMN contact_id UUID;
ALTER TABLE job_cards ADD CONSTRAINT job_cards_organization_contact_fk
  FOREIGN KEY (organization_id, contact_id)
  REFERENCES contacts (organization_id, id);

CREATE INDEX job_cards_organization_contact_idx
  ON job_cards (organization_id, contact_id);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_subject_type_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_event_type_check;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_subject_type_check CHECK (
    subject_type IN ('USER', 'STAFF_PROFILE', 'CUSTOMER', 'CONTACT')
  );

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check CHECK (event_type IN (
    'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED',
    'USER_DEACTIVATED', 'USER_PASSWORD_RESET',
    'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED',
    'CUSTOMER_CREATED', 'CUSTOMER_FIELDS_UPDATED',
    'CUSTOMER_ASSIGNEE_CHANGED', 'CUSTOMER_ACTIVATED',
    'CUSTOMER_DEACTIVATED', 'CONTACT_CREATED',
    'CONTACT_FIELDS_UPDATED', 'CONTACT_MADE_PRIMARY',
    'CONTACT_ACTIVATED', 'CONTACT_DEACTIVATED'
  ));
