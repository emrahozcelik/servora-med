-- OVR-4: LATE_SUBMISSION operational closure (reminder / escalation / manual nudge).
--
-- The OVR-2 immutable incident contract and the shared OVR-2/OVR-3 breach
-- producer are untouched: this migration adds ONLY side-effect / fact tables
-- for what happens *after* a LATE_SUBMISSION breach is materialized, plus the
-- CHECK widening those side effects need to be representable.
--
-- Tables:
--   job_card_overdue_notification_deliveries
--     Durable once-per-episode delivery state for the automatic side effects.
--     One row per (job, delay, episode, kind): the UNIQUE identity absorbs
--     scanner repeats, restarts and concurrent workers, so the same breach
--     episode never nags twice. `sent_at` is the injected domain clock, never
--     DB NOW(); `recorded_at` keeps the DB default as persistence metadata.
--   job_card_submission_reminders
--     Immutable manual manager-reminder facts. One row per manager action;
--     the UNIQUE (manager, client_action_id, operation_key) identity absorbs
--     double-click replays. `sent_at` is the injected request clock so the
--     post-reminder delay is measurable without guessing from activity
--     `created_at` (DB clock) or mutable `updated_at`.
--
-- No backfill: both tables start empty. Historical reminder timestamps are
-- never fabricated, so legacy episodes report their reminder fields as NULL.
--
-- Additive only: no column is added to an existing table, no existing row is
-- modified, every new constraint/index name is deterministic.

CREATE TABLE job_card_overdue_notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  delay_type VARCHAR(20) NOT NULL
    CHECK (delay_type = 'LATE_SUBMISSION'),
  episode_no INTEGER NOT NULL CHECK (episode_no >= 1),
  kind VARCHAR(30) NOT NULL
    CHECK (kind IN ('STAFF_REMINDER', 'MANAGEMENT_ESCALATION')),
  incident_id UUID NOT NULL
    REFERENCES job_card_overdue_incidents(id) ON DELETE RESTRICT,
  sent_at TIMESTAMPTZ NOT NULL,
  recipient_user_id UUID,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Once per breach episode per kind: repeats, restarts and concurrent
  -- workers converge here instead of duplicating notifications.
  UNIQUE (organization_id, job_card_id, delay_type, episode_no, kind),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, recipient_user_id)
    REFERENCES users (organization_id, id)
);

CREATE INDEX job_card_overdue_notification_deliveries_job_time_idx
  ON job_card_overdue_notification_deliveries (organization_id, job_card_id, sent_at DESC, id DESC);

CREATE INDEX job_card_overdue_notification_deliveries_incident_idx
  ON job_card_overdue_notification_deliveries (incident_id);

CREATE TABLE job_card_submission_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  incident_id UUID NOT NULL
    REFERENCES job_card_overdue_incidents(id) ON DELETE RESTRICT,
  episode_no INTEGER NOT NULL CHECK (episode_no >= 1),
  schedule_revision_no INTEGER NOT NULL CHECK (schedule_revision_no >= 1),
  manager_user_id UUID NOT NULL,
  target_staff_user_id UUID NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  client_action_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Double-click / replay identity: the same manager action converges here
  -- instead of duplicating facts, activities or notifications.
  UNIQUE (organization_id, manager_user_id, client_action_id, operation_key),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, manager_user_id)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, target_staff_user_id)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, job_card_id, schedule_revision_no)
    REFERENCES job_card_schedule_revisions (organization_id, job_card_id, revision_no)
    ON DELETE RESTRICT
);

CREATE INDEX job_card_submission_reminders_job_episode_idx
  ON job_card_submission_reminders (organization_id, job_card_id, episode_no, sent_at DESC, id DESC);

-- Manual + automatic reminder activity facts become representable in the
-- append-only activity ledger. The ledger stays append-only: no existing
-- event type is renamed or removed.
ALTER TABLE job_card_activity_logs
  DROP CONSTRAINT job_card_activity_logs_event_type_check,
  ADD CONSTRAINT job_card_activity_logs_event_type_check CHECK (event_type IN (
    'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_ACCEPTED', 'JOB_STARTED',
    'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
    'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_INVALIDATED', 'JOB_FIELDS_UPDATED',
    'DELIVERY_ITEM_ADDED', 'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED',
    'NOTE_ADDED', 'MEETING_DETAILS_UPDATED', 'JOB_APPROVAL_WITHDRAWN',
    'JOB_SUBMISSION_REMINDER_SENT',
    'JOB_SUBMISSION_AUTO_REMINDER_SENT',
    'JOB_SUBMISSION_AUTO_ESCALATION_SENT'
  ));

-- The three new notification kinds become representable. No existing kind is
-- renamed or removed.
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
    'calendar.assigned',
    'calendar.rescheduled',
    'calendar.cancelled',
    'calendar.reminder',
    'message.received'
  ));

-- Fail closed: delivery/reminder history starts empty; history is never
-- backfilled, and the CHECK contracts must actually widen.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM job_card_overdue_notification_deliveries) <> 0 THEN
    RAISE EXCEPTION 'job_card_overdue_notification_deliveries must start empty (no historical backfill)';
  END IF;
  IF (SELECT COUNT(*) FROM job_card_submission_reminders) <> 0 THEN
    RAISE EXCEPTION 'job_card_submission_reminders must start empty (no historical backfill)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_activity_logs'::regclass
       AND conname = 'job_card_activity_logs_event_type_check'
       AND pg_get_constraintdef(oid) LIKE '%JOB_SUBMISSION_REMINDER_SENT%'
  ) THEN
    RAISE EXCEPTION 'job_card_activity_logs event CHECK must accept JOB_SUBMISSION_REMINDER_SENT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'in_app_notifications'::regclass
       AND conname = 'in_app_notifications_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%job.submission_reminder%'
  ) THEN
    RAISE EXCEPTION 'in_app_notifications kind CHECK must accept job.submission_reminder';
  END IF;
END
$$;
