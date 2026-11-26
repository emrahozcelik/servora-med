import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { runOperatorCli } from '../src/db/operator-cli.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';
import { takeOverInstallationModules } from '../src/modules/installation-modules/takeover.js';
import { resetOperatorAccessAfterRestore } from '../src/modules/operator/restore-reset.js';

const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `opflow_${randomUUID().replaceAll('-', '')}`;
const ORIGIN = 'https://app.example.com';
const OPERATOR_PASSWORD = 'Operator#Pass1';
const CUSTOMER_PASSWORD = 'Customer#Pass1';
let admin: Pool | null = null;
let pool: Pool | null = null;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;

const config = {
  nodeEnv: 'test' as const, host: '127.0.0.1', port: 3000, databaseUrl: 'postgresql://unused',
  logLevel: 'silent', corsOrigin: ORIGIN, sessionTtlSeconds: 28_800, loginRateLimitMax: 50,
  rateLimitWindowMs: 60_000, trustedProxy: 'loopback' as const, healthSchemaVersion: null,
  releaseSha: 'dev', actionScopedGeolocationEnabled: false, reverseGeocoderProvider: null,
  googleGeocodingApiKey: null, reverseGeocoderTimeoutMs: 2000, geocodingUserDailyLimit: 15,
  geocodingOrganizationDailyLimit: 250, geocodingGlobalMonthlyLimit: 8000,
  webPush: { enabled: false, vapidSubject: null, vapidPublicKey: null, vapidPrivateKey: null },
};

async function cli(argv: string[], stdin = '', isTTY = false) {
  const out: string[] = []; const err: string[] = [];
  const stdout = new PassThrough(); const stderr = new PassThrough(); const input = new PassThrough();
  stdout.on('data', (chunk) => out.push(String(chunk))); stderr.on('data', (chunk) => err.push(String(chunk)));
  input.end(stdin);
  const code = await runOperatorCli(argv, { stdin: input, stdout, stderr, isTTY }, pool!);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function cookieOf(response: { headers: Record<string, unknown> }) {
  const raw = response.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw);
}

async function operatorLogin(email = 'op@example.com', password = OPERATOR_PASSWORD) {
  const response = await app!.inject({
    method: 'POST', url: '/api/operator/login', headers: { origin: ORIGIN },
    payload: { email, password },
  });
  return response;
}

beforeAll(async () => {
  if (!databaseUrl) return;
  admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
  await takeOverInstallationModules(pool, { overviewDashboard: false });
  const org = (await pool.query<{ id: string }>("INSERT INTO organizations (name) VALUES ('Op flow') RETURNING id")).rows[0]!.id;
  await pool.query(
    "INSERT INTO users (organization_id, name, email, password_hash, role) VALUES ($1, 'Customer Admin', 'admin@example.com', $2, 'ADMIN')",
    [org, await hashPassword(CUSTOMER_PASSWORD)],
  );
  app = await buildApp(config, {
    pool,
    authRepository: new PostgresAuthRepository(pool),
    overviewRepository: {
      getStaffOverview: async () => ({}), getManagementOverview: async () => ({}),
    } as never,
  });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin?.end();
});

