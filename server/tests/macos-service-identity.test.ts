import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const script = fileURLToPath(
  new URL('../../ops/scripts/ensure-macos-service-identity.sh', import.meta.url),
);

function run(
  store: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        SERVORA_IDENTITY_STORE: store,
        SERVORA_ID_MIN: '420',
        SERVORA_ID_MAX: '425',
        ...env,
      },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

describe('ensure-macos-service-identity', () => {
  it('passes bash -n', () => {
    execFileSync('bash', ['-n', script], { stdio: 'pipe' });
  });

  it('creates servora-med and servora-postgres with distinct free ids', () => {
    const store = mkdtempSync(path.join(tmpdir(), 'servora-id-'));
    chmodSync(script, 0o755);

    const first = run(store, ['servora-med', 'Servora-Med Service']);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/ok created non-admin identity servora-med uid\/gid=420/);

    const second = run(store, ['servora-postgres', 'Servora PostgreSQL']);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/ok created non-admin identity servora-postgres uid\/gid=421/);

    const again = run(store, ['servora-med']);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/ok existing non-admin identity servora-med uid\/gid=420/);
  });

  it('aborts when UID is owned by another principal', () => {
    const store = mkdtempSync(path.join(tmpdir(), 'servora-id-'));
    mkdirSync(path.join(store, 'users'), { recursive: true });
    mkdirSync(path.join(store, 'groups'), { recursive: true });
    mkdirSync(path.join(store, 'uids'), { recursive: true });
    mkdirSync(path.join(store, 'gids'), { recursive: true });
    for (const id of ['420', '421', '422', '423', '424', '425']) {
      writeFileSync(path.join(store, 'uids', id), 'foreign\n');
      writeFileSync(path.join(store, 'gids', id), 'foreign\n');
    }

    const result = run(store, ['servora-med']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no free UID\/GID|owned/i);
  });

  it('aborts on partial user-without-group identity', () => {
    const store = mkdtempSync(path.join(tmpdir(), 'servora-id-'));
    mkdirSync(path.join(store, 'users'), { recursive: true });
    mkdirSync(path.join(store, 'groups'), { recursive: true });
    mkdirSync(path.join(store, 'uids'), { recursive: true });
    mkdirSync(path.join(store, 'gids'), { recursive: true });
    writeFileSync(path.join(store, 'users', 'servora-med'), '420\n');
    writeFileSync(path.join(store, 'uids', '420'), 'servora-med\n');

    const result = run(store, ['servora-med']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/partial identity/i);
  });

  it('aborts when existing identity is admin', () => {
    const store = mkdtempSync(path.join(tmpdir(), 'servora-id-'));
    mkdirSync(path.join(store, 'users'), { recursive: true });
    mkdirSync(path.join(store, 'groups'), { recursive: true });
    mkdirSync(path.join(store, 'uids'), { recursive: true });
    mkdirSync(path.join(store, 'gids'), { recursive: true });
    mkdirSync(path.join(store, 'admins'), { recursive: true });
    writeFileSync(path.join(store, 'users', 'servora-med'), '420\n');
    writeFileSync(path.join(store, 'groups', 'servora-med'), '420\n');
    writeFileSync(path.join(store, 'uids', '420'), 'servora-med\n');
    writeFileSync(path.join(store, 'gids', '420'), 'servora-med\n');
    writeFileSync(path.join(store, 'admins', 'servora-med'), '1\n');

    const result = run(store, ['servora-med']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/admin/i);
  });

  it('rolls back group when user creation fails after group (after_group is before user)', () => {
    const store = mkdtempSync(path.join(tmpdir(), 'servora-id-'));
    // Seed a foreign identity that must never be deleted.
    mkdirSync(path.join(store, 'users'), { recursive: true });
    mkdirSync(path.join(store, 'groups'), { recursive: true });
    mkdirSync(path.join(store, 'uids'), { recursive: true });
    mkdirSync(path.join(store, 'gids'), { recursive: true });
    writeFileSync(path.join(store, 'users', 'foreign'), '419\n');
    writeFileSync(path.join(store, 'groups', 'foreign'), '419\n');
    writeFileSync(path.join(store, 'uids', '419'), 'foreign\n');
    writeFileSync(path.join(store, 'gids', '419'), 'foreign\n');

    const result = run(store, ['servora-med'], { SERVORA_IDENTITY_FAIL_AT: 'after_group' });
    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(store, 'groups', 'servora-med'))).toBe(false);
    expect(existsSync(path.join(store, 'users', 'servora-med'))).toBe(false);
    expect(existsSync(path.join(store, 'users', 'foreign'))).toBe(true);
    expect(existsSync(path.join(store, 'groups', 'foreign'))).toBe(true);
  });

  it('rolls back user+group when failure injects after_user_create', () => {
    const store = mkdtempSync(path.join(tmpdir(), 'servora-id-'));
    mkdirSync(path.join(store, 'users'), { recursive: true });
    mkdirSync(path.join(store, 'groups'), { recursive: true });
    mkdirSync(path.join(store, 'uids'), { recursive: true });
    mkdirSync(path.join(store, 'gids'), { recursive: true });
    writeFileSync(path.join(store, 'users', 'foreign'), '419\n');
    writeFileSync(path.join(store, 'groups', 'foreign'), '419\n');
    writeFileSync(path.join(store, 'uids', '419'), 'foreign\n');
    writeFileSync(path.join(store, 'gids', '419'), 'foreign\n');

    const result = run(store, ['servora-med'], { SERVORA_IDENTITY_FAIL_AT: 'after_user_create' });
    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(store, 'users', 'servora-med'))).toBe(false);
    expect(existsSync(path.join(store, 'groups', 'servora-med'))).toBe(false);
    expect(readdirSync(path.join(store, 'uids'))).toEqual(['419']);
    expect(readdirSync(path.join(store, 'gids'))).toEqual(['419']);
    expect(existsSync(path.join(store, 'users', 'foreign'))).toBe(true);
  });

  it('rolls back user+group when property set fails after_user_uid', () => {
    const store = mkdtempSync(path.join(tmpdir(), 'servora-id-'));
    const result = run(store, ['servora-postgres'], { SERVORA_IDENTITY_FAIL_AT: 'after_user_uid' });
    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(store, 'users', 'servora-postgres'))).toBe(false);
    expect(existsSync(path.join(store, 'groups', 'servora-postgres'))).toBe(false);
  });
});
