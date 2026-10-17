import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  parseTestDatabaseUrl,
  validateServerMajor,
  validateTestDatabaseCredentials,
  validateTestDatabaseHost,
  validateTestDatabaseIdentity,
} from '../scripts/test-env-contract.js';

const verifyJs = fileURLToPath(new URL('../scripts/verify-db-auth.mjs', import.meta.url));
const bootstrapJs = fileURLToPath(new URL('../scripts/bootstrap-app-role.mjs', import.meta.url));
const envExample = fileURLToPath(new URL('../../ops/examples/servora-med.env.example', import.meta.url));
const runbook = fileURLToPath(new URL('../../docs/operations/local-macos-cloudflare-tunnel.md', import.meta.url));
const execute = promisify(execFile);
const CHILD_TIMEOUT_MS = 5000;
// Up to six bounded child phases plus bounded connection/cleanup and headroom.
// Keep Vitest's global 5s default unchanged; teardown must finish before this limit.
const AUTH_TEST_TIMEOUT_MS = 60_000;

function testAdminUrl(): string {
  const parsed = parseTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const options = { ci: process.env.CI === 'true' };
  validateTestDatabaseCredentials(parsed);
  validateTestDatabaseIdentity(parsed, options);
  validateTestDatabaseHost(parsed, options);
  return parsed.raw;
}

type AuthFixture = {
  role: string;
  database: string;
  url: string;
  verify: (phase: string, overrides?: NodeJS.ProcessEnv) => Promise<string>;
  inspectArgv: () => Promise<void>;
};

/** Exercise the real verifier while IPC holds it alive for a /proc observation. */
function inspectVerifierArgv(env: NodeJS.ProcessEnv, password: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const gate = "process.send('ready'); await new Promise(resolve => process.once('message', resolve));";
    const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(gate)}`, verifyJs], {
      env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.resume();
    child.stderr?.resume();
    let failure: unknown;
    let observed = false;
    const timer = setTimeout(() => {
      failure = new Error('DB auth argv phase timed out');
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);
    child.once('message', () => {
      try {
        const text = readFileSync(`/proc/${child.pid}/cmdline`, 'utf8');
        // Never print a password or URL even if this assertion fails.
        expect(text.includes(password) || text.includes(url)).toBe(false);
        observed = true;
        child.send('continue');
      } catch (error) {
        failure = error;
        child.kill('SIGKILL');
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (!observed || code !== 0) reject(new Error(`DB auth argv proof incomplete (exit=${code})`));
      else resolve();
    });
  });
}

async function withAuthDatabase(password: string, work: (fixture: AuthFixture) => Promise<void>): Promise<void> {
  const adminUrl = testAdminUrl(); // Never fall back to DATABASE_URL or ADMIN_DATABASE_URL.
  const suffix = randomUUID().replaceAll('-', '');
  const role = `servora_auth_${suffix}`;
  const database = `${role}_db`;
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  const appUrl = url.toString();
  const admin = new pg.Client({
    connectionString: adminUrl, connectionTimeoutMillis: CHILD_TIMEOUT_MS,
    query_timeout: CHILD_TIMEOUT_MS, statement_timeout: CHILD_TIMEOUT_MS,
  });
  const phases: { phase: string; ms: number }[] = [];
  async function measure<T>(phase: string, action: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await action(); }
    finally { phases.push({ phase, ms: Math.round(performance.now() - start) }); }
  }
  async function run(phase: string, script: string, env: NodeJS.ProcessEnv): Promise<string> {
    return measure(phase, async () => {
      try {
        const result = await execute(process.execPath, [script], {
          env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
          timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL',
        });
        return result.stdout;
      } catch (error) {
        const result = error as { code?: number | string; signal?: string; killed?: boolean };
        // Phase diagnostics only: child output and environment can contain secrets.
        throw new Error(`DB auth ${phase} failed (code=${result.code}, signal=${result.signal}, killed=${result.killed})`);
      }
    });
  }
  let claimed = false;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await measure('admin-connect', () => admin.connect());
    const version = await admin.query<{ major: number }>(
      "SELECT current_setting('server_version_num')::int / 10000 AS major",
    );
    validateServerMajor(version.rows[0]!.major);
    const existing = await admin.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1)
        OR EXISTS(SELECT 1 FROM pg_database WHERE datname=$2) AS present`, [role, database],
    );
    if (existing.rows[0]!.present) throw new Error('Refusing an existing auth fixture identity');
    claimed = true;
    await run('bootstrap', bootstrapJs, {
      ADMIN_DATABASE_URL: adminUrl, APP_DB_PASSWORD: password, APP_DB_ROLE: role, APP_DB_NAME: database,
    });
    await work({
      role, database, url: appUrl,
      verify: (phase, overrides = {}) => run(phase, verifyJs, {
        DATABASE_URL: appUrl, EXPECT_USER: role, ...overrides,
      }),
      inspectArgv: () => measure('argv-proof', () => inspectVerifierArgv({
        PATH: process.env.PATH, DATABASE_URL: appUrl, EXPECT_USER: role,
      }, password, appUrl)),
    });
  } catch (error) {
    failure = error;
  } finally {
    if (claimed) {
      try {
        await measure('cleanup-database', async () => {
          const owner = await admin.query<{ owner: string }>(
            `SELECT r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
             WHERE d.datname=$1`, [database],
          );
          if (owner.rows[0] && owner.rows[0].owner !== role) throw new Error('Refusing foreign auth database cleanup');
          await admin.query(`DROP DATABASE IF EXISTS ${database}`);
        });
      } catch (error) { cleanupErrors.push(error); }
      try { await measure('cleanup-role', () => admin.query(`DROP ROLE IF EXISTS ${role}`)); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await measure('admin-close', () => admin.end()); }
    catch (error) { cleanupErrors.push(error); }
    console.info('DB_AUTH_PHASE_TIMINGS', JSON.stringify(phases));
  }
  if (cleanupErrors.length) {
    throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'DB auth fixture cleanup failed');
  }
  if (failure) throw failure;
}

