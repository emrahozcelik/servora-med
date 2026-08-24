-- R2A: retained purge receipts and attribution tombstones.
--
-- The demo dataset row survives as a PURGED tombstone. Purge operations are
-- retained independently from users so a lost response can be replayed even
-- after the target demo users have been deleted.

ALTER TABLE demo_datasets
  ADD COLUMN created_by_user_id_snapshot UUID,
  ALTER COLUMN created_by DROP NOT NULL,
  ADD CONSTRAINT demo_datasets_creator_attribution_check
  CHECK (
    (created_by IS NOT NULL AND created_by_user_id_snapshot IS NULL)
    OR (created_by IS NULL AND created_by_user_id_snapshot IS NOT NULL)
  );

ALTER TABLE audit_events
  ADD COLUMN actor_user_id_snapshot UUID;

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_system_backup_actor_check,
  ADD CONSTRAINT audit_events_actor_attribution_check
  CHECK (
    (
      organization_id IS NULL
      AND actor_user_id IS NULL
      AND actor_user_id_snapshot IS NULL
      AND event_type IN (
        'BACKUP_REQUESTED', 'BACKUP_STARTED', 'BACKUP_VERIFIED',
        'BACKUP_COMPLETED', 'BACKUP_FAILED'
      )
    )
    OR (
      organization_id IS NOT NULL
      AND (
        (actor_user_id IS NOT NULL AND actor_user_id_snapshot IS NULL)
        OR (actor_user_id IS NULL AND actor_user_id_snapshot IS NOT NULL)
      )
    )
  );

CREATE INDEX audit_events_actor_snapshot_idx
  ON audit_events (organization_id, actor_user_id_snapshot, created_at DESC)
  WHERE actor_user_id_snapshot IS NOT NULL;

CREATE TABLE demo_dataset_purge_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  dataset_id UUID NOT NULL,
  client_action_id UUID NOT NULL,
  plan_hash CHAR(64) NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
  requested_by_user_id_snapshot UUID NOT NULL,
  dataset_key VARCHAR(120) NOT NULL,
  seed_version VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  CONSTRAINT demo_dataset_purge_operations_dataset_fk
    FOREIGN KEY (organization_id, dataset_id)
    REFERENCES demo_datasets (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT demo_dataset_purge_operations_client_action_unique
    UNIQUE (organization_id, client_action_id),
  CONSTRAINT demo_dataset_purge_operations_status_check
    CHECK (status IN ('PROCESSING', 'COMPLETED')),
  CONSTRAINT demo_dataset_purge_operations_completion_check
    CHECK (
      (status = 'PROCESSING' AND response_body IS NULL AND completed_at IS NULL)
      OR (status = 'COMPLETED' AND response_body IS NOT NULL AND completed_at IS NOT NULL)
    ),
  CONSTRAINT demo_dataset_purge_operations_key_check
    CHECK (length(trim(dataset_key)) BETWEEN 1 AND 120),
  CONSTRAINT demo_dataset_purge_operations_version_check
    CHECK (length(trim(seed_version)) BETWEEN 1 AND 80)
);

CREATE INDEX demo_dataset_purge_operations_dataset_idx
  ON demo_dataset_purge_operations (organization_id, dataset_id, created_at DESC, id DESC);
