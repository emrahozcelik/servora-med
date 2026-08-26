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

export function createPostgresReadiness(pool: Pool, catalog: MigrationCatalog): HealthReadinessPort {
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
