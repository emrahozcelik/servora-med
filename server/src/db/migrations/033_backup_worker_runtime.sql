-- BR5 backup worker runtime state.
--
-- Lease fields are installation-level ownership evidence. A lease token is an
-- opaque capability; it is never exposed through the admin DTO or logs.
ALTER TABLE backup_runs
  ADD COLUMN lease_token UUID,
  ADD COLUMN lease_until TIMESTAMPTZ,
  ADD COLUMN heartbeat_at TIMESTAMPTZ;

CREATE INDEX backup_runs_lease_expiry_idx
  ON backup_runs (lease_until, id)
  WHERE status = 'RUNNING';

-- A single durable row proves that an idle worker and its scheduler have run;
-- last_scheduled_slot_key is the transactionally consumed logical local-day
-- slot, not an in-memory "last tick" value.
CREATE TABLE backup_worker_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
  worker_heartbeat_at TIMESTAMPTZ,
  scheduler_last_tick_at TIMESTAMPTZ,
  last_scheduled_slot_key VARCHAR(200),
  last_scheduled_local_date DATE,
  last_scheduled_for TIMESTAMPTZ,
  last_scheduled_run_id UUID REFERENCES backup_runs(id),

  CONSTRAINT backup_worker_state_singleton_check CHECK (singleton),
  CONSTRAINT backup_worker_state_slot_check CHECK (
    (last_scheduled_slot_key IS NULL
      AND last_scheduled_local_date IS NULL
      AND last_scheduled_for IS NULL
      AND last_scheduled_run_id IS NULL)
    OR (last_scheduled_slot_key IS NOT NULL
      AND last_scheduled_local_date IS NOT NULL
      AND last_scheduled_for IS NOT NULL
      AND last_scheduled_run_id IS NOT NULL)
  )
);

INSERT INTO backup_worker_state (singleton)
VALUES (TRUE);

-- Scheduled/system backup audit rows have no human actor and no organization
-- scope. Existing business audit rows retain their non-null actor/org FK.
-- This is the narrow system-actor reconciliation required by BR5; no
-- arbitrary ADMIN is selected for a scheduler-created run.
ALTER TABLE audit_events
  ALTER COLUMN organization_id DROP NOT NULL,
  ALTER COLUMN actor_user_id DROP NOT NULL,
  DROP CONSTRAINT audit_events_event_type_check;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN (
    'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED',
    'USER_DEACTIVATED', 'USER_PASSWORD_RESET',
    'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED',
    'CUSTOMER_CREATED', 'CUSTOMER_FIELDS_UPDATED',
    'CUSTOMER_ASSIGNEE_CHANGED', 'CUSTOMER_ACTIVATED',
    'CUSTOMER_DEACTIVATED', 'CONTACT_CREATED',
    'CONTACT_FIELDS_UPDATED', 'CONTACT_MADE_PRIMARY',
    'CONTACT_ACTIVATED', 'CONTACT_DEACTIVATED',
    'PRODUCT_CREATED', 'PRODUCT_FIELDS_UPDATED',
    'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED',
    'CUSTOMER_DELETED', 'PRODUCT_DELETED',
    'STAFF_CONFIDENTIAL_NOTE_CREATED',
    'BACKUP_REQUESTED', 'BACKUP_POLICY_UPDATED',
    'BACKUP_STARTED', 'BACKUP_VERIFIED',
    'BACKUP_COMPLETED', 'BACKUP_FAILED'
  )),
  ADD CONSTRAINT audit_events_system_backup_actor_check
  CHECK (
    (organization_id IS NOT NULL AND actor_user_id IS NOT NULL)
    OR (
      organization_id IS NULL
      AND actor_user_id IS NULL
      AND event_type IN (
        'BACKUP_REQUESTED', 'BACKUP_STARTED', 'BACKUP_VERIFIED',
        'BACKUP_COMPLETED', 'BACKUP_FAILED'
      )
    )
  );
