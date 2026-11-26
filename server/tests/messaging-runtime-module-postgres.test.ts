import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';

import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MSG-001 — Messaging as a runtime installation module (independent acceptance
 * test, written from the fixed contract before the implementation exists).
 *
 * Proves, against a real PostgreSQL 17 schema and the real HTTP surface:
 *   MS1  the one-time MESSAGING_ENABLED env takeover (S1).
 *   MS2  operator "off" hides every messaging route (404 NOT_FOUND), removes the
 *        capability and the Overview summary without a restart (S3, S4).
 *   MS3  operator "on" reverses MS2 even when the legacy env flag is off (S3, S4).
 *   MS4  a missing module row is 503 MODULE_STATE_UNAVAILABLE, capability false,
 *        while Overview stays 200 and textually omits the summary (S2, S3, S4).
 *   MS5  disabled idempotent retries are 404 and leave the stored receipt; the
 *        same clientActionId replays the stored message after re-enable (S3).
 *   MS6  notification center hides conversation rows while disabled, leaves the
 *        rows untouched and shows them again with their read state (S5).
 *   MS7  the push dispatcher abandons disabled-module deliveries, leaves a live
 *        lease untouched, never claims while unreadable and never revives (S6).
 *   MS8  realtime catch-up skips conversation events, advances the cursor past
 *        them and does not replay them after re-enable (S7).
 *   MS9  Staff offboarding keeps transferring JOB conversations and writing the
 *        messaging activity while the module is off (out-of-scope invariant).
 *   MS10 the operator toggle writes only module state + operator audit, and a
 *        stale expectedVersion is 409 MODULE_VERSION_CONFLICT (S1).
 *
 * Supplemental interface checks: the S2 gate helper contract, the S1 registry
 * descriptor and the S8 operator view copy.
 *
 * The file imports the fixed MSG-001 names directly, so it is expected to fail
 * at collection against the pre-MSG-001 tree ("No export named ..."): that is
 * the RED state this test is meant to produce.
 */
import { buildApp } from '../src/app.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations, type MigrationLogger } from '../src/db/migrate-runner.js';
import { runOperatorCli } from '../src/db/operator-cli.js';
import { AppError, toErrorResponse } from '../src/errors/index.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import type { AuthenticatedCapabilities } from '../src/modules/capabilities/types.js';
import {
  assertModuleEnabled,
  moduleGate,
  moduleStateUnavailable,
} from '../src/modules/installation-modules/gate.js';
import {
  findInstallationModule,
  INSTALLATION_MODULES,
} from '../src/modules/installation-modules/registry.js';
import type {
  ModuleStateReader,
  ModuleStateRow,
} from '../src/modules/installation-modules/state.js';
import {
  legacyModuleValues,
  takeOverInstallationModules,
} from '../src/modules/installation-modules/takeover.js';
import { PostgresNotificationRepository } from '../src/modules/notifications/repository.js';
import type { OverviewReadModel } from '../src/modules/overview/repository.js';
import { PostgresStaffOffboardingService } from '../src/modules/people/offboarding.js';
import { InMemoryRealtimeEventBus } from '../src/modules/realtime/event-bus.js';
import { PostgresRealtimeEventRepository } from '../src/modules/realtime/repository.js';
import { RealtimeService } from '../src/modules/realtime/service.js';
import type {
  RealtimeEventRecord,
  RealtimeEventType,
  RealtimeViewer,
} from '../src/modules/realtime/types.js';
import { createDispatcher } from '../src/modules/web-push/dispatcher.js';
import { PostgresWebPushRepository } from '../src/modules/web-push/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const ORIGIN = 'http://127.0.0.1:5173';
const CUSTOMER_COOKIE = 'servora_session';
const OPERATOR_COOKIE = 'servora_operator_session';
const PASSWORD = 'Customer-Pass#2026';
const OPERATOR_PASSWORD = 'Operator-Pass#2026';

const silentLogger: MigrationLogger = { info: () => undefined, error: () => undefined };

const baseConfig = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 0,
  databaseUrl: databaseUrl ?? 'postgresql://unused-msg-runtime',
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
    // Deliberately OFF: MS2/MS3 prove the database is the only runtime source
    // and that the legacy env value is neither a ceiling nor a fallback.
    messaging: false,
    backup: false,
    demoDatasetCreation: false,
  },
};

type TestConfig = Omit<typeof baseConfig, 'nodeEnv'> & { nodeEnv: 'test' | 'production' };

/** The contract-fixed MESSAGING descriptor (registry and operator API copy). */
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
let sharedPasswordHash = '';
const extraPools: Pool[] = [];
const apps: App[] = [];

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
  schema = `msg_runtime_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  pool = schemaPool();
  await runMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    store: new PostgresMigrationStore(pool),
    logger: silentLogger,
  });
  sharedPasswordHash = await hashPassword(PASSWORD);
}, 120_000);

afterAll(async () => {
  if (!databaseUrl) return;
  await Promise.all(extraPools.splice(0).map((created) => created.end()));
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
});

beforeEach(async () => {
  if (!databaseUrl) return;
  // CASCADE reaches every table that references organizations (users, jobs,
  // messaging, notifications, realtime, web push, receipts/audit).
  await pool.query(
    `TRUNCATE organizations, operator_accounts, operator_sessions,
       operator_account_capabilities, operator_audit_events, installation_module_state
     RESTART IDENTITY CASCADE`,
  );
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp(options: { config?: TestConfig } = {}): Promise<App> {
  const app = await buildApp((options.config ?? baseConfig) as Parameters<typeof buildApp>[0], {
    pool,
    authRepository: new PostgresAuthRepository(pool),
    overviewRepository: stubOverview,
    notificationRepository: new PostgresNotificationRepository(pool),
  });
  apps.push(app);
  return app;
}

// ---------------------------------------------------------------- HTTP helpers

let ipCounter = 0;
/** Unique client address per call; the test config trusts the loopback proxy. */
function nextIp(): string {
  ipCounter += 1;
  return `10.9.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

type RequestOptions = {
  cookie?: string | null;
  origin?: string | false;
  ip?: string;
  headers?: Record<string, string>;
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

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
  method: Method,
  url: string,
  payload?: unknown,
  options: RequestOptions = {},
): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    headers: headersFor(options),
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

async function customerLogin(app: App, email: string): Promise<string> {
  const res = await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD });
  expect(res.statusCode).toBe(200);
  const set = setCookieFor(res, CUSTOMER_COOKIE);
  expect(set).not.toBeNull();
  return `${CUSTOMER_COOKIE}=${cookieValue(set!)}`;
}

async function operatorLogin(app: App, email: string): Promise<string> {
  const res = await call(app, 'POST', '/api/operator/login', {
    email,
    password: OPERATOR_PASSWORD,
  });
  expect(res.statusCode).toBe(200);
  const set = setCookieFor(res, OPERATOR_COOKIE);
  expect(set).not.toBeNull();
  return `${OPERATOR_COOKIE}=${cookieValue(set!)}`;
}

function putModule(
  app: App,
  cookie: string,
  key: 'OVERVIEW' | 'MESSAGING',
  enabled: boolean,
  expectedVersion: number,
) {
  return call(
    app,
    'PUT',
    `/api/operator/modules/${key}`,
    { enabled, expectedVersion },
    { cookie },
  );
}

// ---------------------------------------------------------------- operator CLI

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

async function cli(argv: string[], stdinText: string | null = null) {
  const { io, out } = cliIo(stdinText);
  const code = await runOperatorCli(argv, io, pool);
  return { code, stdout: out.stdout.join(''), stderr: out.stderr.join('') };
}

async function grantOperator(email: string, name = 'Module Operator'): Promise<string> {
  const result = await cli(
    ['grant', '--email', email, '--name', name, '--password-stdin'],
    `${OPERATOR_PASSWORD}\n`,
  );
  expect(result.code, result.stderr).toBe(0);
  const row = await pool.query<{ id: string }>(
    `SELECT id FROM operator_accounts WHERE lower(email) = lower($1)`,
    [email],
  );
  return row.rows[0]!.id;
}

// ---------------------------------------------------------------- data helpers

type StateRow = {
  module_key: string;
  enabled: boolean;
  version: number;
  source: string;
  updated_at: Date;
  updated_by_operator_id: string | null;
};

async function moduleRow(key: string): Promise<StateRow | null> {
  const result = await pool.query<StateRow>(
    `SELECT module_key, enabled, version, source, updated_at, updated_by_operator_id
       FROM installation_module_state WHERE module_key = $1`,
    [key],
  );
  return result.rows[0] ?? null;
}

