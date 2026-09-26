-- OVR-4: LATE_SUBMISSION operational visibility, automatic reminder/escalation
-- and the manual management reminder fact.
--
-- Scope (deliberately narrow):
--   * NO new delay type. The existing LATE_START / LATE_SUBMISSION /
--     APPROVAL_WAIT contract, the immutable incident identity and the shared
--     breach producer stay untouched.
--   * The reminder/escalation side-effect is an *age-based projection* of an
--     already-materialized open LATE_SUBMISSION incident. The scanner keeps
--     owning breach truth; this migration adds only delivery state and one new
--     immutable management fact.
--
-- Additive and backward-compatible:
--   * no column on job_card_overdue_incidents is altered and no row is
--     rewritten; the only change to that table is a redundant UNIQUE on
--     (organization_id, id) that enables a tenant-safe composite FK;
--   * no historical backfill anywhere. Old manager reminders did not exist, so
--     post-reminder measurement stays NULL for pre-OVR-4 jobs (never guessed);
--   * every widened CHECK only ADDS values.

-- ---------------------------------------------------------------------------
-- Tenant-safe composite FK target on the immutable incident table.
-- `id` is already the PRIMARY KEY, so this UNIQUE is redundant for uniqueness
-- and exists purely so child tables can declare
-- FOREIGN KEY (organization_id, incident_id) — the same pattern job_cards and
-- job_card_schedule_revisions already use.
-- ---------------------------------------------------------------------------
ALTER TABLE job_card_overdue_incidents
  ADD CONSTRAINT job_card_overdue_incidents_org_id_key
    UNIQUE (organization_id, id);

