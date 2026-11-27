import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R0 — shared installation module registry widening (independent acceptance
 * test, written from the fixed contract before the implementation exists).
 *
 * Proves, against a real PostgreSQL 17 schema:
 *   R0-1 migration 075 widens the module-key / source / audit constraints and
 *        keeps the contract constraint names, without DML.
 *   R0-2 the one-time OVERVIEW env takeover is unchanged (OP10/OP11).
 *   R0-3 a well-formed but non-registry state row stops startup and writes
 *        nothing.
 *   R0-4 a missing registry row with a prior module event fails closed, for
 *        both TAKEN_OVER and INITIALIZED events.
 *   R0-5 legacyModuleValues maps every legacy registry module from capabilities.
 *   R0-6 staticModuleStateReader keeps the boolean form and gains the map form.
 *   R0-7 operator module views expose description / whenDisabled / preserved.
 *   R0-8 /api/auth/me reads overviewDashboard from the database per request and
 *        leaves the other capabilities at their config values.
 *
 * The file imports the fixed R0 names directly, so it is expected to fail at
 * collection against the pre-R0 tree ("No export named ..."): that is the RED
 * state this test is meant to produce.
 */
import { buildApp } from '../src/app.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations, type MigrationLogger } from '../src/db/migrate-runner.js';
import { runOperatorCli } from '../src/db/operator-cli.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';
import { withModuleCapabilities } from '../src/modules/capabilities/service.js';
import type { AuthenticatedCapabilities } from '../src/modules/capabilities/types.js';
import {
  findInstallationModule,
  INSTALLATION_MODULES,
  MODULE_KEY_PATTERN,
} from '../src/modules/installation-modules/registry.js';
import {
  MODULE_STATE_SOURCES,
  readModuleCapabilities,
  staticModuleStateReader,
  type ModuleStateReader,
} from '../src/modules/installation-modules/state.js';
import {
  legacyModuleValues,
  takeOverInstallationModules,
} from '../src/modules/installation-modules/takeover.js';
import type { OverviewReadModel } from '../src/modules/overview/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const MIGRATION_074 = '074_installation_operator_and_module_state';
const MIGRATION_075 = '075_installation_module_registry_widening';

const ORIGIN = 'http://127.0.0.1:5173';
const OPERATOR_COOKIE = 'servora_operator_session';
const CUSTOMER_COOKIE = 'servora_session';
const PASSWORD = 'Operator-Pass#2026';
const CUSTOMER_PASSWORD = 'Customer-Pass#2026';
const CUSTOMER_EMAIL = 'admin@r0-registry.test';

const silentLogger: MigrationLogger = { info: () => undefined, error: () => undefined };

const baseConfig = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 0,
  databaseUrl: databaseUrl ?? 'postgresql://unused-r0-registry',
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

type TestConfig = Omit<typeof baseConfig, 'nodeEnv'> & { nodeEnv: 'test' | 'production' };

/** The contract-fixed OVERVIEW descriptor (registry and operator API copy). */
const OVERVIEW_DESCRIPTOR = {
  key: 'OVERVIEW',
  label: 'Genel Bakış',
  description:
    'Dönem özeti, onay kuyruğu, yaklaşan ve tamamlanan işleri tek ekranda gösteren başlangıç sayfası.',
  capability: 'overviewDashboard',
  legacyEnvKey: 'OVERVIEW_DASHBOARD_ENABLED',
  whenDisabled: [
    'Genel Bakış menüsü ve sayfası',
    "Genel Bakış'ın açılış sayfası olarak kullanılması",
  ],
  preserved: ['İşler, onaylar ve raporlar', 'Geçmiş kayıtlar ve audit kayıtları'],
} as const;

const MESSAGING_DESCRIPTOR = {
  key: 'MESSAGING',
  label: 'Mesajlaşma',
  description: 'İş ve konu merkezli kurum içi iletişim.',
  capability: 'messaging',
  legacyEnvKey: 'MESSAGING_ENABLED',
  whenDisabled: [
    'Mesajlar menüsü ve sayfası',
    'Mesajlaşma API erişimi',
    'İş detayından mesajlaşma',
    'Mesaj bildirimleri ve mesaj Web Push teslimatı',
    'Okunmamış mesaj sayacı',
  ],
  preserved: [
    'Konuşmalar ve mesaj geçmişi',
    'Arşiv ve audit kayıtları',
    'Personel devir ve offboarding işlemleri',
  ],
} as const;

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
  schema = `r0_registry_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  pool = schemaPool();
  await runMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    store: new PostgresMigrationStore(pool),
    logger: silentLogger,
  });
  customerOrganizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [`R0 ${randomUUID()}`],
  )).rows[0]!.id;
  await pool.query(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'Customer Admin', $2, $3, 'ADMIN')`,
    [customerOrganizationId, CUSTOMER_EMAIL, await hashPassword(CUSTOMER_PASSWORD)],
  );
}, 120_000);