async function seedModuleState(key: 'OVERVIEW' | 'MESSAGING', enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
     VALUES ($1, $2, 1, 'ENV_TAKEOVER', now())`,
    [key, enabled],
  );
}

type AuditRow = {
  event_type: string;
  actor_kind: string;
  operator_id: string | null;
  module_key: string | null;
  old_value: unknown;
  new_value: unknown;
};

async function auditRows(eventType?: string): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    `SELECT event_type, actor_kind, operator_id, module_key, old_value, new_value
       FROM operator_audit_events
      WHERE ($1::text IS NULL OR event_type = $1)
      ORDER BY occurred_at, id`,
    [eventType ?? null],
  );
  return result.rows;
}

async function auditCount(): Promise<number> {
  return Number((await pool.query(
    `SELECT count(*)::int AS n FROM operator_audit_events`,
  )).rows[0].n);
}

async function seedOrganization(name = `MSG ${randomUUID()}`): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [name],
  );
  return result.rows[0]!.id;
}

async function seedUser(
  organizationId: string,
  name: string,
  role: SafeUser['role'],
): Promise<SafeUser> {
  const email = `${randomUUID()}@msg-runtime.test`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [organizationId, name, email, sharedPasswordHash, role],
  );
  return {
    id: result.rows[0]!.id,
    organizationId,
    name,
    email,
    role,
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

/** Operational ACCEPTED JobCard assigned to `assignedTo`. */
async function seedAcceptedJob(
  organizationId: string,
  assignedTo: string,
  createdBy: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by, accepted_at, accepted_by)
     VALUES ($1, 'GENERAL_TASK', 'ACCEPTED', 'MSG-001 iş kaydı', $2, $3, now(), $2)
     RETURNING id`,
    [organizationId, assignedTo, createdBy],
  );
  return result.rows[0]!.id;
}

type MessagingFixture = Readonly<{
  app: App;
  organizationId: string;
  admin: SafeUser;
  staff: SafeUser;
  jobId: string;
  adminCookie: string;
  staffCookie: string;
}>;

async function messagingFixture(options: {
  messagingEnabled: boolean;
  overviewEnabled?: boolean;
}): Promise<MessagingFixture> {
  const organizationId = await seedOrganization();
  const admin = await seedUser(organizationId, 'Runtime Admin', 'ADMIN');
  const staff = await seedUser(organizationId, 'Runtime Staff', 'STAFF');
  const jobId = await seedAcceptedJob(organizationId, staff.id, admin.id);
  await seedModuleState('OVERVIEW', options.overviewEnabled ?? true);
  await seedModuleState('MESSAGING', options.messagingEnabled);
  const app = await createApp();
  return {
    app,
    organizationId,
    admin,
    staff,
    jobId,
    adminCookie: await customerLogin(app, admin.email),
    staffCookie: await customerLogin(app, staff.email),
  };
}

async function createJobConversation(
  app: App,
  adminCookie: string,
  jobId: string,
  staffId: string,
): Promise<string> {
  const res = await call(app, 'POST', '/api/messaging/conversations', {
    contextType: 'JOB',
    jobId,
    participantUserIds: [staffId],
  }, { cookie: adminCookie });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

function sendMessage(
  app: App,
  cookie: string,
  conversationId: string,
  body: string,
  clientActionId: string,
) {
  return call(app, 'POST', `/api/messaging/conversations/${conversationId}/messages`, {
    body,
    clientActionId,
  }, { cookie });
}

async function messageCount(conversationId: string): Promise<number> {
  return Number((await pool.query(
    `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1`,
    [conversationId],
  )).rows[0].n);
}

async function messageActivityCount(conversationId: string, clientActionId: string): Promise<number> {
  return Number((await pool.query(
    `SELECT count(*)::int AS n FROM messaging_activity_logs
      WHERE conversation_id = $1 AND action = 'MESSAGE_SENT' AND client_action_id = $2`,
    [conversationId, clientActionId],
  )).rows[0].n);
}

async function conversationNotificationId(
  recipientUserId: string,
  conversationId: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM in_app_notifications
      WHERE recipient_user_id = $1 AND entity_type = 'conversation' AND entity_id = $2
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [recipientUserId, conversationId],
  );
  return result.rows[0]?.id ?? (() => { throw new Error('conversation notification missing'); })();
}

/** Seeds a conversation notification exactly as the messaging producer does. */
async function seedConversationNotification(input: {
  organizationId: string;
  conversationId: string;
  actorUserId: string;
  recipientUserId: string;
  readAt: Date | null;
}): Promise<string> {
  const activity = await pool.query<{ id: string }>(
    `INSERT INTO messaging_activity_logs
       (organization_id, conversation_id, actor_user_id, action, client_action_id, details)
     VALUES ($1, $2, $3, 'MESSAGE_SENT', $4, '{}'::jsonb)
     RETURNING id`,
    [input.organizationId, input.conversationId, input.actorUserId, randomUUID()],
  );
  const event = await pool.query<{ id: string }>(
    `INSERT INTO realtime_events
       (organization_id, messaging_activity_id, event_type, entity_type, entity_id,
        actor_user_id, audience_roles, audience_user_ids, resource_keys)
     VALUES ($1, $2, 'message.sent', 'conversation', $3, $4,
             ARRAY[]::VARCHAR(20)[], ARRAY[$5]::UUID[], ARRAY['messaging', 'notifications'])
     RETURNING id`,
    [
      input.organizationId,
      activity.rows[0]!.id,
      input.conversationId,
      input.actorUserId,
      input.recipientUserId,
    ],
  );
  const notification = await pool.query<{ id: string }>(
    `INSERT INTO in_app_notifications
       (organization_id, recipient_user_id, source_realtime_event_id, kind,
        entity_type, entity_id, created_at, read_at)
     VALUES ($1, $2, $3, 'message.received', 'conversation', $4, now(), $5)
     RETURNING id`,
    [
      input.organizationId,
      input.recipientUserId,
      event.rows[0]!.id,
      input.conversationId,
      input.readAt,
    ],
  );
  return notification.rows[0]!.id;
}

/** Seeds a job-card notification with its own activity + realtime event. */
async function seedJobCardNotification(input: {
  organizationId: string;
  jobId: string;
  actorUserId: string;
  recipientUserId: string;
  readAt: Date | null;
}): Promise<string> {
  const activity = await pool.query<{ id: string }>(
    `INSERT INTO job_card_activity_logs
       (organization_id, job_card_id, actor_id, event_type)
     VALUES ($1, $2, $3, 'JOB_CANCELLED')
     RETURNING id`,
    [input.organizationId, input.jobId, input.actorUserId],
  );
  const event = await pool.query<{ id: string }>(
    `INSERT INTO realtime_events
       (organization_id, source_activity_id, event_type, entity_type, entity_id,
        actor_user_id, audience_roles, audience_user_ids, resource_keys)
     VALUES ($1, $2, 'job.cancelled', 'job-card', $3, $4,
             ARRAY[]::VARCHAR(20)[], ARRAY[$5]::UUID[], ARRAY['notifications'])
     RETURNING id`,
    [
      input.organizationId,
      activity.rows[0]!.id,
      input.jobId,
      input.actorUserId,
      input.recipientUserId,
    ],
  );
  const notification = await pool.query<{ id: string }>(
    `INSERT INTO in_app_notifications
       (organization_id, recipient_user_id, source_realtime_event_id, kind,
        entity_type, entity_id, created_at, read_at)
     VALUES ($1, $2, $3, 'job.cancelled', 'job-card', $4, now(), $5)
     RETURNING id`,
    [
      input.organizationId,
      input.recipientUserId,
      event.rows[0]!.id,
      input.jobId,
      input.readAt,
    ],
  );
  return notification.rows[0]!.id;
}

type NotificationRow = {
  id: string;
  entity_type: string;
  read_at: Date | null;
  dismissed_at: Date | null;
};

async function notificationRows(ids: readonly string[]): Promise<NotificationRow[]> {
  const result = await pool.query<NotificationRow>(
    `SELECT id, entity_type, read_at, dismissed_at
       FROM in_app_notifications
      WHERE id = ANY($1::uuid[])
      ORDER BY id`,
    [ids],
  );
  return result.rows;
}

function notificationById(rows: readonly NotificationRow[], id: string): NotificationRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`notification ${id} missing`);
  return row;
}

