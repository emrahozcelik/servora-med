import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('migration advisory lock integration', () => {
  it('serializes concurrent migrate runners under advisory lock', async () => {
    const schema = `miglock_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    let pool: Pool | null = null;
    const dir = mkdtempSync(path.join(tmpdir(), 'mig-sql-'));
    writeFileSync(path.join(dir, '001_lock_test.sql'), 'SELECT 1;');

    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      const store = new PostgresMigrationStore(pool);
      const [first, second] = await Promise.all([
        runMigrations({ migrationsDirectory: dir, store }),
        runMigrations({ migrationsDirectory: dir, store }),
      ]);
      const applied = new Set([...first.appliedVersions, ...second.appliedVersions]);
      expect(applied.has('001_lock_test')).toBe(true);
      const rows = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations',
      );
      expect(rows.rows.filter((row) => row.version === '001_lock_test')).toHaveLength(1);
    } finally {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});
