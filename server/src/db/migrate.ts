import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.js';
import { closeDatabase, createDatabase } from './index.js';
import { runMigrations } from './migrate-runner.js';

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));

try {
  await runMigrations({ migrationsDirectory, store: database.migrations });
} finally {
  await closeDatabase(database);
}
