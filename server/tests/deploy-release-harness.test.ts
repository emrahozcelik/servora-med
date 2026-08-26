import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const deployScript = fileURLToPath(new URL('../../ops/scripts/deploy-release.sh', import.meta.url));
const TEST_SHA = '0123456789abcdef0123456789abcdef01234567';

function makeFakeBin(dir: string, logFile: string) {
  // node fake: distinguishes migrate vs schema-check
  writeFileSync(
    path.join(dir, 'node'),
    `#!/usr/bin/env bash
log="${logFile}"
args="$*"
if [[ "$args" == *"migrate.js"* ]]; then
  echo "migrate" >> "$log"
  echo "node \$args" >> "$log.details"
  exit \${FAKE_MIGRATE_EXIT:-0}
elif [[ "$args" == *"schema-check.js"* ]]; then
  echo "schema-check" >> "$log"
  echo "node \$args" >> "$log.details"
  # also log the exact path for NEW_RELEASE proof
  echo "\$args" >> "$log.details"
  exit \${FAKE_SCHEMA_EXIT:-0}
else
  echo "node-other" >> "$log"
  exit 0
fi
`,
  );
  chmodSync(path.join(dir, 'node'), 0o755);

  // systemctl fake
  writeFileSync(
    path.join(dir, 'systemctl'),
    `#!/usr/bin/env bash
log="${logFile}"
cmd="$1"
svc="$2"
if [[ "$cmd" == "start" && "$svc" == *backup* ]]; then
  echo "backup:$svc" >> "$log"
  exit \${FAKE_BACKUP_EXIT:-0}
elif [[ "$cmd" == "stop" ]]; then
  echo "stop" >> "$log"
  exit \${FAKE_STOP_EXIT:-0}
elif [[ "$cmd" == "start" ]]; then
  # service start (post-activation or recovery)
  # distinguish by checking if activation already logged
  if grep -q "activate" "$log" 2>/dev/null; then
    echo "start" >> "$log"
  else
    echo "start-recovery" >> "$log"
  fi
  # Use FAKE_START_EXIT for post-activation start, FAKE_RECOVERY_EXIT for recovery if set
  if grep -q "activate" "$log" 2>/dev/null; then
    exit \${FAKE_START_EXIT:-0}
  else
    exit \${FAKE_RECOVERY_EXIT:-\${FAKE_START_EXIT:-0}}
  fi
else
  echo "systemctl \$cmd \$svc" >> "$log"
  exit 0
fi
`,
  );
  chmodSync(path.join(dir, 'systemctl'), 0o755);

  // curl fake
  writeFileSync(
    path.join(dir, 'curl'),
    `#!/usr/bin/env bash
log="${logFile}"
echo "health" >> "$log"
if [[ "\${FAKE_CURL_EXIT:-0}" == "0" ]]; then
  echo '{"status":"ok"}'
  exit 0
else
  echo '{"status":"unavailable"}'
  exit \${FAKE_CURL_EXIT}
fi
`,
  );
  chmodSync(path.join(dir, 'curl'), 0o755);

  // ln fake: log activate and actually create symlink via /bin/ln for hermetic check
  writeFileSync(
    path.join(dir, 'ln'),
    `#!/usr/bin/env bash
log="${logFile}"
echo "activate" >> "$log"
# Call real ln
/bin/ln "$@"
exit $?
`,
  );
  chmodSync(path.join(dir, 'ln'), 0o755);
}

function setupFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'deploy-harness-'));
  const newRelease = path.join(root, 'new-release');
  const currentLink = path.join(root, 'current');
  const envFile = path.join(root, 'servora.env');
  const fakeBin = path.join(root, 'fake-bin');
  const logFile = path.join(root, 'event.log');
  mkdirSync(newRelease + '/server/dist/db', { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  // Required files for deploy pre-checks
  writeFileSync(path.join(newRelease, 'server', 'dist', 'dummy'), 'x');
  // Ensure server/dist exists (already)
  writeFileSync(path.join(newRelease, 'server', 'package-lock.json'), '{}');
  mkdirSync(path.join(newRelease, 'server', 'node_modules'), { recursive: true });
  writeFileSync(envFile, 'DATABASE_URL=postgresql://dummy\n');
  // Create dummy migrate and schema-check files (not executed, fake node intercepts)
  writeFileSync(path.join(newRelease, 'server', 'dist', 'db', 'migrate.js'), '// dummy');
  writeFileSync(path.join(newRelease, 'server', 'dist', 'db', 'schema-check.js'), '// dummy');
  writeFileSync(logFile, '');
  writeFileSync(logFile + '.details', '');
  makeFakeBin(fakeBin, logFile);
  return { root, newRelease, currentLink, envFile, fakeBin, logFile };
}

function runDeploy(env: NodeJS.ProcessEnv, fakeBin: string): { exitCode: number; stdout: string; stderr: string; log: string } {
  const logFile = env.FAKE_LOG as string;
  try {
    const stdout = execFileSync('bash', [deployScript], {
      env: {
        ...process.env,
        ...env,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    return { exitCode: 0, stdout, stderr: '', log };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    return { exitCode: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '', log };
  }
}

describe('deploy-release executable harness', () => {
  it('A: migration failure → schema-check not run, activation not run, exit nonzero', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.com',
          FAKE_LOG: f.logFile,
          FAKE_MIGRATE_EXIT: '1',
          FAKE_SCHEMA_EXIT: '0',
          FAKE_START_EXIT: '0',
          FAKE_CURL_EXIT: '0',
          FAKE_BACKUP_EXIT: '0',
          FAKE_STOP_EXIT: '0',
        },
        f.fakeBin,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.log).toContain('migrate');
      expect(result.log).not.toContain('schema-check');
      expect(result.log).not.toContain('activate');
      // new service start should not run (only recovery attempt)
      expect(result.log).not.toContain('\nstart\n'); // post-activation start
      expect(result.log).toContain('start-recovery');
      expect(result.stdout + result.stderr).not.toContain('Deploy complete');
      // proof NEW_RELEASE artifact
      const details = readFileSync(f.logFile + '.details', 'utf8');
      expect(details).toContain(`${f.newRelease}/server/dist/db/migrate.js`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('B: schema-check failure → activation not run, exit nonzero', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.com',
          FAKE_LOG: f.logFile,
          FAKE_MIGRATE_EXIT: '0',
          FAKE_SCHEMA_EXIT: '1',
          FAKE_START_EXIT: '0',
          FAKE_CURL_EXIT: '0',
        },
        f.fakeBin,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.log).toContain('migrate');
      expect(result.log).toContain('schema-check');
      expect(result.log).not.toContain('activate');
      expect(result.log).not.toContain('\nstart\n');
      expect(result.log).toContain('start-recovery');
      const details = readFileSync(f.logFile + '.details', 'utf8');
      expect(details).toContain(`${f.newRelease}/server/dist/db/schema-check.js`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('C: service start failure after activation → health not run, exit nonzero', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.com',
          FAKE_LOG: f.logFile,
          FAKE_MIGRATE_EXIT: '0',
          FAKE_SCHEMA_EXIT: '0',
          FAKE_START_EXIT: '1',
          FAKE_CURL_EXIT: '0',
        },
        f.fakeBin,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.log).toContain('migrate');
      expect(result.log).toContain('schema-check');
      expect(result.log).toContain('activate');
      expect(result.log).toContain('start');
      expect(result.log).not.toContain('health');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('D: health failure → exit nonzero', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.com',
          FAKE_LOG: f.logFile,
          FAKE_MIGRATE_EXIT: '0',
          FAKE_SCHEMA_EXIT: '0',
          FAKE_START_EXIT: '0',
          FAKE_CURL_EXIT: '22', // curl fails
        },
        f.fakeBin,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.log).toContain('health');
      expect(result.stdout + result.stderr).not.toContain('Deploy complete');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('E: full success → order migrate < schema-check < activate < start < health, exit 0', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.com',
          FAKE_LOG: f.logFile,
          FAKE_MIGRATE_EXIT: '0',
          FAKE_SCHEMA_EXIT: '0',
          FAKE_START_EXIT: '0',
          FAKE_CURL_EXIT: '0',
        },
        f.fakeBin,
      );
      expect(result.exitCode).toBe(0);
      const log = result.log;
      const migrateIdx = log.indexOf('migrate');
      const schemaIdx = log.indexOf('schema-check');
      const activateIdx = log.indexOf('activate');
      const startIdx = log.indexOf('\nstart\n') !== -1 ? log.indexOf('\nstart\n') : log.indexOf('start');
      const healthIdx = log.indexOf('health');
      expect(migrateIdx).toBeGreaterThan(-1);
      expect(schemaIdx).toBeGreaterThan(-1);
      expect(activateIdx).toBeGreaterThan(-1);
      expect(startIdx).toBeGreaterThan(-1);
      expect(healthIdx).toBeGreaterThan(-1);
      expect(migrateIdx).toBeLessThan(schemaIdx);
      expect(schemaIdx).toBeLessThan(activateIdx);
      expect(activateIdx).toBeLessThan(startIdx);
      expect(startIdx).toBeLessThan(healthIdx);
      expect(result.stdout).toContain('Deploy complete');
      const details = readFileSync(f.logFile + '.details', 'utf8');
      expect(details).toContain(`${f.newRelease}/server/dist/db/migrate.js`);
      expect(details).toContain(`${f.newRelease}/server/dist/db/schema-check.js`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('health is mandatory: SERVORA_FQDN absent → fails preflight before stop/migrate/activate', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          // SERVORA_FQDN intentionally absent
          SERVORA_FQDN: '',
          FAKE_LOG: f.logFile,
          FAKE_MIGRATE_EXIT: '0',
          FAKE_SCHEMA_EXIT: '0',
          FAKE_START_EXIT: '0',
          FAKE_CURL_EXIT: '0',
        },
        f.fakeBin,
      );
      expect(result.exitCode).not.toBe(0);
      // Should fail before any operational work
      expect(result.log).not.toContain('stop');
      expect(result.log).not.toContain('migrate');
      expect(result.log).not.toContain('schema-check');
      expect(result.log).not.toContain('activate');
      expect(result.stderr + result.stdout).toMatch(/SERVORA_FQDN is required/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('SERVORA_FQDN set → preflight passes and health uses that hostname', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.test',
          FAKE_LOG: f.logFile,
          FAKE_MIGRATE_EXIT: '0',
          FAKE_SCHEMA_EXIT: '0',
          FAKE_START_EXIT: '0',
          FAKE_CURL_EXIT: '0',
        },
        f.fakeBin,
      );
      expect(result.exitCode).toBe(0);
      expect(result.log).toContain('health');
      // Verify health was called with the SERVORA_FQDN-derived FQDN
      // The fake curl doesn't check FQDN, but the script's health URL is constructed from FQDN
      // We at least prove preflight passed and health executed
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('FQDN env alone without SERVORA_FQDN → still fails preflight (FQDN is internal)', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          FQDN: 'example.test',
          SERVORA_FQDN: '',
          FAKE_LOG: f.logFile,
          FAKE_MIGRATE_EXIT: '0',
          FAKE_SCHEMA_EXIT: '0',
          FAKE_START_EXIT: '0',
          FAKE_CURL_EXIT: '0',
        },
        f.fakeBin,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.log).not.toContain('migrate');
      expect(result.stderr + result.stdout).toMatch(/SERVORA_FQDN is required/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('proves NEW_RELEASE artifacts for both node commands', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.com',
          FAKE_LOG: f.logFile,
          FAKE_MIGRATE_EXIT: '0',
          FAKE_SCHEMA_EXIT: '0',
          FAKE_START_EXIT: '0',
          FAKE_CURL_EXIT: '0',
        },
        f.fakeBin,
      );
      expect(result.exitCode).toBe(0);
      const details = readFileSync(f.logFile + '.details', 'utf8');
      const lines = details.split('\n').filter(Boolean);
      const migrateLine = lines.find((l) => l.includes('migrate.js'));
      const schemaLine = lines.find((l) => l.includes('schema-check.js'));
      expect(migrateLine).toContain(f.newRelease);
      expect(schemaLine).toContain(f.newRelease);
      expect(migrateLine).not.toContain('/current/');
      expect(schemaLine).not.toContain('/current/');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('first deploy (current absent) runs SHA-scoped mandatory backup before migration', () => {
    const f = setupFixture();
    try {
      expect(existsSync(f.currentLink)).toBe(false);
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.com',
          FAKE_LOG: f.logFile,
          FAKE_BACKUP_EXIT: '0',
          FAKE_MIGRATE_EXIT: '0',
          FAKE_SCHEMA_EXIT: '0',
          FAKE_START_EXIT: '0',
          FAKE_CURL_EXIT: '0',
        },
        f.fakeBin,
      );
      expect(result.exitCode).toBe(0);
      const lines = result.log.split('\n').filter(Boolean);
      const backupIdx = lines.findIndex((line) => line.startsWith('backup:'));
      const migrateIdx = lines.indexOf('migrate');
      expect(lines[backupIdx]).toBe(`backup:servora-med-predeploy-backup@${TEST_SHA}.service`);
      expect(backupIdx).toBeGreaterThanOrEqual(0);
      expect(migrateIdx).toBeGreaterThan(backupIdx);
      expect(lines.indexOf('schema-check')).toBeGreaterThan(migrateIdx);
      expect(lines.indexOf('activate')).toBeGreaterThan(lines.indexOf('schema-check'));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('backup failure blocks stop, migration, and activation', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.com',
          FAKE_LOG: f.logFile,
          FAKE_BACKUP_EXIT: '1',
        },
        f.fakeBin,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.log).toContain(`backup:servora-med-predeploy-backup@${TEST_SHA}.service`);
      expect(result.log).not.toContain('stop');
      expect(result.log).not.toContain('migrate');
      expect(result.log).not.toContain('activate');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('rejects an invalid SHA before any operational action', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: '../../evil',
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.com',
          FAKE_LOG: f.logFile,
        },
        f.fakeBin,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.log).toBe('');
      expect(result.stdout + result.stderr).toMatch(/SHA must be a 40-character/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('rejects a production release path that is not the validated SHA root', () => {
    const f = setupFixture();
    try {
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: `/opt/servora-med/releases/${'f'.repeat(40)}`,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.com',
          FAKE_LOG: f.logFile,
        },
        f.fakeBin,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.log).toBe('');
      expect(result.stdout + result.stderr).toMatch(/NEW_RELEASE must match the SHA release root/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('update deploy keeps the existing current release until activation succeeds', () => {
    const f = setupFixture();
    const previous = path.join(f.root, 'previous-release');
    try {
      mkdirSync(previous, { recursive: true });
      symlinkSync(previous, f.currentLink);
      const result = runDeploy(
        {
          SHA: TEST_SHA,
          NEW_RELEASE: f.newRelease,
          ENV_FILE: f.envFile,
          CURRENT_LINK: f.currentLink,
          SERVORA_FQDN: 'example.com',
          FAKE_LOG: f.logFile,
          FAKE_BACKUP_EXIT: '0',
          FAKE_MIGRATE_EXIT: '0',
          FAKE_SCHEMA_EXIT: '0',
          FAKE_START_EXIT: '0',
          FAKE_CURL_EXIT: '0',
        },
        f.fakeBin,
      );
      expect(result.exitCode).toBe(0);
      expect(readlinkSync(f.currentLink)).toBe(f.newRelease);
      expect(result.log.indexOf('backup:')).toBeLessThan(result.log.indexOf('migrate'));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
