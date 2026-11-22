-- OVR-6: lateness alert delivery state and the widened notification/activity
-- vocabularies for quiet-hours-gated automatic lateness alerts.
-- Accepted contract: `DECISIONS.md` OVR-6 and
-- `docs/features/lateness-notifications-quiet-hours.md` (§7.6, §7.7, §8).
--
-- Additive only: one composite UNIQUE next to the existing incident PK, one new
-- table, and two widened CHECKs that keep every earlier value. No row is
-- backfilled or rewritten; the migration executes no DML on existing rows.
--
-- The table:
--   job_card_lateness_alert_deliveries
--     Durable "this alert was sent" fact, one row per delivery identity, so a
--     restarted or concurrent worker converges instead of re-notifying. The row
--     is anchored inside the same transaction as its activity, realtime event,
--     in-app notifications and web-push delivery rows, so a delivery row can
--     never exist without its notifications (and any failure rolls back all of
--     them, leaving the next tick free to retry).
--
--     Identity per kind (kind CHECKs fix the key columns; the rest are NULL):
--       START_REMINDER           -> (job, planned_start_at, recipient)
--       PENDING_ACCEPTANCE_ALERT -> (job, planned_start_at)
--       APPROVAL_WAIT_ALERT      -> (job, incident_id)
--
-- The consistency foreign keys make a cross-job or cross-organization
-- reference impossible: the incident one only works because this migration
-- first adds UNIQUE (organization_id, job_card_id, id) to
-- job_card_overdue_incidents.

ALTER TABLE job_card_overdue_incidents
  ADD CONSTRAINT job_card_overdue_incidents_org_job_id_key
  UNIQUE (organization_id, job_card_id, id);

CREATE TABLE job_card_lateness_alert_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  job_card_id UUID NOT NULL,
  kind VARCHAR(30) NOT NULL,
  -- Planned start of the reminder / alert. Set for START_REMINDER and
  -- PENDING_ACCEPTANCE_ALERT, NULL for APPROVAL_WAIT_ALERT (whose identity is
  -- the incident, not a planned instant).
  planned_start_at TIMESTAMPTZ,
  -- The Staff recipient of a START_REMINDER. Management alerts have no single
  -- recipient: one row per job/instant/incident anchors them all.
  recipient_user_id UUID,
  -- The open APPROVAL_WAIT incident behind an APPROVAL_WAIT_ALERT.
  incident_id UUID,
  -- The send instant: the worker's injected `scanTime`, never a DB clock.
  sent_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_card_lateness_alert_deliveries_kind_check CHECK (
    kind IN ('START_REMINDER', 'APPROVAL_WAIT_ALERT', 'PENDING_ACCEPTANCE_ALERT')
  ),
  -- Every kind owns exactly one key shape; a half-populated or mixed row is
  -- rejected instead of silently widening an identity.
  CONSTRAINT job_card_lateness_alert_deliveries_key_shape_check CHECK (
    (
      kind = 'START_REMINDER'
      AND planned_start_at IS NOT NULL
      AND recipient_user_id IS NOT NULL
      AND incident_id IS NULL
    ) OR (
      kind = 'PENDING_ACCEPTANCE_ALERT'
      AND planned_start_at IS NOT NULL
      AND recipient_user_id IS NULL
      AND incident_id IS NULL
    ) OR (
      kind = 'APPROVAL_WAIT_ALERT'
      AND incident_id IS NOT NULL
      AND planned_start_at IS NULL
      AND recipient_user_id IS NULL
    )
  ),
  -- The delivery identity. NULLS NOT DISTINCT (PostgreSQL 15+) lets the same
  -- constraint serve every kind even though each kind leaves different key
  -- columns NULL; this is also the worker's ON CONFLICT target.
  CONSTRAINT job_card_lateness_alert_deliveries_identity_key
    UNIQUE NULLS NOT DISTINCT (
      organization_id,
      job_card_id,
      kind,
      planned_start_at,
      recipient_user_id,
      incident_id
    ),
  CONSTRAINT job_card_lateness_alert_deliveries_job_fk
    FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  -- An incident of another job or organization can never be referenced.
  CONSTRAINT job_card_lateness_alert_deliveries_incident_fk
    FOREIGN KEY (organization_id, job_card_id, incident_id)
    REFERENCES job_card_overdue_incidents (organization_id, job_card_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT job_card_lateness_alert_deliveries_recipient_fk
    FOREIGN KEY (organization_id, recipient_user_id)
    REFERENCES users (organization_id, id)
);

-- The three new in-app notification kinds become representable. The list is
-- the complete 065 vocabulary plus the new values; no existing value is
-- dropped or renamed.
ALTER TABLE in_app_notifications
  DROP CONSTRAINT in_app_notifications_kind_check,
  ADD CONSTRAINT in_app_notifications_kind_check CHECK (kind IN (
    'job.assigned',
    'job.reassigned',
    'job.awaiting_approval',
    'job.approved',
    'job.revision_requested',
    'job.cancelled',
    'job.invalidated',
    'job.note_added',
    'job.submission_reminder',
    'job.submission_auto_reminder',
    'job.submission_auto_escalation',
    'job.change_requested',
    'job.change_request_resolved',
    'job.acceptance_reminder',
    'job.assignment_declined',
    'job.acceptance_expired',
    'calendar.assigned',
    'calendar.rescheduled',
    'calendar.cancelled',
    'calendar.reminder',
    'message.received',
    'job.start_reminder',
    'job.approval_wait_alert',
    'job.pending_acceptance_alert'
  ));

