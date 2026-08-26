import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const backupScript = fileURLToPath(
  new URL('../../ops/scripts/backup-postgres.sh', import.meta.url),
);
const restoreScript = fileURLToPath(
  new URL('../../ops/scripts/restore-rehearsal.sh', import.meta.url),
);

describe('operations scripts', () => {
  it('passes bash syntax checks', () => {
    const deployScript = fileURLToPath(
      new URL('../../ops/scripts/deploy-release.sh', import.meta.url),
    );
    expect(existsSync(backupScript)).toBe(true);
    expect(existsSync(restoreScript)).toBe(true);
    expect(existsSync(deployScript)).toBe(true);
    execFileSync('bash', ['-n', backupScript], { stdio: 'pipe' });
    execFileSync('bash', ['-n', restoreScript], { stdio: 'pipe' });
    execFileSync('bash', ['-n', deployScript], { stdio: 'pipe' });
  });

  it('restore script refuses production database name', () => {
    chmodSync(restoreScript, 0o755);
    const dir = mkdtempSync(path.join(tmpdir(), 'servora-restore-'));
    const dump = path.join(dir, 'sample.dump');
    writeFileSync(dump, 'not-a-real-dump');
    writeFileSync(`${dump}.sha256`, 'deadbeef  sample.dump\n');
    try {
      execFileSync(
        'bash',
        [restoreScript, dump, '--i-accept-destructive-restore'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TARGET_PGDATABASE: 'servora_med',
            PRODUCTION_PGDATABASE: 'servora_med',
            TARGET_PGUSER: 'servora',
            OPS_LOG: path.join(dir, 'ops.log'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect.unreachable('should refuse production database');
    } catch (error) {
      const err = error as { status?: number; stderr?: string };
      expect(err.status).toBe(3);
      expect(String(err.stderr ?? '')).toMatch(/Refusing restore/i);
    }
  });

  it('restore script refuses invalid database identifiers', () => {
    chmodSync(restoreScript, 0o755);
    const dir = mkdtempSync(path.join(tmpdir(), 'servora-restore-'));
    const dump = path.join(dir, 'sample.dump');
    writeFileSync(dump, 'not-a-real-dump');
    writeFileSync(`${dump}.sha256`, 'deadbeef  sample.dump\n');
    try {
      execFileSync(
        'bash',
        [restoreScript, dump, '--i-accept-destructive-restore'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TARGET_PGDATABASE: 'bad;drop',
            TARGET_PGUSER: 'servora',
            OPS_LOG: path.join(dir, 'ops.log'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect.unreachable('should refuse invalid identifier');
    } catch (error) {
      const err = error as { status?: number; stderr?: string };
      expect(err.status).toBe(6);
      expect(String(err.stderr ?? '')).toMatch(/Invalid TARGET_PGDATABASE/i);
    }
  });

  it('restore script fails closed on checksum mismatch', () => {
    chmodSync(restoreScript, 0o755);
    const dir = mkdtempSync(path.join(tmpdir(), 'servora-restore-'));
    const dump = path.join(dir, 'sample.dump');
    writeFileSync(dump, 'not-a-real-dump');
    writeFileSync(`${dump}.sha256`, '0000000000000000000000000000000000000000000000000000000000000000  sample.dump\n');
    try {
      execFileSync(
        'bash',
        [restoreScript, dump, '--i-accept-destructive-restore'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TARGET_PGDATABASE: 'servora_med_restore_rehearsal',
            TARGET_PGUSER: 'servora',
            OPS_LOG: path.join(dir, 'ops.log'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect.unreachable('should fail checksum');
    } catch (error) {
      const err = error as { status?: number; stderr?: string };
      expect(err.status).toBe(4);
      expect(String(err.stderr ?? '')).toMatch(/Checksum mismatch/i);
    }
  });

  it('deploy-release enforces migrate → schema-check → activate → restart → health order', () => {
    const deployScript = fileURLToPath(new URL('../../ops/scripts/deploy-release.sh', import.meta.url));
    const content = readFileSync(deployScript, 'utf8');
    const migrateIdx = content.indexOf('server/dist/db/migrate.js');
    const schemaIdx = content.indexOf('server/dist/db/schema-check.js');
    const activateIdx = content.indexOf('ln -sfn "$NEW_RELEASE" "$CURRENT_LINK"');
    const restartIdx = content.indexOf('systemctl start "$SERVICE_NAME"', activateIdx);
    const healthIdx = content.indexOf('/api/health', restartIdx);

    expect(migrateIdx).toBeGreaterThan(-1);
    expect(schemaIdx).toBeGreaterThan(-1);
    expect(activateIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(-1);
    expect(healthIdx).toBeGreaterThan(-1);

    expect(migrateIdx).toBeLessThan(schemaIdx);
    expect(schemaIdx).toBeLessThan(activateIdx);
    expect(activateIdx).toBeLessThan(restartIdx);
    expect(restartIdx).toBeLessThan(healthIdx);

    // Must use NEW_RELEASE for both migration and schema check, not current
    expect(content).toContain('"${NEW_RELEASE}/server/dist/db/migrate.js"');
    expect(content).toContain('"${NEW_RELEASE}/server/dist/db/schema-check.js"');
    expect(content).not.toContain('/current/server/dist/db/migrate.js');
    expect(content).not.toContain('/current/server/dist/db/schema-check.js');
  });

  it('deploy-release fails closed when migrate or schema-check fails', () => {
    const deployScript = fileURLToPath(new URL('../../ops/scripts/deploy-release.sh', import.meta.url));
    const content = readFileSync(deployScript, 'utf8');
    // migrate failure block
    expect(content).toContain('Migration failed; leaving current symlink unchanged');
    expect(content).toContain('node "${NEW_RELEASE}/server/dist/db/migrate.js"');
    // schema check failure block
    expect(content).toContain('Schema check failed; leaving current symlink unchanged');
    expect(content).toContain('node "${NEW_RELEASE}/server/dist/db/schema-check.js"');
    // both should restart previous service and exit 1 before activation
    const migrateFailIdx = content.indexOf('Migration failed');
    const schemaFailIdx = content.indexOf('Schema check failed');
    const activateIdx = content.indexOf('ln -sfn "$NEW_RELEASE" "$CURRENT_LINK"');
    expect(migrateFailIdx).toBeLessThan(activateIdx);
    expect(schemaFailIdx).toBeLessThan(activateIdx);
  });

  it('deploy-release does not auto-migrate on service start and systemd has no ExecStartPre migrate', () => {
    const deployScript = fileURLToPath(new URL('../../ops/scripts/deploy-release.sh', import.meta.url));
    const deployContent = readFileSync(deployScript, 'utf8');
    // deploy script should not have ExecStart
    expect(deployContent).not.toMatch(/ExecStart/);
    // systemd unit should not contain migrate
    const systemdService = fileURLToPath(new URL('../../ops/systemd/servora-med.service', import.meta.url));
    const systemdContent = readFileSync(systemdService, 'utf8');
    expect(systemdContent).not.toMatch(/migrate/);
    expect(systemdContent).not.toMatch(/ExecStartPre/);
    expect(systemdContent).toContain('ExecStart=/usr/bin/node dist/index.js');
  });

  it('schema-check is read-only and uses catalog authority', () => {
    const schemaCheck = fileURLToPath(new URL('../../server/src/db/schema-check.ts', import.meta.url));
    const content = readFileSync(schemaCheck, 'utf8');
    expect(content).toContain('loadMigrationCatalog');
    expect(content).toContain('getMigrationsDirectory');
    expect(content).toContain('compareMigrationState');
    expect(content).toContain('fetchAppliedVersions');
    // must not contain migration writes
    expect(content).not.toMatch(/applyMigration/);
    expect(content).not.toMatch(/runMigrations/);
    expect(content).not.toMatch(/initialize\(\)/);
    expect(content).not.toMatch(/withMigrationLock/);
    expect(content).not.toMatch(/CREATE TABLE/);
    expect(content).not.toMatch(/INSERT INTO/);
  });
});
