ALTER TABLE job_cards
  ADD COLUMN scheduled_ends_at TIMESTAMPTZ NULL;

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_scheduled_interval_check
  CHECK (
    scheduled_ends_at IS NULL
    OR (scheduled_at IS NOT NULL AND scheduled_ends_at > scheduled_at)
  );

CREATE INDEX job_cards_calendar_assignee_time_idx
  ON job_cards (organization_id, assigned_to, scheduled_at, id)
  WHERE scheduled_at IS NOT NULL;

CREATE TABLE calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assigned_user_id UUID NOT NULL,
  title VARCHAR(200) NOT NULL,
  description VARCHAR(4000),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  timezone VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  cancel_reason VARCHAR(2000),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT calendar_events_organization_id_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT calendar_events_assigned_user_fk
    FOREIGN KEY (organization_id, assigned_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT calendar_events_created_by_fk
    FOREIGN KEY (organization_id, created_by)
    REFERENCES users (organization_id, id),
  CONSTRAINT calendar_events_updated_by_fk
    FOREIGN KEY (organization_id, updated_by)
    REFERENCES users (organization_id, id),
  CONSTRAINT calendar_events_cancelled_by_fk
    FOREIGN KEY (organization_id, cancelled_by)
    REFERENCES users (organization_id, id),
  CONSTRAINT calendar_events_title_check
    CHECK (length(trim(title)) BETWEEN 1 AND 200),
  CONSTRAINT calendar_events_description_check
    CHECK (description IS NULL OR length(description) <= 4000),
  CONSTRAINT calendar_events_timezone_check
    CHECK (length(trim(timezone)) BETWEEN 1 AND 100),
  CONSTRAINT calendar_events_interval_check
    CHECK (ends_at > starts_at),
  CONSTRAINT calendar_events_status_check
    CHECK (status IN ('ACTIVE', 'CANCELLED')),
  CONSTRAINT calendar_events_version_check
    CHECK (version >= 1),
  CONSTRAINT calendar_events_cancel_reason_check
    CHECK (
      cancel_reason IS NULL
      OR length(trim(cancel_reason)) BETWEEN 1 AND 2000
    ),
  CONSTRAINT calendar_events_cancelled_fields_check
    CHECK (
      (
        status = 'ACTIVE'
        AND cancelled_by IS NULL
        AND cancelled_at IS NULL
        AND cancel_reason IS NULL
      )
      OR (
        status = 'CANCELLED'
        AND cancelled_by IS NOT NULL
        AND cancelled_at IS NOT NULL
        AND cancel_reason IS NOT NULL
      )
    )
);

CREATE INDEX calendar_events_assignee_time_idx
  ON calendar_events (organization_id, assigned_user_id, starts_at, id);
CREATE INDEX calendar_events_organization_time_idx
  ON calendar_events (organization_id, starts_at, id);
CREATE INDEX calendar_events_active_interval_idx
  ON calendar_events (organization_id, assigned_user_id, starts_at, ends_at, id)
  WHERE status = 'ACTIVE';

CREATE TABLE calendar_event_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  calendar_event_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL,
  changed_fields TEXT[] NOT NULL,
  reason VARCHAR(2000),
  client_action_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT calendar_event_activity_event_fk
    FOREIGN KEY (organization_id, calendar_event_id)
    REFERENCES calendar_events (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT calendar_event_activity_actor_fk
    FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT calendar_event_activity_action_check
    CHECK (action IN ('CREATED', 'UPDATED', 'CANCELLED')),
  CONSTRAINT calendar_event_activity_fields_check
    CHECK (cardinality(changed_fields) > 0),
  CONSTRAINT calendar_event_activity_reason_check
    CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT calendar_event_activity_action_unique
    UNIQUE (organization_id, actor_user_id, client_action_id, action)
);

