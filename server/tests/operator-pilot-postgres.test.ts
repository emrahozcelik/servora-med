import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';

import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MOD-002 installation operator + runtime module state (Overview pilot).
 * Black-box acceptance scenarios OP1-OP13 from
 * docs/features/operator-module-pilot.md section 10, written only against the
 * section 12 interfaces: buildApp + app.inject over a real PostgreSQL schema,
 * takeOverInstallationModules, resetOperatorAccessAfterRestore and
 * runOperatorCli (used as the only way to seed operators, except where the CLI
 * cannot express the state).
 *
 * Structural KDF seam (never wall-clock): a counted wrapper around node:crypto
 * `scrypt`, same technique as auth-login-constant-work.test.ts.
 */
const derivations = vi.hoisted(() => ({ slots: [] as number[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    scrypt(
      password: unknown,
      salt: unknown,
      keylen: unknown,
      options: { N?: number } & Record<string, unknown>,
      callback: (err: Error | null, key?: Buffer) => void,
    ) {
      derivations.slots.push(options.N ?? -1);
      return actual.scrypt(
        password as never, salt as never, keylen as never, options as never, callback as never,
      );
    },
  };
});

import { buildApp } from '../src/app.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { runOperatorCli } from '../src/db/operator-cli.js';
import { hashPassword, hashSessionToken } from '../src/modules/auth/crypto.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';
import type { ModuleStateReader } from '../src/modules/installation-modules/state.js';
import { takeOverInstallationModules } from '../src/modules/installation-modules/takeover.js';
import type { OverviewReadModel } from '../src/modules/overview/repository.js';
import { resetOperatorAccessAfterRestore } from '../src/modules/operator/restore-reset.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const ORIGIN = 'http://127.0.0.1:5173';
const OPERATOR_COOKIE = 'servora_operator_session';
const CUSTOMER_COOKIE = 'servora_session';
const PASSWORD = 'Operator-Pass#2026';
const NEW_PASSWORD = 'Operator-New#2027';
const CUSTOMER_PASSWORD = 'Customer-Pass#2026';
const CUSTOMER_EMAIL = 'admin@op-pilot.test';

const baseConfig = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 0,
  databaseUrl: databaseUrl ?? 'postgresql://unused-operator-pilot',
  logLevel: 'silent',
  corsOrigin: ORIGIN,
  sessionTtlSeconds: 28_800,
  loginRateLimitMax: 5,
  rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback' as const,
  healthSchemaVersion: null,
  releaseSha: 'dev',
  actionScopedGeolocationEnabled: false,
  reverseGeocoderProvider: null,
  googleGeocodingApiKey: null,
  reverseGeocoderTimeoutMs: 2_000,
  geocodingUserDailyLimit: 15,
  geocodingOrganizationDailyLimit: 250,
  geocodingGlobalMonthlyLimit: 8_000,
  webPush: { enabled: false, vapidSubject: null, vapidPublicKey: null, vapidPrivateKey: null },
  capabilities: {
    overviewDashboard: false,
    calendar: false,
    messaging: false,
    backup: false,
    demoDatasetCreation: false,
  },
};

const stubOverview = {
  getStaffOverview: async () => ({ marker: 'overview-stub' }),
  getManagementOverview: async () => ({ marker: 'overview-stub' }),
} as unknown as OverviewReadModel;

type App = Awaited<ReturnType<typeof buildApp>>;
type InjectResponse = Awaited<ReturnType<App['inject']>>;

// ---------------------------------------------------------------- fixture

let schema = '';
let adminPool: Pool;
let pool: Pool;
let customerOrganizationId = '';
const extraPools: Pool[] = [];

function schemaPool(): Pool {
  const created = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  });
  extraPools.push(created);
  return created;
}

beforeAll(async () => {
  if (!databaseUrl) return;
  adminPool = new Pool({ connectionString: databaseUrl });
  schema = `op_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  pool = schemaPool();
  await runMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    store: new PostgresMigrationStore(pool),
  });
  customerOrganizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [`OP ${randomUUID()}`],
  )).rows[0]!.id;
  await pool.query(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'Customer Admin', $2, $3, 'ADMIN')`,
    [customerOrganizationId, CUSTOMER_EMAIL, await hashPassword(CUSTOMER_PASSWORD)],
  );
}, 120_000);

afterAll(async () => {
  if (!databaseUrl) return;
  await Promise.all(extraPools.splice(0).map((p) => p.end()));
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
});

beforeEach(async () => {
  if (!databaseUrl) return;
  await pool.query(
    `TRUNCATE operator_audit_events, operator_sessions, operator_account_capabilities,
       installation_module_state, operator_accounts RESTART IDENTITY CASCADE`,
  );
  await pool.query(`DROP TRIGGER IF EXISTS op_force_audit_failure ON operator_audit_events`);
});

const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function createApp(options: {
  config?: Omit<typeof baseConfig, 'nodeEnv'> & { nodeEnv: 'test' | 'production' };
  moduleStateReader?: ModuleStateReader;
  logDestination?: NodeJS.WritableStream;
} = {}): Promise<App> {
  const app = await buildApp((options.config ?? baseConfig) as Parameters<typeof buildApp>[0], {
    pool,
    authRepository: new PostgresAuthRepository(pool),
    overviewRepository: stubOverview,
    ...(options.moduleStateReader ? { moduleStateReader: options.moduleStateReader } : {}),
    ...(options.logDestination ? { loggerDestination: options.logDestination } : {}),
  });
  apps.push(app);
  return app;
}

// ---------------------------------------------------------------- helpers

