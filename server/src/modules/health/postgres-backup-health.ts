import type { Pool } from 'pg';

import type { BackupHealthReadinessPort, PublicBackupHealth } from './service.js';
import {
  createTrustedTimeSampler,
  type TrustedTimeSampler,
} from './trusted-time-sampler.js';
import {
  elapsedTime,
  type CurrentTimeEvidence,
} from '../../../../ops/scripts/trusted-time.mjs';
import {
  evaluateArtifactFreshness,
  parseTimeEvidence,
  type BackupVerificationProof,
  type VerifiedRunEvidence,
} from '../backup/trusted-evidence.js';

export type PostgresBackupHealthOptions = {
  workerEnabled?: boolean;
  workerStaleAfterMs?: number;
  schedulerStaleAfterMs?: number;
  /** Retained for API compatibility; freshness is never derived from it. */
  now?: () => Date;
  /** Test seam: one bounded trusted sample per check. */
  sampleTime?: () => Promise<CurrentTimeEvidence | null>;
  /** Optional shared sampler; when omitted the reader owns one. */
  sampler?: TrustedTimeSampler;
};

type VerifiedRow = {
  id: string;
  status: string;
  origin: VerifiedRunEvidence['origin'];
  verified_at: Date | null;
  remote_key: string | null;
  size_bytes: string | number | null;
  sha256: string | null;
  artifact_generation_id: string | null;
  artifact_generation_time_evidence: unknown;
  verification_time_evidence: unknown;
};

type WorkerRow = {
  worker_heartbeat_at: Date | null;
  scheduler_last_tick_at: Date | null;
  worker_heartbeat_time_evidence: unknown;
  scheduler_last_tick_time_evidence: unknown;
};

