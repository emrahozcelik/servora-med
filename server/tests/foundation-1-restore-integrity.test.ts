import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { RestoreManifestV1 } from '../src/modules/backup/restore/manifest.js';
import { validateRestoredDatabase } from '../src/modules/backup/restore/postgres.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const restoreSourceUrl = new URL('../src/modules/backup/restore/postgres.ts', import.meta.url);

describe('FOUNDATION-1 restore integrity contract', () => {
  it('CORE_RELATIONS includes both foundation history tables', async () => {
    const sql = await readFile(fileURLToPath(restoreSourceUrl), 'utf8');
    const block = sql.slice(sql.indexOf("const CORE_RELATIONS = ["), sql.indexOf('] as const;'));
    expect(block).toContain("'job_card_schedule_revisions'");
    expect(block).toContain("'job_card_assignment_history'");
  });

  it.skipIf(!databaseUrl)('passes with both foundation relations and fails closed when either is missing', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const schema = `f1rs_${randomUUID().replaceAll('-', '')}`;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    try {
      await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
      const versionRow = await pool.query<{ version: string }>(
        `SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1`,
      );
      const schemaVersion = versionRow.rows[0]!.version;
      const targetUrl = new URL(databaseUrl!);
      targetUrl.searchParams.set('options', `-c search_path=${schema}`);
      const manifest = { database: { schemaVersion } } as unknown as RestoreManifestV1;

      const evidence = await validateRestoredDatabase(targetUrl.toString(), manifest);
      expect(evidence.relations).toEqual(expect.arrayContaining([
        'job_card_schedule_revisions',
        'job_card_assignment_history',
      ]));

      await pool.query('ALTER TABLE job_card_schedule_revisions RENAME TO missing_schedule_revisions');
      await expect(validateRestoredDatabase(targetUrl.toString(), manifest))
        .rejects.toMatchObject({ code: 'RESTORE_INTEGRITY_FAILED' });
      await pool.query('ALTER TABLE missing_schedule_revisions RENAME TO job_card_schedule_revisions');

      await pool.query('ALTER TABLE job_card_assignment_history RENAME TO missing_assignment_history');
      await expect(validateRestoredDatabase(targetUrl.toString(), manifest))
        .rejects.toMatchObject({ code: 'RESTORE_INTEGRITY_FAILED' });
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  }, 20_000);
});