let ipCounter = 0;
/** Unique client address per call; the test config trusts the loopback proxy. */
function nextIp(): string {
  ipCounter += 1;
  return `10.1.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

type RequestOptions = {
  cookie?: string | null;
  /** false omits the header; a string is sent verbatim. Default: configured origin. */
  origin?: string | false;
  ip?: string;
  headers?: Record<string, string>;
};

function headersFor(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'x-forwarded-for': options.ip ?? nextIp(),
    ...(options.headers ?? {}),
  };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== false) headers.origin = origin;
  if (options.cookie) headers.cookie = options.cookie;
  return headers;
}

function call(
  app: App,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  options: RequestOptions = {},
): Promise<InjectResponse> {
  return app.inject({
    method, url, headers: headersFor(options),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function setCookies(res: InjectResponse): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function setCookieFor(res: InjectResponse, name: string): string | null {
  return setCookies(res).find((c) => c.startsWith(`${name}=`)) ?? null;
}

function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0]!.slice(setCookie.indexOf('=') + 1);
}

type Login = { res: InjectResponse; raw: string | null; cookie: string | null };

async function operatorLogin(
  app: App, email: string, password = PASSWORD, options: RequestOptions = {},
): Promise<Login> {
  const res = await call(app, 'POST', '/api/operator/login', { email, password }, options);
  const set = setCookieFor(res, OPERATOR_COOKIE);
  const raw = set ? cookieValue(set) : null;
  return { res, raw, cookie: raw ? `${OPERATOR_COOKIE}=${raw}` : null };
}

async function customerLogin(app: App, ip = nextIp()): Promise<string> {
  const res = await call(
    app, 'POST', '/api/auth/login',
    { email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD }, { ip },
  );
  expect(res.statusCode).toBe(200);
  return `${CUSTOMER_COOKIE}=${cookieValue(setCookieFor(res, CUSTOMER_COOKIE)!)}`;
}

type Io = { stdout: string[]; stderr: string[] };

function cliIo(stdinText: string | null, isTTY = false) {
  const out: Io = { stdout: [], stderr: [] };
  const sink = (target: string[]) => new Writable({
    write(chunk, _encoding, callback) { target.push(chunk.toString()); callback(); },
  });
  return {
    io: {
      stdin: Readable.from(stdinText === null ? [] : [stdinText]),
      stdout: sink(out.stdout),
      stderr: sink(out.stderr),
      isTTY,
    },
    out,
  };
}

async function cli(argv: string[], stdinText: string | null = null, isTTY = false) {
  const { io, out } = cliIo(stdinText, isTTY);
  const code = await runOperatorCli(argv, io, pool);
  return { code, stdout: out.stdout.join(''), stderr: out.stderr.join('') };
}

async function grant(email: string, name = 'Operator One', password = PASSWORD): Promise<string> {
  const result = await cli(['grant', '--email', email, '--name', name, '--password-stdin'], `${password}\n`);
  expect(result.code, result.stderr).toBe(0);
  return operatorId(email);
}

async function operatorId(email: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `SELECT id FROM operator_accounts WHERE lower(email) = lower($1)`, [email]);
  return row.rows[0]!.id;
}

type AuditRow = {
  event_type: string;
  actor_kind: string;
  operator_id: string | null;
  target_operator_id: string | null;
  module_key: string | null;
  old_value: unknown;
  new_value: unknown;
  occurred_at: Date;
};

async function auditRows(eventType?: string): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    `SELECT event_type, actor_kind, operator_id, target_operator_id, module_key,
            old_value, new_value, occurred_at
       FROM operator_audit_events
      WHERE ($1::text IS NULL OR event_type = $1)
      ORDER BY occurred_at, id`,
    [eventType ?? null],
  );
  return result.rows;
}

async function auditCount(): Promise<number> {
  return Number((await pool.query(`SELECT count(*)::int AS n FROM operator_audit_events`)).rows[0].n);
}

type StateRow = { enabled: boolean; version: number; source: string; updated_by_operator_id: string | null };

async function stateRow(): Promise<StateRow | null> {
  const result = await pool.query<StateRow>(
    `SELECT enabled, version, source, updated_by_operator_id
       FROM installation_module_state WHERE module_key = 'OVERVIEW'`);
  return result.rows[0] ?? null;
}

async function seedState(enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
     VALUES ('OVERVIEW', $1, 1, 'ENV_TAKEOVER', now())`,
    [enabled],
  );
}

async function activeSessionCount(operatorIdValue: string): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM operator_sessions
      WHERE operator_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [operatorIdValue],
  );
  return Number(result.rows[0].n);
}

/** Active operator with a session, an app, and a seeded Overview state. */
async function operatorFixture(options: { enabled?: boolean; email?: string } = {}) {
  const email = options.email ?? `op-${randomUUID()}@example.com`;
  const id = await grant(email);
  await seedState(options.enabled ?? false);
  const app = await createApp();
  const session = await operatorLogin(app, email);
  expect(session.res.statusCode).toBe(200);
  return { app, email, id, cookie: session.cookie! };
}

function put(
  app: App, cookie: string | null, payload: unknown, key = 'OVERVIEW', options: RequestOptions = {},
) {
  return call(app, 'PUT', `/api/operator/modules/${key}`, payload, { ...options, cookie });
}

async function currentVersion(app: App, cookie: string): Promise<number> {
  const res = await call(app, 'GET', '/api/operator/modules', undefined, { cookie });
  expect(res.statusCode).toBe(200);
  return res.json().modules[0].version;
}

function expectUnauthenticated(res: InjectResponse) {
  expect(res.statusCode).toBe(401);
  expect(setCookies(res).filter((c) => c.startsWith(`${OPERATOR_COOKIE}=`)
    && !/Max-Age=0|Expires=/i.test(c))).toEqual([]);
}

// ---------------------------------------------------------------- OP1

