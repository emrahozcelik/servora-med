-- BR5 operational health: installation-wide, auditable maintenance admission.
-- Additive/forward-only. Seed as PAUSED; never infer approval from migration.
-- The source-owned OT3-C/D positive-health gate remains independently BLOCKED.
-- Revision, not wall time, is the ordering authority for operator transitions.
CREATE TABLE backup_health_maintenance_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
  paused BOOLEAN NOT NULL DEFAULT TRUE,
  revision BIGINT NOT NULL DEFAULT 0,
  reason_code VARCHAR(40) NOT NULL DEFAULT 'INITIAL_HOLD',
  operator_label VARCHAR(80) NOT NULL DEFAULT 'MIGRATION',
  ticket_ref VARCHAR(120) NOT NULL DEFAULT 'INITIAL_HOLD',
  changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT backup_health_maintenance_singleton_check CHECK (singleton),
  CONSTRAINT backup_health_maintenance_revision_check CHECK (revision >= 0),
  CONSTRAINT backup_health_maintenance_reason_check CHECK (reason_code IN (
    'INITIAL_HOLD', 'SCHEDULED_MAINTENANCE', 'EMERGENCY_HOLD', 'POST_MAINTENANCE_CHECK'
  )),
  CONSTRAINT backup_health_maintenance_operator_check CHECK (length(trim(operator_label)) > 0),
  CONSTRAINT backup_health_maintenance_ticket_check CHECK (length(trim(ticket_ref)) > 0)
);

CREATE TABLE backup_health_maintenance_events (
  revision BIGINT PRIMARY KEY CHECK (revision >= 0),
  paused BOOLEAN NOT NULL,
  reason_code VARCHAR(40) NOT NULL,
  operator_label VARCHAR(80) NOT NULL,
  ticket_ref VARCHAR(120) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO backup_health_maintenance_state
  (singleton, paused, revision, reason_code, operator_label, ticket_ref)
VALUES (TRUE, TRUE, 0, 'INITIAL_HOLD', 'MIGRATION', 'INITIAL_HOLD');

INSERT INTO backup_health_maintenance_events
  (revision, paused, reason_code, operator_label, ticket_ref, changed_at)
SELECT revision, paused, reason_code, operator_label, ticket_ref, changed_at
  FROM backup_health_maintenance_state WHERE singleton;

-- All state mutations require a revision increment and generate one audit row,
-- even when the SQL owner operates without the helper function.
CREATE FUNCTION backup_health_maintenance_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.singleton IS DISTINCT FROM OLD.singleton
    OR NEW.revision IS DISTINCT FROM OLD.revision + 1
    OR NEW.paused IS NOT DISTINCT FROM OLD.paused
    OR NEW.changed_at IS NULL
    OR NEW.reason_code IS NULL
    OR NEW.operator_label IS NULL
    OR NEW.ticket_ref IS NULL THEN
    RAISE EXCEPTION 'INVALID_BACKUP_HEALTH_MAINTENANCE_TRANSITION';
  END IF;
  IF NEW.paused AND NEW.reason_code NOT IN ('SCHEDULED_MAINTENANCE', 'EMERGENCY_HOLD') THEN
    RAISE EXCEPTION 'INVALID_BACKUP_HEALTH_PAUSE_REASON';
  END IF;
  IF NOT NEW.paused AND NEW.reason_code <> 'POST_MAINTENANCE_CHECK' THEN
    RAISE EXCEPTION 'INVALID_BACKUP_HEALTH_RESUME_REASON';
  END IF;
  INSERT INTO backup_health_maintenance_events
    (revision, paused, reason_code, operator_label, ticket_ref, changed_at)
  VALUES
    (NEW.revision, NEW.paused, NEW.reason_code, NEW.operator_label, NEW.ticket_ref, NEW.changed_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER backup_health_maintenance_audit
AFTER UPDATE ON backup_health_maintenance_state
FOR EACH ROW
EXECUTE FUNCTION backup_health_maintenance_audit();

-- Event history and state singleton cannot be deleted/rewritten through ordinary
-- DML. DBA/superuser remains inside the trusted database boundary.
CREATE FUNCTION backup_health_maintenance_reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'BACKUP_HEALTH_MAINTENANCE_HISTORY_IMMUTABLE';
END;
$$;

CREATE TRIGGER backup_health_maintenance_events_immutable
BEFORE UPDATE OR DELETE ON backup_health_maintenance_events
FOR EACH ROW EXECUTE FUNCTION backup_health_maintenance_reject_history_mutation();

CREATE TRIGGER backup_health_maintenance_state_no_delete
BEFORE DELETE ON backup_health_maintenance_state
FOR EACH ROW EXECUTE FUNCTION backup_health_maintenance_reject_history_mutation();

-- Operator-only explicit CAS transition. No API endpoint or worker auto-resume.
-- 'Resume' removes only maintenance veto; it does not qualify OT3 or proofs.
CREATE FUNCTION backup_health_maintenance_transition(
  p_expected_revision BIGINT,
  p_next_paused BOOLEAN,
  p_operator_label TEXT,
  p_ticket_ref TEXT,
  p_reason_code TEXT
) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
  v_new_revision BIGINT;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision < 0
    OR p_next_paused IS NULL
    OR p_operator_label IS NULL OR length(trim(p_operator_label)) NOT BETWEEN 1 AND 80
    OR p_ticket_ref IS NULL OR length(trim(p_ticket_ref)) NOT BETWEEN 1 AND 120
    OR p_reason_code IS NULL THEN
    RAISE EXCEPTION 'INVALID_BACKUP_HEALTH_MAINTENANCE_ARGUMENTS';
  END IF;
  IF (p_next_paused AND p_reason_code NOT IN ('SCHEDULED_MAINTENANCE', 'EMERGENCY_HOLD'))
    OR (NOT p_next_paused AND p_reason_code <> 'POST_MAINTENANCE_CHECK') THEN
    RAISE EXCEPTION 'INVALID_BACKUP_HEALTH_MAINTENANCE_REASON';
  END IF;
  UPDATE backup_health_maintenance_state
     SET paused = p_next_paused,
         revision = revision + 1,
         reason_code = p_reason_code,
         operator_label = trim(p_operator_label),
         ticket_ref = trim(p_ticket_ref),
         changed_at = CURRENT_TIMESTAMP
   WHERE singleton AND revision = p_expected_revision
     AND paused IS DISTINCT FROM p_next_paused
  RETURNING revision INTO v_new_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BACKUP_HEALTH_MAINTENANCE_REVISION_CONFLICT';
  END IF;
  RETURN v_new_revision;
END;
$$;

-- PostgreSQL functions are EXECUTE-to-PUBLIC by default. Only the schema
-- owner or an explicitly provisioned operator role can perform transitions.
REVOKE ALL ON FUNCTION backup_health_maintenance_transition(BIGINT, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON backup_health_maintenance_state FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON backup_health_maintenance_events FROM PUBLIC;
