-- MOD-002: installation operator identity, runtime module state and the
-- installation-level operator audit trail.
--
-- All five tables are installation level: they carry no organization_id
-- (precedent: the backup tables). The operator is never a row in `users`.
-- Contract: docs/features/operator-module-pilot.md §2, §5, §6.

CREATE TABLE operator_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT operator_accounts_email_normalized_check
    CHECK (email = lower(btrim(email)) AND length(email) > 0),
  CONSTRAINT operator_accounts_name_check CHECK (length(btrim(name)) > 0),
  CONSTRAINT operator_accounts_password_hash_check CHECK (length(password_hash) > 0),
  CONSTRAINT operator_accounts_version_check CHECK (version >= 1)
);

CREATE UNIQUE INDEX operator_accounts_email_unique_idx ON operator_accounts (email);

-- The capability list is fixed in code; later slices extend this CHECK.
CREATE TABLE operator_account_capabilities (
  operator_id UUID NOT NULL REFERENCES operator_accounts(id),
  capability TEXT NOT NULL,

  PRIMARY KEY (operator_id, capability),
  CONSTRAINT operator_account_capabilities_capability_check
    CHECK (capability IN ('MODULE_MANAGEMENT'))
);

CREATE TABLE operator_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operator_accounts(id),
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,

  CONSTRAINT operator_sessions_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX operator_sessions_operator_id_idx ON operator_sessions (operator_id);

-- One typed row per registry key; not a generic settings bag (UI-002).
CREATE TABLE installation_module_state (
  module_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_operator_id UUID REFERENCES operator_accounts(id),

  CONSTRAINT installation_module_state_key_check CHECK (module_key IN ('OVERVIEW')),
  CONSTRAINT installation_module_state_version_check CHECK (version >= 1),
  CONSTRAINT installation_module_state_source_check
    CHECK (source IN ('ENV_TAKEOVER', 'OPERATOR')),
  CONSTRAINT installation_module_state_source_actor_check
    CHECK ((source = 'OPERATOR') = (updated_by_operator_id IS NOT NULL))
);

CREATE TABLE operator_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_kind TEXT NOT NULL,
  operator_id UUID REFERENCES operator_accounts(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  target_operator_id UUID REFERENCES operator_accounts(id) ON DELETE RESTRICT,
  module_key TEXT,
  old_value JSONB,
  new_value JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT operator_audit_events_actor_kind_check
    CHECK (actor_kind IN ('OPERATOR', 'HOST_CLI', 'SYSTEM')),
  CONSTRAINT operator_audit_events_event_type_check
    CHECK (event_type IN (
      'OPERATOR_GRANTED', 'OPERATOR_PASSWORD_RESET', 'OPERATOR_REVOKED',
      'OPERATOR_LOGIN_SUCCEEDED', 'MODULE_STATE_TAKEN_OVER',
      'MODULE_STATE_CHANGED', 'OPERATOR_ACCESS_RESET_BY_RESTORE'
    )),
  CONSTRAINT operator_audit_events_module_key_check
    CHECK (module_key IS NULL OR module_key IN ('OVERVIEW')),
  -- The acting operator is recorded if and only if the actor is an operator.
  CONSTRAINT operator_audit_events_operator_actor_check
    CHECK ((actor_kind = 'OPERATOR') = (operator_id IS NOT NULL)),
  -- Account events name the account; module events name the module.
  CONSTRAINT operator_audit_events_target_check
    CHECK (
      (event_type IN (
        'OPERATOR_GRANTED', 'OPERATOR_PASSWORD_RESET', 'OPERATOR_REVOKED',
        'OPERATOR_LOGIN_SUCCEEDED', 'OPERATOR_ACCESS_RESET_BY_RESTORE'
      ) AND target_operator_id IS NOT NULL AND module_key IS NULL)
      OR
      (event_type IN ('MODULE_STATE_TAKEN_OVER', 'MODULE_STATE_CHANGED')
        AND module_key IS NOT NULL AND target_operator_id IS NULL)
    ),
  -- Small payloads only: JSON objects, shape limited per event type.
  CONSTRAINT operator_audit_events_value_shape_check
    CHECK (
      (old_value IS NULL OR (jsonb_typeof(old_value) = 'object' AND length(old_value::text) <= 512))
      AND (new_value IS NULL OR (jsonb_typeof(new_value) = 'object' AND length(new_value::text) <= 512))
    ),
  CONSTRAINT operator_audit_events_module_value_check
    CHECK (
      event_type NOT IN ('MODULE_STATE_TAKEN_OVER', 'MODULE_STATE_CHANGED')
      OR (
        new_value IS NOT NULL AND jsonb_typeof(new_value -> 'enabled') = 'boolean'
        AND (
          (event_type = 'MODULE_STATE_TAKEN_OVER' AND old_value IS NULL)
          OR (event_type = 'MODULE_STATE_CHANGED' AND old_value IS NOT NULL
              AND jsonb_typeof(old_value -> 'enabled') = 'boolean')
        )
      )
    )
);

-- Last successful login per account (CLI `list`).
CREATE INDEX operator_audit_events_login_idx
  ON operator_audit_events (target_operator_id, occurred_at DESC)
  WHERE event_type = 'OPERATOR_LOGIN_SUCCEEDED';

-- Takeover fail-closed lookup: has this module ever been taken over?
CREATE INDEX operator_audit_events_takeover_idx
  ON operator_audit_events (module_key)
  WHERE event_type = 'MODULE_STATE_TAKEN_OVER';