// ---------------------------------------------------------------- MS1

describe.skipIf(!databaseUrl)('MS1 MESSAGING_ENABLED is taken over exactly once (S1)', { timeout: 60_000 }, () => {
  const capabilities: AuthenticatedCapabilities = {
    overviewDashboard: false,
    calendar: false,
    messaging: true,
    backup: false,
    demoDatasetCreation: false,
  };

  it('takes over the legacy value once, is restart-safe and ignores later env changes', async () => {
    // Empty database, legacy MESSAGING_ENABLED=false.
    await takeOverInstallationModules(pool, { OVERVIEW: false, MESSAGING: false });

    const off = await moduleRow('MESSAGING');
    expect(off).toMatchObject({
      module_key: 'MESSAGING',
      enabled: false,
      version: 1,
      source: 'ENV_TAKEOVER',
      updated_by_operator_id: null,
    });
    let events = (await auditRows('MODULE_STATE_TAKEN_OVER'))
      .filter((event) => event.module_key === 'MESSAGING');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_kind: 'SYSTEM', operator_id: null });
    expect(events[0]!.new_value).toEqual({ enabled: false, source: 'ENV_TAKEOVER' });

    // Restart with the same env: no duplicate row and no duplicate event.
    await takeOverInstallationModules(pool, { OVERVIEW: false, MESSAGING: false });
    expect(await moduleRow('MESSAGING')).toEqual(off);
    events = (await auditRows('MODULE_STATE_TAKEN_OVER'))
      .filter((event) => event.module_key === 'MESSAGING');
    expect(events).toHaveLength(1);
    expect(await auditCount()).toBe(2); // one OVERVIEW + one MESSAGING takeover

    // Later env change (false -> true) has no effect on the stored row.
    await takeOverInstallationModules(pool, legacyModuleValues(capabilities));
    expect(await moduleRow('MESSAGING')).toEqual(off);

    // Fresh database, legacy MESSAGING_ENABLED=true.
    await pool.query(`TRUNCATE operator_audit_events, installation_module_state CASCADE`);
    await takeOverInstallationModules(pool, legacyModuleValues(capabilities));

    const on = await moduleRow('MESSAGING');
    expect(on).toMatchObject({
      module_key: 'MESSAGING', enabled: true, version: 1, source: 'ENV_TAKEOVER',
    });
    // A later env flip back to false must not change the stored value.
    await takeOverInstallationModules(pool, legacyModuleValues({ ...capabilities, messaging: false }));
    expect(await moduleRow('MESSAGING')).toEqual(on);
    events = (await auditRows('MODULE_STATE_TAKEN_OVER'))
      .filter((event) => event.module_key === 'MESSAGING');
    expect(events).toHaveLength(1);
    expect(events[0]!.new_value).toEqual({ enabled: true, source: 'ENV_TAKEOVER' });
  });
});

// ---------------------------------------------------------------- MS2

const MESSAGING_ROUTES: ReadonlyArray<Readonly<{
  method: Method;
  url: string;
  payload?: Record<string, unknown>;
}>> = [
  { method: 'GET', url: '/api/messaging/conversations' },
  { method: 'GET', url: '/api/messaging/recipients' },
  {
    method: 'POST',
    url: '/api/messaging/conversations',
    payload: { recipientUserId: randomUUID(), contextType: 'GENERAL' },
  },
  { method: 'GET', url: `/api/messaging/conversations/job/${randomUUID()}` },
  { method: 'GET', url: `/api/messaging/conversations/${randomUUID()}/messages` },
  {
    method: 'POST',
    url: `/api/messaging/conversations/${randomUUID()}/messages`,
    payload: { body: 'Kapalı mod denemesi', clientActionId: `closed-${randomUUID()}` },
  },
  { method: 'POST', url: `/api/messaging/conversations/${randomUUID()}/archive` },
  { method: 'POST', url: `/api/messaging/conversations/${randomUUID()}/unarchive` },
  {
    method: 'PATCH',
    url: `/api/messaging/conversations/${randomUUID()}/read`,
    payload: { messageId: randomUUID() },
  },
  { method: 'GET', url: '/api/messaging/unread-count' },
  {
    method: 'POST',
    url: `/api/messaging/conversations/${randomUUID()}/job-assignee-sync`,
    payload: { clientActionId: `sync-${randomUUID()}`, assignmentTransitionId: randomUUID() },
  },
];

describe.skipIf(!databaseUrl)('MS2 operator "off" hides Messaging without a restart (S3, S4)', { timeout: 90_000 }, () => {
  it('every route is 404 NOT_FOUND, the capability is false and Overview omits the summary', async () => {
    expect(MESSAGING_ROUTES).toHaveLength(11);

    const fixture = await messagingFixture({ messagingEnabled: true });
    const conversationId = await createJobConversation(
      fixture.app, fixture.adminCookie, fixture.jobId, fixture.staff.id,
    );
    const baselineSend = await sendMessage(
      fixture.app, fixture.adminCookie, conversationId, 'Kapatmadan önce', `msg-${randomUUID()}`,
    );
    expect(baselineSend.statusCode).toBe(201);

    // Baseline while the module is on.
    const baselineList = await call(
      fixture.app, 'GET', '/api/messaging/conversations', undefined, { cookie: fixture.staffCookie },
    );
    expect(baselineList.statusCode).toBe(200);
    const baselineOverview = await call(
      fixture.app, 'GET', '/api/overview', undefined, { cookie: fixture.staffCookie },
    );
    expect(baselineOverview.statusCode).toBe(200);
    expect(baselineOverview.json().messageUnreadSummary).toEqual({ unreadTotal: 1 });

    const operatorEmail = `op-${randomUUID()}@example.com`;
    await grantOperator(operatorEmail);
    const operatorCookie = await operatorLogin(fixture.app, operatorEmail);

    const off = await putModule(fixture.app, operatorCookie, 'MESSAGING', false, 1);
    expect(off.statusCode).toBe(200);
    expect(off.json().module).toMatchObject({
      key: 'MESSAGING', enabled: false, version: 2, source: 'OPERATOR',
    });
    expect(await moduleRow('MESSAGING')).toMatchObject({ enabled: false, version: 2 });

    // Same process, same sessions: every messaging route now behaves as absent.
    for (const route of MESSAGING_ROUTES) {
      const res = await call(fixture.app, route.method, route.url, route.payload, {
        cookie: fixture.adminCookie,
      });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(404);
      expect(res.json().code, `${route.method} ${route.url}`).toBe('NOT_FOUND');
    }

    // Authentication still runs first: unauthenticated stays 401.
    const unauthenticated = await call(
      fixture.app, 'GET', '/api/messaging/conversations', undefined, { cookie: null },
    );
    expect(unauthenticated.statusCode).toBe(401);

    const me = await call(fixture.app, 'GET', '/api/auth/me', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.capabilities.messaging).toBe(false);

    // Overview still answers 200 but no longer claims to know an unread total.
    const overview = await call(fixture.app, 'GET', '/api/overview', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).not.toHaveProperty('messageUnreadSummary');

    // Data is kept: the conversation and message rows are untouched.
    expect(await messageCount(conversationId)).toBe(1);
  });
});

// ---------------------------------------------------------------- MS3