describe('pilot DB auth contracts (static)', () => {
  it('documents URL-safe hex password and forbids base64 generator', () => {
    const envText = readFileSync(envExample, 'utf8');
    const book = readFileSync(runbook, 'utf8');
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

  it('canonical hex password is URL-safe', async () => {
    const { stdout } = await execute('openssl', ['rand', '-hex', '32'], { encoding: 'utf8', timeout: 2000 });
    expect(stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(stdout.trim()).not.toMatch(/[:@/?#\[\]%]/);
  });

  it('verify script refuses connection string on argv', async () => {
    await expect(execute(process.execPath, [verifyJs, 'postgresql://probe:synthetic@127.0.0.1/probe'], {
      env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://probe:synthetic@127.0.0.1/probe' },
      timeout: 2000,
    })).rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/must not be passed on argv/i) });
  });

  it('EXPECT_FAIL rejects transport errors instead of claiming wrong-password proof', async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('TCP fixture address missing');
      await expect(execute(process.execPath, [verifyJs], {
        env: { PATH: process.env.PATH, DATABASE_URL: `postgresql://probe:synthetic@127.0.0.1:${address.port}/probe`, EXPECT_FAIL: '1' },
        timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL',
      })).rejects.toMatchObject({ code: 1 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 10_000);

  it.each([
    ['missing', undefined, 'TEST_DATABASE_URL is required'],
    ['protected', 'postgresql://probe:synthetic@127.0.0.1/servora_med', 'protected database'],
    ['remote', 'postgresql://probe:synthetic@remote.invalid/servora_med_test_probe', 'loopback'],
  ])('refuses an unsafe explicit test target (%s)', async (_label, target, message) => {
    vi.stubEnv('CI', 'false');
    vi.stubEnv('TEST_DATABASE_URL', target);
    vi.stubEnv('DATABASE_URL', 'postgresql://probe:synthetic@127.0.0.1/servora_med');
    try {
      await expect(withAuthDatabase('synthetic', async () => { throw new Error('must not run'); }))
        .rejects.toThrow(message);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('pilot DB auth contracts (PostgreSQL)', () => {
  it('bootstraps role, accepts correct password, rejects wrong password without argv leak', async () => {
    expect(existsSync(verifyJs)).toBe(true);
    expect(existsSync(bootstrapJs)).toBe(true);
    await withAuthDatabase(randomBytes(32).toString('hex'), async (fixture) => {
      expect(await fixture.verify('correct-password')).toMatch(/ok db-auth/);
      const wrong = new URL(fixture.url);
      wrong.password = 'deliberately-wrong-password';
      expect(await fixture.verify('wrong-password', { DATABASE_URL: wrong.toString(), EXPECT_FAIL: '1' }))
        .toMatch(/ok db-auth expected-failure code=28P01/);
      await expect(fixture.verify('unexpected-success', { EXPECT_FAIL: '1' })).rejects.toThrow('unexpected-success failed');
      const missing = new URL(fixture.url);
      missing.pathname = `/${fixture.database}_absent`;
      await expect(fixture.verify('missing-database', { DATABASE_URL: missing.toString(), EXPECT_FAIL: '1' }))
        .rejects.toThrow('missing-database failed');
      if (process.platform === 'linux') await fixture.inspectArgv();
    });
  }, AUTH_TEST_TIMEOUT_MS);

  it('percent-encoded special password connects', async () => {
    await withAuthDatabase('p@ss/w:ord!#?', async (fixture) => {
      expect(await fixture.verify('encoded-password')).toMatch(/ok db-auth/);
    });
  }, AUTH_TEST_TIMEOUT_MS);

  it('cleans owned role and database when verification throws', async () => {
    let identity: { role: string; database: string } | undefined;
    await expect(withAuthDatabase('synthetic-cleanup-password', async (identityFixture) => {
      const { role, database } = identityFixture;
      identity = { role, database };
      await identityFixture.verify('forced-verification-failure', { EXPECT_FAIL: '1' });
    })).rejects.toThrow('forced-verification-failure failed');
    expect(identity).toBeDefined();
    const client = new pg.Client({ connectionString: testAdminUrl(), connectionTimeoutMillis: CHILD_TIMEOUT_MS, query_timeout: CHILD_TIMEOUT_MS });
    try {
      await client.connect();
      const rows = await client.query(
        `SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname=$1) AS roles,
                (SELECT count(*)::int FROM pg_database WHERE datname=$2) AS databases`,
        [identity!.role, identity!.database],
      );
      expect(rows.rows).toEqual([{ roles: 0, databases: 0 }]);
    } finally { await client.end(); }
  }, AUTH_TEST_TIMEOUT_MS);

  it('isolates concurrent auth fixtures', async () => {
    const identities: string[] = [];
    await Promise.all([1, 2].map(() => withAuthDatabase(randomBytes(32).toString('hex'), async (fixture) => {
      identities.push(fixture.role, fixture.database);
      expect(await fixture.verify('concurrent-password')).toMatch(/ok db-auth/);
    })));
    expect(new Set(identities).size).toBe(4);
  }, AUTH_TEST_TIMEOUT_MS);
});
