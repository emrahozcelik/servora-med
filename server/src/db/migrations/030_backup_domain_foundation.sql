-- Backup & Recovery V1 domain foundation (BR1, see docs/operations/backup-recovery/
-- and DECISIONS.md OPS-002).
--
-- Installation-scope exception: backup/restore tables describe the whole
-- installation (infrastructure state) and therefore deliberately carry NO
-- organization_id, unlike business domain tables (precedent: schema_migrations).
-- These tables must never store secret material: runtime R2 credentials and the
-- age private identity stay operator-managed in environment files only.
--
-- State semantics are owned by the service state machine; SQL constraints below
-- only protect durable invariants (single active run, failure/warning split,
-- terminal-state coherence, enum vocabularies).

CREATE TABLE backup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status VARCHAR(20) NOT NULL,
  phase VARCHAR(30),
  origin VARCHAR(20) NOT NULL,
  scope VARCHAR(20) NOT NULL,
  retention_class VARCHAR(20) NOT NULL,

  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  format_version INTEGER NOT NULL DEFAULT 1,
  app_version VARCHAR(50),
  git_commit VARCHAR(40),
  schema_version VARCHAR(100),
  database_server_version VARCHAR(100),
  dump_version INTEGER,

  remote_key VARCHAR(500),
  size_bytes BIGINT,
  sha256 VARCHAR(64),
  verified_at TIMESTAMPTZ,

  warning_code VARCHAR(50),
  warning_summary VARCHAR(500),
  failure_code VARCHAR(50),
  failure_summary VARCHAR(500),

  CONSTRAINT backup_runs_status_check CHECK (status IN (
    'QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'
  )),
  CONSTRAINT backup_runs_phase_check CHECK (phase IS NULL OR phase IN (
    'PREFLIGHT', 'DATABASE_DUMP', 'FILES_ARCHIVE', 'MANIFEST', 'CHECKSUM',
    'PACKAGE', 'ENCRYPT', 'UPLOAD', 'REMOTE_VERIFY', 'CLEANUP'
  )),
  CONSTRAINT backup_runs_origin_check CHECK (origin IN (
    'MANUAL', 'SCHEDULED', 'PRE_RESTORE'
  )),
  CONSTRAINT backup_runs_scope_check CHECK (scope IN ('DATABASE', 'FULL_DATA')),
  CONSTRAINT backup_runs_retention_class_check CHECK (retention_class IN (
    'DAILY', 'WEEKLY', 'MONTHLY', 'MANUAL', 'PRE_RESTORE'
  )),
  CONSTRAINT backup_runs_failure_code_check CHECK (failure_code IS NULL OR failure_code IN (
    'PREFLIGHT_DATABASE_UNAVAILABLE', 'PREFLIGHT_PG_DUMP_UNAVAILABLE',
    'PREFLIGHT_LOW_DISK', 'PREFLIGHT_STORAGE_UNAVAILABLE',
    'PG_DUMP_FAILED', 'FILES_ARCHIVE_FAILED', 'MANIFEST_FAILED',
    'PACKAGE_FAILED', 'ENCRYPTION_FAILED',
    'R2_AUTH_FAILED', 'R2_UPLOAD_FAILED', 'R2_DOWNLOAD_FAILED',
    'REMOTE_CHECKSUM_MISMATCH', 'WORKER_LOST'
  )),
  CONSTRAINT backup_runs_warning_code_check CHECK (warning_code IS NULL OR warning_code IN (
    'CLEANUP_FAILED'
  )),
  CONSTRAINT backup_runs_status_failure_check CHECK (
    (status <> 'SUCCESS' OR failure_code IS NULL)
    AND (status <> 'FAILED' OR failure_code IS NOT NULL)
  ),
  CONSTRAINT backup_runs_warning_status_check CHECK (
    warning_code IS NULL OR status = 'SUCCESS'
  ),
  CONSTRAINT backup_runs_running_started_check CHECK (
    status <> 'RUNNING' OR started_at IS NOT NULL
  ),
  CONSTRAINT backup_runs_running_phase_check CHECK (
    status <> 'RUNNING' OR phase IS NOT NULL
  ),
  CONSTRAINT backup_runs_terminal_completed_check CHECK (
    status NOT IN ('SUCCESS', 'FAILED', 'CANCELLED') OR completed_at IS NOT NULL
  ),
  CONSTRAINT backup_runs_manual_creator_check CHECK (
    origin <> 'MANUAL' OR created_by IS NOT NULL
  ),
  CONSTRAINT backup_runs_size_check CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT backup_runs_sha256_check CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT backup_runs_verified_check CHECK (
    verified_at IS NULL OR (sha256 IS NOT NULL AND status = 'SUCCESS')
  ),
  CONSTRAINT backup_runs_summary_length_check CHECK (
    (warning_summary IS NULL OR length(trim(warning_summary)) > 0)
    AND (failure_summary IS NULL OR length(trim(failure_summary)) > 0)
  )
);

