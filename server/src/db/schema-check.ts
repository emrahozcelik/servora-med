import { loadConfig } from '../config.js';
import { closeDatabase, createDatabase } from './index.js';
import {
  compareMigrationState,
  loadMigrationCatalog,
  MigrationCatalogError,
  type MigrationCatalog,
} from './migration-catalog.js';
import {
  fetchAppliedVersions,
  getHealthSchemaVersionMismatchError,
  getMigrationsDirectory,
} from './schema-compatibility.js';

function isMissingSchemaMigrationsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === '42P01') return true;
  const msg = (error as { message?: unknown }).message;
  if (typeof msg === 'string' && msg.includes('schema_migrations') && msg.includes('does not exist')) return true;
  return false;
}

function formatPending(catalog: MigrationCatalog, pending: readonly string[]): string {
  if (pending.length === 0) return '';
  return ` pending=${pending.join(',')}`;
}

function formatUnexpected(unexpected: readonly string[]): string {
  if (unexpected.length === 0) return '';
  return ` unexpected=${unexpected.join(',')}`;
}

let exitCode = 0;
let database: ReturnType<typeof createDatabase> | null = null;

try {
  const config = loadConfig();
  const directory = getMigrationsDirectory();
  let catalog: MigrationCatalog;
  try {
    catalog = await loadMigrationCatalog(directory);
  } catch (error) {
    if (error instanceof MigrationCatalogError) {
      console.error(`Catalog invalid (${error.reason}): ${error.message}`);
      console.error('Release/package integrity failure — migration catalog is invalid or missing.');
      exitCode = 1;
      throw error;
    }
    console.error('Failed to load migration catalog:', error);
    exitCode = 1;
    throw error;
  }

  if (!catalog.head || catalog.count === 0) {
    console.error('Application migration catalog is empty or unavailable');
    console.error('Release/package integrity failure — no migrations found.');
    exitCode = 1;
    throw new Error('Catalog empty');
  }

  const mismatch = getHealthSchemaVersionMismatchError(catalog, config.healthSchemaVersion);
  if (mismatch) {
    console.error(mismatch.message);
    console.error('HEALTH_SCHEMA_VERSION must equal the current release catalog head.');
    exitCode = 1;
    throw mismatch;
  }

  database = createDatabase(config.databaseUrl);

  let appliedVersions: string[];
  try {
    appliedVersions = await fetchAppliedVersions(database.pool);
  } catch (error) {
    if (isMissingSchemaMigrationsError(error)) {
      console.error('Database has no migration history; explicit migration may be required. (missing schema_migrations)');
      console.error(`Catalog head: ${catalog.head.version} (count ${catalog.count})`);
      exitCode = 1;
      throw error;
    }
    console.error('Database unavailable or failed to read migration history.');
    // Do not print DATABASE_URL / credentials
    if (error instanceof Error) console.error(error.message);
    exitCode = 1;
    throw error;
  }

  const compatibility = compareMigrationState(catalog, appliedVersions);

  if (compatibility.status === 'COMPATIBLE') {
    console.info(`Schema check: COMPATIBLE (catalog ${catalog.head.version}, count ${catalog.count})`);
    exitCode = 0;
  } else if (compatibility.status === 'BEHIND') {
    console.error(
      `Schema check: BEHIND (catalog ${catalog.head.version}, applied ${compatibility.appliedHead ?? 'none'}${formatPending(catalog, compatibility.pendingVersions)})`,
    );
    console.error('Database must be migrated; Run npm run migrate.');
    exitCode = 1;
  } else if (compatibility.status === 'EMPTY') {
    console.error(`Schema check: EMPTY (catalog ${catalog.head.version}, applied none${formatPending(catalog, compatibility.pendingVersions)})`);
    console.error('Database must be migrated; Run npm run migrate.');
    exitCode = 1;
  } else if (compatibility.status === 'AHEAD') {
    console.error(
      `Schema check: AHEAD (catalog ${catalog.head.version}, applied ${compatibility.appliedHead ?? 'none'}${formatUnexpected(compatibility.unexpectedVersions)})`,
    );
    console.error('Database is newer than this release; do NOT recommend blind migration. Manual investigation required.');
    exitCode = 1;
  } else if (compatibility.status === 'DIVERGED') {
    console.error(
      `Schema check: DIVERGED (catalog ${catalog.head.version}${formatUnexpected(compatibility.unexpectedVersions)} missing=${compatibility.missingVersions.join(',') || 'none'} reason=${compatibility.reason})`,
    );
    console.error('Migration history incompatible; manual investigation required.');
    exitCode = 1;
  } else {
    console.error(`Schema check: UNKNOWN status ${(compatibility as { status: string }).status}`);
    exitCode = 1;
  }
} catch (error) {
  if (exitCode === 0) {
    // Catalog load or other unexpected failure without explicit exit code
    if (error instanceof MigrationCatalogError) {
      // already handled, but ensure non-zero
      exitCode = 1;
    } else if (error instanceof Error && error.message.includes('HEALTH_SCHEMA_VERSION')) {
      exitCode = 1;
    } else if (error instanceof Error && error.message.includes('Catalog empty')) {
      exitCode = 1;
    } else {
      console.error('Schema check failed:', error instanceof Error ? error.message : String(error));
      exitCode = 1;
    }
  }
} finally {
  if (database) {
    try {
      await closeDatabase(database);
    } catch {
      // ignore close errors, exit code already set
    }
  }
  // Ensure process exits with correct code after cleanup
  process.exit(exitCode);
}