-- ---------------------------------------------------------------------------
-- Automatic reminder / escalation delivery state.
--
-- One row per (job card, delay type, SUBMISSION EPISODE, reminder kind). The
-- episode — not the incident — is the identity on purpose: a retroactive
-- schedule revision legitimately creates a second immutable incident for the
-- SAME submission episode, and the employee must still be reminded exactly
-- once. `incident_id` records the triggering breach (the earliest open one for
-- that episode) for traceability; it is not the uniqueness key.
--
-- That identity IS the idempotency contract: a duplicate scanner tick, a
-- process restart or a second server instance converges on the same row
-- instead of delivering twice. The row is NOT domain history — the incident
-- stays the single source of breach truth.
--
-- State machine (lease-based, mirrors calendar_reminders):
--   PENDING   due, not yet claimed
--   CLAIMED   leased by one worker instance (lease_token/lease_until)
--   PROJECTED exactly one realtime event + notification fan-out committed
--   CANCELLED the incident recovered or the job left the submission phase
--             before delivery — nothing is sent
--   ABANDONED retries exhausted
--
-- due_at is the first instant the kind became due (breached_at + threshold).
-- It is persisted so the delivery instant is auditable after a policy change.
-- ---------------------------------------------------------------------------
CREATE TABLE job_card_overdue_incident_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  incident_id UUID NOT NULL,
  job_card_id UUID NOT NULL,
  delay_type VARCHAR(20) NOT NULL,
  episode_no INTEGER NOT NULL,
  reminder_kind VARCHAR(30) NOT NULL,
  state VARCHAR(20) NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code VARCHAR(50),
  projected_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT job_card_overdue_incident_reminders_kind_check
    CHECK (reminder_kind IN ('STAFF_SUBMISSION_REMINDER', 'MANAGEMENT_ESCALATION')),
  -- Widened to the incident delay-type contract instead of pinning
  -- LATE_SUBMISSION: the worker targets one delay type today, and a future
  -- slice must not need a schema change to project another one.
  CONSTRAINT job_card_overdue_incident_reminders_delay_type_check
    CHECK (delay_type IN ('LATE_START', 'LATE_SUBMISSION', 'APPROVAL_WAIT')),
  CONSTRAINT job_card_overdue_incident_reminders_state_check
    CHECK (state IN ('PENDING', 'CLAIMED', 'PROJECTED', 'CANCELLED', 'ABANDONED')),
  CONSTRAINT job_card_overdue_incident_reminders_attempt_check
    CHECK (attempt_count >= 0),
  CONSTRAINT job_card_overdue_incident_reminders_episode_check
    CHECK (episode_no >= 1),
  CONSTRAINT job_card_overdue_incident_reminders_lease_check
    CHECK (
      (state = 'CLAIMED' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
      OR (state <> 'CLAIMED' AND lease_token IS NULL AND lease_until IS NULL)
    ),
  CONSTRAINT job_card_overdue_incident_reminders_due_check
    CHECK (due_at <= next_attempt_at),
  -- The one-delivery-per-(episode, kind) identity.
  CONSTRAINT job_card_overdue_incident_reminders_identity_key
    UNIQUE (organization_id, job_card_id, delay_type, episode_no, reminder_kind),
  CONSTRAINT job_card_overdue_incident_reminders_incident_fk
    FOREIGN KEY (organization_id, incident_id)
    REFERENCES job_card_overdue_incidents (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT job_card_overdue_incident_reminders_job_fk
    FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX job_card_overdue_incident_reminders_claim_idx
  ON job_card_overdue_incident_reminders (state, next_attempt_at, id);

CREATE INDEX job_card_overdue_incident_reminders_job_idx
  ON job_card_overdue_incident_reminders (organization_id, job_card_id);

-- ---------------------------------------------------------------------------
-- Immutable manual management reminder fact.
--
-- The automatic side-effect above is a projection and may be CANCELLED; this
-- table is the opposite: an append-only record that a named manager actually
-- asked a named employee to submit. `sent_at` is the injected request clock
-- (never NOW(), never a mutable updated_at), so
-- `postReminderDelay = recovered_at - sent_at` is measurable after the fact.
--
-- UNIQUE (organization_id, actor_user_id, client_action_id) is the
-- double-click / retry guard: the same clientActionId from the same manager can
-- never append two facts. The processed_actions receipt above it additionally
-- replays the stored response for an exact re-submission.
-- ---------------------------------------------------------------------------
CREATE TABLE job_card_submission_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  incident_id UUID NOT NULL,
  delay_type VARCHAR(20) NOT NULL,
  episode_no INTEGER NOT NULL,
  actor_user_id UUID NOT NULL,
  target_user_id UUID NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  client_action_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT job_card_submission_reminders_client_action_key
    UNIQUE (organization_id, actor_user_id, client_action_id),
  CONSTRAINT job_card_submission_reminders_client_action_check
    CHECK (length(trim(client_action_id)) > 0),
  CONSTRAINT job_card_submission_reminders_delay_type_check
    CHECK (delay_type IN ('LATE_START', 'LATE_SUBMISSION', 'APPROVAL_WAIT')),
  CONSTRAINT job_card_submission_reminders_episode_check
    CHECK (episode_no >= 1),
  CONSTRAINT job_card_submission_reminders_incident_fk
    FOREIGN KEY (organization_id, incident_id)
    REFERENCES job_card_overdue_incidents (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT job_card_submission_reminders_job_fk
    FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT job_card_submission_reminders_actor_fk
    FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT job_card_submission_reminders_target_fk
    FOREIGN KEY (organization_id, target_user_id)
    REFERENCES users (organization_id, id)
);

-- Episode-scoped measurement read (`recoveredAt - latest sentAt`), which must
-- survive a retroactive revision that produced a second incident for the same
-- episode.
CREATE INDEX job_card_submission_reminders_episode_idx
  ON job_card_submission_reminders
     (organization_id, job_card_id, delay_type, episode_no, sent_at DESC, id DESC);

CREATE INDEX job_card_submission_reminders_incident_idx
  ON job_card_submission_reminders (organization_id, incident_id, sent_at, id);

-- ---------------------------------------------------------------------------
-- Realtime source for the worker-generated reminder events.
--
-- An automatic reminder owns no job_card_activity_logs row (it is not a user
-- action), so it cannot satisfy the exact-one-source invariant through
-- source_activity_id. Following the staff_note_id precedent (migration 023),
-- the reminder row itself becomes the event's source and the invariant is
-- extended — never relaxed.
-- ---------------------------------------------------------------------------
ALTER TABLE realtime_events
  ADD COLUMN overdue_reminder_id UUID,
  DROP CONSTRAINT realtime_events_activity_source_check,
  DROP CONSTRAINT realtime_events_event_type_check,
  DROP CONSTRAINT realtime_events_entity_type_check;

ALTER TABLE realtime_events
  ADD CONSTRAINT realtime_events_overdue_reminder_fk
    FOREIGN KEY (overdue_reminder_id)
    REFERENCES job_card_overdue_incident_reminders(id) ON DELETE CASCADE,
  ADD CONSTRAINT realtime_events_overdue_reminder_unique
    UNIQUE (overdue_reminder_id),
  ADD CONSTRAINT realtime_events_activity_source_check CHECK (
    (
      event_type <> 'notification.state_changed'
      AND (
        (source_activity_id IS NOT NULL)::INTEGER
        + (calendar_activity_id IS NOT NULL)::INTEGER
        + (calendar_reminder_id IS NOT NULL)::INTEGER
        + (messaging_activity_id IS NOT NULL)::INTEGER
        + (staff_note_id IS NOT NULL)::INTEGER
        + (overdue_reminder_id IS NOT NULL)::INTEGER = 1
      )
    )
    OR (
      event_type = 'notification.state_changed'
      AND source_activity_id IS NULL
      AND calendar_activity_id IS NULL
      AND calendar_reminder_id IS NULL
      AND messaging_activity_id IS NULL
      AND staff_note_id IS NULL
      AND overdue_reminder_id IS NULL
    )
  ),
  ADD CONSTRAINT realtime_events_event_type_check CHECK (event_type IN (
    'job.created',
    'job.assignment_changed',
    'job.accepted',
    'job.started',
    'job.submitted_for_approval',
    'job.approved',
    'job.revision_requested',
    'job.cancelled',
    'job.invalidated',
    'job.updated',
    'calendar.created',
    'calendar.updated',
    'calendar.cancelled',
    'calendar.reminder_due',
    'message.sent',
    'conversation.created',
    'confidential-note.created',
    'conversation.participants_changed',
    'notification.state_changed',
    'job.submission_reminder_due',
    'job.submission_escalation_due'
  )),
  ADD CONSTRAINT realtime_events_entity_type_check CHECK (entity_type IN (
    'job-card',
    'calendar-event',
    'conversation',
    'confidential-note',
    'notification-center'
  ));

-- ---------------------------------------------------------------------------
-- Notification kinds for the two automatic projections.
-- ---------------------------------------------------------------------------
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
    'job.submission_escalation',
    'calendar.assigned',
    'calendar.rescheduled',
    'calendar.cancelled',
    'calendar.reminder',
    'message.received'
  ));

