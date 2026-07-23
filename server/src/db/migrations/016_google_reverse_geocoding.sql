-- Google reverse-geocoding cost quota buckets and provider source on locations.
-- Does not store coordinates, addresses, JobCard IDs, or API credentials.

CREATE TABLE reverse_geocoding_quota_buckets (
  provider VARCHAR(32) NOT NULL,
  scope_type VARCHAR(32) NOT NULL,
  scope_key TEXT NOT NULL,
  period_start DATE NOT NULL,

  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (
    provider,
    scope_type,
    scope_key,
    period_start
  ),

  CONSTRAINT reverse_geocoding_quota_provider_check
    CHECK (provider IN ('GOOGLE')),

  CONSTRAINT reverse_geocoding_quota_scope_check
    CHECK (
      scope_type IN (
        'USER_DAY',
        'ORGANIZATION_DAY',
        'GLOBAL_MONTH'
      )
    ),

  CONSTRAINT reverse_geocoding_quota_used_count_check
    CHECK (used_count >= 0)
);

CREATE INDEX reverse_geocoding_quota_expires_at_idx
  ON reverse_geocoding_quota_buckets (expires_at);

ALTER TABLE job_action_locations
  ADD COLUMN geocoding_provider VARCHAR(32);

ALTER TABLE job_action_locations
  ADD CONSTRAINT job_action_locations_geocoding_provider_check
  CHECK (
    geocoding_provider IS NULL
    OR geocoding_provider IN ('GOOGLE')
  );
