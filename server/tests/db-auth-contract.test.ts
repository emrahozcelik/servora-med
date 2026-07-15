import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const verifyJs = fileURLToPath(new URL('../scripts/verify-db-auth.mjs', import.meta.url));
const bootstrapJs = fileURLToPath(new URL('../scripts/bootstrap-app-role.mjs', import.meta.url));
const envExample = fileURLToPath(
  new URL('../../ops/examples/servora-med.env.example', import.meta.url),
);
const runbook = fileURLToPath(
  new URL('../../docs/operations/local-macos-cloudflare-tunnel.md', import.meta.url),
);

describe('pilot DB auth contracts (static)', () => {
  it('documents URL-safe hex password and forbids base64 generator', () => {
    const envText = execFileSync('cat', [envExample], { encoding: 'utf8' });
    const book = execFileSync('cat', [runbook], { encoding: 'utf8' });
    expect(envText).toMatch(/URL-safe|percent-encoded/i);
    expect(envText).toMatch(/openssl rand -hex 32/);
    expect(book).toMatch(/openssl rand -hex 32/);
    expect(book).not.toMatch(/openssl rand -base64/);
    expect(book).toMatch(/--auth-host=scram-sha-256/);
    expect(book).toMatch(/--auth-local=peer/);
    expect(book).toMatch(/Never use:/);
    expect(book).toMatch(/verify-db-auth\.mjs/);
    expect(book).toMatch(/bootstrap-app-role\.mjs/);
  });

  it('canonical hex password is URL-safe', () => {
    const hex = execFileSync('openssl', ['rand', '-hex', '32'], { encoding: 'utf8' }).trim();
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    // No reserved URI userinfo characters.
    expect(hex).not.toMatch(/[:@/?#\[\]%]/);
  });

  it('verify script refuses connection string on argv', () => {
    chmodSync(verifyJs, 0o755);
    try {
      execFileSync(
        process.execPath,
        [verifyJs, 'postgresql://servora:secret@127.0.0.1:5432/db'],
        {
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: 'postgresql://servora:secret@127.0.0.1:5432/db' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect.unreachable('should refuse argv URL');
    } catch (error) {
      const err = error as { status?: number; stderr?: string };
      expect(err.status).toBe(2);
      expect(String(err.stderr ?? '')).toMatch(/must not be passed on argv/i);
    }
  });
});

const pgUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

describe.runIf(Boolean(pgUrl))('pilot DB auth contracts (PostgreSQL)', () => {
  it('bootstraps role, accepts correct password, rejects wrong password without argv leak', async () => {
    expect(existsSync(verifyJs)).toBe(true);
    expect(existsSync(bootstrapJs)).toBe(true);

    const password = execFileSync('openssl', ['rand', '-hex', '32'], { encoding: 'utf8' }).trim();
    const role = 'servora_auth_test';
    const dbName = 'servora_auth_test_db';
    const hostPort = new URL(pgUrl).host;
    const appUrl = `postgresql://${role}:${password}@${hostPort}/${dbName}`;

    execFileSync(process.execPath, [bootstrapJs], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ADMIN_DATABASE_URL: pgUrl,
        APP_DB_PASSWORD: password,
        APP_DB_ROLE: role,
        APP_DB_NAME: dbName,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const ok = execFileSync(process.execPath, [verifyJs], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: appUrl,
        EXPECT_USER: role,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(ok).toMatch(/ok db-auth/);

    const wrong = execFileSync(process.execPath, [verifyJs], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: `postgresql://${role}:wrong-password@${hostPort}/${dbName}`,
        EXPECT_FAIL: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(wrong).toMatch(/ok db-auth expected-failure/);

    // Spawn and ensure password is not on argv (Linux /proc).
    if (process.platform === 'linux') {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [verifyJs], {
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            DATABASE_URL: appUrl,
            EXPECT_USER: role,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const pid = child.pid;
        const timer = setTimeout(() => {
          try {
            if (pid && existsSync(`/proc/${pid}/cmdline`)) {
              const raw = execFileSync('cat', [`/proc/${pid}/cmdline`]);
              const text = raw.toString('utf8');
              expect(text).not.toContain(password);
              expect(text).not.toContain(appUrl);
            }
          } catch {
            // Process may have exited already.
          }
        }, 15);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`verify exit ${code}`));
        });
      });
    }

    // Cleanup
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: pgUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('percent-encoded special password connects', async () => {
    const special = 'p@ss/w:ord!';
    const enc = encodeURIComponent(special);
    const role = 'servora_auth_enc';
    const dbName = 'servora_auth_enc_db';
    const hostPort = new URL(pgUrl).host;

    execFileSync(process.execPath, [bootstrapJs], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ADMIN_DATABASE_URL: pgUrl,
        APP_DB_PASSWORD: special,
        APP_DB_ROLE: role,
        APP_DB_NAME: dbName,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const out = execFileSync(process.execPath, [verifyJs], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: `postgresql://${role}:${enc}@${hostPort}/${dbName}`,
        EXPECT_USER: role,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toMatch(/ok db-auth/);

    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: pgUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });
});
