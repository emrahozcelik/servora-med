import { fileURLToPath } from 'node:url';

import { readDatabaseUrl } from '../config.js';
import { closeDatabase, createDatabase } from './index.js';
import { runMigrations } from './migrate-runner.js';

// Narrow database-maintenance config: the migration CLI needs only
// DATABASE_URL. It must NOT require unrelated application-runtime config
// (notably SERVORA_RELEASE_SHA), because the controlled deploy runs it
// before the release identity is transitioned into the production env.
const database = createDatabase(readDatabaseUrl(process.env.DATABASE_URL));
const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));

try {
  await runMigrations({ migrationsDirectory, store: database.migrations });
} finally {
  await closeDatabase(database);
}
