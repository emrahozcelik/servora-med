CREATE TABLE realtime_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  source_activity_id UUID NOT NULL UNIQUE
    REFERENCES job_card_activity_logs(id) ON DELETE CASCADE,
  event_type VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id UUID NOT NULL,
  actor_user_id UUID NULL,
  audience_roles VARCHAR(20)[] NOT NULL DEFAULT '{}',
  audience_user_ids UUID[] NOT NULL DEFAULT '{}',
  resource_keys TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT realtime_events_event_type_check CHECK (
    event_type IN (
      'job.created',
      'job.assignment_changed',
      'job.accepted',
      'job.started',
      'job.submitted_for_approval',
      'job.approved',
      'job.revision_requested',
      'job.cancelled',
      'job.updated'
    )
  ),
  CONSTRAINT realtime_events_entity_type_check CHECK (
    entity_type = 'job-card'
  ),
  CONSTRAINT realtime_events_resources_check CHECK (
    cardinality(resource_keys) > 0
  ),
  CONSTRAINT realtime_events_roles_check CHECK (
    audience_roles <@ ARRAY['ADMIN', 'MANAGER']::VARCHAR(20)[]
  ),
  CONSTRAINT realtime_events_audience_check CHECK (
    cardinality(audience_roles) > 0 OR cardinality(audience_user_ids) > 0
  )
);

CREATE INDEX realtime_events_organization_cursor_idx
  ON realtime_events (organization_id, id);

CREATE INDEX realtime_events_audience_users_gin_idx
  ON realtime_events USING GIN (audience_user_ids);

CREATE INDEX realtime_events_audience_roles_gin_idx
  ON realtime_events USING GIN (audience_roles);