type StatusRow = { status: string };
type ActiveRow = { active: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toVerifiedRun(row: VerifiedRow | undefined): VerifiedRunEvidence | null {
  if (!row) return null;
  return {
    id: row.id,
    origin: row.origin,
    verifiedAt: row.verified_at,
    remoteKey: row.remote_key,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    sha256: row.sha256,
    artifactGenerationId: row.artifact_generation_id,
    artifactGenerationTimeEvidence: parseTimeEvidence(row.artifact_generation_time_evidence),
    verificationTimeEvidence: record(row.verification_time_evidence)
      ? row.verification_time_evidence as unknown as BackupVerificationProof
      : null,
  };
}

function heartbeatFresh(
  at: Date | null,
  rawEvidence: unknown,
  current: CurrentTimeEvidence,
  maxAgeMs: number,
): boolean {
  if (!at) return false;
  const evidence = parseTimeEvidence(rawEvidence);
  if (!evidence) return false;
  // Timestamp and evidence must come from the same atomic write.
  if (evidence.wallAtUTC !== at.toISOString()) return false;
  const elapsed = elapsedTime(evidence, current);
  return elapsed.status === 'KNOWN' && elapsed.upperMs <= maxAgeMs;
}

/** Safe, aggregate-only backup health surface for the operator monitor.
 * No keys, paths, evidence details, or raw diagnostics leave the database
 * boundary. */
export function createPostgresBackupHealth(
  pool: Pool,
  options: PostgresBackupHealthOptions = {},
): BackupHealthReadinessPort {
  const workerEnabled = options.workerEnabled ?? false;
  const workerStaleAfterMs = options.workerStaleAfterMs ?? 120_000;
  const schedulerStaleAfterMs = options.schedulerStaleAfterMs ?? workerStaleAfterMs;
  const injectedSampler = options.sampler;
  const ownsSampler = !options.sampleTime && !injectedSampler;
  const sampler = injectedSampler
    ?? (options.sampleTime ? null : createTrustedTimeSampler());
  const sample = async (): Promise<CurrentTimeEvidence | null> => {
    try {
      if (options.sampleTime) return options.sampleTime();
      if (!sampler) return null;
      return await sampler.sample();
    } catch {
      return null;
    }
  };

  return {
    async check(): Promise<PublicBackupHealth> {
      const unavailable: PublicBackupHealth = {
        status: 'unavailable',
        latestVerifiedAt: null,
        latestScheduledVerifiedAt: null,
        latestRunStatus: null,
        latestScheduledRunStatus: null,
        workerHeartbeatAt: null,
        schedulerLastTickAt: null,
        provider: 'br5-r2',
        providerStatus: 'unavailable',
      };
      try {
        const [latestVerified, scheduledVerified, latestRun, scheduledRun, worker, active] = await Promise.all([
          pool.query<VerifiedRow>(
            `SELECT id, status, origin, verified_at, remote_key, size_bytes, sha256,
                    artifact_generation_id, artifact_generation_time_evidence,
                    verification_time_evidence
               FROM backup_runs
              WHERE status = 'SUCCESS' AND verified_at IS NOT NULL
              ORDER BY verified_at DESC, created_at DESC, id DESC
              LIMIT 1 -- latest_verified`,
          ),
          pool.query<VerifiedRow>(
            `SELECT id, status, origin, verified_at, remote_key, size_bytes, sha256,
                    artifact_generation_id, artifact_generation_time_evidence,
                    verification_time_evidence
               FROM backup_runs
              WHERE status = 'SUCCESS' AND origin = 'SCHEDULED' AND verified_at IS NOT NULL
              ORDER BY verified_at DESC, created_at DESC, id DESC
              LIMIT 1 -- scheduled_verified`,
          ),
          pool.query<StatusRow>(
            `SELECT status FROM backup_runs
              ORDER BY created_at DESC, id DESC LIMIT 1 -- latest_run_status`,
          ),
          pool.query<StatusRow>(
            `SELECT status FROM backup_runs WHERE origin = 'SCHEDULED'
              ORDER BY created_at DESC, id DESC LIMIT 1 -- scheduled_run_status`,
          ),
          pool.query<WorkerRow>(
            `SELECT worker_heartbeat_at, scheduler_last_tick_at,
                    worker_heartbeat_time_evidence, scheduler_last_tick_time_evidence
               FROM backup_worker_state WHERE singleton LIMIT 1`,
          ),
          pool.query<ActiveRow>(
            `SELECT EXISTS(
               SELECT 1 FROM backup_runs
                WHERE status = 'RUNNING' AND lease_until > CURRENT_TIMESTAMP
             ) AS active -- active_running`,
          ),
        ]);

        const workerRow = worker.rows[0] ?? null;
        const verifiedRun = toVerifiedRun(latestVerified.rows[0]);
        const scheduledVerifiedRun = toVerifiedRun(scheduledVerified.rows[0]);
        const latestRunStatus = latestRun.rows[0]?.status ?? null;
        const latestScheduledRunStatus = scheduledRun.rows[0]?.status ?? null;
        const workerHeartbeatAt = workerRow?.worker_heartbeat_at ?? null;
        const schedulerLastTickAt = workerRow?.scheduler_last_tick_at ?? null;

        const projection = {
          latestVerifiedAt: verifiedRun?.verifiedAt?.toISOString() ?? null,
          latestScheduledVerifiedAt: scheduledVerifiedRun?.verifiedAt?.toISOString() ?? null,
          latestRunStatus,
          latestScheduledRunStatus,
          workerHeartbeatAt: workerHeartbeatAt?.toISOString() ?? null,
          schedulerLastTickAt: schedulerLastTickAt?.toISOString() ?? null,
          provider: 'br5-r2' as const,
        };

        // Failure priority does not depend on a current sample or liveness.
        if (latestScheduledRunStatus === 'FAILED') {
          return {
            ...unavailable,
            ...projection,
            providerStatus: 'failed',
          };
        }
        if (!scheduledVerifiedRun) {
          return { ...unavailable, ...projection };
        }

        const current = await sample();
        if (!current) return { ...unavailable, ...projection };

        const freshness = evaluateArtifactFreshness(scheduledVerifiedRun, current);
        if (freshness === 'stale') {
          return { ...unavailable, ...projection, providerStatus: 'stale' };
        }
        if (freshness !== 'healthy') {
          return { ...unavailable, ...projection };
        }

        if (workerEnabled) {
          const workerLive = heartbeatFresh(
            workerHeartbeatAt,
            workerRow?.worker_heartbeat_time_evidence,
            current,
            workerStaleAfterMs,
          );
          const schedulerLive = active.rows[0]?.active === true && workerLive
            ? true
            : heartbeatFresh(
              schedulerLastTickAt,
              workerRow?.scheduler_last_tick_time_evidence,
              current,
              schedulerStaleAfterMs,
            );
          if (!workerLive || !schedulerLive) {
            return { ...unavailable, ...projection };
          }
        }

        return {
          status: 'ok',
          ...projection,
          providerStatus: 'healthy',
        };
      } catch {
        return unavailable;
      }
    },
    async close() {
      if (ownsSampler && sampler) await sampler.close();
    },
  };
}
