import type {
  BackupFailureClass,
  BackupProviderStatus,
  BackupTriggerClass,
} from './backup-freshness.js';

export type PublicHealthStatus = {
  status: 'ok' | 'unavailable';
  /** Exact server release SHA (`dev` outside controlled releases). */
  releaseSha: string;
};

export type PublicBackupHealth = {
  /**
   * Compatibility aggregate. Keeps its pre-existing meaning for existing
   * consumers: `ok` only for the fully healthy provider state, otherwise
   * `unavailable`. The richer accepted vocabulary lives in `providerStatus`.
   */
  status: 'ok' | 'unavailable';
  latestVerifiedAt: string | null;
  /** Latest verified scheduled run; manual success must not satisfy scheduled freshness. */
  latestScheduledVerifiedAt: string | null;
  latestRunStatus: string | null;
  latestScheduledRunStatus: string | null;
  workerHeartbeatAt: string | null;
  schedulerLastTickAt: string | null;

  // --- Additive provider detail (OPS-BACKUP-OBS-1). Optional so existing
  // providers and consumers keep compiling; the active provider always emits
  // them. Safe by construction: status vocabulary and instants only — never a
  // path, filename, database name, hostname, credential, object key or raw
  // error. ---
  /** Which provider produced this projection. */
  provider?: 'none' | 'host-observation' | 'br5-r2';
  /** Accepted semantic vocabulary; `status` is derived from it. */
  providerStatus?: BackupProviderStatus;
  /** When the provider last updated its evidence. */
  observationUpdatedAt?: string | null;
  latestAttemptAt?: string | null;
  latestAttemptCompletedAt?: string | null;
  latestAttemptTrigger?: BackupTriggerClass | null;
  /** Allowlisted failure-class token, never raw stderr. */
  latestAttemptFailureClass?: BackupFailureClass | null;
};

export type HealthReadinessPort = {
  check(): Promise<'ok' | 'unavailable'>;
};

export type BackupHealthReadinessPort = {
  check(): Promise<PublicBackupHealth>;
};

export const alwaysOkReadiness: HealthReadinessPort = {
  async check() {
    return 'ok';
  },
};

export function getPublicHealthStatus(
  result: 'ok' | 'unavailable',
  releaseSha: string,
): PublicHealthStatus {
  return { status: result, releaseSha };
}
