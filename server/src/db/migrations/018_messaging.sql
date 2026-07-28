CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  direct_key VARCHAR(300) NOT NULL,
  context_type VARCHAR(20) NOT NULL DEFAULT 'GENERAL',
  job_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT conversations_organization_id_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT conversations_identity_unique
    UNIQUE (organization_id, direct_key),
  CONSTRAINT conversations_context_type_check
    CHECK (context_type IN ('GENERAL', 'JOB')),
  CONSTRAINT conversations_job_fk
    FOREIGN KEY (organization_id, job_id)
    REFERENCES job_cards (organization_id, id) ON DELETE SET NULL,
  CONSTRAINT conversations_job_id_scope_check
    CHECK (job_id IS NULL OR context_type = 'JOB')
);

CREATE INDEX conversations_organization_updated_idx
  ON conversations (organization_id, updated_at DESC, id);

CREATE TABLE conversation_participants (
  conversation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  last_read_message_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT conversation_participants_pk
    PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT conversation_participants_conv_fk
    FOREIGN KEY (organization_id, conversation_id)
    REFERENCES conversations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_participants_user_fk
    FOREIGN KEY (organization_id, user_id)
    REFERENCES users (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_participants_read_fk
    FOREIGN KEY (conversation_id, last_read_message_id)
    REFERENCES messages (conversation_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX conversation_participants_user_updated_idx
  ON conversation_participants (organization_id, user_id, conversation_id);

CREATE TABLE messages (
  id UUID DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  sender_user_id UUID NOT NULL,
  client_action_id VARCHAR(255) NOT NULL,
  body VARCHAR(4000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT messages_organization_id_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT messages_conversation_user_action_unique
    UNIQUE (conversation_id, sender_user_id, client_action_id),
  CONSTRAINT messages_conversation_fk
    FOREIGN KEY (organization_id, conversation_id)
    REFERENCES conversations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT messages_sender_fk
    FOREIGN KEY (organization_id, sender_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT messages_body_check
    CHECK (length(body) BETWEEN 1 AND 4000),
  CONSTRAINT messages_body_plain_check
    CHECK (body !~ '<[a-zA-Z/]'),
  PRIMARY KEY (conversation_id, id)
);

CREATE INDEX messages_organization_cursor_idx
  ON messages (organization_id, conversation_id, created_at, id);

ALTER TABLE in_app_notifications
  DROP CONSTRAINT in_app_notifications_entity_type_check,
  DROP CONSTRAINT in_app_notifications_kind_check;

ALTER TABLE in_app_notifications
  ADD CONSTRAINT in_app_notifications_entity_type_check
    CHECK (entity_type IN ('job-card', 'calendar-event', 'conversation')),
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
      'calendar.reminder',
      'message.received'
    ));

ALTER TABLE realtime_events
  ADD COLUMN messaging_activity_id UUID,
  DROP CONSTRAINT realtime_events_activity_source_check,
  DROP CONSTRAINT realtime_events_event_type_check,
  DROP CONSTRAINT realtime_events_entity_type_check;

ALTER TABLE realtime_events
  ADD CONSTRAINT realtime_events_messaging_activity_fk
    FOREIGN KEY (messaging_activity_id)
    REFERENCES messaging_activity_logs(id) ON DELETE CASCADE,
  ADD CONSTRAINT realtime_events_messaging_activity_unique
    UNIQUE (messaging_activity_id),
  ADD CONSTRAINT realtime_events_activity_source_check
    CHECK (
      (source_activity_id IS NOT NULL)::INTEGER
      + (calendar_activity_id IS NOT NULL)::INTEGER
      + (calendar_reminder_id IS NOT NULL)::INTEGER
      + (messaging_activity_id IS NOT NULL)::INTEGER = 1
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
      'calendar.reminder_due',
      'message.sent',
      'conversation.created'
    )),
  ADD CONSTRAINT realtime_events_entity_type_check
    CHECK (entity_type IN ('job-card', 'calendar-event', 'conversation'));

CREATE TABLE messaging_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL,
  client_action_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT messaging_activity_actor_fk
    FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT messaging_activity_conversation_fk
    FOREIGN KEY (organization_id, conversation_id)
    REFERENCES conversations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT messaging_activity_action_check
    CHECK (action IN ('CONVERSATION_CREATED', 'MESSAGE_SENT')),
  CONSTRAINT messaging_activity_unique
    UNIQUE (organization_id, actor_user_id, client_action_id, action)
);
