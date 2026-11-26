-- R0: widen installation module registry constraints so later modules add
-- only a registry entry, without another key migration.

ALTER TABLE installation_module_state
  DROP CONSTRAINT installation_module_state_key_check,
  DROP CONSTRAINT installation_module_state_source_check,
  ADD CONSTRAINT installation_module_state_key_check
    CHECK (module_key ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  ADD CONSTRAINT installation_module_state_source_check
    CHECK (source IN ('ENV_TAKEOVER', 'OPERATOR', 'FRESH_INSTALL'));

ALTER TABLE operator_audit_events
  DROP CONSTRAINT operator_audit_events_event_type_check,
  DROP CONSTRAINT operator_audit_events_module_key_check,
  DROP CONSTRAINT operator_audit_events_target_check,
  DROP CONSTRAINT operator_audit_events_module_value_check,
  ADD CONSTRAINT operator_audit_events_event_type_check
    CHECK (event_type IN (
      'OPERATOR_GRANTED', 'OPERATOR_PASSWORD_RESET', 'OPERATOR_REVOKED',
      'OPERATOR_LOGIN_SUCCEEDED', 'MODULE_STATE_TAKEN_OVER',
      'MODULE_STATE_CHANGED', 'MODULE_STATE_INITIALIZED',
      'OPERATOR_ACCESS_RESET_BY_RESTORE'
    )),
  ADD CONSTRAINT operator_audit_events_module_key_check
    CHECK (module_key IS NULL OR module_key ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  ADD CONSTRAINT operator_audit_events_target_check
    CHECK (
      (event_type IN (
        'OPERATOR_GRANTED', 'OPERATOR_PASSWORD_RESET', 'OPERATOR_REVOKED',
        'OPERATOR_LOGIN_SUCCEEDED', 'OPERATOR_ACCESS_RESET_BY_RESTORE'
      ) AND target_operator_id IS NOT NULL AND module_key IS NULL)
      OR
      (event_type IN (
        'MODULE_STATE_TAKEN_OVER', 'MODULE_STATE_CHANGED', 'MODULE_STATE_INITIALIZED'
      ) AND module_key IS NOT NULL AND target_operator_id IS NULL)
    ),
  ADD CONSTRAINT operator_audit_events_module_value_check
    CHECK (
      event_type NOT IN (
        'MODULE_STATE_TAKEN_OVER', 'MODULE_STATE_CHANGED', 'MODULE_STATE_INITIALIZED'
      )
      OR (
        new_value IS NOT NULL AND jsonb_typeof(new_value -> 'enabled') = 'boolean'
        AND (
          (event_type IN ('MODULE_STATE_TAKEN_OVER', 'MODULE_STATE_INITIALIZED') AND old_value IS NULL)
          OR (event_type = 'MODULE_STATE_CHANGED' AND old_value IS NOT NULL
              AND jsonb_typeof(old_value -> 'enabled') = 'boolean')
        )
      )
    );

CREATE INDEX operator_audit_events_module_idx
  ON operator_audit_events (module_key, occurred_at)
  WHERE module_key IS NOT NULL;