describe.skipIf(!databaseUrl)('OP1 operator login', { timeout: 60_000 }, () => {
  it('valid login returns the operator and sets a hardened, path-scoped cookie', async () => {
    const email = 'Op.One@Example.com';
    const id = await grant(email, 'Operator One');
    const app = await createApp();

    const { res, raw } = await operatorLogin(app, email.toUpperCase());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      operator: {
        id,
        name: 'Operator One',
        email: email.toLowerCase(),
        capabilities: ['MODULE_MANAGEMENT'],
      },
    });
    expect(JSON.stringify(res.json())).not.toMatch(/scrypt|password/i);

    const cookie = setCookieFor(res, OPERATOR_COOKIE)!;
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Strict/i);
    expect(cookie).toMatch(/;\s*Path=\/api\/operator(;|$)/);
    expect(cookie).not.toMatch(/;\s*Domain=/i);
    expect(cookie).not.toMatch(/;\s*Secure/i); // Secure only in production
    const maxAge = /Max-Age=(\d+)/i.exec(cookie);
    const expires = /Expires=([^;]+)/i.exec(cookie);
    const lifetimeSeconds = maxAge
      ? Number(maxAge[1])
      : (new Date(expires![1]!).getTime() - Date.now()) / 1000;
    expect(Math.abs(lifetimeSeconds - 7200)).toBeLessThan(60); // 2 hours absolute

    // Opaque token, only its SHA-256 is stored (SEC-001 pattern).
    const sessions = await pool.query<{ token_hash: string; created_at: Date; expires_at: Date; revoked_at: Date | null }>(
      `SELECT token_hash, created_at, expires_at, revoked_at FROM operator_sessions WHERE operator_id = $1`, [id]);
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0]!.token_hash).toBe(hashSessionToken(raw!));
    expect(sessions.rows[0]!.token_hash).not.toBe(raw);
    expect(sessions.rows[0]!.revoked_at).toBeNull();
    expect(Math.abs(
      (sessions.rows[0]!.expires_at.getTime() - sessions.rows[0]!.created_at.getTime()) / 1000 - 7200,
    )).toBeLessThan(60);

    // Session + OPERATOR_LOGIN_SUCCEEDED audit event, actor = the operator.
    const events = await auditRows('OPERATOR_LOGIN_SUCCEEDED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_kind: 'OPERATOR', operator_id: id });
  });

  it('session is absolute: authenticated requests do not renew the expiry or re-issue the cookie', async () => {
    const { app, cookie, id } = await operatorFixture();
    const before = await pool.query(`SELECT expires_at FROM operator_sessions WHERE operator_id = $1`, [id]);

    const me = await call(app, 'GET', '/api/operator/me', undefined, { cookie });

    expect(me.statusCode).toBe(200);
    expect(setCookieFor(me, OPERATOR_COOKIE)).toBeNull();
    const after = await pool.query(`SELECT expires_at FROM operator_sessions WHERE operator_id = $1`, [id]);
    expect(after.rows[0].expires_at).toEqual(before.rows[0].expires_at);
  });

  it('cookie is Secure under the production configuration', async () => {
    const email = `op-${randomUUID()}@example.com`;
    await grant(email);
    const app = await createApp({ config: { ...baseConfig, nodeEnv: 'production' } });

    const { res } = await operatorLogin(app, email);

    expect(res.statusCode).toBe(200);
    expect(setCookieFor(res, OPERATOR_COOKIE)).toMatch(/;\s*Secure/i);
  });

  it('unknown email, inactive account and wrong password give an identical 401 with identical KDF work', async () => {
    const activeEmail = `active-${randomUUID()}@example.com`;
    const inactiveEmail = `inactive-${randomUUID()}@example.com`;
    await grant(activeEmail);
    await grant(inactiveEmail);
    expect((await cli(['revoke', '--email', inactiveEmail])).code).toBe(0);
    const app = await createApp();
    const loginsBefore = await auditCount();

    const attempts: Array<{ res: InjectResponse; work: number[] }> = [];
    for (const [email, password] of [
      [`ghost-${randomUUID()}@example.com`, PASSWORD], // unknown email
      [inactiveEmail, PASSWORD], // inactive, correct password
      [activeEmail, 'Wrong-Password#1'], // wrong password
    ] as const) {
      const start = derivations.slots.length;
      const res = await call(app, 'POST', '/api/operator/login', { email, password });
      attempts.push({ res, work: derivations.slots.slice(start).sort((a, b) => a - b) });
    }

    for (const { res } of attempts) {
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_CREDENTIALS');
      expect(setCookies(res)).toEqual([]);
    }
    expect(attempts[1]!.res.json()).toEqual(attempts[0]!.res.json());
    expect(attempts[2]!.res.json()).toEqual(attempts[0]!.res.json());
    expect(attempts[0]!.work.length).toBeGreaterThan(0);
    expect(attempts[1]!.work).toEqual(attempts[0]!.work);
    expect(attempts[2]!.work).toEqual(attempts[0]!.work);
    // Failed logins are never audit rows and never create sessions.
    expect(await auditCount()).toBe(loginsBefore);
    expect((await pool.query(`SELECT count(*)::int AS n FROM operator_sessions`)).rows[0].n).toBe(0);
  });

  it.each([
    ['missing body', undefined],
    ['missing password', { email: 'a@example.com' }],
    ['missing email', { password: PASSWORD }],
    ['non-string email', { email: 42, password: PASSWORD }],
    ['non-string password', { email: 'a@example.com', password: { x: 1 } }],
  ])('rejects %s with 400 VALIDATION_ERROR and no session', async (_label, payload) => {
    const app = await createApp();

    const res = await call(app, 'POST', '/api/operator/login', payload);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(setCookies(res)).toEqual([]);
  });

  it('applies a small body limit before any KDF work', async () => {
    const app = await createApp();
    const start = derivations.slots.length;

    const res = await call(app, 'POST', '/api/operator/login', {
      email: 'a@example.com', password: 'x'.repeat(300_000),
    });

    expect([400, 413]).toContain(res.statusCode);
    expect(derivations.slots.length).toBe(start);
  });

  it('limits attempts per client address, before the KDF, and does not throttle other clients', async () => {
    const email = `op-${randomUUID()}@example.com`;
    await grant(email);
    const app = await createApp();
    const ip = nextIp();

    const statuses: number[] = [];
    let workDuringLimited = -1;
    for (let i = 0; i < 40; i += 1) {
      const start = derivations.slots.length;
      const res = await call(app, 'POST', '/api/operator/login',
        { email: `nobody-${i}@example.com`, password: 'Wrong-Password#1' }, { ip });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) {
        workDuringLimited = derivations.slots.length - start;
        expect(res.json().code).toBe('RATE_LIMIT_EXCEEDED');
        break;
      }
    }

    expect(statuses[0]).toBe(401);
    expect(statuses[statuses.length - 1]).toBe(429);
    expect(workDuringLimited).toBe(0); // limiter runs before the KDF
    // A throttled address cannot log in even with correct credentials.
    expect((await operatorLogin(app, email, PASSWORD, { ip })).res.statusCode).toBe(429);
    // Another client address is unaffected.
    expect((await operatorLogin(app, email, PASSWORD, { ip: nextIp() })).res.statusCode).toBe(200);
  });

  it('limits attempts per normalized email across addresses, before the KDF', async () => {
    const email = `target-${randomUUID()}@example.com`;
    await grant(email);
    const app = await createApp();

    let limitedAt = -1;
    for (let i = 0; i < 40; i += 1) {
      const start = derivations.slots.length;
      // Case/whitespace variants share one bucket (normalized email).
      const variant = i % 2 === 0 ? email.toUpperCase() : ` ${email} `;
      const res = await call(app, 'POST', '/api/operator/login',
        { email: variant, password: 'Wrong-Password#1' }, { ip: nextIp() });
      if (res.statusCode === 429) {
        limitedAt = i;
        expect(derivations.slots.length - start).toBe(0);
        break;
      }
      expect(res.statusCode).toBe(401);
    }

    expect(limitedAt).toBeGreaterThan(0);
    // The right password from a fresh address is also refused for this email...
    expect((await operatorLogin(app, email, PASSWORD, { ip: nextIp() })).res.statusCode).toBe(429);
    // ...but a different email from a fresh address is not.
    const other = `other-${randomUUID()}@example.com`;
    await grant(other);
    expect((await operatorLogin(app, other, PASSWORD, { ip: nextIp() })).res.statusCode).toBe(200);
  });

  it('operator and customer login limits are separate budgets', async () => {
    const email = `op-${randomUUID()}@example.com`;
    await grant(email);
    const app = await createApp();
    const ip = nextIp();

    // Exhaust the customer login budget (loginRateLimitMax = 5) on this address.
    let customerLimited = false;
    for (let i = 0; i < 12 && !customerLimited; i += 1) {
      const res = await call(app, 'POST', '/api/auth/login',
        { email: CUSTOMER_EMAIL, password: 'Wrong-Password#1' }, { ip });
      customerLimited = res.statusCode === 429;
    }
    expect(customerLimited).toBe(true);
    expect((await operatorLogin(app, email, PASSWORD, { ip })).res.statusCode).toBe(200);

    // And exhausting the operator budget leaves the customer login untouched.
    const ip2 = nextIp();
    for (let i = 0; i < 40; i += 1) {
      const res = await call(app, 'POST', '/api/operator/login',
        { email: `nobody-${i}@example.com`, password: 'Wrong-Password#1' }, { ip: ip2 });
      if (res.statusCode === 429) break;
    }
    const customer = await call(app, 'POST', '/api/auth/login',
      { email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD }, { ip: ip2 });
    expect(customer.statusCode).toBe(200);
  });

  it('GET /me returns the operator identity and capabilities', async () => {
    const { app, cookie, id, email } = await operatorFixture();

    const res = await call(app, 'GET', '/api/operator/me', undefined, { cookie });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      operator: { id, name: 'Operator One', email, capabilities: ['MODULE_MANAGEMENT'] },
    });
  });

  it('host CLI list reports the last successful login derived from the audit table', async () => {
    const { email } = await operatorFixture();

    const listed = await cli(['list']);

    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(email);
    expect(listed.stdout).toContain('MODULE_MANAGEMENT');
    const [login] = await auditRows('OPERATOR_LOGIN_SUCCEEDED');
    const iso = login!.occurred_at.toISOString().slice(0, 10);
    const local = new Date(login!.occurred_at.getTime() - login!.occurred_at.getTimezoneOffset() * 60_000)
      .toISOString().slice(0, 10);
    expect(listed.stdout.includes(iso) || listed.stdout.includes(local)).toBe(true);
  });
});