afterAll(async () => {
  if (!databaseUrl) return;
  await Promise.all(extraPools.splice(0).map((created) => created.end()));
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
});

beforeEach(async () => {
  if (!databaseUrl) return;
  await pool.query(
    `TRUNCATE operator_audit_events, operator_sessions, operator_account_capabilities,
       installation_module_state, operator_accounts RESTART IDENTITY CASCADE`,
  );
});

const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function createApp(options: {
  config?: TestConfig;
  moduleStateReader?: ModuleStateReader;
} = {}): Promise<App> {
  const app = await buildApp((options.config ?? baseConfig) as Parameters<typeof buildApp>[0], {
    pool,
    authRepository: new PostgresAuthRepository(pool),
    overviewRepository: stubOverview,
    ...(options.moduleStateReader ? { moduleStateReader: options.moduleStateReader } : {}),
  });
  apps.push(app);
  return app;
}

// ---------------------------------------------------------------- helpers

let ipCounter = 0;
/** Unique client address per call; the test config trusts the loopback proxy. */
function nextIp(): string {
  ipCounter += 1;
  return `10.2.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
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
  return setCookies(res).find((cookie) => cookie.startsWith(`${name}=`)) ?? null;
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

type StateRow = {
  module_key: string;
  enabled: boolean;
  version: number;
  source: string;
  updated_at: Date;
  updated_by_operator_id: string | null;
};

async function stateRow(key = 'OVERVIEW'): Promise<StateRow | null> {
  const result = await pool.query<StateRow>(
    `SELECT module_key, enabled, version, source, updated_at, updated_by_operator_id
       FROM installation_module_state WHERE module_key = $1`,
    [key],
  );
  return result.rows[0] ?? null;
}

async function stateRows(): Promise<StateRow[]> {
  const result = await pool.query<StateRow>(
    `SELECT module_key, enabled, version, source, updated_at, updated_by_operator_id
       FROM installation_module_state ORDER BY module_key`,
  );
  return result.rows;
}

async function seedState(
  enabled: boolean,
  options: { key?: string; source?: 'ENV_TAKEOVER' | 'FRESH_INSTALL'; version?: number } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
     VALUES ($1, $2, $3, $4, now())`,
    [options.key ?? 'OVERVIEW', enabled, options.version ?? 1, options.source ?? 'ENV_TAKEOVER'],
  );
}

