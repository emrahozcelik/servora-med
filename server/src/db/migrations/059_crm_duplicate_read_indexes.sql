-- CRM Slice 4A PR1: bounded BUSINESS source scan and per-customer membership probes.
-- No review state or business-row changes.
CREATE INDEX customers_duplicate_source_idx
  ON customers (organization_id, id) WHERE data_class = 'BUSINESS';

CREATE INDEX contacts_duplicate_membership_idx
  ON contacts (organization_id, customer_id, id);
