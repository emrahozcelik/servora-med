ALTER TABLE sessions
  ADD CONSTRAINT sessions_user_id_id_unique UNIQUE (user_id, id);

ALTER TABLE in_app_notifications
  ADD CONSTRAINT in_app_notifications_organization_id_id_unique
  UNIQUE (organization_id, id);

CREATE TABLE web_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL,
  session_id UUID NOT NULL,
  endpoint VARCHAR(2048) NOT NULL,
  endpoint_hash CHAR(64) NOT NULL UNIQUE,
  p256dh VARCHAR(512) NOT NULL,
  auth VARCHAR(512) NOT NULL,
  expiration_time TIMESTAMPTZ,
  vapid_public_key_fingerprint CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TIMESTAMPTZ,
  disabled_reason VARCHAR(40),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  consecutive_failures SMALLINT NOT NULL DEFAULT 0,

  CONSTRAINT web_push_subscriptions_organization_id_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT web_push_subscriptions_recipient_fk
    FOREIGN KEY (organization_id, recipient_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT web_push_subscriptions_session_fk
    FOREIGN KEY (recipient_user_id, session_id)
    REFERENCES sessions (user_id, id),
  CONSTRAINT web_push_subscriptions_endpoint_check
    CHECK (length(trim(endpoint)) BETWEEN 1 AND 2048),
  CONSTRAINT web_push_subscriptions_endpoint_hash_check
    CHECK (endpoint_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT web_push_subscriptions_p256dh_check
    CHECK (length(trim(p256dh)) BETWEEN 1 AND 512),
  CONSTRAINT web_push_subscriptions_auth_check
    CHECK (length(trim(auth)) BETWEEN 1 AND 512),
  CONSTRAINT web_push_subscriptions_vapid_fingerprint_check
    CHECK (vapid_public_key_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT web_push_subscriptions_failures_check
    CHECK (consecutive_failures BETWEEN 0 AND 6),
  CONSTRAINT web_push_subscriptions_disabled_reason_check
    CHECK (
      disabled_reason IS NULL OR disabled_reason IN (
        'USER_DISABLED',
        'REPLACED',
        'SESSION_INACTIVE',
        'PROVIDER_STALE',
        'VAPID_ROTATED'
      )
    ),
  CONSTRAINT web_push_subscriptions_disabled_fields_check
    CHECK (
      (disabled_at IS NULL AND disabled_reason IS NULL)
      OR (disabled_at IS NOT NULL AND disabled_reason IS NOT NULL)
    )
);

CREATE UNIQUE INDEX web_push_subscriptions_active_session_idx
  ON web_push_subscriptions (session_id)
  WHERE disabled_at IS NULL;

CREATE INDEX web_push_subscriptions_recipient_idx
  ON web_push_subscriptions (organization_id, recipient_user_id, updated_at DESC);

CREATE INDEX web_push_subscriptions_session_cleanup_idx
  ON web_push_subscriptions (session_id, disabled_at);

CREATE TABLE web_push_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  notification_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  last_error_code VARCHAR(80),
  delivered_at TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT web_push_deliveries_identity_unique
    UNIQUE (notification_id, subscription_id),
  CONSTRAINT web_push_deliveries_notification_fk
    FOREIGN KEY (organization_id, notification_id)
    REFERENCES in_app_notifications (organization_id, id),
  CONSTRAINT web_push_deliveries_subscription_fk
    FOREIGN KEY (organization_id, subscription_id)
    REFERENCES web_push_subscriptions (organization_id, id),
  CONSTRAINT web_push_deliveries_state_check
    CHECK (state IN ('PENDING', 'CLAIMED', 'DELIVERED', 'ABANDONED')),
  CONSTRAINT web_push_deliveries_attempt_check
    CHECK (attempt_count BETWEEN 0 AND 6),
  CONSTRAINT web_push_deliveries_error_code_check
    CHECK (last_error_code IS NULL OR length(trim(last_error_code)) BETWEEN 1 AND 80),
  CONSTRAINT web_push_deliveries_state_fields_check
    CHECK (
      (
        state = 'PENDING'
        AND lease_token IS NULL
        AND lease_until IS NULL
        AND delivered_at IS NULL
        AND abandoned_at IS NULL
      )
      OR (
        state = 'CLAIMED'
        AND lease_token IS NOT NULL
        AND lease_until IS NOT NULL
        AND delivered_at IS NULL
        AND abandoned_at IS NULL
      )
      OR (
        state = 'DELIVERED'
        AND lease_token IS NULL
        AND lease_until IS NULL
        AND delivered_at IS NOT NULL
        AND abandoned_at IS NULL
      )
      OR (
        state = 'ABANDONED'
        AND lease_token IS NULL
        AND lease_until IS NULL
        AND delivered_at IS NULL
        AND abandoned_at IS NOT NULL
      )
    )
);

CREATE INDEX web_push_deliveries_due_idx
  ON web_push_deliveries (state, next_attempt_at, lease_until, id)
  WHERE state IN ('PENDING', 'CLAIMED');

CREATE INDEX web_push_deliveries_subscription_idx
  ON web_push_deliveries (subscription_id, state, created_at DESC);
