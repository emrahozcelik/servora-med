import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations, type MigrationStore } from '../src/db/migrate-runner.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createMigrationsDirectory(files: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'servora-med-migrations-'));
  temporaryDirectories.push(directory);
  await Promise.all(
    Object.entries(files).map(([name, sql]) => writeFile(path.join(directory, name), sql, 'utf8')),
  );
  return directory;
}

class MemoryMigrationStore implements MigrationStore {
  initialized = false;
  appliedVersions: string[];
  applications: Array<{ version: string; sql: string }> = [];

  constructor(appliedVersions: string[] = []) {
    this.appliedVersions = appliedVersions;
  }

  async initialize() {
    this.initialized = true;
  }

  async getAppliedVersions() {
    return this.appliedVersions;
  }

  async applyMigration(version: string, sql: string) {
    this.applications.push({ version, sql });
    this.appliedVersions.push(version);
  }
}

describe('runMigrations', () => {
  it('ships the complete ordered migration set through JobCard workspace', async () => {
    const migrationsDirectory = fileURLToPath(
      new URL('../src/db/migrations', import.meta.url),
    );

    const files = await readdir(migrationsDirectory);

    expect(files.filter((file) => file.endsWith('.sql')).sort()).toEqual([
      '001_auth_foundation.sql',
      '002_delivery_tracer.sql',
      '003_people.sql',
      '004_crm_contacts.sql',
      '005_product_catalog.sql',
      '006_jobcard_workspace.sql',
    ]);
  });

  it('applies pending SQL files in lexical order and skips applied versions', async () => {
    const directory = await createMigrationsDirectory({
      '003_third.sql': 'SELECT 3;',
      '001_first.sql': 'SELECT 1;',
      '002_second.sql': 'SELECT 2;',
      'README.md': 'not a migration',
    });
    const store = new MemoryMigrationStore(['002_second']);

    const result = await runMigrations({ migrationsDirectory: directory, store });

    expect(store.initialized).toBe(true);
    expect(store.applications).toEqual([
      { version: '001_first', sql: 'SELECT 1;' },
      { version: '003_third', sql: 'SELECT 3;' },
    ]);
    expect(result).toEqual({ appliedVersions: ['001_first', '003_third'] });
  });

  it('accepts an empty migration directory', async () => {
    const directory = await createMigrationsDirectory({});
    const store = new MemoryMigrationStore();

    await expect(runMigrations({ migrationsDirectory: directory, store })).resolves.toEqual({
      appliedVersions: [],
    });
  });
});

describe('PostgresMigrationStore', () => {
  it('applies one migration in a transaction and releases the client', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    let released = false;
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rows: [] };
      },
      release() {
        released = true;
      },
    };
    const pool = {
      async query() {
        return { rows: [] };
      },
      async connect() {
        return client;
      },
    };
    const store = new PostgresMigrationStore(pool);

    await store.applyMigration('001_auth', 'CREATE TABLE users (id uuid);');

    expect(calls).toEqual([
      { sql: 'BEGIN', values: undefined },
      { sql: 'CREATE TABLE users (id uuid);', values: undefined },
      {
        sql: 'INSERT INTO schema_migrations (version) VALUES ($1)',
        values: ['001_auth'],
      },
      { sql: 'COMMIT', values: undefined },
    ]);
    expect(released).toBe(true);
  });

  it('rolls back and releases the client when migration SQL fails', async () => {
    const calls: string[] = [];
    let released = false;
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql === 'BROKEN SQL') {
          throw new Error('migration failed');
        }
        return { rows: [] };
      },
      release() {
        released = true;
      },
    };
    const pool = {
      async query() {
        return { rows: [] };
      },
      async connect() {
        return client;
      },
    };
    const store = new PostgresMigrationStore(pool);

    await expect(store.applyMigration('001_broken', 'BROKEN SQL')).rejects.toThrow(
      'migration failed',
    );

    expect(calls).toEqual(['BEGIN', 'BROKEN SQL', 'ROLLBACK']);
    expect(released).toBe(true);
  });
});