/** Active operator with a session, an app, and seeded module states. */
async function operatorFixture(
  options: { enabled?: boolean; source?: 'ENV_TAKEOVER' | 'FRESH_INSTALL'; email?: string } = {},
) {
  const email = options.email ?? `op-${randomUUID()}@example.com`;
  const id = await grant(email);
  await seedState(options.enabled ?? false, { source: options.source });
  await seedState(false, { key: 'MESSAGING', source: options.source });
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

async function expectCheckViolation(sql: string, values: unknown[] = []): Promise<void> {
  await expect(pool.query(sql, values)).rejects.toMatchObject({ code: '23514' });
}

// ---------------------------------------------------------------- R0-1

describe.skipIf(!databaseUrl)('R0-1 migration 075 widens the registry constraints', { timeout: 120_000 }, () => {
  it('applies as the new head and keeps the contract constraint and index names', async () => {
    const head = (await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
    )).rows[0]!.version;
    expect(head).toBe(MIGRATION_075);

    const constraints = (await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid IN ('installation_module_state'::regclass, 'operator_audit_events'::regclass)
        ORDER BY conname`,
    )).rows.map((row) => row.conname);
    expect(constraints).toEqual(expect.arrayContaining([
      'installation_module_state_key_check',
      'installation_module_state_source_check',
      'operator_audit_events_event_type_check',
      'operator_audit_events_module_key_check',
      'operator_audit_events_target_check',
      'operator_audit_events_module_value_check',
    ]));

    const indexes = (await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'operator_audit_events'`,
    )).rows.map((row) => row.indexname);
    expect(indexes).toContain('operator_audit_events_module_idx');
  });

  it.each(['overview', 'X', '1ABC', 'A'.repeat(33)])(
    'rejects the malformed module key %s in installation_module_state with 23514',
    async (key) => {
      await expectCheckViolation(
        `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
         VALUES ($1, true, 1, 'ENV_TAKEOVER', now())`,
        [key],
      );
    },
  );

  it.each(['overview', 'X', '1ABC', 'A'.repeat(33)])(
    'rejects the malformed module key %s in operator_audit_events with 23514',
    async (key) => {
      await expectCheckViolation(
        `INSERT INTO operator_audit_events (actor_kind, event_type, module_key, new_value, occurred_at)
         VALUES ('SYSTEM', 'MODULE_STATE_TAKEN_OVER', $1, $2::jsonb, now())`,
        [key, JSON.stringify({ enabled: true, source: 'ENV_TAKEOVER' })],
      );
    },
  );

  it('accepts a well-formed non-registry key at the database layer', async () => {
    await pool.query(
      `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
       VALUES ('MESSAGING', true, 1, 'ENV_TAKEOVER', now())`,
    );
    await pool.query(
      `INSERT INTO operator_audit_events (actor_kind, event_type, module_key, new_value, occurred_at)
       VALUES ('SYSTEM', 'MODULE_STATE_TAKEN_OVER', 'MESSAGING', $1::jsonb, now())`,
      [JSON.stringify({ enabled: true, source: 'ENV_TAKEOVER' })],
    );

    expect(await stateRow('MESSAGING')).toMatchObject({
      module_key: 'MESSAGING', enabled: true, version: 1, source: 'ENV_TAKEOVER',
    });
    const events = await auditRows('MODULE_STATE_TAKEN_OVER');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_kind: 'SYSTEM', module_key: 'MESSAGING' });

    // Upper boundary of the pattern is 32 characters and is accepted too.
    const maxLengthKey = `A${'B'.repeat(31)}`;
    expect(maxLengthKey).toHaveLength(32);
    await expect(pool.query(
      `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
       VALUES ($1, false, 1, 'FRESH_INSTALL', now())`,
      [maxLengthKey],
    )).resolves.toBeDefined();
  });

  it("accepts source 'FRESH_INSTALL' and still rejects an unknown source", async () => {
    await seedState(false, { key: 'MESSAGING', source: 'FRESH_INSTALL' });
    expect(await stateRow('MESSAGING')).toMatchObject({
      enabled: false, version: 1, source: 'FRESH_INSTALL', updated_by_operator_id: null,
    });

    await expectCheckViolation(
      `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
       VALUES ('CALENDAR', false, 1, 'IMPORTED', now())`,
    );
  });

  it('accepts MODULE_STATE_INITIALIZED only with module_key, no target operator, boolean enabled and NULL old_value', async () => {
    // Valid INITIALIZED event: enabled is a JSON boolean and old_value is NULL.
    await expect(pool.query(
      `INSERT INTO operator_audit_events (actor_kind, event_type, module_key, new_value, occurred_at)
       VALUES ('SYSTEM', 'MODULE_STATE_INITIALIZED', 'MESSAGING', $1::jsonb, now())`,
      [JSON.stringify({ enabled: false, source: 'FRESH_INSTALL' })],
    )).resolves.toBeDefined();

    // module_key is required for a module event.
    await expectCheckViolation(
      `INSERT INTO operator_audit_events (actor_kind, event_type, new_value, occurred_at)
       VALUES ('SYSTEM', 'MODULE_STATE_INITIALIZED', $1::jsonb, now())`,
      [JSON.stringify({ enabled: false, source: 'FRESH_INSTALL' })],
    );

    // target_operator_id must be NULL for a module event.
    const target = await pool.query<{ id: string }>(
      `INSERT INTO operator_accounts (email, name, password_hash)
       VALUES ($1, 'Target Operator', 'x') RETURNING id`,
      [`target-${randomUUID()}@example.com`],
    );
    await expectCheckViolation(
      `INSERT INTO operator_audit_events
         (actor_kind, event_type, target_operator_id, module_key, new_value, occurred_at)
       VALUES ('SYSTEM', 'MODULE_STATE_INITIALIZED', $1, 'MESSAGING', $2::jsonb, now())`,
      [target.rows[0]!.id, JSON.stringify({ enabled: false, source: 'FRESH_INSTALL' })],
    );

    // new_value.enabled must be a JSON boolean. (A missing key would evaluate
    // the natural TAKEN_OVER-shaped CHECK to NULL, which PostgreSQL accepts;
    // the contract's violation is a present non-boolean value.)
    await expectCheckViolation(
      `INSERT INTO operator_audit_events (actor_kind, event_type, module_key, new_value, occurred_at)
       VALUES ('SYSTEM', 'MODULE_STATE_INITIALIZED', 'MESSAGING', $1::jsonb, now())`,
      [JSON.stringify({ enabled: 'yes', source: 'FRESH_INSTALL' })],
    );

    // old_value must be NULL, exactly like MODULE_STATE_TAKEN_OVER.
    await expectCheckViolation(
      `INSERT INTO operator_audit_events
         (actor_kind, event_type, module_key, old_value, new_value, occurred_at)
       VALUES ('SYSTEM', 'MODULE_STATE_INITIALIZED', 'MESSAGING', $1::jsonb, $2::jsonb, now())`,
      [JSON.stringify({ enabled: false }), JSON.stringify({ enabled: false, source: 'FRESH_INSTALL' })],
    );
  });

  it('upgrades a 074 database to 075 without rewriting existing module state', async () => {
    const upgradeSchema = `r0_upgrade_${randomUUID().replaceAll('-', '')}`;
    const legacyDirectory = await mkdtemp(path.join(tmpdir(), 'r0-074-'));
    let upgradePool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${upgradeSchema}`);
      upgradePool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${upgradeSchema},public`,
      });
      for (const name of (await readdir(MIGRATIONS_DIRECTORY))
        .filter((entry) => entry.endsWith('.sql') && entry < '075_')) {
        await copyFile(path.join(MIGRATIONS_DIRECTORY, name), path.join(legacyDirectory, name));
      }
      const store = new PostgresMigrationStore(upgradePool);
      const before = await runMigrations({
        migrationsDirectory: legacyDirectory, store, logger: silentLogger,
      });
      expect(before.appliedVersions.at(-1)).toBe(MIGRATION_074);

      await upgradePool.query(
        `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
         VALUES ('OVERVIEW', true, 1, 'ENV_TAKEOVER', now())`,
      );
      await upgradePool.query(
        `INSERT INTO operator_audit_events (actor_kind, event_type, module_key, new_value, occurred_at)
         VALUES ('SYSTEM', 'MODULE_STATE_TAKEN_OVER', 'OVERVIEW', $1::jsonb, now())`,
        [JSON.stringify({ enabled: true, source: 'ENV_TAKEOVER' })],
      );
      // 074 hard-locks the key; this is the pre-upgrade starting point.
      await expect(upgradePool.query(
        `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
         VALUES ('MESSAGING', true, 1, 'ENV_TAKEOVER', now())`,
      )).rejects.toMatchObject({ code: '23514' });

      const upgrade = await runMigrations({
        migrationsDirectory: MIGRATIONS_DIRECTORY, store, logger: silentLogger,
      });
      expect(upgrade.appliedVersions).toEqual([MIGRATION_075]);
      expect((await upgradePool.query<{ version: string }>(
        `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
      )).rows[0]!.version).toBe(MIGRATION_075);

      // No DML: the existing row and audit event are untouched.
      const overview = (await upgradePool.query(
        `SELECT module_key, enabled, version, source FROM installation_module_state
          WHERE module_key = 'OVERVIEW'`,
      )).rows[0];
      expect(overview).toMatchObject({ enabled: true, version: 1, source: 'ENV_TAKEOVER' });
      expect(Number((await upgradePool.query(
        `SELECT count(*)::int AS n FROM operator_audit_events`,
      )).rows[0].n)).toBe(1);

      // The widened constraints are active after the upgrade.
      await expect(upgradePool.query(
        `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
         VALUES ('MESSAGING', true, 1, 'ENV_TAKEOVER', now())`,
      )).resolves.toBeDefined();
      await expect(upgradePool.query(
        `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
         VALUES ('overview', true, 1, 'ENV_TAKEOVER', now())`,
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await upgradePool?.end().catch(() => undefined);
      await rm(legacyDirectory, { recursive: true, force: true });
      await adminPool.query(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE`);
    }
  });
});

