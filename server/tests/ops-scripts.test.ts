import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
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
    expect(existsSync(backupScript)).toBe(true);
    expect(existsSync(restoreScript)).toBe(true);
    execFileSync('bash', ['-n', backupScript], { stdio: 'pipe' });
    execFileSync('bash', ['-n', restoreScript], { stdio: 'pipe' });
  });

  it('restore script refuses production database name without disposable target', () => {
    chmodSync(restoreScript, 0o755);
    // Missing dump path / flags should fail closed.
    try {
      execFileSync('bash', [restoreScript], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect.unreachable('should exit non-zero');
    } catch (error) {
      const err = error as { status?: number; stderr?: string };
      expect(err.status).toBeGreaterThan(0);
    }
  });

  it('restore script refuses when target equals production database name', () => {
    chmodSync(restoreScript, 0o755);
    // Create empty fake dump path reference only for argv; script exits before read if guards hit first
    // after dump existence check — use /dev/null as non-file fails earlier; write temp empty? 
    // Guard after dump exists: use this test file as fake dump.
    try {
      execFileSync(
        'bash',
        [restoreScript, restoreScript, '--i-accept-destructive-restore'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TARGET_PGDATABASE: 'servora_med',
            PRODUCTION_PGDATABASE: 'servora_med',
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
});