describe.skipIf(!databaseUrl)('operator CLI, session and module toggle (MOD-002)', () => {
  it('grant refuses argv/env passwords and a missing password source', async () => {
    expect((await cli(['grant', '--email', 'op@example.com', '--name', 'Op', '--password', 'x'])).code).toBe(2);
    expect((await cli(['grant', '--email', 'op@example.com', '--name', 'Op', '-p', 'x'])).code).toBe(2);
    const noSource = await cli(['grant', '--email', 'op@example.com', '--name', 'Op']);
    expect(noSource.code).not.toBe(0);
    expect(noSource.stderr).not.toBe('');
  });

  it('grants through stdin, lists, and rejects a duplicate active grant', async () => {
    const granted = await cli(['grant', '--email', 'Op@Example.com', '--name', 'Op', '--password-stdin'], `${OPERATOR_PASSWORD}\n`);
    expect(granted.code).toBe(0);
    expect(granted.stdout).not.toContain(OPERATOR_PASSWORD);
    expect((await cli(['grant', '--email', 'op@example.com', '--name', 'Op', '--password-stdin'], `${OPERATOR_PASSWORD}\n`)).code).toBe(1);
    const list = await cli(['list']);
    expect(list.stdout.trim().split('\n')).toHaveLength(1);
    expect(list.stdout).toMatch(/op@example\.com\tOp\tactive\tMODULE_MANAGEMENT\t-/);
    const audit = await pool!.query("SELECT actor_kind, operator_id, target_operator_id FROM operator_audit_events WHERE event_type = 'OPERATOR_GRANTED'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_kind: 'HOST_CLI', operator_id: null });
    expect(audit.rows[0].target_operator_id).not.toBeNull();
  });

  it('applies origin, uniform 401 and the cookie contract on login', async () => {
    const noOrigin = await app!.inject({ method: 'POST', url: '/api/operator/login', payload: { email: 'op@example.com', password: OPERATOR_PASSWORD } });
    expect(noOrigin.statusCode).toBe(403);
    const wrong = await operatorLogin('op@example.com', 'Wrong#Pass1');
    const unknown = await operatorLogin('nobody@example.com');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());

    const ok = await operatorLogin();
    expect(ok.statusCode).toBe(200);
    const cookie = cookieOf(ok);
    expect(cookie).toMatch(/^servora_operator_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/operator/);
    expect(cookie).toMatch(/Max-Age=7200/);
    const ttl = await pool!.query('SELECT EXTRACT(EPOCH FROM expires_at - created_at)::int AS ttl FROM operator_sessions');
    expect(ttl.rows.every((row) => row.ttl === 7200)).toBe(true);
    const oversized = await app!.inject({
      method: 'POST', url: '/api/operator/login', headers: { origin: ORIGIN },
      payload: { email: 'a@example.com', password: 'x'.repeat(5_000) },
    });
    expect(oversized.statusCode).toBe(413);
  });

  it('toggles Overview with version checks, audit and no restart', async () => {
    const token = cookieOf(await operatorLogin()).split(';')[0]!;
    const headers = { origin: ORIGIN, cookie: token };

    const customerLogin = await app!.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN },
      payload: { email: 'admin@example.com', password: CUSTOMER_PASSWORD },
    });
    const customerCookie = cookieOf(customerLogin).split(';')[0]!;
    expect(customerLogin.json().user.capabilities.overviewDashboard).toBe(false);
    expect((await app!.inject({ method: 'GET', url: '/api/overview', headers: { cookie: customerCookie } })).statusCode).toBe(404);
    // Cookie isolation: customer cookie on operator API and operator cookie on customer API.
    expect((await app!.inject({ method: 'GET', url: '/api/operator/me', headers: { cookie: customerCookie } })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: token } })).statusCode).toBe(401);

    const modules = (await app!.inject({ method: 'GET', url: '/api/operator/modules', headers })).json().modules;
    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatchObject({ key: 'OVERVIEW', enabled: false, version: 1 });

    const put = (payload: object, key = 'OVERVIEW') => app!.inject({ method: 'PUT', url: `/api/operator/modules/${key}`, headers, payload });
    expect((await put({ enabled: true, expectedVersion: 1 }, 'NOPE')).statusCode).toBe(404);
    expect((await put({ enabled: 'yes', expectedVersion: 1 })).statusCode).toBe(400);
    const on = await put({ enabled: true, expectedVersion: 1 });
    expect(on.statusCode).toBe(200);
    expect(on.json().module).toMatchObject({ enabled: true, version: 2, source: 'OPERATOR' });

    expect((await app!.inject({ method: 'GET', url: '/api/overview', headers: { cookie: customerCookie } })).statusCode).toBe(200);
    const me = await app!.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: customerCookie } });
    expect(me.json().user.capabilities.overviewDashboard).toBe(true);

    const stale = await put({ enabled: true, expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('MODULE_VERSION_CONFLICT');
    const same = await put({ enabled: true, expectedVersion: 2 });
    expect(same.statusCode).toBe(200);
    const changes = await pool!.query("SELECT operator_id FROM operator_audit_events WHERE event_type = 'MODULE_STATE_CHANGED'");
    expect(changes.rows).toHaveLength(1);
    expect(changes.rows[0].operator_id).not.toBeNull();

    const off = await put({ enabled: false, expectedVersion: 2 });
    expect(off.json().module).toMatchObject({ enabled: false, version: 3 });
    expect((await app!.inject({ method: 'GET', url: '/api/overview', headers: { cookie: customerCookie } })).statusCode).toBe(404);
  });

  it('fails closed with 503 when the state row is missing', async () => {
    const token = cookieOf(await operatorLogin()).split(';')[0]!;
    const saved = (await pool!.query('SELECT * FROM installation_module_state')).rows[0];
    await pool!.query('DELETE FROM installation_module_state');
    try {
      const response = await app!.inject({ method: 'GET', url: '/api/operator/modules', headers: { cookie: token } });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('MODULE_STATE_UNAVAILABLE');
    } finally {
      await pool!.query(
        'INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at, updated_by_operator_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [saved.module_key, saved.enabled, saved.version, saved.source, saved.updated_at, saved.updated_by_operator_id],
      );
    }
  });

  it('logout, reset-password and revoke invalidate sessions', async () => {
    const first = cookieOf(await operatorLogin()).split(';')[0]!;
    const logout = await app!.inject({ method: 'POST', url: '/api/operator/logout', headers: { origin: ORIGIN, cookie: first } });
    expect(logout.statusCode).toBe(204);
    expect(cookieOf(logout)).toMatch(/Path=\/api\/operator/);
    expect((await app!.inject({ method: 'GET', url: '/api/operator/me', headers: { cookie: first } })).statusCode).toBe(401);

    const second = cookieOf(await operatorLogin()).split(';')[0]!;
    const reset = await cli(['reset-password', '--email', 'op@example.com', '--password-stdin'], 'Another#Pass2\n');
    expect(reset.code).toBe(0);
    expect((await app!.inject({ method: 'GET', url: '/api/operator/me', headers: { cookie: second } })).statusCode).toBe(401);
    expect((await operatorLogin('op@example.com', OPERATOR_PASSWORD)).statusCode).toBe(401);
    const third = await operatorLogin('op@example.com', 'Another#Pass2');
    expect(third.statusCode).toBe(200);

    expect((await cli(['revoke', '--email', 'op@example.com'])).code).toBe(0);
    expect((await app!.inject({ method: 'GET', url: '/api/operator/me', headers: { cookie: cookieOf(third).split(';')[0]! } })).statusCode).toBe(401);
    expect((await operatorLogin('op@example.com', 'Another#Pass2')).statusCode).toBe(401);

    const reactivated = await cli(['grant', '--email', 'op@example.com', '--name', 'Op', '--password-stdin'], 'Third#Pass3\n');
    expect(reactivated.stdout).toMatch(/Reactivated/);
    expect((await operatorLogin('op@example.com', 'Third#Pass3')).statusCode).toBe(200);
  });

  it('generates a password only on an interactive terminal', async () => {
    const generated = await cli(['grant', '--email', 'gen@example.com', '--name', 'Gen'], '\n', true);
    expect(generated.code).toBe(0);
    expect(generated.stdout).toMatch(/Generated password \(shown once\): \S+/);
  });

  it('restore reset revokes sessions, deactivates accounts and is repeatable', async () => {
    const cookie = cookieOf(await operatorLogin('op@example.com', 'Third#Pass3')).split(';')[0]!;
    const now = new Date('2026-11-26T12:00:00.000Z');
    const client = await pool!.connect();
    try {
      const first = await resetOperatorAccessAfterRestore(client, now);
      expect(first.deactivatedAccounts).toBe(2);
      expect(first.revokedSessions).toBeGreaterThan(0);
      expect(await resetOperatorAccessAfterRestore(client, now)).toEqual({ revokedSessions: 0, deactivatedAccounts: 0 });
    } finally { client.release(); }
    expect((await app!.inject({ method: 'GET', url: '/api/operator/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await operatorLogin('op@example.com', 'Third#Pass3')).statusCode).toBe(401);
    const events = await pool!.query("SELECT actor_kind, operator_id FROM operator_audit_events WHERE event_type = 'OPERATOR_ACCESS_RESET_BY_RESTORE'");
    expect(events.rows.length).toBeGreaterThan(0);
    expect(events.rows.every((row) => row.actor_kind === 'SYSTEM' && row.operator_id === null)).toBe(true);
    expect((await cli(['reset-after-restore'])).code).toBe(0);
  });

  it('rate limits login per client address and per normalized email, using the shared 429 mapping', async () => {
    const limited = await buildApp({ ...config, loginRateLimitMax: 2 }, { pool: pool! });
    try {
      const attempt = (email: string, remoteAddress: string) => limited.inject({
        method: 'POST', url: '/api/operator/login', headers: { origin: ORIGIN }, remoteAddress,
        payload: { email, password: 'Wrong#Pass1' },
      });
      // Per address: the third attempt is refused whatever the email.
      expect((await attempt('a1@example.com', '10.0.0.1')).statusCode).toBe(401);
      expect((await attempt('a2@example.com', '10.0.0.1')).statusCode).toBe(401);
      const byAddress = await attempt('a3@example.com', '10.0.0.1');
      expect(byAddress.statusCode).toBe(429);
      expect(byAddress.json().code).toBe('RATE_LIMIT_EXCEEDED');
      // Per normalized email: different addresses, same email after trim + lowercase.
      expect((await attempt('Same@Example.com', '10.0.0.2')).statusCode).toBe(401);
      expect((await attempt(' same@example.com ', '10.0.0.3')).statusCode).toBe(401);
      expect((await attempt('SAME@example.com', '10.0.0.4')).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