// ---------------------------------------------------------------- R0-2

describe.skipIf(!databaseUrl)('R0-2 takeover still takes over the OVERVIEW env value', { timeout: 60_000 }, () => {
  it('creates one row and one TAKEN_OVER event and is idempotent across restarts', async () => {
    const fixed = new Date('2026-11-26T09:30:00.000Z');

    await takeOverInstallationModules(pool, { OVERVIEW: true, MESSAGING: false }, () => fixed);

    const first = await stateRow();
    expect(first).toMatchObject({
      module_key: 'OVERVIEW',
      enabled: true,
      version: 1,
      source: 'ENV_TAKEOVER',
      updated_by_operator_id: null,
    });
    const events = await auditRows('MODULE_STATE_TAKEN_OVER');
    expect(events).toHaveLength(2);
    const overviewEvent = events.find((event) => event.module_key === 'OVERVIEW')!;
    expect(overviewEvent).toMatchObject({
      actor_kind: 'SYSTEM',
      operator_id: null,
      target_operator_id: null,
      module_key: 'OVERVIEW',
      old_value: null,
    });
    expect(overviewEvent.new_value).toEqual({ enabled: true, source: 'ENV_TAKEOVER' });
    expect(overviewEvent.occurred_at.toISOString()).toBe(fixed.toISOString());

    // Restart twice; the env value changed after takeover has no effect.
    await takeOverInstallationModules(pool, { OVERVIEW: false, MESSAGING: true });
    await takeOverInstallationModules(pool, { OVERVIEW: true, MESSAGING: false });

    expect(await stateRow()).toEqual(first);
    expect(await auditRows('MODULE_STATE_TAKEN_OVER')).toHaveLength(2);
    expect(await auditCount()).toBe(2);
  });

  it('fresh install with the env value unset takes over disabled (OP11)', async () => {
    await takeOverInstallationModules(pool, { OVERVIEW: false, MESSAGING: false });

    expect(await stateRow()).toMatchObject({
      enabled: false, version: 1, source: 'ENV_TAKEOVER',
    });
    const events = await auditRows('MODULE_STATE_TAKEN_OVER');
    expect(events).toHaveLength(2);
    expect(events[0]!.new_value).toEqual({ enabled: false, source: 'ENV_TAKEOVER' });
    expect(await auditCount()).toBe(2);
  });

  it('rejects an incomplete legacy map for a legacy registry module and writes nothing', async () => {
    // A legacy registry module must have an explicit boolean; `{}` is a
    // programming error, not "env unset", and must stop startup.
    await expect(takeOverInstallationModules(pool, {})).rejects.toThrow();

    expect(await stateRow()).toBeNull();
    expect(await auditCount()).toBe(0);
  });

  it('concurrent startups create exactly one row and one event (OP10)', async () => {
    const pools = [schemaPool(), schemaPool()];
    for (let round = 0; round < 3; round += 1) {
      await pool.query(`TRUNCATE operator_audit_events, installation_module_state CASCADE`);

      await Promise.all([0, 1, 2, 3, 4, 5].map((index) =>
        takeOverInstallationModules(pools[index % 2]!, { OVERVIEW: true, MESSAGING: false })));

      expect((await pool.query(
        `SELECT count(*)::int AS n FROM installation_module_state`,
      )).rows[0].n).toBe(2);
      expect(await stateRow()).toMatchObject({ enabled: true, source: 'ENV_TAKEOVER' });
      expect(await auditRows('MODULE_STATE_TAKEN_OVER')).toHaveLength(2);
      expect(await auditCount()).toBe(2);
    }
  });
});