describe.skipIf(!databaseUrl)('MS3 operator "on" reverses MS2 with the legacy env flag off (S3, S4)', { timeout: 90_000 }, () => {
  it('routes, capability and the Overview summary come back without a restart', async () => {
    const fixture = await messagingFixture({ messagingEnabled: false });

    const offList = await call(
      fixture.app, 'GET', '/api/messaging/conversations', undefined, { cookie: fixture.adminCookie },
    );
    expect(offList.statusCode).toBe(404);
    expect(offList.json().code).toBe('NOT_FOUND');

    const operatorEmail = `op-${randomUUID()}@example.com`;
    await grantOperator(operatorEmail);
    const operatorCookie = await operatorLogin(fixture.app, operatorEmail);

    // config.capabilities.messaging is false for this app: the database alone
    // decides, so this proves the legacy env value is not a ceiling.
    const on = await putModule(fixture.app, operatorCookie, 'MESSAGING', true, 1);
    expect(on.statusCode).toBe(200);
    expect(on.json().module).toMatchObject({
      key: 'MESSAGING', enabled: true, version: 2, source: 'OPERATOR',
    });

    const me = await call(fixture.app, 'GET', '/api/auth/me', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.capabilities.messaging).toBe(true);

    const conversationId = await createJobConversation(
      fixture.app, fixture.adminCookie, fixture.jobId, fixture.staff.id,
    );
    const sent = await sendMessage(
      fixture.app, fixture.adminCookie, conversationId, 'Açıldıktan sonra', `msg-${randomUUID()}`,
    );
    expect(sent.statusCode).toBe(201);

    const list = await call(fixture.app, 'GET', '/api/messaging/conversations', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((item: { id: string }) => item.id)).toContain(conversationId);

    const unread = await call(fixture.app, 'GET', '/api/messaging/unread-count', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(unread.statusCode).toBe(200);
    expect(unread.json().unreadCount).toBe(1);

    const recipients = await call(fixture.app, 'GET', '/api/messaging/recipients', undefined, {
      cookie: fixture.adminCookie,
    });
    expect(recipients.statusCode).toBe(200);

    const overview = await call(fixture.app, 'GET', '/api/overview', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().messageUnreadSummary).toEqual({ unreadTotal: 1 });
  });
});

// ---------------------------------------------------------------- MS4

describe.skipIf(!databaseUrl)('MS4 a missing module row fails closed (S2, S3, S4)', { timeout: 90_000 }, () => {
  it('messaging routes are 503, the capability is false and Overview stays 200 without the summary', async () => {
    const fixture = await messagingFixture({ messagingEnabled: true });
    await pool.query(`DELETE FROM installation_module_state WHERE module_key = 'MESSAGING'`);
    expect(await moduleRow('MESSAGING')).toBeNull();
    expect(await moduleRow('OVERVIEW')).toMatchObject({ enabled: true });

    const list = await call(fixture.app, 'GET', '/api/messaging/conversations', undefined, {
      cookie: fixture.adminCookie,
    });
    expect(list.statusCode).toBe(503);
    expect(list.json().code).toBe('MODULE_STATE_UNAVAILABLE');

    const write = await call(
      fixture.app,
      'POST',
      `/api/messaging/conversations/${randomUUID()}/messages`,
      { body: 'Durum okunamıyor', clientActionId: `unreadable-${randomUUID()}` },
      { cookie: fixture.adminCookie },
    );
    expect(write.statusCode).toBe(503);
    expect(write.json().code).toBe('MODULE_STATE_UNAVAILABLE');

    const unauthenticated = await call(
      fixture.app, 'GET', '/api/messaging/conversations', undefined, { cookie: null },
    );
    expect(unauthenticated.statusCode).toBe(401);

    const me = await call(fixture.app, 'GET', '/api/auth/me', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.capabilities.messaging).toBe(false);

    const overview = await call(fixture.app, 'GET', '/api/overview', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).not.toHaveProperty('messageUnreadSummary');
  });
});

// ---------------------------------------------------------------- MS5

describe.skipIf(!databaseUrl)('MS5 idempotent messaging send across the switch (S3)', { timeout: 90_000 }, () => {
  it('404 while disabled leaves the receipt, and the same clientActionId replays after re-enable', async () => {
    const fixture = await messagingFixture({ messagingEnabled: true });
    const conversationId = await createJobConversation(
      fixture.app, fixture.adminCookie, fixture.jobId, fixture.staff.id,
    );
    const clientActionId = `msg-${randomUUID()}`;
    const body = 'Idempotent teslimat mesajı';

    const first = await sendMessage(
      fixture.app, fixture.adminCookie, conversationId, body, clientActionId,
    );
    expect(first.statusCode).toBe(201);
    const stored = first.json();
    expect(stored.isDuplicate).toBe(false);
    expect(await messageCount(conversationId)).toBe(1);
    expect(await messageActivityCount(conversationId, clientActionId)).toBe(1);

    const operatorEmail = `op-${randomUUID()}@example.com`;
    await grantOperator(operatorEmail);
    const operatorCookie = await operatorLogin(fixture.app, operatorEmail);
    expect((await putModule(fixture.app, operatorCookie, 'MESSAGING', false, 1)).statusCode).toBe(200);

    const blocked = await sendMessage(
      fixture.app, fixture.adminCookie, conversationId, body, clientActionId,
    );
    expect(blocked.statusCode).toBe(404);
    expect(blocked.json().code).toBe('NOT_FOUND');
    // The stored receipt is untouched by the rejected retry.
    expect(await messageCount(conversationId)).toBe(1);
    expect(await messageActivityCount(conversationId, clientActionId)).toBe(1);

    expect((await putModule(fixture.app, operatorCookie, 'MESSAGING', true, 2)).statusCode).toBe(200);

    const replay = await sendMessage(
      fixture.app, fixture.adminCookie, conversationId, body, clientActionId,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: stored.id, isDuplicate: true, body });
    expect(await messageCount(conversationId)).toBe(1);
    expect(await messageActivityCount(conversationId, clientActionId)).toBe(1);
  });
});

// ---------------------------------------------------------------- MS6