// ---------------------------------------------------------------- OP2

describe.skipIf(!databaseUrl)('OP2 session separation', { timeout: 60_000 }, () => {
  it('no cookie and a customer cookie are 401 on every operator route', async () => {
    const { app } = await operatorFixture();
    const customerCookie = await customerLogin(app);

    for (const cookie of [null, customerCookie]) {
      const me = await call(app, 'GET', '/api/operator/me', undefined, { cookie });
      expect(me.statusCode).toBe(401);
      expect(me.json().code).toBe('OPERATOR_UNAUTHENTICATED');
      expect((await call(app, 'GET', '/api/operator/modules', undefined, { cookie })).statusCode).toBe(401);
      expect((await put(app, cookie, { enabled: true, expectedVersion: 1 })).statusCode).toBe(401);
    }
    expect((await stateRow())!.enabled).toBe(false);
    // The customer session is still alive: operator routes never touched it.
    expect((await call(app, 'GET', '/api/auth/me', undefined, { cookie: customerCookie })).statusCode).toBe(200);
  });

  it('a customer session token presented under the operator cookie name is rejected', async () => {
    const { app } = await operatorFixture();
    const customerCookie = await customerLogin(app);
    const rawCustomerToken = customerCookie.slice(`${CUSTOMER_COOKIE}=`.length);

    const res = await call(app, 'GET', '/api/operator/me', undefined,
      { cookie: `${OPERATOR_COOKIE}=${rawCustomerToken}` });

    expect(res.statusCode).toBe(401);
  });

  it('an operator cookie authenticates nothing on customer routes', async () => {
    const { app, cookie } = await operatorFixture({ enabled: true });
    const rawOperatorToken = cookie.slice(`${OPERATOR_COOKIE}=`.length);

    for (const presented of [cookie, `${CUSTOMER_COOKIE}=${rawOperatorToken}`]) {
      const me = await call(app, 'GET', '/api/auth/me', undefined, { cookie: presented });
      expect(me.statusCode).toBe(401);
      const overview = await call(app, 'GET', '/api/overview', undefined, { cookie: presented });
      expect(overview.statusCode).toBe(401);
    }
  });

  it('customer APIs and /api/health expose nothing about operators', async () => {
    const { app } = await operatorFixture({ enabled: true });
    const customerCookie = await customerLogin(app);

    const bodies = await Promise.all([
      call(app, 'GET', '/api/health', undefined, {}),
      call(app, 'GET', '/api/auth/me', undefined, { cookie: customerCookie }),
      call(app, 'GET', '/api/overview', undefined, { cookie: customerCookie }),
    ]);

    for (const res of bodies) expect(res.body).not.toMatch(/operator/i);
  });
});

// ---------------------------------------------------------------- OP3

