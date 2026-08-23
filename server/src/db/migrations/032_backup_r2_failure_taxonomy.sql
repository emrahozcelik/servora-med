-- BR4 R2 failure taxonomy (additive only).
--
-- Remote-object integrity conflicts and verify-phase transport failures are
-- distinct operational situations that the BR0 taxonomy anticipated but did
-- not yet name:
--   R2_OBJECT_CONFLICT — the deterministic object key already exists but does
--     not match this run's exact expected artifact/metadata. Integrity class,
--     fail closed: no overwrite, no delete, no automatic retry.
--   R2_VERIFY_FAILED — remote verification could not be completed because the
--     remote object could not be read/streamed due to transport/service
--     failure. Transient class: retryable by the future BR5 bounded phase
--     retry; terminal FAILED only after retry exhaustion.
--   R2_OBJECT_TOO_LARGE — the ciphertext exceeds R2's conditional single-PUT
--     ceiling. BR4 deliberately does not fall back to race-prone multipart
--     finalization; terminal until multipart no-overwrite is reconciled.
-- Existing codes keep their exact meanings; no existing rows are altered.

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
    'R2_OBJECT_TOO_LARGE', 'R2_OBJECT_CONFLICT', 'R2_VERIFY_FAILED',
    'REMOTE_CHECKSUM_MISMATCH', 'WORKER_LOST'
  ));
