import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { RestoreService } from '../src/modules/backup/restore/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

describe.skipIf(!databaseUrl || process.env.BR7_DB_ACCEPTANCE !== '1')('BR7 DR PostgreSQL acceptance', () => {
  it('restores a real custom dump into a new target without the source metadata database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'br7-dr-'));
    const admin = new Pool({ connectionString: databaseUrl! });
    const sourceDb = `br7_src_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const targetDb = `br7_dst_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    try {
      await admin.query(`CREATE DATABASE ${sourceDb}`);
      const sourceUrl = new URL(databaseUrl!);
      sourceUrl.pathname = `/${sourceDb}`;
      const source = new Pool({ connectionString: sourceUrl.toString() });
      await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(source) });
      const org = (await source.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('BR7 Synthetic Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!;
      await source.query(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'BR7 Synthetic Admin', $2, 'synthetic-hash', 'ADMIN')`,
        [org.id, `${randomUUID()}@br7.invalid`],
      );
      const dumpPath = path.join(root, 'database.dump');
      const env: NodeJS.ProcessEnv = { ...process.env };
      const parsed = new URL(databaseUrl!);
      env.PGHOST = parsed.hostname;
      env.PGPORT = parsed.port || '5432';
      env.PGUSER = decodeURIComponent(parsed.username);
      env.PGDATABASE = sourceDb;
      if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
      execFileSync(process.env.PG_DUMP_BIN ?? 'pg_dump', ['-Fc', '--no-owner', '--no-acl', '--file', dumpPath], { env });
      const dump = await readFile(dumpPath);
      const digest = createHash('sha256').update(dump).digest('hex');
      const listing = execFileSync(process.env.PG_RESTORE_BIN ?? 'pg_restore', ['-l', dumpPath], { encoding: 'utf8' });
      const dumpVersion = /Dump Version:\s*(\S+)/.exec(listing)?.[1] ?? '1.15';
      const dumpToolVersion = /Dumped by pg_dump version:\s*(.+)/.exec(listing)?.[1]?.trim() ?? '16.13';
      const backupId = randomUUID();
      const manifest = {
        format: 'servora-backup', formatVersion: 1, backupId,
        createdAt: new Date().toISOString(),
        application: { applicationVersion: 'br7-test', gitCommit: null },
        backupScope: 'DATABASE', origin: 'MANUAL', retentionClass: 'MANUAL',
        database: { engine: 'postgresql', serverVersion: '16.13', dumpVersion, dumpToolVersion, schemaVersion: '035_demo_data_purge_foundation' },
        contents: { database: { file: 'database.dump', bytes: dump.byteLength, sha256: digest }, files: null },
        checksums: { file: 'checksums.sha256' },
      };
      await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(path.join(root, 'checksums.sha256'), `${digest}  database.dump\n`);
      const packagePath = path.join(root, 'package.sbk.tar');
      execFileSync('tar', ['-cf', packagePath, '-C', root, 'manifest.json', 'database.dump', 'checksums.sha256']);
      await source.end();
      await admin.query(`DROP DATABASE ${sourceDb}`);

      const result = await new RestoreService({
        targetAdminDatabaseUrl: databaseUrl,
        productionDatabaseUrl: sourceUrl.toString(),
        workspaceRoot: path.join(root, 'workspace'),
      }).restore({
        archiveOrId: packagePath,
        mode: 'DISASTER_RECOVERY',
        targetDatabase: targetDb,
        acknowledgeDestructiveRestore: true,
      });
      expect(result.outcome).toBe('READY_FOR_CUTOVER');
      const targetUrl = new URL(databaseUrl!);
      targetUrl.pathname = `/${targetDb}`;
      const target = new Pool({ connectionString: targetUrl.toString() });
      try {
        await expect(target.query(`SELECT name FROM organizations WHERE name = 'BR7 Synthetic Org'`)).resolves.toMatchObject({ rows: [{ name: 'BR7 Synthetic Org' }] });
        await expect(target.query('SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1'))
          .resolves.toMatchObject({ rows: [{ version: manifest.database.schemaVersion }] });
        await expect(target.query(`SELECT status FROM restore_runs WHERE id = $1`, [result.restoreRunId])).resolves.toMatchObject({ rows: [{ status: 'READY_FOR_CUTOVER' }] });
      } finally {
        await target.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${targetDb}`).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${sourceDb}`).catch(() => undefined);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