describe.skipIf(!databaseUrl)('MS6 notification center hides conversation rows while disabled (S5)', { timeout: 90_000 }, () => {
  it('excludes them from list/unread, refuses direct mutation, preserves rows and restores read state', async () => {
    const fixture = await messagingFixture({ messagingEnabled: true });
    const conversationId = await createJobConversation(
      fixture.app, fixture.adminCookie, fixture.jobId, fixture.staff.id,
    );
    const sent = await sendMessage(
      fixture.app, fixture.adminCookie, conversationId, 'Bildirim üreten mesaj', `msg-${randomUUID()}`,
    );
    expect(sent.statusCode).toBe(201);

    // A: producer-created, unread conversation notification.
    const unreadConversationId = await conversationNotificationId(fixture.staff.id, conversationId);
    // B: read conversation notification.
    const readAt = new Date('2026-11-26T09:00:00.000Z');
    const readConversationId = await seedConversationNotification({
      organizationId: fixture.organizationId,
      conversationId,
      actorUserId: fixture.admin.id,
      recipientUserId: fixture.staff.id,
      readAt,
    });
    // C: read job-card notification, D: unread job-card notification.
    const readJobId = await seedJobCardNotification({
      organizationId: fixture.organizationId,
      jobId: fixture.jobId,
      actorUserId: fixture.admin.id,
      recipientUserId: fixture.staff.id,
      readAt,
    });
    const unreadJobId = await seedJobCardNotification({
      organizationId: fixture.organizationId,
      jobId: fixture.jobId,
      actorUserId: fixture.admin.id,
      recipientUserId: fixture.staff.id,
      readAt: null,
    });
    const allIds = [unreadConversationId, readConversationId, readJobId, unreadJobId];

    const listEnabled = await call(fixture.app, 'GET', '/api/notifications', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(listEnabled.statusCode).toBe(200);
    expect(listEnabled.json().items).toHaveLength(4);
    const beforeEnabled = await call(fixture.app, 'GET', '/api/notifications/unread-count', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(beforeEnabled.json().unreadCount).toBe(2);

    const operatorEmail = `op-${randomUUID()}@example.com`;
    await grantOperator(operatorEmail);
    const operatorCookie = await operatorLogin(fixture.app, operatorEmail);
    expect((await putModule(fixture.app, operatorCookie, 'MESSAGING', false, 1)).statusCode).toBe(200);

    const list = await call(fixture.app, 'GET', '/api/notifications', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(2);
    expect(list.json().items.map((item: { id: string }) => item.id).sort())
      .toEqual([readJobId, unreadJobId].sort());
    expect(list.json().items.every(
      (item: { entity: { type: string } }) => item.entity.type === 'job-card',
    )).toBe(true);

    const unread = await call(fixture.app, 'GET', '/api/notifications/unread-count', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(unread.json().unreadCount).toBe(1); // only the unread job-card row

    const before = await notificationRows(allIds);

    const markRead = await call(
      fixture.app, 'PATCH', `/api/notifications/${unreadConversationId}/read`, undefined,
      { cookie: fixture.staffCookie },
    );
    expect(markRead.statusCode).toBe(404);
    expect(['NOT_FOUND', 'NOTIFICATION_NOT_FOUND']).toContain(markRead.json().code);

    const dismiss = await call(
      fixture.app, 'POST', `/api/notifications/${unreadConversationId}/dismiss`, undefined,
      { cookie: fixture.staffCookie },
    );
    expect(dismiss.statusCode).toBe(404);
    expect(['NOT_FOUND', 'NOTIFICATION_NOT_FOUND']).toContain(dismiss.json().code);

    const byEntity = await call(fixture.app, 'POST', '/api/notifications/read-by-entity', {
      entityType: 'conversation',
      entityId: conversationId,
    }, { cookie: fixture.staffCookie });
    expect(byEntity.statusCode).toBe(404);
    expect(['NOT_FOUND', 'NOTIFICATION_NOT_FOUND']).toContain(byEntity.json().code);

    // The refused mutations wrote nothing at all.
    expect(await notificationRows(allIds)).toEqual(before);

    // clear-read must not dismiss the hidden read conversation row, while the
    // visible read job-card row is cleared as usual.
    const clearRead = await call(fixture.app, 'POST', '/api/notifications/clear-read', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(clearRead.statusCode).toBe(204);
    const afterClearRead = await notificationRows(allIds);
    expect(notificationById(afterClearRead, readConversationId).dismissed_at).toBeNull();
    expect(notificationById(afterClearRead, readConversationId).read_at).toEqual(readAt);
    expect(notificationById(afterClearRead, readJobId).dismissed_at).not.toBeNull();
    expect(notificationById(afterClearRead, unreadConversationId).dismissed_at).toBeNull();

    // clear-all must not dismiss either conversation row.
    const clearAll = await call(fixture.app, 'POST', '/api/notifications/clear-all', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(clearAll.statusCode).toBe(204);
    const afterClearAll = await notificationRows(allIds);
    expect(notificationById(afterClearAll, unreadConversationId).dismissed_at).toBeNull();
    expect(notificationById(afterClearAll, unreadConversationId).read_at).toBeNull();
    expect(notificationById(afterClearAll, readConversationId).dismissed_at).toBeNull();
    expect(notificationById(afterClearAll, readConversationId).read_at).toEqual(readAt);
    expect(notificationById(afterClearAll, unreadJobId).dismissed_at).not.toBeNull();

    // Re-enable: both conversation rows come back with their original state.
    expect((await putModule(fixture.app, operatorCookie, 'MESSAGING', true, 2)).statusCode).toBe(200);
    const restored = await call(fixture.app, 'GET', '/api/notifications', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().items.map((item: { id: string }) => item.id).sort())
      .toEqual([readConversationId, unreadConversationId].sort());
    const restoredRows = restored.json().items as Array<{
      id: string; readAt: string | null; entity: { type: string };
    }>;
    expect(restoredRows.find((item) => item.id === unreadConversationId)?.readAt).toBeNull();
    expect(restoredRows.find((item) => item.id === readConversationId)?.readAt)
      .toBe(readAt.toISOString());

    const restoredUnread = await call(
      fixture.app, 'GET', '/api/notifications/unread-count', undefined,
      { cookie: fixture.staffCookie },
    );
    expect(restoredUnread.json().unreadCount).toBe(1);

    // Fail closed: an unreadable module state (missing row) also hides the
    // conversation rows instead of exposing them.
    await pool.query(`DELETE FROM installation_module_state WHERE module_key = 'MESSAGING'`);
    const unreadable = await call(fixture.app, 'GET', '/api/notifications', undefined, {
      cookie: fixture.staffCookie,
    });
    expect(unreadable.statusCode).toBe(200);
    expect(unreadable.json().items).toHaveLength(0);
    const unreadableCount = await call(
      fixture.app, 'GET', '/api/notifications/unread-count', undefined,
      { cookie: fixture.staffCookie },
    );
    expect(unreadableCount.json().unreadCount).toBe(0);
  });
});

// ---------------------------------------------------------------- MS7

type PushFixture = Readonly<{
  at: Date;
  organizationId: string;
  actorId: string;
  recipientId: string;
  conversationId: string;
}>;

function hexToken(): string {
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
}

async function pushFixture(): Promise<PushFixture> {
  const at = new Date('2026-07-22T10:00:00.000Z');
  const organizationId = await seedOrganization();
  const actor = await seedUser(organizationId, 'Push Actor', 'ADMIN');
  const recipient = await seedUser(organizationId, 'Push Recipient', 'STAFF');
  const conversation = await pool.query<{ id: string }>(
    `INSERT INTO conversations (organization_id, direct_key, context_type, title)
     VALUES ($1, $2, 'GENERAL', 'Push konuşması')
     RETURNING id`,
    [organizationId, `msg-runtime:${randomUUID()}`],
  );

  return {
    at,
    organizationId,
    actorId: actor.id,
    recipientId: recipient.id,
    conversationId: conversation.rows[0]!.id,
  };
}

/**
 * Every delivery gets its own active session/subscription. Two deliveries of
 * one subscription process concurrently would both upgrade the same SHARE lock
 * to an UPDATE inside the delivery lifecycle guard; the loser aborts and, with
 * the fixed test clock, its lease would never expire. One subscription per
 * delivery keeps this acceptance test focused on the module switch.
 */
async function addPushSubscription(
  organizationId: string,
  recipientId: string,
  at: Date,
): Promise<string> {
  const session = await pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, '2099-01-01T00:00:00Z', '2026-07-22T08:00:00Z')
     RETURNING id`,
    [recipientId, hexToken()],
  );
  const subscription = await pool.query<{ id: string }>(
    `INSERT INTO web_push_subscriptions
       (organization_id, recipient_user_id, session_id, endpoint, endpoint_hash,
        p256dh, auth, vapid_public_key_fingerprint, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'test-p256dh', 'test-auth', $6, $7, $7)
     RETURNING id`,
    [
      organizationId,
      recipientId,
      session.rows[0]!.id,
      `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      hexToken(),
      'a'.repeat(64),
      at,
    ],
  );
  return subscription.rows[0]!.id;
}

async function seedPushDelivery(
  organizationId: string,
  notificationId: string,
  subscriptionId: string,
  at: Date,
  options: { state?: 'PENDING' | 'CLAIMED'; leaseToken?: string; leaseUntil?: Date; attemptCount?: number } = {},
): Promise<string> {
  const state = options.state ?? 'PENDING';
  const result = await pool.query<{ id: string }>(
    `INSERT INTO web_push_deliveries
       (organization_id, notification_id, subscription_id, state, attempt_count,
        next_attempt_at, lease_token, lease_until, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6, $6)
     RETURNING id`,
    [
      organizationId,
      notificationId,
      subscriptionId,
      state,
      options.attemptCount ?? 0,
      at,
      options.leaseToken ?? null,
      options.leaseUntil ?? null,
    ],
  );
  return result.rows[0]!.id;
}

type DeliveryRow = {
  id: string;
  state: string;
  attempt_count: number;
  lease_token: string | null;
  lease_until: Date | null;
  last_error_code: string | null;
  abandoned_at: Date | null;
};

async function deliveryRow(deliveryId: string): Promise<DeliveryRow> {
  const result = await pool.query<DeliveryRow>(
    `SELECT id, state, attempt_count, lease_token, lease_until, last_error_code, abandoned_at
       FROM web_push_deliveries WHERE id = $1`,
    [deliveryId],
  );
  return result.rows[0]!;
}

async function waitFor(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function pushDispatcher(
  at: Date,
  sent: string[],
  readMessagingEnabled?: () => Promise<boolean>,
) {
  return createDispatcher({ pollIntervalMs: 10, gracePeriodMs: 500 }, {
    repository: new PostgresWebPushRepository(pool),
    sender: {
      send: async (input) => {
        sent.push(input.payload.notificationId);
        return { type: 'response' as const, statusCode: 201 };
      },
    },
    buildPayload: (notification) => ({
      version: 1 as const,
      notificationId: notification.id,
      title: notification.title,
      body: notification.body,
      url: '/notifications',
    }),
    topicBuilder: (notificationId) => notificationId.replaceAll('-', ''),
    clock: () => at,
    ...(readMessagingEnabled ? { readMessagingEnabled } : {}),
  });
}

describe.skipIf(!databaseUrl)('MS7 the push dispatcher respects the disabled module (S6)', { timeout: 90_000 }, () => {
  it('abandons pending conversation deliveries, keeps a live lease, never claims when unreadable and never revives', async () => {
    const fixture = await pushFixture();
    const { at, organizationId, actorId, recipientId, conversationId } = fixture;
    const jobId = await seedAcceptedJob(organizationId, recipientId, actorId);

    const conversationNotification = await seedConversationNotification({
      organizationId,
      conversationId,
      actorUserId: actorId,
      recipientUserId: recipientId,
      readAt: null,
    });
    const jobNotification = await seedJobCardNotification({
      organizationId,
      jobId,
      actorUserId: actorId,
      recipientUserId: recipientId,
      readAt: null,
    });
    const leasedNotification = await seedConversationNotification({
      organizationId,
      conversationId,
      actorUserId: actorId,
      recipientUserId: recipientId,
      readAt: null,
    });

    const conversationDelivery = await seedPushDelivery(
      organizationId,
      conversationNotification,
      await addPushSubscription(organizationId, recipientId, at),
      at,
    );
    const jobDelivery = await seedPushDelivery(
      organizationId,
      jobNotification,
      await addPushSubscription(organizationId, recipientId, at),
      at,
    );
    const leaseToken = randomUUID();
    const leasedDelivery = await seedPushDelivery(
      organizationId,
      leasedNotification,
      await addPushSubscription(organizationId, recipientId, at),
      at,
      {
        state: 'CLAIMED',
        attemptCount: 1,
        leaseToken,
        leaseUntil: new Date(at.getTime() + 30_000),
      },
    );

    // Tick 1: disabled -> pending conversation push is abandoned, other push is
    // delivered, a live in-flight lease is left to finish.
    const sentDisabled: string[] = [];
    const disabledDispatcher = pushDispatcher(at, sentDisabled, async () => false);
    try {
      disabledDispatcher.start();
      await waitFor(
        async () => (await deliveryRow(jobDelivery)).state === 'DELIVERED',
        'the non-conversation push delivery',
      );
    } finally {
      await disabledDispatcher.stop();
    }

    const abandoned = await deliveryRow(conversationDelivery);
    expect(abandoned).toMatchObject({
      state: 'ABANDONED',
      last_error_code: 'MODULE_DISABLED',
      lease_token: null,
      lease_until: null,
    });
    expect(abandoned.abandoned_at).not.toBeNull();
    expect(await deliveryRow(jobDelivery)).toMatchObject({ state: 'DELIVERED' });
    expect(sentDisabled).toEqual([jobNotification]);

    const liveLease = await deliveryRow(leasedDelivery);
    expect(liveLease).toMatchObject({ state: 'CLAIMED', lease_token: leaseToken });
    expect(liveLease.abandoned_at).toBeNull();

    // Tick 2: an unreadable module state never abandons and never claims
    // conversation deliveries; other deliveries still flow.
    const unreadableConversationNotification = await seedConversationNotification({
      organizationId,
      conversationId,
      actorUserId: actorId,
      recipientUserId: recipientId,
      readAt: null,
    });
    const unreadableConversationDelivery = await seedPushDelivery(
      organizationId,
      unreadableConversationNotification,
      await addPushSubscription(organizationId, recipientId, at),
      at,
    );
    const healthyJobNotification = await seedJobCardNotification({
      organizationId,
      jobId,
      actorUserId: actorId,
      recipientUserId: recipientId,
      readAt: null,
    });
    const healthyJobDelivery = await seedPushDelivery(
      organizationId,
      healthyJobNotification,
      await addPushSubscription(organizationId, recipientId, at),
      at,
    );

    const sentUnreadable: string[] = [];
    const unreadableDispatcher = pushDispatcher(at, sentUnreadable, async () => {
      throw new Error('module state store unavailable');
    });
    try {
      unreadableDispatcher.start();
      await waitFor(
        async () => (await deliveryRow(healthyJobDelivery)).state === 'DELIVERED',
        'the non-conversation push delivery while unreadable',
      );
    } finally {
      await unreadableDispatcher.stop();
    }

    expect(await deliveryRow(unreadableConversationDelivery)).toMatchObject({
      state: 'PENDING',
      attempt_count: 0,
      lease_token: null,
      last_error_code: null,
      abandoned_at: null,
    });
    expect(sentUnreadable).toEqual([healthyJobNotification]);
    // The earlier abandonment is not rewritten by the unreadable tick.
    expect((await deliveryRow(conversationDelivery)).abandoned_at)
      .toEqual(abandoned.abandoned_at);

    // Tick 3: re-enabled -> an abandoned delivery is never revived.
    const laterConversationNotification = await seedConversationNotification({
      organizationId,
      conversationId,
      actorUserId: actorId,
      recipientUserId: recipientId,
      readAt: null,
    });
    const laterConversationDelivery = await seedPushDelivery(
      organizationId,
      laterConversationNotification,
      await addPushSubscription(organizationId, recipientId, at),
      at,
    );

    const sentEnabled: string[] = [];
    const enabledDispatcher = pushDispatcher(at, sentEnabled, async () => true);
    try {
      enabledDispatcher.start();
      await waitFor(
        async () => (await deliveryRow(laterConversationDelivery)).state === 'DELIVERED',
        'the conversation push delivery after re-enable',
      );
    } finally {
      await enabledDispatcher.stop();
    }

    // The delivery that was merely held while unreadable is a normal PENDING
    // delivery and is delivered once the module is readable again; the one
    // abandoned while disabled is not part of this batch.
    expect(sentEnabled.slice().sort()).toEqual(
      [laterConversationNotification, unreadableConversationNotification].sort(),
    );
    expect(sentEnabled).not.toContain(conversationNotification);
    expect(await deliveryRow(conversationDelivery)).toMatchObject({
      state: 'ABANDONED',
      last_error_code: 'MODULE_DISABLED',
    });
    expect((await deliveryRow(conversationDelivery)).abandoned_at)
      .toEqual(abandoned.abandoned_at);
  });
});

// ---------------------------------------------------------------- MS8

describe.skipIf(!databaseUrl)('MS8 realtime catch-up hides conversation events while disabled (S7)', { timeout: 90_000 }, () => {
  it('skips conversation events, advances the cursor past them and does not replay after re-enable', async () => {
    const organizationId = await seedOrganization();
    const viewerUser = await seedUser(organizationId, 'Realtime Manager', 'MANAGER');
    const worker = await seedUser(organizationId, 'Realtime Staff', 'STAFF');
    const jobId = await seedAcceptedJob(organizationId, worker.id, viewerUser.id);
    const viewer: RealtimeViewer = {
      organizationId,
      userId: viewerUser.id,
      role: 'MANAGER',
    };

    const appendJobEvent = async (eventType: RealtimeEventType) => {
      const activity = await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs
           (organization_id, job_card_id, actor_id, event_type)
         VALUES ($1, $2, $3, 'JOB_CANCELLED')
         RETURNING id`,
        [organizationId, jobId, viewerUser.id],
      );
      const row = await pool.query<{ id: string; created_at: Date }>(
        `INSERT INTO realtime_events
           (organization_id, source_activity_id, event_type, entity_type, entity_id,
            actor_user_id, audience_roles, audience_user_ids, resource_keys)
         VALUES ($1, $2, $3, 'job-card', $4, $5,
                 ARRAY['ADMIN', 'MANAGER']::VARCHAR(20)[], ARRAY[$5]::UUID[],
                 ARRAY['job-board', 'notifications'])
         RETURNING id, created_at`,
        [organizationId, activity.rows[0]!.id, eventType, jobId, viewerUser.id],
      );
      return {
        id: BigInt(row.rows[0]!.id),
        organizationId,
        sourceActivityId: activity.rows[0]!.id,
        messagingActivityId: null,
        type: eventType,
        entityType: 'job-card' as const,
        entityId: jobId,
        actorUserId: viewerUser.id,
        audience: { roles: ['ADMIN', 'MANAGER'] as const, userIds: [viewerUser.id] },
        resourceKeys: ['job-board', 'notifications'],
        occurredAt: row.rows[0]!.created_at,
      } satisfies RealtimeEventRecord;
    };

    const appendConversationEvent = async () => {
      const conversation = await pool.query<{ id: string }>(
        `INSERT INTO conversations (organization_id, direct_key, context_type, title)
         VALUES ($1, $2, 'GENERAL', 'Realtime konuşması')
         RETURNING id`,
        [organizationId, `realtime:${randomUUID()}`],
      );
      const activity = await pool.query<{ id: string }>(
        `INSERT INTO messaging_activity_logs
           (organization_id, conversation_id, actor_user_id, action, client_action_id, details)
         VALUES ($1, $2, $3, 'MESSAGE_SENT', $4, '{}'::jsonb)
         RETURNING id`,
        [organizationId, conversation.rows[0]!.id, viewerUser.id, randomUUID()],
      );
      const row = await pool.query<{ id: string; created_at: Date }>(
        `INSERT INTO realtime_events
           (organization_id, messaging_activity_id, event_type, entity_type, entity_id,
            actor_user_id, audience_roles, audience_user_ids, resource_keys)
         VALUES ($1, $2, 'message.sent', 'conversation', $3, $4,
                 ARRAY['ADMIN', 'MANAGER']::VARCHAR(20)[], ARRAY[$4]::UUID[],
                 ARRAY['conversations', 'notifications'])
         RETURNING id, created_at`,
        [organizationId, activity.rows[0]!.id, conversation.rows[0]!.id, viewerUser.id],
      );
      return {
        id: BigInt(row.rows[0]!.id),
        organizationId,
        sourceActivityId: null,
        messagingActivityId: activity.rows[0]!.id,
        type: 'message.sent' as const,
        entityType: 'conversation' as const,
        entityId: conversation.rows[0]!.id,
        actorUserId: viewerUser.id,
        audience: { roles: ['ADMIN', 'MANAGER'] as const, userIds: [viewerUser.id] },
        resourceKeys: ['conversations', 'notifications'],
        occurredAt: row.rows[0]!.created_at,
      } satisfies RealtimeEventRecord;
    };

    const jobEventOne = await appendJobEvent('job.created');
    const jobEventTwo = await appendJobEvent('job.updated');
    const conversationEvent = await appendConversationEvent();
    // The skipped event is deliberately the LAST of the opening batch so a
    // missing `lastSent` advancement is observable in the next cursor.
    expect(conversationEvent.id).toBeGreaterThan(jobEventTwo.id);

    const realRepository = new PostgresRealtimeEventRepository(pool);
    const afterIds: bigint[] = [];
    const repository = {
      visibleHighWater: (target: RealtimeViewer) => realRepository.visibleHighWater(target),
      replayVisible: (target: RealtimeViewer, afterId: bigint, limit: number) => {
        afterIds.push(afterId);
        return realRepository.replayVisible(target, afterId, limit);
      },
    };

    let messagingVisible = false;
    const bus = new InMemoryRealtimeEventBus();
    const service = new RealtimeService(
      repository,
      bus,
      () => new Date('2026-11-26T10:00:00.000Z'),
      async () => messagingVisible,
    );
    const sent: string[] = [];
    const subscription = await service.open(viewer, 0n, {
      send: async (envelope) => { sent.push(envelope.id); },
    });

    try {
      expect(sent).toEqual([jobEventOne.id.toString(), jobEventTwo.id.toString()]);
      expect(afterIds[0]).toBe(0n);

      // A live job event wakes a catch-up. It must resume AFTER the skipped
      // conversation event, proving the cursor advanced without sending it.
      const liveJobEvent = await appendJobEvent('job.cancelled');
      bus.publish(liveJobEvent);
      await waitFor(async () => sent.length === 3, 'the live job event');
      expect(sent).toEqual([
        jobEventOne.id.toString(),
        jobEventTwo.id.toString(),
        liveJobEvent.id.toString(),
      ]);
      expect(afterIds[1]).toBe(conversationEvent.id);

      // Re-enable: a NEW conversation event is delivered, but the previously
      // skipped one is never replayed.
      messagingVisible = true;
      const liveConversationEvent = await appendConversationEvent();
      bus.publish(liveConversationEvent);
      await waitFor(async () => sent.length === 4, 'the live conversation event after re-enable');

      expect(sent).toEqual([
        jobEventOne.id.toString(),
        jobEventTwo.id.toString(),
        liveJobEvent.id.toString(),
        liveConversationEvent.id.toString(),
      ]);
      expect(sent).not.toContain(conversationEvent.id.toString());
      expect(afterIds[2]).toBe(liveJobEvent.id);
    } finally {
      subscription.close();
      service.close();
    }

    // History is preserved: the skip never deletes or rewrites rows.
    const stored = await pool.query<{ id: string; entity_type: string }>(
      `SELECT id, entity_type FROM realtime_events ORDER BY id`,
    );
    expect(stored.rows).toHaveLength(5);
    expect(stored.rows.map((row) => row.id)).toContain(conversationEvent.id.toString());
  });
});

// ---------------------------------------------------------------- MS9

describe.skipIf(!databaseUrl)('MS9 Staff offboarding stays module-independent (out-of-scope invariant)', { timeout: 90_000 }, () => {
  it('transfers JOB conversation participants and writes the messaging activity while messaging is off', async () => {
    const at = new Date('2026-08-25T09:00:00.000Z');
    const organizationId = await seedOrganization();
    const admin = await seedUser(organizationId, 'Offboarding Admin', 'ADMIN');
    const target = await seedUser(organizationId, 'Offboarding Target', 'STAFF');
    const replacement = await seedUser(organizationId, 'Offboarding Replacement', 'STAFF');

    await seedModuleState('OVERVIEW', true);
    await seedModuleState('MESSAGING', false);

    const jobId = await seedAcceptedJob(organizationId, target.id, admin.id);
    const conversation = await pool.query<{ id: string }>(
      `INSERT INTO conversations (organization_id, direct_key, context_type, job_id)
       VALUES ($1, $2, 'JOB', $3) RETURNING id`,
      [organizationId, `context:JOB:${jobId}`, jobId],
    );
    const conversationId = conversation.rows[0]!.id;
    await pool.query(
      `INSERT INTO conversation_participants (organization_id, conversation_id, user_id)
       VALUES ($1, $2, $3)`,
      [organizationId, conversationId, target.id],
    );

    const service = new PostgresStaffOffboardingService(pool, undefined, () => new Date(at));
    const plan = await service.preview(admin, target.id);
    expect(plan.jobConversations).toEqual([{ jobCardId: jobId, conversationId }]);

    const response = await service.execute(admin, target.id, {
      clientActionId: `offboard-${randomUUID()}`,
      planHash: plan.planHash,
      reasonCode: 'ACCESS_ENDED',
      jobDecisions: plan.jobs.map((job) => ({
        jobCardId: job.id,
        replacementUserId: replacement.id,
      })),
      calendarDecisions: [],
      followUpDecisions: [],
      customerDecisions: [],
      reminderDecisions: [],
    });
    expect(response.status).toBe('OFFBOARDED');

    const participants = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 ORDER BY user_id`,
      [conversationId],
    );
    expect(participants.rows.map((row) => row.user_id)).toEqual([replacement.id]);

    const activity = await pool.query<{
      action: string; details: { removedUserIds: string[]; addedUserIds: string[] };
    }>(
      `SELECT action, details FROM messaging_activity_logs
        WHERE conversation_id = $1 ORDER BY created_at`,
      [conversationId],
    );
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0]).toMatchObject({
      action: 'PARTICIPANTS_CHANGED',
      details: {
        removedUserIds: [target.id],
        addedUserIds: [replacement.id],
      },
    });

    const realtime = await pool.query<{ event_type: string; entity_type: string }>(
      `SELECT event_type, entity_type FROM realtime_events
        WHERE entity_id = $1 ORDER BY id`,
      [conversationId],
    );
    expect(realtime.rows).toEqual([
      { event_type: 'conversation.participants_changed', entity_type: 'conversation' },
    ]);

    // Offboarding never reads or rewrites the module switch.
    expect(await moduleRow('MESSAGING')).toMatchObject({
      enabled: false, version: 1, source: 'ENV_TAKEOVER',
    });
  });
});

// ---------------------------------------------------------------- MS10

const TOGGLE_SIDE_EFFECT_TABLES = [
  'users',
  'sessions',
  'operator_accounts',
  'operator_sessions',
  'operator_account_capabilities',
  'job_cards',
  'job_card_activity_logs',
  'conversations',
  'conversation_participants',
  'messages',
  'messaging_activity_logs',
  'in_app_notifications',
  'web_push_subscriptions',
  'web_push_deliveries',
  'realtime_events',
  'processed_actions',
  'audit_events',
] as const;

type TableCounts = Record<string, number>;

async function tableCounts(): Promise<TableCounts> {
  const counts: TableCounts = {};
  for (const table of TOGGLE_SIDE_EFFECT_TABLES) {
    counts[table] = Number((await pool.query(
      `SELECT count(*)::int AS n FROM ${table}`,
    )).rows[0].n);
  }
  return counts;
}

async function seedWebPushDeliveryFor(
  organizationId: string,
  userId: string,
  notificationId: string,
): Promise<string> {
  const session = await pool.query<{ id: string }>(
    `SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId],
  );
  const subscription = await pool.query<{ id: string }>(
    `INSERT INTO web_push_subscriptions
       (organization_id, recipient_user_id, session_id, endpoint, endpoint_hash,
        p256dh, auth, vapid_public_key_fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'test-p256dh', 'test-auth', $6)
     RETURNING id`,
    [
      organizationId,
      userId,
      session.rows[0]!.id,
      `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      hexToken(),
      'a'.repeat(64),
    ],
  );
  const delivery = await pool.query<{ id: string }>(
    `INSERT INTO web_push_deliveries
       (organization_id, notification_id, subscription_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [organizationId, notificationId, subscription.rows[0]!.id],
  );
  return delivery.rows[0]!.id;
}

describe.skipIf(!databaseUrl)('MS10 the operator toggle writes only module state and audit (S1)', { timeout: 90_000 }, () => {
  it('leaves every other table untouched, including the push queue, and rejects a stale version', async () => {
    const fixture = await messagingFixture({ messagingEnabled: true });
    const conversationId = await createJobConversation(
      fixture.app, fixture.adminCookie, fixture.jobId, fixture.staff.id,
    );
    const sent = await sendMessage(
      fixture.app, fixture.adminCookie, conversationId, 'Sayaç verisi', `msg-${randomUUID()}`,
    );
    expect(sent.statusCode).toBe(201);
    const notificationId = await conversationNotificationId(fixture.staff.id, conversationId);
    const deliveryId = await seedWebPushDeliveryFor(
      fixture.organizationId, fixture.staff.id, notificationId,
    );

    const operatorEmail = `op-${randomUUID()}@example.com`;
    const operatorId = await grantOperator(operatorEmail);
    const operatorCookie = await operatorLogin(fixture.app, operatorEmail);

    const before = await tableCounts();
    const auditsBefore = await auditCount();

    const off = await putModule(fixture.app, operatorCookie, 'MESSAGING', false, 1);
    expect(off.statusCode).toBe(200);
    expect(off.json().module).toMatchObject({
      key: 'MESSAGING', enabled: false, version: 2, source: 'OPERATOR',
    });

    const after = await tableCounts();
    expect(after).toEqual(before);
    expect(await auditCount()).toBe(auditsBefore + 1);
    expect((await deliveryRow(deliveryId)).state).toBe('PENDING');
    expect(await moduleRow('MESSAGING')).toMatchObject({
      enabled: false,
      version: 2,
      source: 'OPERATOR',
      updated_by_operator_id: operatorId,
    });

    const [event] = (await auditRows('MODULE_STATE_CHANGED'));
    expect(event).toMatchObject({
      actor_kind: 'OPERATOR',
      operator_id: operatorId,
      module_key: 'MESSAGING',
      old_value: { enabled: true, version: 1 },
      new_value: { enabled: false, version: 2 },
    });

    // Stale expectedVersion: 409 and absolutely no additional write.
    const stale = await putModule(fixture.app, operatorCookie, 'MESSAGING', true, 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('MODULE_VERSION_CONFLICT');
    expect(await moduleRow('MESSAGING')).toMatchObject({ enabled: false, version: 2 });
    expect(await tableCounts()).toEqual(after);
    expect(await auditCount()).toBe(auditsBefore + 1);
  });
});

// ---------------------------------------------------------------- S1 registry / S8 operator view

describe.skipIf(!databaseUrl)('S1/S8 registry descriptor and operator view (S1, S8)', { timeout: 60_000 }, () => {
  it('registers MESSAGING after OVERVIEW with the contract copy', () => {
    expect(findInstallationModule('MESSAGING')).toEqual(MESSAGING_DESCRIPTOR);
    expect(INSTALLATION_MODULES.map((module) => module.key)).toEqual(['OVERVIEW', 'MESSAGING']);
  });

  it('GET /api/operator/modules renders the MESSAGING row with its lists', async () => {
    const fixture = await messagingFixture({ messagingEnabled: false });
    const operatorEmail = `op-${randomUUID()}@example.com`;
    await grantOperator(operatorEmail);
    const operatorCookie = await operatorLogin(fixture.app, operatorEmail);

    const res = await call(fixture.app, 'GET', '/api/operator/modules', undefined, {
      cookie: operatorCookie,
    });
    expect(res.statusCode).toBe(200);
    const modules = res.json().modules as Array<Record<string, unknown>>;
    expect(modules).toHaveLength(2);
    const messaging = modules.find((module) => module.key === 'MESSAGING');
    expect(messaging).toMatchObject({
      key: 'MESSAGING',
      label: MESSAGING_DESCRIPTOR.label,
      description: MESSAGING_DESCRIPTOR.description,
      enabled: false,
      version: 1,
      source: 'ENV_TAKEOVER',
    });
    expect(messaging!.whenDisabled).toEqual([...MESSAGING_DESCRIPTOR.whenDisabled]);
    expect(messaging!.preserved).toEqual([...MESSAGING_DESCRIPTOR.preserved]);
  });
});

// ---------------------------------------------------------------- S2 gate helper

function enabledRow(key: string, enabled: boolean): ModuleStateRow {
  return {
    key: key as ModuleStateRow['key'],
    enabled,
    version: 1,
    source: 'ENV_TAKEOVER',
    updatedAt: new Date(0),
    updatedByOperatorId: null,
  };
}

function staticReader(row: ModuleStateRow | null): ModuleStateReader {
  return { read: async () => row };
}

describe.skipIf(!databaseUrl)('S2 shared module gate helper (S2)', { timeout: 60_000 }, () => {
  it('assertModuleEnabled maps enabled/disabled/missing/unreadable exactly as the contract states', async () => {
    const logger = { error: vi.fn() };

    await expect(assertModuleEnabled(
      staticReader(enabledRow('MESSAGING', true)), 'MESSAGING', logger,
    )).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();

    await expect(assertModuleEnabled(
      staticReader(enabledRow('MESSAGING', false)), 'MESSAGING', logger,
    )).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
      message: 'Sayfa bulunamadı.',
    });
    expect(logger.error).not.toHaveBeenCalled();

    await expect(assertModuleEnabled(
      staticReader(null), 'MESSAGING', logger,
    )).rejects.toMatchObject({
      code: 'MODULE_STATE_UNAVAILABLE',
      statusCode: 503,
      message: 'Modül durumu şu anda okunamıyor.',
    });

    const failing: ModuleStateReader = {
      read: async () => { throw new Error('module state store unavailable'); },
    };
    await expect(assertModuleEnabled(
      failing, 'MESSAGING', logger,
    )).rejects.toMatchObject({
      code: 'MODULE_STATE_UNAVAILABLE',
      statusCode: 503,
    });

    // A read failure is logged (the contract's explicit logging case).
    expect(logger.error).toHaveBeenCalled();

    const unavailable = moduleStateUnavailable();
    expect(unavailable).toBeInstanceOf(AppError);
    expect(unavailable.code).toBe('MODULE_STATE_UNAVAILABLE');
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.message).toBe('Modül durumu şu anda okunamıyor.');
  });

  it('moduleGate applies the same states inside a Fastify preHandler', async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      const response = toErrorResponse(error);
      return reply.code(response.statusCode).send(response.body);
    });
    app.get('/enabled', { preHandler: moduleGate(staticReader(enabledRow('MESSAGING', true)), 'MESSAGING') },
      async () => ({ ok: true }));
    app.get('/disabled', { preHandler: moduleGate(staticReader(enabledRow('MESSAGING', false)), 'MESSAGING') },
      async () => ({ ok: true }));
    app.get('/missing', { preHandler: moduleGate(staticReader(null), 'MESSAGING') },
      async () => ({ ok: true }));
    app.get('/failing', {
      preHandler: moduleGate({
        read: async () => { throw new Error('module state store unavailable'); },
      }, 'MESSAGING'),
    }, async () => ({ ok: true }));

    try {
      const enabled = await app.inject({ method: 'GET', url: '/enabled' });
      expect(enabled.statusCode).toBe(200);

      const disabled = await app.inject({ method: 'GET', url: '/disabled' });
      expect(disabled.statusCode).toBe(404);
      expect(disabled.json().code).toBe('NOT_FOUND');

      const missing = await app.inject({ method: 'GET', url: '/missing' });
      expect(missing.statusCode).toBe(503);
      expect(missing.json().code).toBe('MODULE_STATE_UNAVAILABLE');

      const failing = await app.inject({ method: 'GET', url: '/failing' });
      expect(failing.statusCode).toBe(503);
      expect(failing.json().code).toBe('MODULE_STATE_UNAVAILABLE');
    } finally {
      await app.close();
    }
  });
});