-- ---------------------------------------------------------------------------
-- Audit event for the manual management reminder.
-- ---------------------------------------------------------------------------
ALTER TABLE job_card_activity_logs
  DROP CONSTRAINT job_card_activity_logs_event_type_check,
  ADD CONSTRAINT job_card_activity_logs_event_type_check CHECK (event_type IN (
    'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_ACCEPTED', 'JOB_STARTED',
    'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
    'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_INVALIDATED', 'JOB_FIELDS_UPDATED',
    'DELIVERY_ITEM_ADDED', 'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED',
    'NOTE_ADDED', 'MEETING_DETAILS_UPDATED', 'JOB_APPROVAL_WITHDRAWN',
    'JOB_SUBMISSION_REMINDER_SENT'
  ));

-- Fail closed if any contract did not actually widen: a partially applied
-- migration must abort instead of leaving a writer that cannot persist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'realtime_events'::regclass
       AND conname = 'realtime_events_event_type_check'
       AND pg_get_constraintdef(oid) LIKE '%job.submission_reminder_due%'
  ) THEN
    RAISE EXCEPTION 'realtime_events event_type CHECK must accept job.submission_reminder_due';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'realtime_events'::regclass
       AND conname = 'realtime_events_activity_source_check'
       AND pg_get_constraintdef(oid) LIKE '%overdue_reminder_id%'
  ) THEN
    RAISE EXCEPTION 'realtime_events activity source CHECK must accept overdue_reminder_id';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'in_app_notifications'::regclass
       AND conname = 'in_app_notifications_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%job.submission_escalation%'
  ) THEN
    RAISE EXCEPTION 'in_app_notifications kind CHECK must accept job.submission_escalation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_activity_logs'::regclass
       AND conname = 'job_card_activity_logs_event_type_check'
       AND pg_get_constraintdef(oid) LIKE '%JOB_SUBMISSION_REMINDER_SENT%'
  ) THEN
    RAISE EXCEPTION 'job_card_activity_logs event_type CHECK must accept JOB_SUBMISSION_REMINDER_SENT';
  END IF;
END
$$;