describe.skipIf(!databaseUrl)('OP3 origin enforcement on operator writes (non-production config)', { timeout: 60_000 }, () => {
  const BAD_ORIGINS: Array<[string, string | false]> = [
    ['missing', false],
    ['literal null', 'null'],
    ['foreign host', 'http://evil.example'],
    ['same host other port', 'http://127.0.0.1:5174'],
    ['trailing slash (not exact)', `${ORIGIN}/`],
  ];

  it.each(BAD_ORIGINS)('login with %s Origin is 403 INVALID_ORIGIN and creates nothing', async (_label, origin) => {
    const email = `op-${randomUUID()}@example.com`;
    await grant(email);
    const app = await createApp();
    const events = await auditCount();

    const res = await call(app, 'POST', '/api/operator/login', { email, password: PASSWORD }, { origin });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('INVALID_ORIGIN');
    expect(setCookies(res)).toEqual([]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM operator_sessions`)).rows[0].n).toBe(0);
    expect(await auditCount()).toBe(events);
  });

  it.each(BAD_ORIGINS)('logout with %s Origin is 403 and leaves the session alive', async (_label, origin) => {
    const { app, cookie, id } = await operatorFixture();

    const res = await call(app, 'POST', '/api/operator/logout', undefined, { cookie, origin });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('INVALID_ORIGIN');
    expect(await activeSessionCount(id)).toBe(1);
    expect((await call(app, 'GET', '/api/operator/me', undefined, { cookie })).statusCode).toBe(200);
  });

  it.each(BAD_ORIGINS)('module PUT with %s Origin is 403 and writes nothing', async (_label, origin) => {
    const { app, cookie } = await operatorFixture();
    const version = await currentVersion(app, cookie);
    const events = await auditCount();

    const res = await put(app, cookie, { enabled: true, expectedVersion: version }, 'OVERVIEW', { origin });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('INVALID_ORIGIN');
    expect(await stateRow()).toMatchObject({ enabled: false, version });
    expect(await auditCount()).toBe(events);
  });

  it('safe reads do not require an Origin header; the exact configured Origin is accepted on writes', async () => {
    const { app, cookie } = await operatorFixture();

    expect((await call(app, 'GET', '/api/operator/me', undefined, { cookie, origin: false })).statusCode).toBe(200);
    expect((await call(app, 'GET', '/api/operator/modules', undefined, { cookie, origin: false })).statusCode).toBe(200);
    const version = await currentVersion(app, cookie);
    expect((await put(app, cookie, { enabled: true, expectedVersion: version }, 'OVERVIEW', { origin: ORIGIN })).statusCode)
      .toBe(200);
  });
});

// ---------------------------------------------------------------- OP4

describe.skipIf(!databaseUrl)('OP4 session validity', { timeout: 60_000 }, () => {
  async function expectDead(app: App, cookie: string) {
    expectUnauthenticated(await call(app, 'GET', '/api/operator/me', undefined, { cookie }));
    expectUnauthenticated(await call(app, 'GET', '/api/operator/modules', undefined, { cookie }));
    expectUnauthenticated(await put(app, cookie, { enabled: true, expectedVersion: 1 }));
  }

  it('an expired session is 401 everywhere and cannot change state', async () => {
    const { app, cookie, id } = await operatorFixture();
    await pool.query(
      `UPDATE operator_sessions SET expires_at = now() - interval '1 minute' WHERE operator_id = $1`, [id]);

    await expectDead(app, cookie);
    expect(await stateRow()).toMatchObject({ enabled: false, version: 1 });
    expect(await auditRows('MODULE_STATE_CHANGED')).toHaveLength(0);
  });

  it('logout revokes the session, clears the cookie with the same Path, and the old cookie is dead', async () => {
    const { app, cookie, id } = await operatorFixture();

    const res = await call(app, 'POST', '/api/operator/logout', undefined, { cookie });

    expect(res.statusCode).toBe(204);
    const cleared = setCookieFor(res, OPERATOR_COOKIE)!;
    expect(cleared).toMatch(/;\s*Path=\/api\/operator(;|$)/);
    expect(/Max-Age=0/i.test(cleared) || /Expires=Thu, 01 Jan 1970/i.test(cleared)).toBe(true);
    const rows = await pool.query(`SELECT revoked_at FROM operator_sessions WHERE operator_id = $1`, [id]);
    expect(rows.rows[0].revoked_at).not.toBeNull();
    await expectDead(app, cookie);
  });

  it('CLI revoke deactivates the account, revokes sessions and blocks new logins', async () => {
    const { app, cookie, id, email } = await operatorFixture();

    expect((await cli(['revoke', '--email', email])).code).toBe(0);

    await expectDead(app, cookie);
    expect(await activeSessionCount(id)).toBe(0);
    expect((await operatorLogin(app, email)).res.statusCode).toBe(401);
  });

  it('CLI reset-password revokes sessions, rejects the old password and accepts the new one', async () => {
    const { app, cookie, id, email } = await operatorFixture();

    const reset = await cli(['reset-password', '--email', email, '--password-stdin'], `${NEW_PASSWORD}\n`);
    expect(reset.code, reset.stderr).toBe(0);

    await expectDead(app, cookie);
    expect(await activeSessionCount(id)).toBe(0);
    expect((await operatorLogin(app, email, PASSWORD)).res.statusCode).toBe(401);
    const fresh = await operatorLogin(app, email, NEW_PASSWORD);
    expect(fresh.res.statusCode).toBe(200);
    expect((await call(app, 'GET', '/api/operator/me', undefined, { cookie: fresh.cookie })).statusCode).toBe(200);
  });

  it('a deactivated account is 401 even if its session row was never revoked', async () => {
    const { app, cookie, id } = await operatorFixture();
    await pool.query(`UPDATE operator_accounts SET is_active = false WHERE id = $1`, [id]);

    await expectDead(app, cookie);
    expect(await stateRow()).toMatchObject({ enabled: false, version: 1 });
  });

  it('a session revoked between the gate and the mutation cannot commit a change', async () => {
    const { app, cookie, id } = await operatorFixture();
    const holder: PoolClient = await pool.connect();
    try {
      // Hold the operator account lock so the PUT's transaction parks on it.
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM operator_accounts WHERE id = $1 FOR UPDATE`, [id]);
      const pending = put(app, cookie, { enabled: true, expectedVersion: 1 });
      const settled = await Promise.race([
        pending.then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 750)),
      ]);
      expect(settled, 'mutation must lock the operator account (contract section 3/6)').toBe('blocked');
      await holder.query(`UPDATE operator_sessions SET revoked_at = now() WHERE operator_id = $1`, [id]);
      await holder.query('COMMIT');

      const res = await pending;

      expect(res.statusCode).toBe(401);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await stateRow()).toMatchObject({ enabled: false, version: 1 });
    expect(await auditRows('MODULE_STATE_CHANGED')).toHaveLength(0);
  });

  it('an account deactivated between the gate and the mutation cannot commit a change', async () => {
    const { app, cookie, id } = await operatorFixture();
    const holder: PoolClient = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM operator_accounts WHERE id = $1 FOR UPDATE`, [id]);
      const pending = put(app, cookie, { enabled: true, expectedVersion: 1 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await holder.query(`UPDATE operator_accounts SET is_active = false WHERE id = $1`, [id]);
      await holder.query('COMMIT');

      expect((await pending).statusCode).toBe(401);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await stateRow()).toMatchObject({ enabled: false, version: 1 });
  });
});

// ---------------------------------------------------------------- OP5

describe.skipIf(!databaseUrl)('OP5 capability enforcement', { timeout: 60_000 }, () => {
  it('an operator without MODULE_MANAGEMENT gets 403 FORBIDDEN and nothing is written', async () => {
    const { app, cookie, id } = await operatorFixture();
    await pool.query(`DELETE FROM operator_account_capabilities WHERE operator_id = $1`, [id]);
    const events = await auditCount();

    const res = await put(app, cookie, { enabled: true, expectedVersion: 1 });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
    expect(await stateRow()).toMatchObject({ enabled: false, version: 1 });
    expect(await auditCount()).toBe(events);
    // Identity still resolves, with an empty capability list; listing needs the capability too.
    const me = await call(app, 'GET', '/api/operator/me', undefined, { cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().operator.capabilities).toEqual([]);
    const modules = await call(app, 'GET', '/api/operator/modules', undefined, { cookie });
    expect(modules.statusCode).toBe(403);
    expect(modules.json().code).toBe('FORBIDDEN');
  });

  it('a capability removed between the gate and the mutation cannot commit a change', async () => {
    const { app, cookie, id } = await operatorFixture();
    const holder: PoolClient = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM operator_accounts WHERE id = $1 FOR UPDATE`, [id]);
      const pending = put(app, cookie, { enabled: true, expectedVersion: 1 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await holder.query(`DELETE FROM operator_account_capabilities WHERE operator_id = $1`, [id]);
      await holder.query('COMMIT');

      expect((await pending).statusCode).toBe(403);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await stateRow()).toMatchObject({ enabled: false, version: 1 });
  });

  it('the module list shape for a capable operator', async () => {
    const { app, cookie } = await operatorFixture({ enabled: true });

    const res = await call(app, 'GET', '/api/operator/modules', undefined, { cookie });

    expect(res.statusCode).toBe(200);
    const { modules } = res.json();
    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatchObject({ key: 'OVERVIEW', enabled: true, version: 1, source: 'ENV_TAKEOVER' });
    expect(typeof modules[0].label).toBe('string');
    expect(typeof modules[0].updatedAt).toBe('string');
  });
});

// ---------------------------------------------------------------- OP6

