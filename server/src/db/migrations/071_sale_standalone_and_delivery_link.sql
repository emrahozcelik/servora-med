-- SALE-002 (S1): standalone sales and the sale -> delivery link.
--
-- Additive only: no DML, no backfill, no snapshot fabrication. 071 must be
-- deployed before any code writes `delivery_source_sale_id` or a NULL sale
-- source (schema-first, exactly like 057/058).
--
-- The one-active-sale-per-visit rule is NOT rebuilt:
-- `job_cards_one_active_sale_per_visit_idx` stays exactly as 057 created it.
-- A standalone sale stores `sale_source_visit_id = NULL`, and NULL values are
-- distinct in a PostgreSQL unique btree, so any number of standalone sales may
-- coexist without colliding with that slot index.
--
-- Cross-table invariant a CHECK cannot express:
--   `job_cards.sale_source_visit_id IS NULL`
--     <=> `job_card_sale_details.source_visit_version IS NULL`.
-- It spans two tables, so both writers enforce it: the visit-origin create
-- writes both, the standalone create writes neither. A future reader must not
-- assume the database proves it.

-- R1/R8: a SALE may exist without a source visit and only a SALE may carry
-- one; a PRODUCT_DELIVERY may point at the one sale it was created from.
ALTER TABLE job_cards
  DROP CONSTRAINT job_cards_sale_source_present_check,
  ADD CONSTRAINT job_cards_sale_source_type_check
    CHECK (sale_source_visit_id IS NULL OR type = 'SALE'),
  ADD COLUMN delivery_source_sale_id UUID,
  ADD CONSTRAINT job_cards_delivery_source_sale_fk
    FOREIGN KEY (organization_id, delivery_source_sale_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT job_cards_delivery_source_type_check
    CHECK (delivery_source_sale_id IS NULL OR type = 'PRODUCT_DELIVERY'),
  -- The composite FK proves same-organization existence only; it cannot prove
  -- the target is a SALE. The service verifies `source.type = 'SALE'` under
  -- lock; this CHECK only forbids a card linking to itself.
  ADD CONSTRAINT job_cards_delivery_source_self_check
    CHECK (delivery_source_sale_id IS DISTINCT FROM id);

-- R8: at most one delivery per sale, ever. Cancelled/invalidated deliveries
-- keep the slot (D4: no partial deliveries; a replacement is a separate future
-- decision).
CREATE UNIQUE INDEX job_cards_one_delivery_per_sale_idx
  ON job_cards (organization_id, delivery_source_sale_id)
  WHERE delivery_source_sale_id IS NOT NULL;

-- R2: a standalone sale stores no source snapshots; a visit-origin sale stores
-- all of them. The service enforces the cross-table half of this invariant.
ALTER TABLE job_card_sale_details
  ALTER COLUMN source_visit_version DROP NOT NULL,
  ALTER COLUMN source_visit_title_snapshot DROP NOT NULL,
  ALTER COLUMN source_customer_name_snapshot DROP NOT NULL,
  ADD CONSTRAINT job_card_sale_details_source_shape_check CHECK (
    (source_visit_version IS NULL
      AND source_visit_title_snapshot IS NULL
      AND source_customer_name_snapshot IS NULL
      AND source_planned_contact_id IS NULL
      AND source_planned_contact_name_snapshot IS NULL
      AND source_planned_contact_title_snapshot IS NULL
      AND source_met_contact_id IS NULL
      AND source_met_contact_name_snapshot IS NULL
      AND source_met_contact_title_snapshot IS NULL)
    OR (source_visit_version IS NOT NULL AND source_visit_version > 0
      AND source_visit_title_snapshot IS NOT NULL
      AND length(trim(source_visit_title_snapshot)) > 0
      AND source_customer_name_snapshot IS NOT NULL
      AND length(trim(source_customer_name_snapshot)) > 0));

-- R13: the sale-approval delivery is its own assignment-offer producer. The
-- list is the complete 065 vocabulary plus the new reason.
ALTER TABLE job_card_assignment_offers
  DROP CONSTRAINT job_card_assignment_offers_opened_reason_check,
  ADD CONSTRAINT job_card_assignment_offers_opened_reason_check CHECK (opened_reason IN (
    'CREATE', 'REASSIGN', 'RESCHEDULE', 'FOLLOW_UP_CREATE',
    'APPROVE_FOLLOW_UP', 'CANCEL_REPLACEMENT', 'OFFBOARDING_TRANSFER',
    'REOFFER', 'SALE_APPROVAL'));

-- R14: one canonical fact on the sale when the approval opens a delivery. The
-- list is the complete 069 vocabulary plus the new event; no existing value is
-- dropped or renamed.
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
    'SALE_ITEM_REMOVED',
    'JOB_EARLY_START_AUTHORIZED',
    'JOB_CHANGE_REQUESTED',
    'JOB_CHANGE_REQUEST_RESOLVED',
    'JOB_ASSIGNMENT_OFFER_OPENED',
    'JOB_ASSIGNMENT_REMINDER_SENT',
    'JOB_ASSIGNMENT_DECLINED',
    'JOB_ASSIGNMENT_RELEASED',
    'JOB_ASSIGNMENT_OFFER_EXPIRED',
    'JOB_ASSIGNMENT_OFFER_WITHDRAWN',
    'JOB_OVERDUE_ENDED_BY_EXTENSION',
    'JOB_START_REMINDER_SENT',
    'JOB_APPROVAL_WAIT_ALERT_SENT',
    'JOB_PENDING_ACCEPTANCE_ALERT_SENT',
    'SALE_DELIVERY_CREATED'
  ));

