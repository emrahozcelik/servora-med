import type { Pool } from 'pg';

import { compareMigrationState, type MigrationCatalog } from '../../db/migration-catalog.js';
import type { HealthReadinessPort } from './service.js';

/**
 * SD2: readiness now uses the SD1 migration catalog as the sole authoritative
 * expected history. It is loaded once at bootstrap and reused; each check
 * re-reads DB applied versions read-only (no initialize(), no advisory lock).
 * Any incompatibility (BEHIND, EMPTY, AHEAD, DIVERGED, missing table, DB down)
 * => unavailable (503) without exposing migration internals publicly.
 *
 * HEALTH_SCHEMA_VERSION is NOT used as expected head; it is an optional
 * config assertion validated at startup (see db/schema-compatibility).
 */

export function createPostgresReadiness(
  pool: Pool,
  catalogOrVersion: MigrationCatalog | string | null = null,
): HealthReadinessPort {
  // Backward compatibility for existing tests that still pass a string healthSchemaVersion.
  if (typeof catalogOrVersion === 'string' || catalogOrVersion === null) {
    return createLegacyPostgresReadiness(pool, catalogOrVersion as string | null);
  }
  const catalog = catalogOrVersion as MigrationCatalog;
  return {
    async check() {
      try {
        // Liveness probe; if this fails we are unavailable regardless.
        await pool.query('SELECT 1');
        if (!catalog.head || catalog.count === 0) {
          return 'unavailable';
        }
        let appliedVersions: string[];
        try {
          const result = await pool.query<{ version: string }>(
            'SELECT version FROM schema_migrations ORDER BY version',
          );
          appliedVersions = result.rows.map((row) => row.version);
        } catch {
          // Missing table, permission, or connection error inside history read => unavailable
          return 'unavailable';
        }
        const result = compareMigrationState(catalog, appliedVersions);
        return result.status === 'COMPATIBLE' ? 'ok' : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
  };
}

/**
 * @deprecated Legacy health check that used HEALTH_SCHEMA_VERSION exact match.
 * Kept only for historical tests; new code should use catalog-aware variant above.
 */
export function createLegacyPostgresReadiness(
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
