import { readFile } from 'node:fs/promises';

import { loadMigrationCatalog } from './migration-catalog.js';

export interface MigrationStore {
  initialize(): Promise<void>;
  getAppliedVersions(): Promise<string[]>;
  applyMigration(version: string, sql: string): Promise<void>;
  withMigrationLock?<T>(fn: () => Promise<T>): Promise<T>;
}

export type MigrationLogger = {
  info(message: string): void;
  error(message: string): void;
};

type RunMigrationsOptions = {
  migrationsDirectory: string;
  store: MigrationStore;
  logger?: MigrationLogger;
};

async function applyPending(
  migrationsDirectory: string,
  store: MigrationStore,
  logger: MigrationLogger,
): Promise<{ appliedVersions: string[] }> {
  await store.initialize();

  const appliedVersions = new Set(await store.getAppliedVersions());
  const catalog = await loadMigrationCatalog(migrationsDirectory);
  const newlyApplied: string[] = [];

  for (const entry of catalog.entries) {
    if (appliedVersions.has(entry.version)) {
      continue;
    }

    const sql = await readFile(entry.path, 'utf8');
    try {
      await store.applyMigration(entry.version, sql);
      newlyApplied.push(entry.version);
      logger.info(`Migration applied: ${entry.filename}`);
    } catch (error) {
      logger.error(`Migration failed: ${entry.filename}`);
      throw error;
    }
  }

  return { appliedVersions: newlyApplied };
}

export async function runMigrations({
  migrationsDirectory,
  store,
  logger = console,
}: RunMigrationsOptions): Promise<{ appliedVersions: string[] }> {
  if (store.withMigrationLock) {
    return store.withMigrationLock(() => applyPending(migrationsDirectory, store, logger));
  }
  return applyPending(migrationsDirectory, store, logger);
}
