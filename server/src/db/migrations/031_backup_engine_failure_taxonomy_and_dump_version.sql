-- BR2 engine reconciliation (external review of PR #189, head 8b06a07):
--
-- 1. dumpVersion semantics. The custom archive's format version ("Dump
--    Version: 1.15-0" from `pg_restore -l`) is a dotted string, not an
--    integer. The column becomes VARCHAR; BR2 populates it from the produced
--    archive header, and the producer tool version is recorded separately in
--    the manifest (dumpToolVersion).
-- 2. Failure taxonomy completion (additive): CHECKSUM-phase failures get
--    their own stable code instead of overloading MANIFEST_FAILED, and local
--    files-archive prerequisites get a dedicated preflight code instead of
--    overloading the R2-oriented PREFLIGHT_STORAGE_UNAVAILABLE.

ALTER TABLE backup_runs
  ALTER COLUMN dump_version TYPE VARCHAR(30)
  USING (CASE WHEN dump_version IS NULL THEN NULL ELSE dump_version::text END);

ALTER TABLE backup_runs
  DROP CONSTRAINT backup_runs_failure_code_check;

ALTER TABLE backup_runs
  ADD CONSTRAINT backup_runs_failure_code_check CHECK (failure_code IS NULL OR failure_code IN (
    'PREFLIGHT_DATABASE_UNAVAILABLE', 'PREFLIGHT_PG_DUMP_UNAVAILABLE',
    'PREFLIGHT_LOW_DISK', 'PREFLIGHT_STORAGE_UNAVAILABLE',
    'PREFLIGHT_FILES_ARCHIVE_UNAVAILABLE',
    'PREFLIGHT_WORKSPACE_CONFLICT',
    'PG_DUMP_FAILED', 'FILES_ARCHIVE_FAILED', 'MANIFEST_FAILED',
    'CHECKSUM_FAILED', 'PACKAGE_FAILED', 'ENCRYPTION_FAILED',
    'R2_AUTH_FAILED', 'R2_UPLOAD_FAILED', 'R2_DOWNLOAD_FAILED',
    'REMOTE_CHECKSUM_MISMATCH', 'WORKER_LOST'
  ));
