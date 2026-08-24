import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const script = fileURLToPath(
  new URL('../../ops/scripts/restore-dr-acceptance.sh', import.meta.url),
);

function runGate(extraEnv: NodeJS.ProcessEnv, args = ['--i-accept-real-r2-test']) {
  return spawnSync('/bin/bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...extraEnv,
    },
  });
}

describe('real R2 DR acceptance shell gate', () => {
  it('rejects unknown options before reading any acceptance configuration', () => {
    const result = runGate({}, ['--unexpected']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });

  it('does not fall back to production credentials', () => {
    const productionSecret = 'production-secret-must-not-appear';
    const sessionToken = 'session-token-must-not-appear';
    const result = runGate({
      BACKUP_R2_ACCOUNT_ID: 'a'.repeat(32),
      BACKUP_R2_BUCKET: 'servora-production',
      BACKUP_R2_ACCESS_KEY_ID: 'production-access-key',
      BACKUP_R2_SECRET_ACCESS_KEY: productionSecret,
      SERVORA_ACCEPTANCE_R2_SESSION_TOKEN: sessionToken,
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('acceptance bucket configured? NO');
    expect(result.stdout).toContain('acceptance credentials configured? NO');
    expect(result.stdout).toContain('explicit opt-in supplied? YES');
    expect(result.stdout).toContain('REAL_R2_DR_ACCEPTANCE = NOT EXECUTED');
    expect(result.stdout).toContain(
      'reason: dedicated disposable Cloudflare R2 acceptance credentials unavailable',
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(productionSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(sessionToken);
  });

  it('reports bucket and credential presence as separate gates', () => {
    const result = runGate({
      SERVORA_ACCEPTANCE_R2_ACCOUNT_ID: 'b'.repeat(32),
      SERVORA_ACCEPTANCE_R2_ACCESS_KEY_ID: 'acceptance-access-key',
      SERVORA_ACCEPTANCE_R2_SECRET_ACCESS_KEY: 'acceptance-secret',
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('acceptance bucket configured? NO');
    expect(result.stdout).toContain('acceptance credentials configured? YES');
    expect(result.stdout).toContain('REAL_R2_DR_ACCEPTANCE = NOT EXECUTED');
  });

  it('rejects an acceptance bucket that matches configured production', () => {
    const acceptanceSecret = 'acceptance-secret-must-not-appear';
    const result = runGate({
      SERVORA_ACCEPTANCE_R2_ACCOUNT_ID: 'b'.repeat(32),
      SERVORA_ACCEPTANCE_R2_BUCKET: 'servora-shared',
      SERVORA_ACCEPTANCE_R2_ACCESS_KEY_ID: 'acceptance-access-key',
      SERVORA_ACCEPTANCE_R2_SECRET_ACCESS_KEY: acceptanceSecret,
      BACKUP_R2_BUCKET: 'servora-shared',
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('reason: acceptance bucket is not production-distinct');
    expect(`${result.stdout}${result.stderr}`).not.toContain(acceptanceSecret);
  });

  it('rejects an exact production credential pair even with a distinct bucket', () => {
    const sharedSecret = 'shared-secret-must-not-appear';
    const result = runGate({
      SERVORA_ACCEPTANCE_R2_ACCOUNT_ID: 'c'.repeat(32),
      SERVORA_ACCEPTANCE_R2_BUCKET: 'servora-acceptance',
      SERVORA_ACCEPTANCE_R2_ACCESS_KEY_ID: 'shared-access-key',
      SERVORA_ACCEPTANCE_R2_SECRET_ACCESS_KEY: sharedSecret,
      BACKUP_R2_BUCKET: 'servora-production',
      BACKUP_R2_ACCESS_KEY_ID: 'shared-access-key',
      BACKUP_R2_SECRET_ACCESS_KEY: sharedSecret,
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('reason: acceptance credentials are not production-distinct');
    expect(`${result.stdout}${result.stderr}`).not.toContain(sharedSecret);
  });

  it('stops before external execution when disposable database or age prerequisites are absent', () => {
    const result = runGate({
      SERVORA_ACCEPTANCE_R2_ACCOUNT_ID: 'd'.repeat(32),
      SERVORA_ACCEPTANCE_R2_BUCKET: 'servora-acceptance',
      SERVORA_ACCEPTANCE_R2_ACCESS_KEY_ID: 'acceptance-access-key',
      SERVORA_ACCEPTANCE_R2_SECRET_ACCESS_KEY: 'acceptance-secret',
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('ephemeral age identity generated? NO');
    expect(result.stdout).toContain('source DB synthetic? NO');
    expect(result.stdout).toContain('REAL_R2_DR_ACCEPTANCE = NOT EXECUTED');
    expect(result.stdout).toContain(
      'reason: disposable PostgreSQL or age acceptance prerequisites unavailable',
    );
  });
});
