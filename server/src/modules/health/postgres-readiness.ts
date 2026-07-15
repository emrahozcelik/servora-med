import type { Pool } from 'pg';

import type { HealthReadinessPort } from './service.js';

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
          if (!exact.rows[0]) return 'unavailable';
          return 'ok';
        }
        const count = await pool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM schema_migrations',
        );
        if (Number(count.rows[0]?.count ?? 0) < 1) return 'unavailable';
        return 'ok';
      } catch {
        return 'unavailable';
      }
    },
  };
}
