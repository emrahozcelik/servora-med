import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

import {
  compareMigrationState,
  loadMigrationCatalog,
  type MigrationCatalog,
  type MigrationCompatibility,
} from './migration-catalog.js';

/**
 * Read-only runtime schema compatibility for startup + readiness.
 * Uses SD1 catalog as sole authoritative expected head.
 * Never mutates DB (no initialize(), no advisory lock, no auto-migrate).
 */

export function getMigrationsDirectory(): string {
  return fileURLToPath(new URL('./migrations', import.meta.url));
}

function isMissingSchemaMigrationsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === '42P01') return true;
  const msg = (error as { message?: unknown }).message;
  if (typeof msg === 'string' && msg.includes('schema_migrations') && msg.includes('does not exist')) return true;
  return false;
}

export async function fetchAppliedVersions(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY applied_at ASC, version ASC',
  );
  return result.rows.map((row) => row.version);
}

export type SchemaCompatibilityOptions = {
  pool: Pool;
  catalog: MigrationCatalog;
};

export async function checkDatabaseSchemaCompatibility(
  options: SchemaCompatibilityOptions,
): Promise<MigrationCompatibility> {
  const applied = await fetchAppliedVersions(options.pool);
  return compareMigrationState(options.catalog, applied);
}

export type SchemaGuardResult =
  | { compatible: true; catalog: MigrationCatalog; compatibility: Extract<MigrationCompatibility, { status: 'COMPATIBLE' }> }
  | { compatible: false; catalog: MigrationCatalog; compatibility: Exclude<MigrationCompatibility, { status: 'COMPATIBLE' }> };

/**
 * Load catalog (once) and check DB compatibility.
 * Returns typed result; throws only for catalog load failure or DB connectivity failure.
 * Missing schema_migrations table is treated as incompatible (not thrown), except
 * the caller may want to distinguish for logging — this helper returns it as DIVERGED-like
 * via compare? Instead we propagate missing-table as a distinct thrown signal so startup
 * can log "history unavailable". For health we convert to unavailable.
 */
export async function loadCatalogAndCheck(
  pool: Pool,
  migrationsDirectory: string,
): Promise<MigrationCompatibility> {
  const catalog = await loadMigrationCatalog(migrationsDirectory);
  if (catalog.count === 0 || !catalog.head) {
    throw Object.assign(new Error('Application migration catalog is empty or unavailable'), {
      code: 'CATALOG_EMPTY',
      catalog,
    });
  }
  const applied = await fetchAppliedVersions(pool);
  return compareMigrationState(catalog, applied);
}

export function formatCompatibilityForLog(
  compatibility: MigrationCompatibility,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    status: compatibility.status,
    catalogHead: compatibility.catalog.head?.version ?? null,
    catalogCount: compatibility.catalog.count,
  };
  if (compatibility.status === 'BEHIND') {
    return {
      ...base,
      appliedHead: compatibility.appliedHead,
      expectedHead: compatibility.expectedHead,
      pendingVersions: compatibility.pendingVersions,
    };
  }
  if (compatibility.status === 'EMPTY') {
    return {
      ...base,
      expectedHead: compatibility.expectedHead,
      pendingVersions: compatibility.pendingVersions,
    };
  }
  if (compatibility.status === 'AHEAD') {
    return {
      ...base,
      appliedHead: compatibility.appliedHead,
      expectedHead: compatibility.expectedHead,
      unexpectedVersions: compatibility.unexpectedVersions,
    };
  }
  if (compatibility.status === 'DIVERGED') {
    return {
      ...base,
      unexpectedVersions: compatibility.unexpectedVersions,
      missingVersions: compatibility.missingVersions,
      duplicateVersions: compatibility.duplicateVersions,
      reason: compatibility.reason,
    };
  }
  return base;
}

export function getHealthSchemaVersionMismatchError(
  catalog: MigrationCatalog,
  healthSchemaVersion: string | null,
): Error | null {
  if (!healthSchemaVersion) return null;
  const head = catalog.head?.version ?? null;
  if (head && healthSchemaVersion !== head) {
    return new Error(
      `HEALTH_SCHEMA_VERSION mismatch: expected ${head} but got ${healthSchemaVersion}`,
    );
  }
  return null;
}

export type StartupLogger = {
  error(fields: Record<string, unknown>, message: string): void;
  info?(fields: Record<string, unknown>, message: string): void;
};

/**
 * Startup fail-fast assertion: only COMPATIBLE may proceed.
 * Never mutates DB. Returns void on success, throws with actionable message on failure.
 * Missing table -> "Database migration history is unavailable. Run npm run migrate..."
 * BEHIND/EMPTY -> "Database schema is behind application migrations. Run npm run migrate."
 * AHEAD -> "Database schema is newer than this application release. Refusing startup."
 * DIVERGED -> "Database migration history is incompatible..."
 */
export async function assertStartupSchemaCompatible(options: {
  pool: Pool;
  catalog: MigrationCatalog;
  logger?: StartupLogger;
}): Promise<void> {
  if (!options.catalog.head || options.catalog.count === 0) {
    const error = new Error('Application migration catalog is empty or unavailable');
    options.logger?.error({ catalogCount: options.catalog.count }, error.message);
    throw error;
  }
  let appliedVersions: string[];
  try {
    appliedVersions = await fetchAppliedVersions(options.pool);
  } catch (error) {
    if (isMissingSchemaMigrationsError(error)) {
      const msg =
        'Database migration history is unavailable. Run npm run migrate for a new/uninitialized database.';
      options.logger?.error(
        { err: error, expectedHead: options.catalog.head.version },
        msg,
      );
      throw new Error(msg);
    }
    throw error;
  }
  const compatibility = compareMigrationState(options.catalog, appliedVersions);
  if (compatibility.status === 'COMPATIBLE') return;
  if (compatibility.status === 'BEHIND' || compatibility.status === 'EMPTY') {
    const pending = (compatibility as { pendingVersions?: readonly string[] }).pendingVersions ?? [];
    options.logger?.error(
      {
        status: compatibility.status,
        expectedHead: options.catalog.head.version,
        appliedHead:
          compatibility.status === 'BEHIND'
            ? (compatibility as { appliedHead: string | null }).appliedHead
            : null,
        pendingVersions: pending,
      },
      'Database schema is behind application migrations. Run npm run migrate.',
    );
  } else if (compatibility.status === 'AHEAD') {
    options.logger?.error(
      {
        status: compatibility.status,
        expectedHead: options.catalog.head.version,
        appliedHead: (compatibility as { appliedHead: string | null }).appliedHead,
        unexpectedVersions: (compatibility as { unexpectedVersions: readonly string[] }).unexpectedVersions,
      },
      'Database schema is newer than this application release. Refusing startup.',
    );
  } else {
    options.logger?.error(
      {
        status: compatibility.status,
        reason: (compatibility as { reason?: string }).reason,
        expectedHead: options.catalog.head.version,
      },
      'Database migration history is incompatible with this application release. Refusing startup.',
    );
  }
  throw new Error(`Database schema incompatibility: ${compatibility.status}`);
}
