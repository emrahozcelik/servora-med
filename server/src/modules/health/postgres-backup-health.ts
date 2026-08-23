import type { Pool } from 'pg';

import type { BackupHealthReadinessPort, PublicBackupHealth } from './service.js';

export type PostgresBackupHealthOptions = {
  workerEnabled?: boolean;
  workerStaleAfterMs?: number;
  schedulerStaleAfterMs?: number;
  now?: () => Date;
};

/** Safe, aggregate-only backup health surface for the existing operator
 * alerting monitor. No keys, paths, diagnostics, or object contents leave the
 * database boundary. */
export function createPostgresBackupHealth(
  pool: Pool,
  options: PostgresBackupHealthOptions = {},
): BackupHealthReadinessPort {
  const workerEnabled = options.workerEnabled ?? false;
  const workerStaleAfterMs = options.workerStaleAfterMs ?? 120_000;
  const schedulerStaleAfterMs = options.schedulerStaleAfterMs ?? workerStaleAfterMs;
  const now = options.now ?? (() => new Date());

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
      };
      try {
        const [verified, scheduledVerified, latest, scheduledLatest, worker] = await Promise.all([
          pool.query<{ verified_at: Date | null }>(
            `SELECT verified_at FROM backup_runs
              WHERE status = 'SUCCESS' AND verified_at IS NOT NULL
              ORDER BY verified_at DESC LIMIT 1`,
          ),
          pool.query<{ verified_at: Date | null }>(
            `SELECT verified_at FROM backup_runs
              WHERE status = 'SUCCESS' AND origin = 'SCHEDULED' AND verified_at IS NOT NULL
              ORDER BY verified_at DESC LIMIT 1`,
          ),
          pool.query<{ status: string }>(
            `SELECT status FROM backup_runs ORDER BY created_at DESC, id DESC LIMIT 1`,
          ),
          pool.query<{ status: string }>(
            `SELECT status FROM backup_runs WHERE origin = 'SCHEDULED'
              ORDER BY created_at DESC, id DESC LIMIT 1`,
          ),
          pool.query<{
            worker_heartbeat_at: Date | null;
            scheduler_last_tick_at: Date | null;
          }>(
            `SELECT worker_heartbeat_at, scheduler_last_tick_at
               FROM backup_worker_state WHERE singleton LIMIT 1`,
          ),
        ]);
        const verifiedAt = verified.rows[0]?.verified_at ?? null;
        const workerHeartbeatAt = worker.rows[0]?.worker_heartbeat_at ?? null;
        const schedulerLastTickAt = worker.rows[0]?.scheduler_last_tick_at ?? null;
        const currentTime = now().getTime();
        const workerHealthy = !workerEnabled
          || (workerHeartbeatAt !== null && currentTime - workerHeartbeatAt.getTime() <= workerStaleAfterMs);
        const schedulerHealthy = !workerEnabled
          || (schedulerLastTickAt !== null && currentTime - schedulerLastTickAt.getTime() <= schedulerStaleAfterMs);
        return {
          status: verifiedAt && workerHealthy && schedulerHealthy ? 'ok' : 'unavailable',
          latestVerifiedAt: verifiedAt?.toISOString() ?? null,
          latestScheduledVerifiedAt: scheduledVerified.rows[0]?.verified_at?.toISOString() ?? null,
          latestRunStatus: latest.rows[0]?.status ?? null,
          latestScheduledRunStatus: scheduledLatest.rows[0]?.status ?? null,
          workerHeartbeatAt: workerHeartbeatAt?.toISOString() ?? null,
          schedulerLastTickAt: schedulerLastTickAt?.toISOString() ?? null,
        };
      } catch {
        return unavailable;
      }
    },
  };
}
