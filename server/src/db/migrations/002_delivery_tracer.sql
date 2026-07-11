ALTER TABLE users
  ADD CONSTRAINT users_organization_id_id_unique UNIQUE (organization_id, id);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL CHECK (length(trim(name)) > 0),
  customer_type VARCHAR(30) NOT NULL
    CHECK (customer_type IN ('clinic', 'hospital', 'dealer', 'company', 'other')),
  tax_number VARCHAR(50),
  phone VARCHAR(50),
  email VARCHAR(255),
  city VARCHAR(100),
  district VARCHAR(100),
  address TEXT,
  assigned_staff_user_id UUID,
  status VARCHAR(20) NOT NULL DEFAULT 'prospect'
    CHECK (status IN ('prospect', 'active', 'inactive')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, assigned_staff_user_id)
    REFERENCES users (organization_id, id)
);

CREATE INDEX customers_organization_name_idx ON customers (organization_id, name);
CREATE INDEX customers_organization_assignee_idx ON customers (organization_id, assigned_staff_user_id);
CREATE INDEX customers_organization_status_idx ON customers (organization_id, status);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  sku VARCHAR(100) NOT NULL CHECK (length(trim(sku)) > 0),
  name VARCHAR(255) NOT NULL CHECK (length(trim(name)) > 0),
  brand VARCHAR(100),
  category VARCHAR(100),
  model VARCHAR(100),
  unit VARCHAR(30) NOT NULL DEFAULT 'adet' CHECK (length(trim(unit)) > 0),
  default_price NUMERIC(12,2),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, sku)
);

CREATE INDEX products_organization_name_idx ON products (organization_id, name);
CREATE INDEX products_organization_active_idx ON products (organization_id, is_active);

CREATE TABLE job_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  type VARCHAR(40) NOT NULL
    CHECK (type IN ('PRODUCT_DELIVERY', 'GENERAL_TASK')),
  status VARCHAR(30) NOT NULL DEFAULT 'NEW'
    CHECK (status IN (
      'NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL',
      'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED'
    )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  title VARCHAR(255) NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT,
  customer_id UUID,
  assigned_to UUID NOT NULL,
  created_by UUID NOT NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_date DATE,
  planned_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  staff_completed_at TIMESTAMPTZ,
  staff_completed_by UUID,
  staff_completion_note TEXT,
  manager_approved_at TIMESTAMPTZ,
  manager_approved_by UUID,
  manager_approval_note TEXT,
  revision_requested_at TIMESTAMPTZ,
  revision_requested_by UUID,
  revision_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES customers (organization_id, id),
  FOREIGN KEY (organization_id, assigned_to)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, created_by)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, staff_completed_by)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, manager_approved_by)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, revision_requested_by)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, cancelled_by)
    REFERENCES users (organization_id, id),
  CHECK (
    status <> 'WAITING_APPROVAL'
    OR (staff_completed_at IS NOT NULL AND staff_completed_by IS NOT NULL)
  ),
  CHECK (
    status <> 'COMPLETED'
    OR (
      staff_completed_at IS NOT NULL AND staff_completed_by IS NOT NULL
      AND manager_approved_at IS NOT NULL AND manager_approved_by IS NOT NULL
    )
  ),
  CHECK (
    status <> 'REVISION_REQUESTED'
    OR (
      staff_completed_at IS NOT NULL AND staff_completed_by IS NOT NULL
      AND revision_requested_at IS NOT NULL AND revision_requested_by IS NOT NULL
      AND revision_reason IS NOT NULL AND length(trim(revision_reason)) > 0
    )
  ),
  CHECK (
    status <> 'CANCELLED'
    OR (
      cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
      AND cancel_reason IS NOT NULL AND length(trim(cancel_reason)) > 0
    )
  )
);

CREATE INDEX job_cards_organization_status_idx ON job_cards (organization_id, status);
CREATE INDEX job_cards_organization_assignee_status_idx ON job_cards (organization_id, assigned_to, status);
CREATE INDEX job_cards_organization_type_status_idx ON job_cards (organization_id, type, status);
CREATE INDEX job_cards_organization_customer_idx ON job_cards (organization_id, customer_id);
CREATE INDEX job_cards_organization_created_idx ON job_cards (organization_id, created_at DESC);
CREATE INDEX job_cards_active_due_date_idx ON job_cards (organization_id, due_date)
  WHERE status IN ('NEW', 'PLANNED', 'IN_PROGRESS', 'REVISION_REQUESTED');

CREATE TABLE job_card_delivery_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  product_id UUID NOT NULL,
  delivery_purpose VARCHAR(20) NOT NULL
    CHECK (delivery_purpose IN ('SALE', 'SAMPLE', 'CONSIGNMENT', 'RETURN', 'OTHER')),
  delivered_at TIMESTAMPTZ NOT NULL,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit VARCHAR(30) NOT NULL CHECK (length(trim(unit)) > 0),
  product_name_snapshot VARCHAR(255) NOT NULL CHECK (length(trim(product_name_snapshot)) > 0),
  product_sku_snapshot VARCHAR(100),
  product_model_snapshot VARCHAR(100),
  lot_no VARCHAR(100),
  serial_no VARCHAR(100),
  expiry_date DATE,
  delivery_note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, product_id)
    REFERENCES products (organization_id, id)
);

CREATE INDEX delivery_items_job_sort_idx ON job_card_delivery_items (job_card_id, sort_order);
CREATE INDEX delivery_items_organization_job_idx ON job_card_delivery_items (organization_id, job_card_id);
CREATE INDEX delivery_items_product_time_idx ON job_card_delivery_items (organization_id, product_id, delivered_at);
CREATE INDEX delivery_items_purpose_time_idx ON job_card_delivery_items (organization_id, delivery_purpose, delivered_at);

CREATE TABLE job_card_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  actor_id UUID,
  event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
    'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_STARTED',
    'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
    'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_FIELDS_UPDATED',
    'DELIVERY_ITEM_ADDED', 'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED',
    'NOTE_ADDED'
  )),
  old_value JSONB,
  new_value JSONB,
  metadata JSONB,
  client_action_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, actor_id)
    REFERENCES users (organization_id, id)
);

CREATE INDEX activity_job_time_idx ON job_card_activity_logs (job_card_id, created_at, id);
CREATE INDEX activity_organization_time_idx ON job_card_activity_logs (organization_id, created_at DESC);
CREATE INDEX activity_organization_event_idx ON job_card_activity_logs (organization_id, event_type, created_at DESC);

CREATE TABLE processed_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL,
  client_action_id VARCHAR(255) NOT NULL CHECK (length(trim(client_action_id)) > 0),
  operation_key VARCHAR(100) NOT NULL CHECK (length(trim(operation_key)) > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  status_code INTEGER,
  response_body JSONB,
  error_code VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (organization_id, user_id, client_action_id, operation_key),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES users (organization_id, id),
  CHECK (
    status <> 'completed'
    OR (status_code IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX processed_actions_created_idx ON processed_actions (created_at);