CREATE INDEX backup_runs_created_cursor_idx
  ON backup_runs (created_at DESC, id DESC);

CREATE INDEX backup_runs_active_idx
  ON backup_runs (created_at DESC)
  WHERE status IN ('QUEUED', 'RUNNING');

-- Durable "at most one active backup per installation" guard (BR0 architecture
-- §9). Race-free at the storage layer: the service also pre-checks, but this
-- partial unique index on a constant expression is the authoritative guard.
CREATE UNIQUE INDEX backup_runs_single_active_unique
  ON backup_runs ((1))
  WHERE status IN ('QUEUED', 'RUNNING');

-- Installation-level backup policy. Singleton row; seeded with the BR0-approved
-- defaults. Manual / pre-restore age policies (30 days) are domain constants,
-- not persisted policy fields.
CREATE TABLE backup_policy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  schedule_time_local VARCHAR(5) NOT NULL DEFAULT '02:30',
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  daily_retention INTEGER NOT NULL DEFAULT 7,
  weekly_retention INTEGER NOT NULL DEFAULT 4,
  monthly_retention INTEGER NOT NULL DEFAULT 6,
  default_scope VARCHAR(20) NOT NULL DEFAULT 'DATABASE',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),

  CONSTRAINT backup_policy_singleton_unique UNIQUE (singleton),
  CONSTRAINT backup_policy_singleton_check CHECK (singleton),
  CONSTRAINT backup_policy_time_check CHECK (schedule_time_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT backup_policy_retention_check CHECK (
    daily_retention BETWEEN 1 AND 365
    AND weekly_retention BETWEEN 1 AND 52
    AND monthly_retention BETWEEN 1 AND 120
  ),
  CONSTRAINT backup_policy_scope_check CHECK (default_scope IN ('DATABASE', 'FULL_DATA'))
);

INSERT INTO backup_policy (
  id, singleton, enabled, schedule_time_local, timezone,
  daily_retention, weekly_retention, monthly_retention, default_scope
) VALUES (
  gen_random_uuid(), TRUE, FALSE, '02:30', 'UTC', 7, 4, 6, 'DATABASE'
);

-- Installation-level storage CONFIGURATION STATE ONLY. Never secret material:
-- R2 credentials stay in operator env files. Connection testing arrives in BR4;
-- the columns are the BR0 contract.
CREATE TABLE backup_storage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton BOOLEAN NOT NULL DEFAULT TRUE,
  provider VARCHAR(30) NOT NULL DEFAULT 'CLOUDFLARE_R2',
  bucket_alias VARCHAR(200),
  prefix VARCHAR(200) NOT NULL DEFAULT 'production/',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_connection_test_at TIMESTAMPTZ,
  last_connection_test_ok BOOLEAN,

  CONSTRAINT backup_storage_singleton_unique UNIQUE (singleton),
  CONSTRAINT backup_storage_singleton_check CHECK (singleton),
  CONSTRAINT backup_storage_provider_check CHECK (provider IN ('CLOUDFLARE_R2')),
  CONSTRAINT backup_storage_enabled_check CHECK (
    enabled = FALSE OR (bucket_alias IS NOT NULL AND length(trim(bucket_alias)) > 0)
  )
);

