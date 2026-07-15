import type { Pool } from 'pg';

import type { HealthReadinessPort } from './service.js';

/**
 * Production always supplies an exact HEALTH_SCHEMA_VERSION.
 * Development/test may omit it; then any applied migration row is enough.
 * Production must never use a "count >= 1" fallback.
 */
export function createPostgresReadiness(
  pool: Pool,
  healthSchemaVersion: string | null = null,
): HealthReadinessPort {
  return {
    async check() {
      try {
        await pool.query('SELECT 1');
        if (healthSchemaVersion) {
          const exact = await pool.query<{ version: string }>(
            'SELECT version FROM schema_migrations WHERE version = $1 LIMIT 1',
            [healthSchemaVersion],
          );
          return exact.rows[0] ? 'ok' : 'unavailable';
        }
        const count = await pool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM schema_migrations',
        );
        return Number(count.rows[0]?.count ?? 0) >= 1 ? 'ok' : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
  };
}
