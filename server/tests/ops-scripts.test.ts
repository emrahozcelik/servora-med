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
    const predeployLauncher = fileURLToPath(
      new URL('../../ops/scripts/predeploy-backup-launcher.sh', import.meta.url),
    );
    expect(existsSync(backupScript)).toBe(true);
    expect(existsSync(restoreScript)).toBe(true);
    expect(existsSync(deployScript)).toBe(true);
    expect(existsSync(predeployLauncher)).toBe(true);
    execFileSync('bash', ['-n', backupScript], { stdio: 'pipe' });
    execFileSync('bash', ['-n', restoreScript], { stdio: 'pipe' });
    execFileSync('bash', ['-n', deployScript], { stdio: 'pipe' });
    execFileSync('bash', ['-n', predeployLauncher], { stdio: 'pipe' });
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
    const backupIdx = content.indexOf('systemctl start "$PREDEPLOY_BACKUP_UNIT"');
    const migrateIdx = content.indexOf('if ! node "${NEW_RELEASE}/server/dist/db/migrate.js"');
    const schemaIdx = content.indexOf('if ! node "${NEW_RELEASE}/server/dist/db/schema-check.js"');
    const activateIdx = content.indexOf('ln -sfn "$EXPECTED_RELEASE" "$CURRENT_LINK"');
    const restartIdx = content.indexOf('systemctl start "$SERVICE_NAME"', activateIdx);
    const healthIdx = content.indexOf('/api/health', restartIdx);

    expect(backupIdx).toBeGreaterThan(-1);
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(schemaIdx).toBeGreaterThan(-1);
    expect(activateIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(-1);
    expect(healthIdx).toBeGreaterThan(-1);

    expect(backupIdx).toBeLessThan(migrateIdx);
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
    const activateIdx = content.indexOf('ln -sfn "$EXPECTED_RELEASE" "$CURRENT_LINK"');
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

  it('first-deploy backup unit is SHA-scoped, release-rooted, and least-privilege', () => {
    const unitPath = fileURLToPath(
      new URL('../../ops/systemd/servora-med-predeploy-backup@.service', import.meta.url),
    );
    const content = readFileSync(unitPath, 'utf8');
    expect(content).toContain('User=servora-med');
    expect(content).toContain('Group=servora-med');
    expect(content).toContain('EnvironmentFile=/etc/servora-med/servora-med-backup.env');
    expect(content).toContain('ExecStart=/usr/local/libexec/servora-med/predeploy-backup-launcher %i');
    expect(content).not.toContain('/opt/servora-med/releases/%i/');
    expect(content).not.toContain('/opt/servora-med/current/ops/scripts/backup-postgres.sh');
    expect(content).toContain('NoNewPrivileges=true');
    expect(content).toContain('ProtectSystem=strict');
  });

  it('release provenance is fixed to the validated SHA path', () => {
    const deployScript = fileURLToPath(new URL('../../ops/scripts/deploy-release.sh', import.meta.url));
    const content = readFileSync(deployScript, 'utf8');
    expect(content).toContain('readonly RELEASE_ROOT="/opt/servora-med/releases"');
    expect(content).toContain('readonly EXPECTED_RELEASE="${RELEASE_ROOT}/${SHA}"');
    expect(content).toContain('NEW_RELEASE="${NEW_RELEASE-${EXPECTED_RELEASE}}"');
    expect(content).toContain('if [[ "$NEW_RELEASE" != "$EXPECTED_RELEASE" ]]');
    expect(content).toContain('assert_release_dir "$EXPECTED_RELEASE"');
    expect(content).toContain('assert_release_file "$required_file"');
    expect(content).toContain('ln -sfn "$EXPECTED_RELEASE" "$CURRENT_LINK"');
    expect(content).not.toContain('RELEASE_ROOT="${RELEASE_ROOT:-');
    expect(content).not.toContain('CURRENT_LINK="${CURRENT_LINK:-');
  });

  it('pre-deploy launcher validates the instance before deriving a release path', () => {
    const launcher = fileURLToPath(
      new URL('../../ops/scripts/predeploy-backup-launcher.sh', import.meta.url),
    );
    const content = readFileSync(launcher, 'utf8');
    expect(content).toContain('readonly RELEASE_ROOT="/opt/servora-med/releases"');
    expect(content).toMatch(/\[\[ ! "\$SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
    expect(content).toContain('assert_physical_dir "$RELEASE_DIR"');
    expect(content).toContain('assert_physical_file "$BACKUP_SCRIPT"');
    expect(content).toContain('exec "$BACKUP_SCRIPT"');
    expect(content).not.toMatch(/\$\{1\}.*\/opt\/servora-med/);
  });

  it.each(['', 'short', 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', '../escape', 'sha with whitespace'])
    ('pre-deploy launcher rejects unsafe instance %s before filesystem access', (instance) => {
      const launcher = fileURLToPath(
        new URL('../../ops/scripts/predeploy-backup-launcher.sh', import.meta.url),
      );
      try {
        execFileSync('bash', [launcher, instance], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        expect.unreachable('unsafe instance must fail');
      } catch (error) {
        const err = error as { status?: number; stderr?: string };
        expect(err.status).toBe(64);
        expect(String(err.stderr ?? '')).toMatch(/release instance|exactly one/);
      }
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
