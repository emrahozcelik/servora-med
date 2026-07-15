import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresMigrationStore } from '../src/db/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const backupScript = fileURLToPath(
  new URL('../../ops/scripts/backup-postgres.sh', import.meta.url),
);
const restoreScript = fileURLToPath(
  new URL('../../ops/scripts/restore-rehearsal.sh', import.meta.url),
);
const migrationsDirectory = fileURLToPath(
  new URL('../src/db/migrations', import.meta.url),
);

describe.skipIf(!databaseUrl)('PostgreSQL backup and restore acceptance', () => {
  it('backs up, checksums, restores, and verifies fixture data', async () => {
    chmodSync(backupScript, 0o755);
    chmodSync(restoreScript, 0o755);

    const work = mkdtempSync(path.join(tmpdir(), 'servora-backup-'));
    const backupDir = path.join(work, 'backups');
    const opsLog = path.join(work, 'ops.log');
    const sourceDb = `servora_bak_src_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const targetDb = `servora_bak_dst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    const admin = new Pool({ connectionString: databaseUrl });
    try {
      await admin.query(`CREATE DATABASE ${sourceDb}`);
      const sourceUrl = (() => {
        const url = new URL(databaseUrl!);
        url.pathname = `/${sourceDb}`;
        return url.toString();
      })();
      const sourcePool = new Pool({ connectionString: sourceUrl });
      try {
        await runMigrations({
          migrationsDirectory,
          store: new PostgresMigrationStore(sourcePool),
        });
        const org = (await sourcePool.query<{ id: string }>(
          `INSERT INTO organizations (name, timezone)
           VALUES ('Backup Fixture Org', 'Europe/Istanbul') RETURNING id`,
        )).rows[0]!;
        await sourcePool.query(
          `INSERT INTO users (organization_id, name, email, password_hash, role)
           VALUES ($1, 'Backup Admin', $2, 'hash', 'ADMIN')`,
          [org.id, `${randomUUID()}@test.local`],
        );

        const env = {
          ...process.env,
          BACKUP_DIR: backupDir,
          OPS_LOG: opsLog,
          PGHOST: '127.0.0.1',
          PGPORT: '5432',
          PGUSER: process.env.USER ?? 'postgres',
          PGDATABASE: sourceDb,
        };

        // Prefer peer auth when possible: rewrite env from DATABASE_URL if needed
        const parsed = new URL(databaseUrl!);
        if (parsed.hostname) env.PGHOST = parsed.hostname;
        if (parsed.port) env.PGPORT = parsed.port;
        if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
        if (parsed.password) {
          const pgpass = path.join(work, 'pgpass');
          writeFileSync(
            pgpass,
            `${env.PGHOST}:${env.PGPORT}:*:${env.PGUSER}:${decodeURIComponent(parsed.password)}\n`,
            { mode: 0o600 },
          );
          env.PGPASSFILE = pgpass;
        }

        execFileSync('bash', [backupScript], { env, stdio: 'pipe' });

        const dumps = readdirSync(backupDir).filter((name) => name.endsWith('.dump'));
        expect(dumps).toHaveLength(1);
        const dumpPath = path.join(backupDir, dumps[0]!);
        const checksumPath = `${dumpPath}.sha256`;
        expect(existsSync(checksumPath)).toBe(true);
        const checksumBody = readFileSync(checksumPath, 'utf8').trim();
        expect(checksumBody).toMatch(/^[a-f0-9]{64} {2}servora-med-.*\.dump$/);
        expect(checksumBody).not.toContain(backupDir);

        execFileSync(
          'bash',
          [restoreScript, dumpPath, '--i-accept-destructive-restore', '--keep'],
          {
            env: {
              ...env,
              TARGET_PGDATABASE: targetDb,
              TARGET_PGUSER: env.PGUSER,
              TARGET_PGHOST: env.PGHOST,
              TARGET_PGPORT: env.PGPORT,
              PRODUCTION_PGDATABASE: 'servora_med',
              OPS_LOG: path.join(work, 'restore-ops.log'),
            },
            stdio: 'pipe',
          },
        );

        const targetUrl = (() => {
          const url = new URL(databaseUrl!);
          url.pathname = `/${targetDb}`;
          return url.toString();
        })();
        const targetPool = new Pool({ connectionString: targetUrl });
        try {
          const versions = await targetPool.query<{ version: string }>(
            'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
          );
          expect(versions.rows[0]?.version).toBe('007_sales_meeting');
          const users = await targetPool.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM users',
          );
          expect(Number(users.rows[0]?.count)).toBeGreaterThanOrEqual(1);
          const orgs = await targetPool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM organizations WHERE name='Backup Fixture Org'`,
          );
          expect(Number(orgs.rows[0]?.count)).toBe(1);
        } finally {
          await targetPool.end();
        }

        const ops = readFileSync(opsLog, 'utf8');
        expect(ops).toMatch(/result=success/);
        expect(ops).not.toMatch(/password|postgresql:\/\/[^:]+:[^@]+@/i);
      } finally {
        await sourcePool.end();
        await admin.query(`DROP DATABASE IF EXISTS ${sourceDb}`);
        await admin.query(`DROP DATABASE IF EXISTS ${targetDb}`);
      }
    } finally {
      await admin.end();
    }
  }, 120_000);

  it('fails closed when offsite hook fails and does not claim success without dump', async () => {
    chmodSync(backupScript, 0o755);
    const work = mkdtempSync(path.join(tmpdir(), 'servora-offsite-'));
    const backupDir = path.join(work, 'backups');
    const opsLog = path.join(work, 'ops.log');
    const hook = path.join(work, 'fail-hook.sh');
    writeFileSync(hook, '#!/usr/bin/env bash\nexit 9\n', { mode: 0o755 });

    const sourceDb = `servora_bak_fail_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = new Pool({ connectionString: databaseUrl });
    try {
      await admin.query(`CREATE DATABASE ${sourceDb}`);
      const sourceUrl = (() => {
        const url = new URL(databaseUrl!);
        url.pathname = `/${sourceDb}`;
        return url.toString();
      })();
      const sourcePool = new Pool({ connectionString: sourceUrl });
      try {
        await runMigrations({
          migrationsDirectory,
          store: new PostgresMigrationStore(sourcePool),
        });
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          BACKUP_DIR: backupDir,
          OPS_LOG: opsLog,
          PGDATABASE: sourceDb,
          OFFSITE_COPY_HOOK: hook,
        };
        const parsed = new URL(databaseUrl!);
        env.PGHOST = parsed.hostname || '127.0.0.1';
        env.PGPORT = parsed.port || '5432';
        env.PGUSER = parsed.username
          ? decodeURIComponent(parsed.username)
          : (process.env.USER ?? 'postgres');
        if (parsed.password) {
          const pgpass = path.join(work, 'pgpass');
          writeFileSync(
            pgpass,
            `${env.PGHOST}:${env.PGPORT}:*:${env.PGUSER}:${decodeURIComponent(parsed.password)}\n`,
            { mode: 0o600 },
          );
          env.PGPASSFILE = pgpass;
        }

        try {
          execFileSync('bash', [backupScript], { env, stdio: 'pipe' });
          expect.unreachable('offsite hook failure must fail backup');
        } catch (error) {
          const err = error as { status?: number };
          expect(err.status).toBeGreaterThan(0);
        }
        const ops = existsSync(opsLog) ? readFileSync(opsLog, 'utf8') : '';
        expect(ops).toMatch(/result=failure/);
      } finally {
        await sourcePool.end();
        await admin.query(`DROP DATABASE IF EXISTS ${sourceDb}`);
      }
    } finally {
      await admin.end();
    }
  }, 120_000);
});