// ---------------------------------------------------------------- R0-3

describe.skipIf(!databaseUrl)('R0-3 takeover rejects installation state outside the registry', { timeout: 60_000 }, () => {
  it('a well-formed non-registry row stops startup and writes nothing', async () => {
    await seedState(true, { key: 'CALENDAR', source: 'FRESH_INSTALL' });
    const before = await stateRows();
    const eventsBefore = await auditCount();

    const error = await takeOverInstallationModules(pool, { OVERVIEW: true, MESSAGING: false })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('outside the registry');
    expect((error as Error).message).toContain('CALENDAR');
    expect((error as Error).message).toContain('controlled recovery required');

    expect(await stateRows()).toEqual(before);
    expect(await stateRow('OVERVIEW')).toBeNull();
    expect(await auditCount()).toBe(eventsBefore);
  });

  it('names every offending key and never inserts the registry rows', async () => {
    await seedState(true, { key: 'BACKUP', source: 'FRESH_INSTALL' });
    await seedState(false, { key: 'CALENDAR', source: 'FRESH_INSTALL' });

    const error = await takeOverInstallationModules(pool, { OVERVIEW: true, MESSAGING: false })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('BACKUP');
    expect((error as Error).message).toContain('CALENDAR');
    expect(await stateRow('OVERVIEW')).toBeNull();
    expect(await auditCount()).toBe(0);
  });
});

// ---------------------------------------------------------------- R0-4

