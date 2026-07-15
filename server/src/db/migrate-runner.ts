import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

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
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const newlyApplied: string[] = [];

  for (const file of files) {
    const version = file.slice(0, -'.sql'.length);
    if (appliedVersions.has(version)) {
      continue;
    }

    const sql = await readFile(path.join(migrationsDirectory, file), 'utf8');
    try {
      await store.applyMigration(version, sql);
      newlyApplied.push(version);
      logger.info(`Migration applied: ${file}`);
    } catch (error) {
      logger.error(`Migration failed: ${file}`);
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
