export type PublicHealthStatus = {
  status: 'ok' | 'unavailable';
  /** Exact server release SHA (`dev` outside controlled releases). */
  releaseSha: string;
};

export type PublicBackupHealth = {
  status: 'ok' | 'unavailable';
  latestVerifiedAt: string | null;
  /** Latest verified scheduled run; manual success must not satisfy scheduled freshness. */
  latestScheduledVerifiedAt: string | null;
  latestRunStatus: string | null;
  latestScheduledRunStatus: string | null;
  workerHeartbeatAt: string | null;
  schedulerLastTickAt: string | null;
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