describe.skipIf(!databaseUrl)('R0-4 takeover fails closed when a module event exists without its row', { timeout: 60_000 }, () => {
  it('a prior TAKEN_OVER event for a missing registry row fails startup and writes nothing (OP12)', async () => {
    await takeOverInstallationModules(pool, { OVERVIEW: true, MESSAGING: false });
    await pool.query(`DELETE FROM installation_module_state`);
    const events = await auditCount();

    await expect(takeOverInstallationModules(pool, { OVERVIEW: true, MESSAGING: false }))
      .rejects.toThrow(/controlled recovery required/);
    await expect(takeOverInstallationModules(pool, { OVERVIEW: false, MESSAGING: false }))
      .rejects.toThrow(/controlled recovery required/);

    expect(await stateRow()).toBeNull();
    expect(await auditCount()).toBe(events);
  });

  it('a prior MODULE_STATE_INITIALIZED event for a missing registry row also fails closed', async () => {
    // The current registry has no module with legacyEnvKey === null, and the
    // fixed takeover signature has no descriptor seam, so this branch is
    // exercised by seeding the INITIALIZED event the widened schema allows.
    await pool.query(
      `INSERT INTO operator_audit_events (actor_kind, event_type, module_key, new_value, occurred_at)
       VALUES ('SYSTEM', 'MODULE_STATE_INITIALIZED', 'OVERVIEW', $1::jsonb, now())`,
      [JSON.stringify({ enabled: false, source: 'FRESH_INSTALL' })],
    );
    const events = await auditCount();

    const error = await takeOverInstallationModules(pool, { OVERVIEW: true, MESSAGING: false })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('OVERVIEW');
    expect((error as Error).message).toContain('controlled recovery required');
    expect(await stateRow()).toBeNull();
    expect(await auditCount()).toBe(events);
  });
});

// ---------------------------------------------------------------- R0-5

describe.skipIf(!databaseUrl)('R0-5 legacyModuleValues', { timeout: 60_000 }, () => {
  const legacyModules = INSTALLATION_MODULES.filter((module) => module.legacyEnvKey !== null);
  const capabilities: AuthenticatedCapabilities = {
    overviewDashboard: true,
    calendar: false,
    messaging: false,
    backup: false,
    demoDatasetCreation: false,
  };

  it('maps every legacy registry module from its capability value', () => {
    const values = legacyModuleValues(capabilities);

    expect(Object.keys(values).sort()).toEqual(legacyModules.map((module) => module.key).sort());
    for (const module of legacyModules) {
      expect(values[module.key]).toBe(capabilities[module.capability]);
    }
    expect(values.OVERVIEW).toBe(true);
  });

  it('defaults a missing capabilities object to false for every legacy module', () => {
    const values = legacyModuleValues(undefined);

    expect(Object.keys(values).sort()).toEqual(legacyModules.map((module) => module.key).sort());
    for (const module of legacyModules) {
      expect(values[module.key]).toBe(false);
    }
    expect(values.OVERVIEW).toBe(false);
  });

  it('reads an explicit false instead of treating the module as absent', () => {
    const values = legacyModuleValues({ ...capabilities, overviewDashboard: false });
    expect(values.OVERVIEW).toBe(false);
  });
});

// ---------------------------------------------------------------- R0-6

