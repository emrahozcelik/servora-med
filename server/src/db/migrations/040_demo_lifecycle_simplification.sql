-- D4: make Demo data disposable after a successful purge.
--
-- The purge operation remains only as technical idempotency metadata. Demo
-- business state is not retained as a PURGED registry/domain row.

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
      'JOB_CARD_INVALIDATED', 'DEMO_DATASET_CREATED',
      'DEMO_DATASET_PURGED'
    ));

-- A technical receipt must survive deletion of the domain registry row so a
-- lost HTTP response can be retried safely. It is intentionally not a domain
-- foreign key and is never returned by the Demo dataset list/detail queries.
ALTER TABLE demo_dataset_purge_operations
  DROP CONSTRAINT demo_dataset_purge_operations_dataset_fk;

-- Do not leave a legacy in-flight operation in an indeterminate state while
-- changing the meaning of the receipt table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM demo_dataset_purge_operations
    WHERE status = 'PROCESSING'
  ) THEN
    RAISE EXCEPTION 'D4 cannot reconcile an in-flight Demo purge operation'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- Normalize retained R2 receipts to the minimal D4 technical shape. This
-- removes the old PURGED dataset DTO from the receipt while preserving the
-- retry identity, plan, counts, and completion timestamp.
UPDATE demo_dataset_purge_operations AS operation
SET response_body = jsonb_build_object(
  'operationId', operation.id::text,
  'status', 'COMPLETED',
  'datasetId', operation.dataset_id::text,
  'datasetKey', operation.dataset_key,
  'seedVersion', operation.seed_version,
  'planHash', operation.plan_hash,
  'affectedCounts', COALESCE(
    operation.response_body->'affectedCounts',
    jsonb_build_object(
      'users', 0, 'staffProfiles', 0, 'customers', 0, 'contacts', 0,
      'products', 0, 'jobCards', 0, 'deliveryItems', 0, 'notes', 0,
      'confidentialNotes', 0, 'activities', 0, 'followUps', 0,
      'calendarEvents', 0, 'conversations', 0, 'messages', 0,
      'notifications', 0, 'reminders', 0, 'realtimeEvents', 0
    )
  ),
  'retained', jsonb_build_object(
    'auditActorDetaches', COALESCE(
      NULLIF(operation.response_body->'retained'->>'auditActorDetaches', '')::integer,
      0
    )
  ),
  'completedAt', COALESCE(operation.response_body->>'completedAt', operation.completed_at::text)
)
WHERE operation.status = 'COMPLETED';

-- Legacy PURGED rows are disposable Demo registry state. Reconcile only rows
-- whose six dataset-owned roots are already empty. Any remaining Demo root
-- aborts the migration instead of attempting broad cleanup or touching
-- BUSINESS data.
DO $$
DECLARE
  legacy RECORD;
BEGIN
  FOR legacy IN
    SELECT id, organization_id
    FROM demo_datasets
    WHERE status = 'PURGED'
    ORDER BY organization_id, id
  LOOP
    IF EXISTS (
      SELECT 1 FROM users
      WHERE organization_id = legacy.organization_id
        AND data_class = 'DEMO' AND demo_dataset_id = legacy.id
    ) OR EXISTS (
      SELECT 1 FROM customers
      WHERE organization_id = legacy.organization_id
        AND data_class = 'DEMO' AND demo_dataset_id = legacy.id
    ) OR EXISTS (
      SELECT 1 FROM products
      WHERE organization_id = legacy.organization_id
        AND data_class = 'DEMO' AND demo_dataset_id = legacy.id
    ) OR EXISTS (
      SELECT 1 FROM job_cards
      WHERE organization_id = legacy.organization_id
        AND data_class = 'DEMO' AND demo_dataset_id = legacy.id
    ) OR EXISTS (
      SELECT 1 FROM conversations
      WHERE organization_id = legacy.organization_id
        AND data_class = 'DEMO' AND demo_dataset_id = legacy.id
    ) OR EXISTS (
      SELECT 1 FROM calendar_events
      WHERE organization_id = legacy.organization_id
        AND data_class = 'DEMO' AND demo_dataset_id = legacy.id
    ) THEN
      RAISE EXCEPTION 'D4 cannot reconcile PURGED Demo dataset with remaining Demo roots: %', legacy.id
        USING ERRCODE = 'P0001';
    END IF;

    DELETE FROM demo_datasets
    WHERE organization_id = legacy.organization_id
      AND id = legacy.id
      AND status = 'PURGED';
  END LOOP;
END $$;

-- The registry now represents active disposable Demo state only. Keep the
-- legacy columns for schema compatibility, but make new PURGED tombstones
-- impossible at the database boundary.
ALTER TABLE demo_datasets
  DROP CONSTRAINT demo_datasets_status_check,
  DROP CONSTRAINT demo_datasets_status_time_check,
  DROP CONSTRAINT demo_datasets_creator_attribution_check;

ALTER TABLE demo_datasets
  ADD CONSTRAINT demo_datasets_active_status_check
    CHECK (status = 'ACTIVE' AND purged_at IS NULL),
  ADD CONSTRAINT demo_datasets_active_creator_attribution_check
    CHECK (created_by IS NOT NULL AND created_by_user_id_snapshot IS NULL);
