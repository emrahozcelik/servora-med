ALTER TABLE realtime_events
  ADD CONSTRAINT realtime_events_organization_id_id_unique
  UNIQUE (organization_id, id);

CREATE TABLE in_app_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL,
  source_realtime_event_id BIGINT NOT NULL,
  kind VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,

  CONSTRAINT in_app_notifications_recipient_source_unique
    UNIQUE (recipient_user_id, source_realtime_event_id),
  CONSTRAINT in_app_notifications_recipient_fk
    FOREIGN KEY (organization_id, recipient_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT in_app_notifications_source_event_fk
    FOREIGN KEY (organization_id, source_realtime_event_id)
    REFERENCES realtime_events (organization_id, id),
  CONSTRAINT in_app_notifications_entity_type_check
    CHECK (entity_type = 'job-card'),
  CONSTRAINT in_app_notifications_kind_check
    CHECK (kind IN (
      'job.assigned',
      'job.reassigned',
      'job.awaiting_approval',
      'job.approved',
      'job.revision_requested',
      'job.cancelled'
    ))
);

CREATE INDEX in_app_notifications_recipient_unread_idx
  ON in_app_notifications (
    organization_id,
    recipient_user_id,
    read_at,
    created_at DESC,
    id DESC
  );

CREATE INDEX in_app_notifications_recipient_created_idx
  ON in_app_notifications (
    organization_id,
    recipient_user_id,
    created_at DESC,
    id DESC
  );

CREATE INDEX in_app_notifications_source_event_idx
  ON in_app_notifications (source_realtime_event_id);