describe.skipIf(!databaseUrl)('R0-6 staticModuleStateReader', { timeout: 60_000 }, () => {
  it('boolean form reports the fixed value for every registry key (existing callers unchanged)', async () => {
    for (const enabled of [true, false]) {
      const reader = staticModuleStateReader(enabled);
      for (const module of INSTALLATION_MODULES) {
        const row = await reader.read(module.key);
        expect(row).toMatchObject({ key: module.key, enabled });
      }
    }
  });

  it('map form reports listed keys and null for an unlisted registry key', async () => {
    await expect(staticModuleStateReader({ OVERVIEW: true }).read('OVERVIEW'))
      .resolves.toMatchObject({ key: 'OVERVIEW', enabled: true });
    await expect(staticModuleStateReader({ OVERVIEW: false }).read('OVERVIEW'))
      .resolves.toMatchObject({ key: 'OVERVIEW', enabled: false });
    await expect(staticModuleStateReader({}).read('OVERVIEW')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------- R0-7

describe.skipIf(!databaseUrl)('R0-7 operator module views expose registry copy', { timeout: 60_000 }, () => {
  it('GET returns description, whenDisabled and preserved matching the registry', async () => {
    const { app, cookie } = await operatorFixture({ enabled: false });

    const res = await call(app, 'GET', '/api/operator/modules', undefined, { cookie });

    expect(res.statusCode).toBe(200);
    const { modules } = res.json();
    expect(modules).toHaveLength(2);
    expect(modules[0]).toMatchObject({
      key: OVERVIEW_DESCRIPTOR.key,
      label: OVERVIEW_DESCRIPTOR.label,
      enabled: false,
      version: 1,
      source: 'ENV_TAKEOVER',
      description: OVERVIEW_DESCRIPTOR.description,
    });
    expect(modules[0].whenDisabled).toEqual([...OVERVIEW_DESCRIPTOR.whenDisabled]);
    expect(modules[0].preserved).toEqual([...OVERVIEW_DESCRIPTOR.preserved]);
    expect(modules[1]).toMatchObject({
      key: MESSAGING_DESCRIPTOR.key,
      label: MESSAGING_DESCRIPTOR.label,
      enabled: false,
      version: 1,
      source: 'ENV_TAKEOVER',
      description: MESSAGING_DESCRIPTOR.description,
    });
    expect(modules[1].whenDisabled).toEqual([...MESSAGING_DESCRIPTOR.whenDisabled]);
    expect(modules[1].preserved).toEqual([...MESSAGING_DESCRIPTOR.preserved]);

    // The registry descriptor is the source of the copy.
    const registryEntry = findInstallationModule('OVERVIEW')!;
    expect(modules[0].description).toBe(registryEntry.description);
    expect(modules[0].whenDisabled).toEqual(registryEntry.whenDisabled);
    expect(modules[0].preserved).toEqual(registryEntry.preserved);
  });

  it('PUT response carries the same copy', async () => {
    const { app, cookie } = await operatorFixture({ enabled: false });

    const res = await put(app, cookie, { enabled: true, expectedVersion: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.json().module).toMatchObject({
      key: 'OVERVIEW',
      enabled: true,
      version: 2,
      source: 'OPERATOR',
      description: OVERVIEW_DESCRIPTOR.description,
    });
    expect(res.json().module.whenDisabled).toEqual([...OVERVIEW_DESCRIPTOR.whenDisabled]);
    expect(res.json().module.preserved).toEqual([...OVERVIEW_DESCRIPTOR.preserved]);
  });

  it("GET reports the widened 'FRESH_INSTALL' source", async () => {
    const { app, cookie } = await operatorFixture({ enabled: false, source: 'FRESH_INSTALL' });

    const res = await call(app, 'GET', '/api/operator/modules', undefined, { cookie });

    expect(res.statusCode).toBe(200);
    expect(res.json().modules[0]).toMatchObject({
      key: 'OVERVIEW', enabled: false, source: 'FRESH_INSTALL',
    });
  });

  it.each(['CALENDAR', 'NOPE', 'OVERVIEW2'])(
    'PUT /api/operator/modules/%s stays 404 NOT_FOUND and writes nothing (OP9)',
    async (key) => {
      const { app, cookie } = await operatorFixture({ enabled: false });
      const events = await auditCount();

      const res = await put(app, cookie, { enabled: true, expectedVersion: 1 }, key);

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
      expect(await stateRow()).toMatchObject({ enabled: false, version: 1 });
      expect((await pool.query(
        `SELECT count(*)::int AS n FROM installation_module_state`,
      )).rows[0].n).toBe(2);
      expect(await auditCount()).toBe(events);
    },
  );
});

// ---------------------------------------------------------------- R0-8

describe.skipIf(!databaseUrl)('R0-8 /api/auth/me reads module capabilities from the database per request', { timeout: 60_000 }, () => {
  it('toggles overviewDashboard without restart and leaves the other capabilities at their config values', async () => {
    const email = `op-${randomUUID()}@example.com`;
    await grant(email);
    await seedState(false);
    await seedState(true, { key: 'MESSAGING' });
    const app = await createApp({
      config: {
        ...baseConfig,
        capabilities: {
          ...baseConfig.capabilities,
          calendar: true,
          messaging: false,
        },
      },
    });
    const operator = await operatorLogin(app, email);
    expect(operator.res.statusCode).toBe(200);
    const customerCookie = await customerLogin(app);

    const off = await call(app, 'GET', '/api/auth/me', undefined, { cookie: customerCookie });
    expect(off.statusCode).toBe(200);
    expect(off.json().user.capabilities).toMatchObject({
      overviewDashboard: false, calendar: true, messaging: true,
    });

    const on = await put(app, operator.cookie, { enabled: true, expectedVersion: 1 });
    expect(on.statusCode).toBe(200);

    const onMe = await call(app, 'GET', '/api/auth/me', undefined, { cookie: customerCookie });
    expect(onMe.statusCode).toBe(200);
    expect(onMe.json().user.capabilities).toMatchObject({
      overviewDashboard: true, calendar: true, messaging: true,
    });

    const login = await call(app, 'POST', '/api/auth/login', {
      email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD,
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.capabilities).toMatchObject({
      overviewDashboard: true, calendar: true, messaging: true,
    });

    const offAgain = await put(app, operator.cookie, { enabled: false, expectedVersion: 2 });
    expect(offAgain.statusCode).toBe(200);

    const offMe = await call(app, 'GET', '/api/auth/me', undefined, { cookie: customerCookie });
    expect(offMe.statusCode).toBe(200);
    expect(offMe.json().user.capabilities).toMatchObject({
      overviewDashboard: false, calendar: true, messaging: true,
    });
  });
});

// ---------------------------------------------------------------- interfaces

describe.skipIf(!databaseUrl)('R0 registry widening interfaces', { timeout: 60_000 }, () => {
  it('keeps OVERVIEW and MESSAGING registry entries with the contract descriptors', () => {
    expect(INSTALLATION_MODULES).toEqual([OVERVIEW_DESCRIPTOR, MESSAGING_DESCRIPTOR]);
    expect(findInstallationModule('OVERVIEW')).toEqual(OVERVIEW_DESCRIPTOR);
    expect(findInstallationModule('MESSAGING')).toEqual(MESSAGING_DESCRIPTOR);
    expect(findInstallationModule('CALENDAR')).toBeUndefined();
  });

  it('exports MODULE_KEY_PATTERN matching the database regex', () => {
    for (const valid of ['OVERVIEW', 'MESSAGING', 'A1', 'A_1', `A${'B'.repeat(31)}`]) {
      expect(MODULE_KEY_PATTERN.test(valid)).toBe(true);
    }
    for (const invalid of ['overview', 'X', '1ABC', 'A'.repeat(33), 'OVERVIEW-2', '']) {
      expect(MODULE_KEY_PATTERN.test(invalid)).toBe(false);
    }
  });

  it('MODULE_STATE_SOURCES includes FRESH_INSTALL', () => {
    expect([...MODULE_STATE_SOURCES]).toEqual(['ENV_TAKEOVER', 'OPERATOR', 'FRESH_INSTALL']);
  });

  it('readModuleCapabilities reads every registry module once and keys by capability', async () => {
    const seen: string[] = [];
    const reader: ModuleStateReader = {
      read: async (key) => {
        seen.push(key);
        return {
          key,
          enabled: key === 'OVERVIEW',
          version: 1,
          source: 'ENV_TAKEOVER',
          updatedAt: new Date(0),
          updatedByOperatorId: null,
        };
      },
    };
    const logger = { error: vi.fn() };

    const values = await readModuleCapabilities(reader, logger);

    expect(seen.slice().sort()).toEqual(INSTALLATION_MODULES.map((module) => module.key).sort());
    expect(seen).toHaveLength(INSTALLATION_MODULES.length);
    expect(values).toEqual({ overviewDashboard: true, messaging: false });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('readModuleCapabilities reports a missing row as false and logs it', async () => {
    const logger = { error: vi.fn() };

    const values = await readModuleCapabilities(staticModuleStateReader({}), logger);

    expect(values).toEqual({ overviewDashboard: false, messaging: false });
    expect(logger.error).toHaveBeenCalled();
  });

  it('readModuleCapabilities reports a read failure as false and logs it', async () => {
    const logger = { error: vi.fn() };
    const failing: ModuleStateReader = {
      read: async () => { throw new Error('module state store unavailable'); },
    };

    const values = await readModuleCapabilities(failing, logger);

    expect(values).toEqual({ overviewDashboard: false, messaging: false });
    expect(logger.error).toHaveBeenCalled();
  });

  it('withModuleCapabilities spreads module values over capabilities and defaults', () => {
    const capabilities: AuthenticatedCapabilities = {
      duplicateCustomerComparison: true,
      overviewDashboard: false,
      calendar: true,
      messaging: false,
      backup: true,
      demoDatasetCreation: false,
    };

    const applied = withModuleCapabilities(capabilities, { overviewDashboard: true });
    expect(applied).toMatchObject({
      overviewDashboard: true,
      calendar: true,
      messaging: false,
      backup: true,
      demoDatasetCreation: false,
      duplicateCustomerComparison: true,
    });
    expect(capabilities.overviewDashboard).toBe(false); // input is not mutated

    const defaults = withModuleCapabilities(undefined, { overviewDashboard: true });
    expect(defaults).toMatchObject({
      overviewDashboard: true,
      calendar: false,
      messaging: false,
      backup: false,
      demoDatasetCreation: false,
    });

    const untouched = withModuleCapabilities(capabilities, {});
    expect(untouched.overviewDashboard).toBe(false);
    expect(untouched.calendar).toBe(true);
  });
});
