-- BR5-TT-1: trusted event evidence for the BR5/R2 backup provider.
--
-- Additive and forward-only. Every new column is nullable with no default;
-- existing rows remain valid history with NULL/UNKNOWN evidence. There is no
-- backfill, inferred boot ID, rewritten timestamp, or synthetic proof.
--
-- Time evidence is format-2 boot-bound TimeEvidence. The application validates
-- the full shape; these constraints protect the durable binding/atomicity
-- invariants at the database boundary.

ALTER TABLE backup_worker_state
  ADD COLUMN worker_heartbeat_time_evidence JSONB,
  ADD COLUMN scheduler_last_tick_time_evidence JSONB;

ALTER TABLE backup_worker_state
  ADD CONSTRAINT backup_worker_state_worker_evidence_check CHECK (
    worker_heartbeat_time_evidence IS NULL
    OR (
      worker_heartbeat_at IS NOT NULL
      AND jsonb_typeof(worker_heartbeat_time_evidence) = 'object'
    )
  ),
  ADD CONSTRAINT backup_worker_state_scheduler_evidence_check CHECK (
    scheduler_last_tick_time_evidence IS NULL
    OR (
      scheduler_last_tick_at IS NOT NULL
      AND jsonb_typeof(scheduler_last_tick_time_evidence) = 'object'
    )
  );

ALTER TABLE backup_runs
  ADD COLUMN artifact_generation_id UUID,
  ADD COLUMN artifact_generation_time_evidence JSONB,
  ADD COLUMN verification_time_evidence JSONB;

-- One dump generation belongs to exactly one run. This is the durable
-- new-run boundary: a run cannot adopt another run's generation.
CREATE UNIQUE INDEX backup_runs_artifact_generation_unique
  ON backup_runs (artifact_generation_id)
  WHERE artifact_generation_id IS NOT NULL;

ALTER TABLE backup_runs
  ADD CONSTRAINT backup_runs_artifact_generation_evidence_check CHECK (
    artifact_generation_time_evidence IS NULL
    OR (
      artifact_generation_id IS NOT NULL
      AND jsonb_typeof(artifact_generation_time_evidence) = 'object'
    )
  ),
  ADD CONSTRAINT backup_runs_verification_evidence_check CHECK (
    verification_time_evidence IS NULL
    OR (
      jsonb_typeof(verification_time_evidence) = 'object'
      AND artifact_generation_id IS NOT NULL
      AND remote_key IS NOT NULL AND remote_key <> ''
      AND size_bytes IS NOT NULL AND size_bytes > 0
      AND sha256 IS NOT NULL AND sha256 ~ '^[0-9a-f]{64}$'
      AND verification_time_evidence ? 'proofVersion'
      AND verification_time_evidence->>'proofVersion' = '2'
      AND verification_time_evidence ? 'runId'
      AND verification_time_evidence->>'runId' = id::text
      AND verification_time_evidence ? 'artifactGenerationId'
      AND verification_time_evidence->>'artifactGenerationId' = artifact_generation_id::text
      AND verification_time_evidence ? 'artifactSha256'
      AND verification_time_evidence->>'artifactSha256' = sha256
      AND verification_time_evidence ? 'sizeBytes'
      AND (verification_time_evidence->>'sizeBytes')::bigint = size_bytes
      AND verification_time_evidence ? 'remoteKey'
      AND verification_time_evidence->>'remoteKey' = remote_key
      AND verification_time_evidence ? 'origin'
      AND verification_time_evidence->>'origin' = origin
      AND verification_time_evidence ? 'verifiedAt'
      AND jsonb_typeof(verification_time_evidence->'verifiedAt') = 'string'
      AND (
        verified_at IS NULL
        OR verified_at = (verification_time_evidence->>'verifiedAt')::timestamptz
      )
    )
  );

-- AC-A1: verified_at is required for a SUCCESS row, but the constraint is
-- added NOT VALID so historical rows that predate this evidence model are not
-- rewritten. New/updated rows are still checked.
ALTER TABLE backup_runs
  ADD CONSTRAINT backup_runs_success_verified_check CHECK (
    status <> 'SUCCESS' OR verified_at IS NOT NULL
  ) NOT VALID;

-- Write-once generation and proof columns. A retry may update integrity fields
-- only before a proof is accepted; it can never replace the generation, the
-- original before, or an accepted proof/after.
CREATE FUNCTION backup_runs_trusted_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.artifact_generation_id IS NOT NULL
     AND (
       NEW.artifact_generation_id IS DISTINCT FROM OLD.artifact_generation_id
       OR NEW.artifact_generation_time_evidence IS DISTINCT FROM OLD.artifact_generation_time_evidence
     ) THEN
    RAISE EXCEPTION 'backup artifact generation evidence is immutable';
  END IF;
  IF OLD.verification_time_evidence IS NOT NULL
     AND NEW.verification_time_evidence IS DISTINCT FROM OLD.verification_time_evidence THEN
    RAISE EXCEPTION 'backup verification evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER backup_runs_trusted_evidence_immutable
  BEFORE UPDATE ON backup_runs
  FOR EACH ROW
  EXECUTE FUNCTION backup_runs_trusted_evidence_immutable();