describe.skipIf(!databaseUrl)('OP6 runtime effect without restart', { timeout: 60_000 }, () => {
  async function customerView(app: App, cookie: string) {
    const me = await call(app, 'GET', '/api/auth/me', undefined, { cookie });
    const overview = await call(app, 'GET', '/api/overview', undefined, { cookie });
    expect(me.statusCode).toBe(200);
    return { overviewDashboard: me.json().user.capabilities.overviewDashboard, overview };
  }

  it('toggle on and off is reflected immediately for an already-logged-in customer', async () => {
    const { app, cookie, id } = await operatorFixture({ enabled: false });
    const customerCookie = await customerLogin(app);

    const off = await customerView(app, customerCookie);
    expect(off.overviewDashboard).toBe(false);
    expect(off.overview.statusCode).toBe(404);
    expect(off.overview.json().code).toBe('NOT_FOUND');

    const on = await put(app, cookie, { enabled: true, expectedVersion: 1 });
    expect(on.statusCode).toBe(200);
    expect(on.json().module).toMatchObject({ key: 'OVERVIEW', enabled: true, version: 2, source: 'OPERATOR' });
    expect(await stateRow()).toMatchObject({ enabled: true, version: 2, source: 'OPERATOR', updated_by_operator_id: id });
    const onView = await customerView(app, customerCookie);
    expect(onView.overviewDashboard).toBe(true);
    expect(onView.overview.statusCode).toBe(200);

    const offAgain = await put(app, cookie, { enabled: false, expectedVersion: 2 });
    expect(offAgain.statusCode).toBe(200);
    expect(offAgain.json().module).toMatchObject({ enabled: false, version: 3 });
    const offView = await customerView(app, customerCookie);
    expect(offView.overviewDashboard).toBe(false);
    expect(offView.overview.statusCode).toBe(404);
  });

  it('a fresh customer login also reports the database state', async () => {
    const { app, cookie } = await operatorFixture({ enabled: false });
    expect((await put(app, cookie, { enabled: true, expectedVersion: 1 })).statusCode).toBe(200);

    const res = await call(app, 'POST', '/api/auth/login',
      { email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.capabilities.overviewDashboard).toBe(true);
  });

  it('the legacy env value is not a ceiling and not a fallback once the database holds the state', async () => {
    const email = `op-${randomUUID()}@example.com`;
    await grant(email);
    await seedState(false);
    // Env says ON, database says OFF: database wins.
    const envOnApp = await createApp({
      config: { ...baseConfig, capabilities: { ...baseConfig.capabilities, overviewDashboard: true } },
    });
    const customerCookie = await customerLogin(envOnApp);
    const off = await customerView(envOnApp, customerCookie);
    expect(off.overviewDashboard).toBe(false);
    expect(off.overview.statusCode).toBe(404);

    // Env says OFF, operator turns it ON: no ceiling.
    const envOffApp = await createApp();
    const cookie = (await operatorLogin(envOffApp, email)).cookie!;
    expect((await put(envOffApp, cookie, { enabled: true, expectedVersion: 1 })).statusCode).toBe(200);
    const on = await customerView(envOffApp, await customerLogin(envOffApp));
    expect(on.overviewDashboard).toBe(true);
    expect(on.overview.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- OP7

describe.skipIf(!databaseUrl)('OP7 optimistic versioning', { timeout: 60_000 }, () => {
  it('a stale version is 409 MODULE_VERSION_CONFLICT even when the value equals the stored one', async () => {
    const { app, cookie } = await operatorFixture({ enabled: false });
    expect((await put(app, cookie, { enabled: true, expectedVersion: 1 })).statusCode).toBe(200); // v2, on
    const events = await auditCount();

    const differing = await put(app, cookie, { enabled: false, expectedVersion: 1 });
    const sameValue = await put(app, cookie, { enabled: true, expectedVersion: 1 });
    const future = await put(app, cookie, { enabled: false, expectedVersion: 99 });

    for (const res of [differing, sameValue, future]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('MODULE_VERSION_CONFLICT');
    }
    expect(await stateRow()).toMatchObject({ enabled: true, version: 2 });
    expect(await auditCount()).toBe(events);
  });

  it('current version with the same value is 200 with no new audit event and no version bump', async () => {
    const { app, cookie } = await operatorFixture({ enabled: true });
    const events = await auditCount();
    const before = await pool.query(`SELECT updated_at FROM installation_module_state`);

    const res = await put(app, cookie, { enabled: true, expectedVersion: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.json().module).toMatchObject({ key: 'OVERVIEW', enabled: true, version: 1 });
    expect(await auditCount()).toBe(events);
    expect(await stateRow()).toMatchObject({ enabled: true, version: 1, source: 'ENV_TAKEOVER' });
    const after = await pool.query(`SELECT updated_at FROM installation_module_state`);
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);
  });

  it('a real change bumps the version and records exactly one MODULE_STATE_CHANGED event', async () => {
    const { app, cookie, id } = await operatorFixture({ enabled: false });
    const before = (await auditRows()).length;

    const res = await put(app, cookie, { enabled: true, expectedVersion: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.json().module.version).toBe(2);
    const events = (await auditRows()).slice(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'MODULE_STATE_CHANGED', actor_kind: 'OPERATOR', operator_id: id, module_key: 'OVERVIEW',
    });
    expect(events[0]!.old_value).not.toBeNull();
    expect(events[0]!.new_value).not.toBeNull();
    expect(JSON.stringify(events[0]!.old_value)).not.toEqual(JSON.stringify(events[0]!.new_value));
  });

  it('two concurrent writers with the same expected version: exactly one wins', async () => {
    const { app, cookie } = await operatorFixture({ enabled: false });

    const results = await Promise.all([
      put(app, cookie, { enabled: true, expectedVersion: 1 }),
      put(app, cookie, { enabled: true, expectedVersion: 1 }),
      put(app, cookie, { enabled: true, expectedVersion: 1 }),
    ]);

    const codes = results.map((r) => r.statusCode).sort();
    // The first applies the change; the others hit a stale version (409).
    expect(codes).toEqual([200, 409, 409]);
    expect(await stateRow()).toMatchObject({ enabled: true, version: 2 });
    expect(await auditRows('MODULE_STATE_CHANGED')).toHaveLength(1);
  });

  it.each([
    ['missing expectedVersion', { enabled: true }],
    ['missing enabled', { expectedVersion: 1 }],
    ['non-boolean enabled', { enabled: 'yes', expectedVersion: 1 }],
    ['non-integer expectedVersion', { enabled: true, expectedVersion: 1.5 }],
    ['string expectedVersion', { enabled: true, expectedVersion: '1' }],
    ['empty body', {}],
  ])('rejects %s with 400 VALIDATION_ERROR and writes nothing', async (_label, payload) => {
    const { app, cookie } = await operatorFixture({ enabled: false });
    const events = await auditCount();

    const res = await put(app, cookie, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await stateRow()).toMatchObject({ enabled: false, version: 1 });
    expect(await auditCount()).toBe(events);
  });
});

// ---------------------------------------------------------------- OP8

describe.skipIf(!databaseUrl)('OP8 state change and audit are one transaction', { timeout: 60_000 }, () => {
  async function installAuditFailure(eventType: string) {
    await pool.query(`
      CREATE OR REPLACE FUNCTION op_force_audit_failure() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced operator audit failure'; END;
      $$ LANGUAGE plpgsql`);
    await pool.query(`
      CREATE TRIGGER op_force_audit_failure BEFORE INSERT ON operator_audit_events
      FOR EACH ROW WHEN (NEW.event_type = '${eventType}')
      EXECUTE FUNCTION op_force_audit_failure()`);
  }

  it('a forced audit failure rolls the module state change back', async () => {
    const { app, cookie } = await operatorFixture({ enabled: false });
    const customerCookie = await customerLogin(app);
    await installAuditFailure('MODULE_STATE_CHANGED');

    const res = await put(app, cookie, { enabled: true, expectedVersion: 1 });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(await stateRow()).toMatchObject({ enabled: false, version: 1, source: 'ENV_TAKEOVER', updated_by_operator_id: null });
    expect(await auditRows('MODULE_STATE_CHANGED')).toHaveLength(0);
    expect((await call(app, 'GET', '/api/overview', undefined, { cookie: customerCookie })).statusCode).toBe(404);
  });

  it('a forced audit failure on login leaves no session behind', async () => {
    const email = `op-${randomUUID()}@example.com`;
    await grant(email);
    const app = await createApp();
    await installAuditFailure('OPERATOR_LOGIN_SUCCEEDED');

    const { res, cookie } = await operatorLogin(app, email);

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(cookie).toBeNull();
    expect((await pool.query(`SELECT count(*)::int AS n FROM operator_sessions`)).rows[0].n).toBe(0);
  });

  it('operator_audit_events rejects an OPERATOR event without an operator and a HOST_CLI event with one', async () => {
    const id = await grant(`op-${randomUUID()}@example.com`);
    // 23514 = check_violation: the refusal must come from a CHECK, not from an unrelated NOT NULL.
    await expect(pool.query(
      `INSERT INTO operator_audit_events (actor_kind, event_type, module_key, occurred_at)
       VALUES ('OPERATOR', 'MODULE_STATE_CHANGED', 'OVERVIEW', now())`,
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO operator_audit_events (actor_kind, operator_id, event_type, module_key, occurred_at)
       VALUES ('SYSTEM', $1, 'MODULE_STATE_CHANGED', 'OVERVIEW', now())`, [id],
    )).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------- OP9

describe.skipIf(!databaseUrl)('OP9 unknown module key', { timeout: 60_000 }, () => {
  it.each(['MESSAGING', 'NOPE', 'OVERVIEW2'])('PUT /modules/%s is 404 NOT_FOUND and writes nothing', async (key) => {
    const { app, cookie } = await operatorFixture({ enabled: false });
    const events = await auditCount();

    const res = await put(app, cookie, { enabled: true, expectedVersion: 1 }, key);

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    expect(await stateRow()).toMatchObject({ enabled: false, version: 1 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM installation_module_state`)).rows[0].n).toBe(1);
    expect(await auditCount()).toBe(events);
  });

  it('the database refuses a module key outside the registry', async () => {
    await expect(pool.query(
      `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
       VALUES ('MESSAGING', true, 1, 'ENV_TAKEOVER', now())`,
    )).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------- OP10 / OP11 / OP12

describe.skipIf(!databaseUrl)('OP10 takeover', { timeout: 60_000 }, () => {
  it('concurrent startups with a missing row create exactly one row and one audit event', async () => {
    const pools = [schemaPool(), schemaPool()];
    for (let round = 0; round < 5; round += 1) {
      await pool.query(`TRUNCATE operator_audit_events, installation_module_state CASCADE`);

      await Promise.all([0, 1, 2, 3, 4, 5].map((i) =>
        takeOverInstallationModules(pools[i % 2]!, { overviewDashboard: true })));

      expect((await pool.query(`SELECT count(*)::int AS n FROM installation_module_state`)).rows[0].n).toBe(1);
      expect(await stateRow()).toMatchObject({ enabled: true, source: 'ENV_TAKEOVER' });
      const events = await auditRows('MODULE_STATE_TAKEN_OVER');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor_kind: 'SYSTEM', operator_id: null, module_key: 'OVERVIEW' });
      expect(await auditCount()).toBe(1);
    }
  });

  it('a restart does not duplicate, and later env changes have no effect', async () => {
    await takeOverInstallationModules(pool, { overviewDashboard: true });
    const first = await stateRow();

    await takeOverInstallationModules(pool, { overviewDashboard: true });
    await takeOverInstallationModules(pool, { overviewDashboard: false }); // env flipped after takeover

    expect(await stateRow()).toEqual(first);
    expect(first!.enabled).toBe(true);
    expect(await auditRows('MODULE_STATE_TAKEN_OVER')).toHaveLength(1);
    expect(await auditCount()).toBe(1);
  });

  it('an operator change survives restarts regardless of the env value', async () => {
    const email = `op-${randomUUID()}@example.com`;
    await grant(email);
    await takeOverInstallationModules(pool, { overviewDashboard: false });
    const app = await createApp();
    const { cookie } = await operatorLogin(app, email);
    expect((await put(app, cookie, { enabled: true, expectedVersion: 1 })).statusCode).toBe(200);

    await takeOverInstallationModules(pool, { overviewDashboard: false });

    expect(await stateRow()).toMatchObject({ enabled: true, version: 2, source: 'OPERATOR' });
    expect(await auditRows('MODULE_STATE_TAKEN_OVER')).toHaveLength(1);
  });
});

describe.skipIf(!databaseUrl)('OP11 takeover defaults on an empty database', { timeout: 60_000 }, () => {
  it.each([
    ['env unset', false],
    ['env true', true],
  ])('%s -> enabled=%s', async (_label, legacy) => {
    await takeOverInstallationModules(pool, { overviewDashboard: legacy });

    expect(await stateRow()).toMatchObject({ enabled: legacy, source: 'ENV_TAKEOVER' });
    expect(await auditRows('MODULE_STATE_TAKEN_OVER')).toHaveLength(1);
  });

  it('takeover uses the injected clock for the audit time', async () => {
    const fixed = new Date('2026-11-26T09:30:00.000Z');

    await takeOverInstallationModules(pool, { overviewDashboard: true }, () => fixed);

    const [event] = await auditRows('MODULE_STATE_TAKEN_OVER');
    expect(event!.occurred_at.toISOString()).toBe(fixed.toISOString());
  });
});

describe.skipIf(!databaseUrl)('OP12 fail-closed state reads', { timeout: 60_000 }, () => {
  it('a missing row with an existing takeover event fails startup closed and writes nothing', async () => {
    await takeOverInstallationModules(pool, { overviewDashboard: true });
    await pool.query(`DELETE FROM installation_module_state`);
    const events = await auditCount();

    await expect(takeOverInstallationModules(pool, { overviewDashboard: true })).rejects.toThrow();
    await expect(takeOverInstallationModules(pool, { overviewDashboard: false })).rejects.toThrow();

    expect(await stateRow()).toBeNull();
    expect(await auditCount()).toBe(events);
  });

  it('a state read failure answers Overview 503 and /api/auth/me overviewDashboard:false, and logs it', async () => {
    const email = `op-${randomUUID()}@example.com`;
    await grant(email);
    await seedState(true);
    const logLines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) { logLines.push(chunk.toString()); callback(); },
    });
    const failingReader: ModuleStateReader = {
      read: async () => { throw new Error('module state store unavailable'); },
    };
    const app = await createApp({
      config: { ...baseConfig, logLevel: 'error' }, moduleStateReader: failingReader, logDestination: destination,
    });
    const customerCookie = await customerLogin(app);

    const overview = await call(app, 'GET', '/api/overview', undefined, { cookie: customerCookie });
    expect(overview.statusCode).toBe(503);
    expect(overview.json().code).toBe('MODULE_STATE_UNAVAILABLE');
    const me = await call(app, 'GET', '/api/auth/me', undefined, { cookie: customerCookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.capabilities.overviewDashboard).toBe(false);
    const login = await call(app, 'POST', '/api/auth/login', { email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.capabilities.overviewDashboard).toBe(false);

    const session = await operatorLogin(app, email);
    expect(session.res.statusCode).toBe(200);
    const modules = await call(app, 'GET', '/api/operator/modules', undefined, { cookie: session.cookie });
    expect(modules.statusCode).toBe(503);
    expect(modules.json().code).toBe('MODULE_STATE_UNAVAILABLE');

    expect(logLines.join('')).toContain('module state store unavailable');
  });

  it('a missing state row at runtime behaves the same: 503 / false, never an env fallback', async () => {
    const email = `op-${randomUUID()}@example.com`;
    await grant(email);
    const app = await createApp({
      config: { ...baseConfig, capabilities: { ...baseConfig.capabilities, overviewDashboard: true } },
    });
    const customerCookie = await customerLogin(app);
    const { cookie } = await operatorLogin(app, email);
    // No installation_module_state row exists.

    const overview = await call(app, 'GET', '/api/overview', undefined, { cookie: customerCookie });
    expect(overview.statusCode).toBe(503);
    expect(overview.json().code).toBe('MODULE_STATE_UNAVAILABLE');
    const me = await call(app, 'GET', '/api/auth/me', undefined, { cookie: customerCookie });
    expect(me.json().user.capabilities.overviewDashboard).toBe(false);
    const modules = await call(app, 'GET', '/api/operator/modules', undefined, { cookie });
    expect(modules.statusCode).toBe(503);
    const write = await put(app, cookie, { enabled: true, expectedVersion: 1 });
    expect(write.statusCode).toBe(503);
    expect(write.json().code).toBe('MODULE_STATE_UNAVAILABLE');
    expect(await stateRow()).toBeNull();
    expect(await auditRows('MODULE_STATE_CHANGED')).toHaveLength(0);
  });

  it('once the row exists the same app recovers without restart', async () => {
    const app = await createApp();
    const customerCookie = await customerLogin(app);
    expect((await call(app, 'GET', '/api/overview', undefined, { cookie: customerCookie })).statusCode).toBe(503);

    await seedState(true);

    expect((await call(app, 'GET', '/api/overview', undefined, { cookie: customerCookie })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- OP13

describe.skipIf(!databaseUrl)('OP13 restore reset', { timeout: 60_000 }, () => {
  async function restoreReset(now: Date) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await resetOperatorAccessAfterRestore(client, now);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('revokes every session and deactivates every account; old cookies and passwords are rejected until re-granted', async () => {
    const emailA = `a-${randomUUID()}@example.com`;
    const emailB = `b-${randomUUID()}@example.com`;
    const idA = await grant(emailA, 'Operator A');
    const idB = await grant(emailB, 'Operator B');
    await seedState(true);
    const app = await createApp();
    const a1 = await operatorLogin(app, emailA);
    const a2 = await operatorLogin(app, emailA);
    const b1 = await operatorLogin(app, emailB);
    const customerCookie = await customerLogin(app);
    const now = new Date(Date.now() + 5_000); // never earlier than the sessions' created_at

    const result = await restoreReset(now);

    expect(result).toEqual({ revokedSessions: 3, deactivatedAccounts: 2 });
    for (const cookie of [a1.cookie!, a2.cookie!, b1.cookie!]) {
      expectUnauthenticated(await call(app, 'GET', '/api/operator/me', undefined, { cookie }));
      expectUnauthenticated(await call(app, 'GET', '/api/operator/modules', undefined, { cookie }));
    }
    const accounts = await pool.query(`SELECT id, is_active FROM operator_accounts`);
    expect(accounts.rows.map((r) => r.is_active)).toEqual([false, false]);
    expect(await activeSessionCount(idA) + await activeSessionCount(idB)).toBe(0);
    const revokedAt = await pool.query(`SELECT revoked_at FROM operator_sessions`);
    for (const row of revokedAt.rows) expect(row.revoked_at.toISOString()).toBe(now.toISOString());
    // Old passwords no longer authenticate (accounts are inactive until re-granted).
    expect((await operatorLogin(app, emailA, PASSWORD)).res.statusCode).toBe(401);
    expect((await operatorLogin(app, emailB, PASSWORD)).res.statusCode).toBe(401);
    // Audit: system-actor reset events.
    const events = await auditRows('OPERATOR_ACCESS_RESET_BY_RESTORE');
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const event of events) expect(event).toMatchObject({ actor_kind: 'SYSTEM', operator_id: null });
    // Customer sessions and module state are not touched by the operator reset.
    expect((await call(app, 'GET', '/api/auth/me', undefined, { cookie: customerCookie })).statusCode).toBe(200);
    expect(await stateRow()).toMatchObject({ enabled: true, version: 1 });
  });

  it('is idempotent: a second run finds nothing left to revoke or deactivate', async () => {
    await grant(`a-${randomUUID()}@example.com`);
    const app = await createApp();
    await seedState(false);
    await operatorLogin(app, (await pool.query(`SELECT email FROM operator_accounts`)).rows[0].email);

    expect(await restoreReset(new Date())).toEqual({ revokedSessions: 1, deactivatedAccounts: 1 });
    expect(await restoreReset(new Date())).toEqual({ revokedSessions: 0, deactivatedAccounts: 0 });
  });

  it('rolls back with the caller transaction', async () => {
    const email = `a-${randomUUID()}@example.com`;
    const id = await grant(email);
    const app = await createApp();
    await seedState(false);
    await operatorLogin(app, email);
    const events = await auditCount();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await resetOperatorAccessAfterRestore(client, new Date());
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect((await pool.query(`SELECT is_active FROM operator_accounts WHERE id = $1`, [id])).rows[0].is_active).toBe(true);
    expect(await activeSessionCount(id)).toBe(1);
    expect(await auditCount()).toBe(events);
  });

  it('the host re-grants an account with a new password after the reset', async () => {
    const email = `a-${randomUUID()}@example.com`;
    const id = await grant(email);
    await seedState(false);
    const app = await createApp();
    await restoreReset(new Date());
    expect((await operatorLogin(app, email, PASSWORD)).res.statusCode).toBe(401);

    const regrant = await cli(['grant', '--email', email, '--name', 'Operator One', '--password-stdin'], `${NEW_PASSWORD}\n`);
    expect(regrant.code, regrant.stderr).toBe(0);

    expect(await operatorId(email)).toBe(id); // same identity, reactivated
    expect((await operatorLogin(app, email, PASSWORD)).res.statusCode).toBe(401); // old password stays dead
    const fresh = await operatorLogin(app, email, NEW_PASSWORD);
    expect(fresh.res.statusCode).toBe(200);
    expect(fresh.res.json().operator.capabilities).toEqual(['MODULE_MANAGEMENT']);
  });

  it('the CLI reset-after-restore command applies the same reset', async () => {
    const email = `a-${randomUUID()}@example.com`;
    await grant(email);
    await seedState(false);
    const app = await createApp();
    const { cookie } = await operatorLogin(app, email);

    const result = await cli(['reset-after-restore']);

    expect(result.code, result.stderr).toBe(0);
    expectUnauthenticated(await call(app, 'GET', '/api/operator/me', undefined, { cookie }));
    expect((await operatorLogin(app, email)).res.statusCode).toBe(401);
    expect((await auditRows('OPERATOR_ACCESS_RESET_BY_RESTORE')).length).toBeGreaterThanOrEqual(1);
  });
});
