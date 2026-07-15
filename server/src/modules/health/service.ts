export type PublicHealthStatus = {
  status: 'ok' | 'unavailable';
};

export type HealthReadinessPort = {
  check(): Promise<'ok' | 'unavailable'>;
};

export const alwaysOkReadiness: HealthReadinessPort = {
  async check() {
    return 'ok';
  },
};

export function getPublicHealthStatus(result: 'ok' | 'unavailable'): PublicHealthStatus {
  return { status: result };
}
