-- Visit-to-Sale V1: independent product agreement, never a delivery or follow-up.
-- No historical backfill. Cross-row source eligibility is checked under service locks.
-- The source requirement is this slice's policy; standalone orders need a later design/migration.
ALTER TABLE job_cards
  DROP CONSTRAINT job_cards_type_check,
  ADD CONSTRAINT job_cards_type_check CHECK (type IN (
    'PRODUCT_DELIVERY','GENERAL_TASK','SALES_MEETING','WEEKLY_REPORT','SALE'
  )),
  ADD COLUMN sale_source_visit_id UUID,
  ADD CONSTRAINT job_cards_sale_source_visit_fk
    FOREIGN KEY (organization_id, sale_source_visit_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT job_cards_sale_source_present_check
    CHECK ((type = 'SALE') = (sale_source_visit_id IS NOT NULL)),
  ADD CONSTRAINT job_cards_sale_source_self_check
    CHECK (sale_source_visit_id IS DISTINCT FROM id),
  ADD CONSTRAINT job_cards_sale_fields_check CHECK (type <> 'SALE' OR (
    customer_id IS NOT NULL AND data_class = 'BUSINESS'
    AND contact_id IS NULL AND engagement_kind IS NULL
    AND scheduled_at IS NULL AND scheduled_ends_at IS NULL AND due_date IS NULL
    AND source_job_card_id IS NULL AND follow_up_instructions IS NULL
    AND follow_up_proposed_at IS NULL AND follow_up_proposed_type IS NULL
    AND follow_up_proposed_assignee IS NULL AND follow_up_proposal_instructions IS NULL
    AND follow_up_proposal_origin IS NULL AND follow_up_proposed_by IS NULL
  ));

CREATE UNIQUE INDEX job_cards_one_active_sale_per_visit_idx
  ON job_cards (organization_id, sale_source_visit_id)
  WHERE type = 'SALE' AND status IN (
    'NEW','ACCEPTED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED'
  );
CREATE INDEX job_cards_sale_source_history_idx
  ON job_cards (organization_id, sale_source_visit_id, created_at DESC, id DESC)
  WHERE sale_source_visit_id IS NOT NULL;

CREATE TABLE job_card_sale_details (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID PRIMARY KEY,
  sold_at TIMESTAMPTZ NOT NULL CHECK (isfinite(sold_at)),
  sale_contact_id UUID,
  sale_contact_name_snapshot VARCHAR(255),
  sale_contact_title_snapshot VARCHAR(255),
  source_visit_version INTEGER NOT NULL CHECK (source_visit_version > 0),
  source_visit_title_snapshot VARCHAR(255) NOT NULL CHECK (length(trim(source_visit_title_snapshot)) > 0),
  source_customer_name_snapshot VARCHAR(255) NOT NULL CHECK (length(trim(source_customer_name_snapshot)) > 0),
  source_planned_contact_id UUID,
  source_planned_contact_name_snapshot VARCHAR(255),
  source_planned_contact_title_snapshot VARCHAR(255),
  source_met_contact_id UUID,
  source_met_contact_name_snapshot VARCHAR(255),
  source_met_contact_title_snapshot VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, job_card_id),
  FOREIGN KEY (organization_id, job_card_id) REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, sale_contact_id) REFERENCES contacts (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_planned_contact_id) REFERENCES contacts (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_met_contact_id) REFERENCES contacts (organization_id, id) ON DELETE RESTRICT,
  CHECK ((sale_contact_id IS NULL AND sale_contact_name_snapshot IS NULL AND sale_contact_title_snapshot IS NULL)
    OR (sale_contact_id IS NOT NULL AND sale_contact_name_snapshot IS NOT NULL AND length(trim(sale_contact_name_snapshot)) > 0)),
  CHECK ((source_planned_contact_id IS NULL AND source_planned_contact_name_snapshot IS NULL AND source_planned_contact_title_snapshot IS NULL)
    OR (source_planned_contact_id IS NOT NULL AND source_planned_contact_name_snapshot IS NOT NULL AND length(trim(source_planned_contact_name_snapshot)) > 0)),
  CHECK ((source_met_contact_id IS NULL AND source_met_contact_name_snapshot IS NULL AND source_met_contact_title_snapshot IS NULL)
    OR (source_met_contact_id IS NOT NULL AND source_met_contact_name_snapshot IS NOT NULL AND length(trim(source_met_contact_name_snapshot)) > 0))
);
CREATE INDEX sale_details_contact_idx ON job_card_sale_details (organization_id, sale_contact_id);
CREATE INDEX sale_details_planned_contact_idx ON job_card_sale_details (organization_id, source_planned_contact_id);
CREATE INDEX sale_details_met_contact_idx ON job_card_sale_details (organization_id, source_met_contact_id);

CREATE TABLE job_card_sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  product_id UUID NOT NULL,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity >= 0.001 AND quantity <= 999999999.999),
  product_name_snapshot VARCHAR(255) NOT NULL CHECK (length(trim(product_name_snapshot)) > 0),
  product_sku_snapshot VARCHAR(100),
  product_brand_snapshot VARCHAR(100),
  product_model_snapshot VARCHAR(100),
  unit_snapshot VARCHAR(30),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, job_card_id, product_id),
  FOREIGN KEY (organization_id, job_card_id) REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, product_id) REFERENCES products (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX sale_items_job_sort_idx ON job_card_sale_items (organization_id, job_card_id, sort_order, id);
CREATE INDEX sale_items_product_idx ON job_card_sale_items (organization_id, product_id);

ALTER TABLE job_card_activity_logs
  DROP CONSTRAINT job_card_activity_logs_event_type_check,
  ADD CONSTRAINT job_card_activity_logs_event_type_check CHECK (event_type IN (
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