-- R8 precision: a sale-linked delivery can never also be a follow-up child.
ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_delivery_source_not_follow_up_check
    CHECK (delivery_source_sale_id IS NULL OR source_job_card_id IS NULL);

-- Fail closed: the new fact columns must start empty (no historical backfill),
-- the replaced constraint must be gone, every new constraint and the unique
-- index must exist with the accepted definition, and the source snapshots must
-- actually be nullable.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM job_cards WHERE delivery_source_sale_id IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'job_cards must not be pre-populated with sale-linked deliveries';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_cards'::regclass
       AND conname = 'job_cards_sale_source_present_check'
  ) THEN
    RAISE EXCEPTION 'job_cards must no longer require a source visit for every sale';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_cards'::regclass
       AND conname = 'job_cards_sale_source_type_check'
       AND pg_get_constraintdef(oid) LIKE '%sale_source_visit_id IS NULL%'
       AND pg_get_constraintdef(oid) LIKE '%SALE%'
  ) THEN
    RAISE EXCEPTION 'job_cards must allow a standalone sale and forbid a non-sale source';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_cards'::regclass
       AND conname = 'job_cards_delivery_source_sale_fk'
       AND contype = 'f'
       AND pg_get_constraintdef(oid) LIKE '%delivery_source_sale_id%'
       AND pg_get_constraintdef(oid) LIKE '%ON DELETE RESTRICT%'
  ) THEN
    RAISE EXCEPTION 'job_cards must keep the sale -> delivery foreign key';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_cards'::regclass
       AND conname = 'job_cards_delivery_source_type_check'
       AND pg_get_constraintdef(oid) LIKE '%PRODUCT_DELIVERY%'
  ) THEN
    RAISE EXCEPTION 'job_cards must keep the PRODUCT_DELIVERY-only delivery link';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_cards'::regclass
       AND conname = 'job_cards_delivery_source_self_check'
       AND pg_get_constraintdef(oid) LIKE '%IS DISTINCT FROM id%'
  ) THEN
    RAISE EXCEPTION 'job_cards must reject a self-linked sale delivery';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_cards'::regclass
       AND conname = 'job_cards_delivery_source_not_follow_up_check'
       AND pg_get_constraintdef(oid) LIKE '%source_job_card_id IS NULL%'
  ) THEN
    RAISE EXCEPTION 'job_cards must exclude a sale-linked follow-up child';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname = 'job_cards_one_delivery_per_sale_idx'
       AND indexdef LIKE 'CREATE UNIQUE INDEX%'
       AND indexdef LIKE '%delivery_source_sale_id IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'job_cards must keep at most one delivery per sale';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname = 'job_cards_one_active_sale_per_visit_idx'
       AND indexdef LIKE 'CREATE UNIQUE INDEX%'
       AND indexdef LIKE '%sale_source_visit_id%'
       AND indexdef LIKE '%SALE%'
       AND indexdef LIKE '%WAITING_APPROVAL%'
  ) THEN
    RAISE EXCEPTION 'the one-active-sale-per-visit slot index must stay intact';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_sale_details'::regclass
       AND conname = 'job_card_sale_details_source_shape_check'
       AND pg_get_constraintdef(oid) LIKE '%source_visit_version IS NULL%'
       AND pg_get_constraintdef(oid) LIKE '%source_met_contact_id IS NULL%'
  ) THEN
    RAISE EXCEPTION 'job_card_sale_details must keep the all-or-none source shape';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'job_card_sale_details'
         AND column_name IN ('source_visit_version','source_visit_title_snapshot','source_customer_name_snapshot')
         AND is_nullable = 'NO') <> 0 THEN
    RAISE EXCEPTION 'job_card_sale_details source snapshots must be nullable for a standalone sale';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_assignment_offers'::regclass
       AND conname = 'job_card_assignment_offers_opened_reason_check'
       AND pg_get_constraintdef(oid) LIKE '%SALE_APPROVAL%'
       AND pg_get_constraintdef(oid) LIKE '%REOFFER%'
  ) THEN
    RAISE EXCEPTION 'job_card_assignment_offers must accept SALE_APPROVAL and keep the old reasons';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_activity_logs'::regclass
       AND conname = 'job_card_activity_logs_event_type_check'
       AND pg_get_constraintdef(oid) LIKE '%SALE_DELIVERY_CREATED%'
       AND pg_get_constraintdef(oid) LIKE '%SALE_FROM_VISIT_CREATED%'
  ) THEN
    RAISE EXCEPTION 'job_card_activity_logs must accept SALE_DELIVERY_CREATED and keep the old events';
  END IF;
END
$$;
