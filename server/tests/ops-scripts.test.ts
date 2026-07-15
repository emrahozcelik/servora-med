import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
});
