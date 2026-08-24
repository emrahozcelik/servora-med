-- R1: explicit demo data classification and dataset ownership.
--
-- Existing rows receive BUSINESS as an explicit schema default. This is not a
-- name/email/SKU inference and deliberately does not attempt to classify any
-- historical development rows as DEMO.

CREATE TABLE demo_datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  dataset_key VARCHAR(120) NOT NULL
    CHECK (length(trim(dataset_key)) BETWEEN 1 AND 120),
  seed_version VARCHAR(80) NOT NULL
    CHECK (length(trim(seed_version)) BETWEEN 1 AND 80),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'PURGED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL,
  purged_at TIMESTAMPTZ,

  CONSTRAINT demo_datasets_organization_id_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT demo_datasets_key_unique
    UNIQUE (organization_id, dataset_key),
  CONSTRAINT demo_datasets_created_by_fk
    FOREIGN KEY (organization_id, created_by)
    REFERENCES users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT demo_datasets_status_time_check
    CHECK (
      (status = 'ACTIVE' AND purged_at IS NULL)
      OR (status = 'PURGED' AND purged_at IS NOT NULL)
    )
);

CREATE INDEX demo_datasets_organization_status_idx
  ON demo_datasets (organization_id, status, created_at DESC, id DESC);

-- User and StaffProfile ownership is represented by users. Staff profiles are
-- intentionally graph-derived through their user_id instead of carrying a
-- second lineage column.
ALTER TABLE users
  ADD COLUMN data_class VARCHAR(20) NOT NULL DEFAULT 'BUSINESS',
  ADD COLUMN demo_dataset_id UUID,
  ADD CONSTRAINT users_data_class_check
    CHECK (
      (data_class = 'BUSINESS' AND demo_dataset_id IS NULL)
      OR (data_class = 'DEMO' AND demo_dataset_id IS NOT NULL)
    ),
  ADD CONSTRAINT users_demo_dataset_fk
    FOREIGN KEY (organization_id, demo_dataset_id)
    REFERENCES demo_datasets (organization_id, id) ON DELETE RESTRICT;

CREATE INDEX users_demo_dataset_idx
  ON users (organization_id, demo_dataset_id, id)
  WHERE data_class = 'DEMO';

ALTER TABLE customers
  ADD COLUMN data_class VARCHAR(20) NOT NULL DEFAULT 'BUSINESS',
  ADD COLUMN demo_dataset_id UUID,
  ADD CONSTRAINT customers_data_class_check
    CHECK (
      (data_class = 'BUSINESS' AND demo_dataset_id IS NULL)
      OR (data_class = 'DEMO' AND demo_dataset_id IS NOT NULL)
    ),
  ADD CONSTRAINT customers_demo_dataset_fk
    FOREIGN KEY (organization_id, demo_dataset_id)
    REFERENCES demo_datasets (organization_id, id) ON DELETE RESTRICT;

CREATE INDEX customers_demo_dataset_idx
  ON customers (organization_id, demo_dataset_id, id)
  WHERE data_class = 'DEMO';

ALTER TABLE products
  ADD COLUMN data_class VARCHAR(20) NOT NULL DEFAULT 'BUSINESS',
  ADD COLUMN demo_dataset_id UUID,
  ADD CONSTRAINT products_data_class_check
    CHECK (
      (data_class = 'BUSINESS' AND demo_dataset_id IS NULL)
      OR (data_class = 'DEMO' AND demo_dataset_id IS NOT NULL)
    ),
  ADD CONSTRAINT products_demo_dataset_fk
    FOREIGN KEY (organization_id, demo_dataset_id)
    REFERENCES demo_datasets (organization_id, id) ON DELETE RESTRICT;

CREATE INDEX products_demo_dataset_idx
  ON products (organization_id, demo_dataset_id, id)
  WHERE data_class = 'DEMO';

ALTER TABLE job_cards
  ADD COLUMN data_class VARCHAR(20) NOT NULL DEFAULT 'BUSINESS',
  ADD COLUMN demo_dataset_id UUID,
  ADD CONSTRAINT job_cards_data_class_check
    CHECK (
      (data_class = 'BUSINESS' AND demo_dataset_id IS NULL)
      OR (data_class = 'DEMO' AND demo_dataset_id IS NOT NULL)
    ),
  ADD CONSTRAINT job_cards_demo_dataset_fk
    FOREIGN KEY (organization_id, demo_dataset_id)
    REFERENCES demo_datasets (organization_id, id) ON DELETE RESTRICT;

CREATE INDEX job_cards_demo_dataset_idx
  ON job_cards (organization_id, demo_dataset_id, id)
  WHERE data_class = 'DEMO';

-- Conversations are independent durable aggregates. Their messages and
-- participants are graph-derived through conversation_id.
ALTER TABLE conversations
  ADD COLUMN data_class VARCHAR(20) NOT NULL DEFAULT 'BUSINESS',
  ADD COLUMN demo_dataset_id UUID,
  ADD CONSTRAINT conversations_data_class_check
    CHECK (
      (data_class = 'BUSINESS' AND demo_dataset_id IS NULL)
      OR (data_class = 'DEMO' AND demo_dataset_id IS NOT NULL)
    ),
  ADD CONSTRAINT conversations_demo_dataset_fk
    FOREIGN KEY (organization_id, demo_dataset_id)
    REFERENCES demo_datasets (organization_id, id) ON DELETE RESTRICT;

CREATE INDEX conversations_demo_dataset_idx
  ON conversations (organization_id, demo_dataset_id, id)
  WHERE data_class = 'DEMO';

-- Calendar events can exist independently of a JobCard, so they carry their
-- own root lineage. Reminders/realtime/notifications derive from their source.
ALTER TABLE calendar_events
  ADD COLUMN data_class VARCHAR(20) NOT NULL DEFAULT 'BUSINESS',
  ADD COLUMN demo_dataset_id UUID,
  ADD CONSTRAINT calendar_events_data_class_check
    CHECK (
      (data_class = 'BUSINESS' AND demo_dataset_id IS NULL)
      OR (data_class = 'DEMO' AND demo_dataset_id IS NOT NULL)
    ),
  ADD CONSTRAINT calendar_events_demo_dataset_fk
    FOREIGN KEY (organization_id, demo_dataset_id)
    REFERENCES demo_datasets (organization_id, id) ON DELETE RESTRICT;

CREATE INDEX calendar_events_demo_dataset_idx
  ON calendar_events (organization_id, demo_dataset_id, id)
  WHERE data_class = 'DEMO';