INSERT INTO backup_storage (id, singleton, provider, prefix, enabled)
VALUES (gen_random_uuid(), TRUE, 'CLOUDFLARE_R2', 'production/', FALSE);

-- Restore-domain foundation (BR7 executes restores; BR1 only records future
-- state/audit infrastructure). target_database is a database NAME only — never
-- a connection string (restore-rehearsal identifier contract).
CREATE TABLE restore_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id UUID REFERENCES backup_runs(id),
  mode VARCHAR(30) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'RUNNING',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  initiated_by VARCHAR(255) NOT NULL,
  target_database VARCHAR(63) NOT NULL,
  pre_restore_backup_id UUID REFERENCES backup_runs(id),
  verification_result JSONB,
  failure_code VARCHAR(50),

  CONSTRAINT restore_runs_mode_check CHECK (mode IN ('REHEARSAL', 'DISASTER_RECOVERY')),
  CONSTRAINT restore_runs_status_check CHECK (status IN (
    'RUNNING', 'READY_FOR_CUTOVER', 'COMPLETED', 'FAILED', 'CANCELLED'
  )),
  CONSTRAINT restore_runs_failure_code_check CHECK (failure_code IS NULL OR failure_code IN (
    'RESTORE_MANIFEST_INVALID', 'RESTORE_FORMAT_UNSUPPORTED',
    'RESTORE_CHECKSUM_FAILED', 'RESTORE_DATABASE_CREATE_FAILED',
    'RESTORE_PG_RESTORE_FAILED', 'RESTORE_INTEGRITY_FAILED'
  )),
  CONSTRAINT restore_runs_failure_status_check CHECK (
    status <> 'FAILED' OR failure_code IS NOT NULL
  ),
  CONSTRAINT restore_runs_terminal_completed_check CHECK (
    status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') OR completed_at IS NOT NULL
  ),
  CONSTRAINT restore_runs_initiated_by_check CHECK (length(trim(initiated_by)) > 0),
  CONSTRAINT restore_runs_target_database_check CHECK (
    target_database ~ '^[A-Za-z_][A-Za-z0-9_]*$'
  )
);

CREATE INDEX restore_runs_started_idx ON restore_runs (started_at DESC);

-- Durable "backup and restore are mutually exclusive" foundation: at most one
-- RUNNING restore. The shared cross-process advisory-lock namespace used by the
-- future worker (BR5) and restore CLI (BR7) is defined in the backup module
-- types; this index protects the DB-visible side.
CREATE UNIQUE INDEX restore_runs_single_running_unique
  ON restore_runs ((1))
  WHERE status = 'RUNNING';

-- Audit vocabulary extension (identifiers only; metadata never carries secrets,
-- credentials, or dump content — see backup-recovery platform contracts §8).
ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_subject_type_check,
  DROP CONSTRAINT audit_events_event_type_check;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_subject_type_check
  CHECK (subject_type IN (
    'USER', 'STAFF_PROFILE', 'CUSTOMER', 'CONTACT', 'PRODUCT',
    'STAFF_CONFIDENTIAL_NOTE', 'BACKUP_RUN', 'BACKUP_POLICY'
  )),
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN (
    'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED',
    'USER_DEACTIVATED', 'USER_PASSWORD_RESET',
    'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED',
    'CUSTOMER_CREATED', 'CUSTOMER_FIELDS_UPDATED',
    'CUSTOMER_ASSIGNEE_CHANGED', 'CUSTOMER_ACTIVATED',
    'CUSTOMER_DEACTIVATED', 'CONTACT_CREATED',
    'CONTACT_FIELDS_UPDATED', 'CONTACT_MADE_PRIMARY',
    'CONTACT_ACTIVATED', 'CONTACT_DEACTIVATED',
    'PRODUCT_CREATED', 'PRODUCT_FIELDS_UPDATED',
    'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED',
    'CUSTOMER_DELETED', 'PRODUCT_DELETED',
    'STAFF_CONFIDENTIAL_NOTE_CREATED',
    'BACKUP_REQUESTED', 'BACKUP_POLICY_UPDATED'
  ));
