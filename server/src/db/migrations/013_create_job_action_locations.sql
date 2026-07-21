ALTER TABLE job_card_activity_logs
  ADD CONSTRAINT job_card_activity_logs_location_reference_unique
  UNIQUE (organization_id, job_card_id, id, event_type, actor_id);

CREATE TABLE job_action_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  job_card_id UUID NOT NULL,
  activity_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL,
  capture_outcome VARCHAR(20) NOT NULL,
  failure_reason VARCHAR(40),
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  accuracy_meters NUMERIC(12,3),
  captured_at TIMESTAMPTZ,
  geocoding_status VARCHAR(20) NOT NULL,
  neighborhood VARCHAR(160),
  district VARCHAR(160),
  city VARCHAR(160),
  approximate_label VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT job_action_locations_activity_unique UNIQUE (activity_id),
  CONSTRAINT job_action_locations_action_check CHECK (action = 'JOB_STARTED'),
  CONSTRAINT job_action_locations_failure_reason_check CHECK (
    failure_reason IS NULL OR failure_reason IN (
      'PERMISSION_DENIED',
      'POSITION_UNAVAILABLE',
      'TIMEOUT',
      'UNSUPPORTED',
      'UNKNOWN'
    )
  ),
  CONSTRAINT job_action_locations_latitude_check CHECK (
    latitude IS NULL OR latitude BETWEEN -90 AND 90
  ),
  CONSTRAINT job_action_locations_longitude_check CHECK (
    longitude IS NULL OR longitude BETWEEN -180 AND 180
  ),
  CONSTRAINT job_action_locations_accuracy_check CHECK (
    accuracy_meters IS NULL OR accuracy_meters > 0
  ),
  CONSTRAINT job_action_locations_geocoding_status_check CHECK (
    geocoding_status IN ('NOT_REQUESTED', 'RESOLVED', 'FAILED')
  ),
  CONSTRAINT job_action_locations_geocoding_fields_check CHECK (
    (
      geocoding_status = 'RESOLVED'
      AND capture_outcome = 'CAPTURED'
      AND approximate_label IS NOT NULL
    )
    OR
    (
      geocoding_status IN ('NOT_REQUESTED', 'FAILED')
      AND neighborhood IS NULL
      AND district IS NULL
      AND city IS NULL
      AND approximate_label IS NULL
    )
  ),
  CONSTRAINT job_action_locations_activity_fk
    FOREIGN KEY (
      organization_id,
      job_card_id,
      activity_id,
      action,
      actor_user_id
    ) REFERENCES job_card_activity_logs (
      organization_id,
      job_card_id,
      id,
      event_type,
      actor_id
    ),
  CONSTRAINT job_action_locations_capture_fields_check CHECK (
    (
      capture_outcome = 'CAPTURED'
      AND failure_reason IS NULL
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND accuracy_meters IS NOT NULL
      AND captured_at IS NOT NULL
    )
    OR
    (
      capture_outcome = 'UNAVAILABLE'
      AND failure_reason IS NOT NULL
      AND latitude IS NULL
      AND longitude IS NULL
      AND accuracy_meters IS NULL
      AND captured_at IS NULL
      AND geocoding_status = 'NOT_REQUESTED'
    )
  )
);

CREATE INDEX job_action_locations_job_time_idx
  ON job_action_locations (organization_id, job_card_id, created_at DESC, id DESC);