-- The three new activity event types become representable. The list is the
-- complete 066 vocabulary plus the new values; no existing value is dropped or
-- renamed.
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
    'JOB_PENDING_ACCEPTANCE_ALERT_SENT'
  ));

-- Fail closed: the new table starts empty (no historical backfill), and every
-- constraint must actually exist with its accepted definition.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM job_card_lateness_alert_deliveries) <> 0 THEN
    RAISE EXCEPTION 'job_card_lateness_alert_deliveries must start empty (no historical backfill)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_org_job_id_key'
       AND contype = 'u'
       AND pg_get_constraintdef(oid) LIKE '%(organization_id, job_card_id, id)%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must keep the (organization_id, job_card_id, id) key';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_lateness_alert_deliveries'::regclass
       AND conname = 'job_card_lateness_alert_deliveries_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%START_REMINDER%'
       AND pg_get_constraintdef(oid) LIKE '%APPROVAL_WAIT_ALERT%'
       AND pg_get_constraintdef(oid) LIKE '%PENDING_ACCEPTANCE_ALERT%'
  ) THEN
    RAISE EXCEPTION 'job_card_lateness_alert_deliveries kind CHECK must accept the three kinds';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_lateness_alert_deliveries'::regclass
       AND conname = 'job_card_lateness_alert_deliveries_key_shape_check'
       AND pg_get_constraintdef(oid) LIKE '%planned_start_at%'
       AND pg_get_constraintdef(oid) LIKE '%recipient_user_id%'
       AND pg_get_constraintdef(oid) LIKE '%incident_id%'
  ) THEN
    RAISE EXCEPTION 'job_card_lateness_alert_deliveries must keep the per-kind key shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_lateness_alert_deliveries'::regclass
       AND conname = 'job_card_lateness_alert_deliveries_identity_key'
       AND contype = 'u'
       AND pg_get_constraintdef(oid) LIKE '%NULLS NOT DISTINCT%'
       AND pg_get_constraintdef(oid) LIKE '%organization_id, job_card_id, kind%'
  ) THEN
    RAISE EXCEPTION 'job_card_lateness_alert_deliveries must keep the NULLS NOT DISTINCT identity';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_lateness_alert_deliveries'::regclass
       AND conname = 'job_card_lateness_alert_deliveries_job_fk'
       AND contype = 'f'
       AND pg_get_constraintdef(oid) LIKE '%REFERENCES job_cards(organization_id, id)%'
       AND pg_get_constraintdef(oid) LIKE '%ON DELETE RESTRICT%'
  ) THEN
    RAISE EXCEPTION 'job_card_lateness_alert_deliveries must reference the same org/job';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_lateness_alert_deliveries'::regclass
       AND conname = 'job_card_lateness_alert_deliveries_incident_fk'
       AND contype = 'f'
       AND pg_get_constraintdef(oid)
         LIKE '%REFERENCES job_card_overdue_incidents(organization_id, job_card_id, id)%'
       AND pg_get_constraintdef(oid) LIKE '%ON DELETE RESTRICT%'
  ) THEN
    RAISE EXCEPTION 'job_card_lateness_alert_deliveries must bind the incident to the same org/job';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_lateness_alert_deliveries'::regclass
       AND conname = 'job_card_lateness_alert_deliveries_recipient_fk'
       AND contype = 'f'
       AND pg_get_constraintdef(oid) LIKE '%REFERENCES users(organization_id, id)%'
  ) THEN
    RAISE EXCEPTION 'job_card_lateness_alert_deliveries recipient must belong to the organization';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'in_app_notifications'::regclass
       AND conname = 'in_app_notifications_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%job.start_reminder%'
       AND pg_get_constraintdef(oid) LIKE '%job.approval_wait_alert%'
       AND pg_get_constraintdef(oid) LIKE '%job.pending_acceptance_alert%'
       -- The widened CHECK keeps every earlier value.
       AND pg_get_constraintdef(oid) LIKE '%job.assignment_declined%'
       AND pg_get_constraintdef(oid) LIKE '%message.received%'
  ) THEN
    RAISE EXCEPTION 'in_app_notifications kind CHECK must accept the lateness kinds and keep the old ones';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_activity_logs'::regclass
       AND conname = 'job_card_activity_logs_event_type_check'
       AND pg_get_constraintdef(oid) LIKE '%JOB_START_REMINDER_SENT%'
       AND pg_get_constraintdef(oid) LIKE '%JOB_APPROVAL_WAIT_ALERT_SENT%'
       AND pg_get_constraintdef(oid) LIKE '%JOB_PENDING_ACCEPTANCE_ALERT_SENT%'
       -- The widened CHECK keeps every earlier value.
       AND pg_get_constraintdef(oid) LIKE '%WEEKLY_REPORT_REMOVED%'
       AND pg_get_constraintdef(oid) LIKE '%JOB_OVERDUE_ENDED_BY_EXTENSION%'
  ) THEN
    RAISE EXCEPTION 'job_card_activity_logs event CHECK must accept the lateness events and keep the old ones';
  END IF;
END
$$;