CREATE TABLE calendar_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_card_id UUID,
  calendar_event_id UUID,
  recipient_user_id UUID NOT NULL,
  remind_at TIMESTAMPTZ NOT NULL,
  channel VARCHAR(20) NOT NULL DEFAULT 'IN_APP',
  state VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  dedupe_key VARCHAR(500) NOT NULL,
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  last_error_code VARCHAR(80),
  projected_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT calendar_reminders_organization_id_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT calendar_reminders_identity_unique UNIQUE (dedupe_key),
  CONSTRAINT calendar_reminders_job_fk
    FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT calendar_reminders_event_fk
    FOREIGN KEY (organization_id, calendar_event_id)
    REFERENCES calendar_events (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT calendar_reminders_recipient_fk
    FOREIGN KEY (organization_id, recipient_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT calendar_reminders_source_check
    CHECK (
      (job_card_id IS NOT NULL)::INTEGER
      + (calendar_event_id IS NOT NULL)::INTEGER = 1
    ),
  CONSTRAINT calendar_reminders_channel_check
    CHECK (channel = 'IN_APP'),
  CONSTRAINT calendar_reminders_state_check
    CHECK (state IN (
      'PENDING', 'CLAIMED', 'PROJECTED', 'CANCELLED', 'ABANDONED'
    )),
  CONSTRAINT calendar_reminders_attempt_check
    CHECK (attempt_count BETWEEN 0 AND 6),
  CONSTRAINT calendar_reminders_error_check
    CHECK (
      last_error_code IS NULL
      OR length(trim(last_error_code)) BETWEEN 1 AND 80
    ),
  CONSTRAINT calendar_reminders_state_fields_check
    CHECK (
      (state = 'PENDING' AND lease_token IS NULL AND lease_until IS NULL
        AND projected_at IS NULL AND cancelled_at IS NULL AND abandoned_at IS NULL)
      OR (state = 'CLAIMED' AND lease_token IS NOT NULL AND lease_until IS NOT NULL
        AND projected_at IS NULL AND cancelled_at IS NULL AND abandoned_at IS NULL)
      OR (state = 'PROJECTED' AND lease_token IS NULL AND lease_until IS NULL
        AND projected_at IS NOT NULL AND cancelled_at IS NULL AND abandoned_at IS NULL)
      OR (state = 'CANCELLED' AND lease_token IS NULL AND lease_until IS NULL
        AND projected_at IS NULL AND cancelled_at IS NOT NULL AND abandoned_at IS NULL)
      OR (state = 'ABANDONED' AND lease_token IS NULL AND lease_until IS NULL
        AND projected_at IS NULL AND cancelled_at IS NULL AND abandoned_at IS NOT NULL)
    )
);

CREATE INDEX calendar_reminders_due_idx
  ON calendar_reminders (state, next_attempt_at, lease_until, id)
  WHERE state IN ('PENDING', 'CLAIMED');
CREATE INDEX calendar_reminders_job_source_idx
  ON calendar_reminders (organization_id, job_card_id, state)
  WHERE job_card_id IS NOT NULL;
CREATE INDEX calendar_reminders_event_source_idx
  ON calendar_reminders (organization_id, calendar_event_id, state)
  WHERE calendar_event_id IS NOT NULL;
CREATE INDEX calendar_reminders_recipient_history_idx
  ON calendar_reminders (organization_id, recipient_user_id, created_at DESC);

ALTER TABLE in_app_notifications
  DROP CONSTRAINT in_app_notifications_entity_type_check,
  DROP CONSTRAINT in_app_notifications_kind_check;

ALTER TABLE in_app_notifications
  ADD CONSTRAINT in_app_notifications_entity_type_check
    CHECK (entity_type IN ('job-card', 'calendar-event')),
  ADD CONSTRAINT in_app_notifications_kind_check
    CHECK (kind IN (
      'job.assigned',
      'job.reassigned',
      'job.awaiting_approval',
      'job.approved',
      'job.revision_requested',
      'job.cancelled',
      'calendar.assigned',
      'calendar.rescheduled',
      'calendar.cancelled',
      'calendar.reminder'
    ));

ALTER TABLE realtime_events
  ALTER COLUMN source_activity_id DROP NOT NULL,
  ADD COLUMN calendar_activity_id UUID,
  ADD COLUMN calendar_reminder_id UUID,
  DROP CONSTRAINT realtime_events_event_type_check,
  DROP CONSTRAINT realtime_events_entity_type_check;

ALTER TABLE realtime_events
  ADD CONSTRAINT realtime_events_calendar_activity_fk
    FOREIGN KEY (calendar_activity_id)
    REFERENCES calendar_event_activity_logs(id) ON DELETE CASCADE,
  ADD CONSTRAINT realtime_events_calendar_activity_unique
    UNIQUE (calendar_activity_id),
  ADD CONSTRAINT realtime_events_calendar_reminder_fk
    FOREIGN KEY (calendar_reminder_id)
    REFERENCES calendar_reminders(id) ON DELETE CASCADE,
  ADD CONSTRAINT realtime_events_calendar_reminder_unique
    UNIQUE (calendar_reminder_id),
  ADD CONSTRAINT realtime_events_activity_source_check
    CHECK (
      (source_activity_id IS NOT NULL)::INTEGER
      + (calendar_reminder_id IS NOT NULL)::INTEGER
      + (calendar_activity_id IS NOT NULL)::INTEGER = 1
    ),
  ADD CONSTRAINT realtime_events_event_type_check
    CHECK (event_type IN (
      'job.created',
      'job.assignment_changed',
      'job.accepted',
      'job.started',
      'job.submitted_for_approval',
      'job.approved',
      'job.revision_requested',
      'job.cancelled',
      'job.updated',
      'calendar.created',
      'calendar.updated',
      'calendar.cancelled',
      'calendar.reminder_due'
    )),
  ADD CONSTRAINT realtime_events_entity_type_check
    CHECK (entity_type IN ('job-card', 'calendar-event'));
