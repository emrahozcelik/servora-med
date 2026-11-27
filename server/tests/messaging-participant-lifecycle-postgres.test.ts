import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * MSG-002 — Messaging participant lifecycle (independent acceptance tests).
 *
 * Written from the fixed MSG-002 contract against a real PostgreSQL 17 schema.
 * At the time this file was authored the worktree still carried the pre-MSG-002
 * implementation, so the `assigneeSync` assertions are expected to fail (RED).
 *
 * Contract coverage:
 *   L1  P1 pending sync hint + P2 sync of the hinted transition (A→B).
 *   L2  P2 immutable/latest transition authority (B→C before any sync).
 *   L3  P1/P2 terminal JobCard exclusion + terminal read/send policy.
 *   L4  P2 organization-wide ADMIN/MANAGER authority without membership;
 *       STAFF stays 403 and another organization stays opaque 404.
 *   L5  P1/P2 reassignment while MESSAGING is operator-disabled, then the real
 *       operator PUT re-enable and the hint/sync working afterwards.
 *   L6  P3 offboarding replacement read marker (latest message, unread 0).
 *   L7  P4 inactive participant receives no in-app notification draft.
 *   L8  P2 idempotent replay by a non-participant MANAGER writes nothing new.
 *
 * Out of scope here (owned by the web/UI worker): P5 persistent prompt,
 * calendar page behavior and the Playwright capture script.
 *
 * The imports intentionally use the contract names verbatim
 * (`AssigneeSyncHint`, `JobConversationLookup`, `assigneeSync`,
 * `transitionId`, `previousAssignee`, `newAssignee`).
 */
import { buildApp } from '../src/app.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations, type MigrationLogger } from '../src/db/migrate-runner.js';
import { toErrorResponse } from '../src/errors/index.js';
import { createSessionToken } from '../src/modules/auth/crypto.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { moduleGate } from '../src/modules/installation-modules/gate.js';
import {
  PostgresModuleStateReader,
  staticModuleStateReader,
  type ModuleStateReader,
} from '../src/modules/installation-modules/state.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { messagingRoutes } from '../src/modules/messaging/routes.js';
import { MessagingService } from '../src/modules/messaging/service.js';
import type { AssigneeSyncHint, JobConversationLookup } from '../src/modules/messaging/types.js';
import { PostgresOperatorRepository } from '../src/modules/operator/repository.js';
import { OperatorService } from '../src/modules/operator/service.js';
import { PostgresStaffOffboardingService } from '../src/modules/people/offboarding.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const ORIGIN = 'http://127.0.0.1:5173';
const SESSION_COOKIE = 'servora_session';
const OPERATOR_COOKIE = 'servora_operator_session';
const OPERATOR_PASSWORD = 'Operator-Pass#2026';

const silentLogger: MigrationLogger = { info: () => undefined, error: () => undefined };

/**
 * Full-app config for L5 only. `capabilities.messaging` is deliberately false:
 * MSG-001 makes the database module row the only runtime source, and L5 proves
 * the operator toggle — not the legacy env-shaped flag — drives the gate.
 */
const baseConfig = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 0,
  databaseUrl: databaseUrl ?? 'postgresql://unused-msg002',
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

// ---------------------------------------------------------------- fixture

let schema = '';
let adminPool: Pool;
let pool: Pool;
const openApps: Array<{ close(): Promise<unknown> }> = [];

beforeAll(async () => {
  if (!databaseUrl) return;
  adminPool = new Pool({ connectionString: databaseUrl });
  schema = `msg002_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  });
  await runMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    store: new PostgresMigrationStore(pool),
    logger: silentLogger,
  });
}, 120_000);

afterAll(async () => {
  if (!databaseUrl) return;
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
});

beforeEach(async () => {
  if (!databaseUrl) return;
  // CASCADE reaches every table that references organizations (users, jobs,
  // messaging, notifications, realtime, sessions, receipts/audit).
  await pool.query(
    `TRUNCATE organizations, operator_accounts, operator_sessions,
       operator_account_capabilities, operator_audit_events, installation_module_state
     RESTART IDENTITY CASCADE`,
  );
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function createOrganization(name: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [name],
  )).rows[0]!.id;
}

async function createUser(
  organizationId: string,
  name: string,
  role: SafeUser['role'],
  isActive = true,
): Promise<SafeUser> {
  const email = `${randomUUID()}@msg002.test`;
  const row = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'unused-msg002-test-hash', $4, $5) RETURNING id`,
    [organizationId, name, email, role, isActive],
  )).rows[0]!;
  if (role === 'STAFF') {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id) VALUES ($1, $2)`,
      [organizationId, row.id],
    );
  }
  return {
    id: row.id,
    organizationId,
    name,
    email,
    role,
    mustChangePassword: false,
    isActive,
    version: 1,
  };
}

/** Operational ACCEPTED JobCard assigned to `assignedTo` (M9 fixture shape). */
async function createJob(
  organizationId: string,
  actor: SafeUser,
  title: string,
  assignedTo: string,
): Promise<{ id: string; version: number }> {
  return (await pool.query<{ id: string; version: number }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        accepted_at, accepted_by, started_at)
     VALUES ($1, 'GENERAL_TASK', 'ACCEPTED', $2, $3, $4, NOW(), $4, NOW())
     RETURNING id, version`,
    [organizationId, title, assignedTo, actor.id],
  )).rows[0]!;
}

function messaging(): MessagingService {
  return new MessagingService(pool);
}

function jobCards(): JobCardService {
  return new JobCardService(new PostgresJobCardRepository(pool));
}

async function createCanonicalConversation(
  actor: SafeUser,
  jobId: string,
  staff: SafeUser,
): Promise<string> {
  const conversation = await messaging().createOrGetConversation(actor, {
    contextType: 'JOB',
    jobId,
    participantUserIds: [staff.id],
  });
  return conversation.id;
}

/** Job PATCH reassignment A→B and returns the immutable JOB_ASSIGNED activity id. */
async function reassign(
  actor: SafeUser,
  jobId: string,
  assignedTo: string,
  expectedVersion: number,
): Promise<string> {
  const patched = await jobCards().patch(actor, jobId, { expectedVersion, assignedTo });
  expect(
    patched.assignmentTransitionId,
    'Job PATCH must return the JOB_ASSIGNED activity id for an assignee change',
  ).not.toBeNull();
  return patched.assignmentTransitionId as string;
}

async function jobVersion(jobId: string): Promise<number> {
  return (await pool.query<{ version: number }>(
    `SELECT version FROM job_cards WHERE id = $1`,
    [jobId],
  )).rows[0]!.version;
}

async function seedMessage(actor: SafeUser, conversationId: string, body: string): Promise<void> {
  await messaging().sendMessage(actor, conversationId, body, `msg002-seed-${randomUUID()}`);
}

/**
 * Direct message insert with an explicit created_at. L6 needs two historical
 * messages whose ordering is unambiguous for both
 * `findLatestMessageId` (created_at DESC, id DESC) and any implementation that
 * reads the maximum created_at.
 */
async function seedMessageAt(
  conversationId: string,
  sender: SafeUser,
  body: string,
  createdAt: string,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO messages
       (conversation_id, organization_id, sender_user_id, client_action_id, body, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [conversationId, sender.organizationId, sender.id, `msg002-at-${randomUUID()}`, body, createdAt],
  )).rows[0]!.id;
}

async function setTerminalStatus(
  jobId: string,
  status: 'COMPLETED' | 'CANCELLED' | 'INVALIDATED',
  actorId: string,
): Promise<void> {
  if (status === 'COMPLETED') {
    // 002 + 006: COMPLETED requires the started and approval timestamps.
    await pool.query(
      `UPDATE job_cards
          SET status = 'COMPLETED',
              started_at = COALESCE(started_at, NOW()),
              staff_completed_at = NOW(), staff_completed_by = $2,
              manager_approved_at = NOW(), manager_approved_by = $2
        WHERE id = $1`,
      [jobId, actorId],
    );
    return;
  }
  if (status === 'CANCELLED') {
    await pool.query(
      `UPDATE job_cards
          SET status = 'CANCELLED',
              cancelled_at = NOW(), cancelled_by = $2,
              cancel_reason = 'MSG-002 terminal policy test'
        WHERE id = $1`,
      [jobId, actorId],
    );
    return;
  }
  await pool.query(
    `UPDATE job_cards
        SET status = 'INVALIDATED',
            invalidated_at = NOW(), invalidated_by = $2,
            invalidation_reason_code = 'DUPLICATE'
      WHERE id = $1`,
    [jobId, actorId],
  );
}

async function participantIdsOf(conversationId: string): Promise<string[]> {
  const rows = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 ORDER BY user_id`,
    [conversationId],
  );
  return rows.rows.map((row) => row.user_id);
}

async function participantReadMarker(
  conversationId: string,
  userId: string,
): Promise<{ last_read_message_id: string | null } | null> {
  const rows = await pool.query<{ last_read_message_id: string | null }>(
    `SELECT last_read_message_id
       FROM conversation_participants
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  return rows.rows[0] ?? null;
}

async function latestMessageId(conversationId: string): Promise<string | null> {
  return (await pool.query<{ id: string }>(
    `SELECT id FROM messages WHERE conversation_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [conversationId],
  )).rows[0]?.id ?? null;
}

async function messageCount(conversationId: string): Promise<number> {
  return (await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1`,
    [conversationId],
  )).rows[0]!.n;
}

// ---------------------------------------------------------------- HTTP apps

type LookupResult = Readonly<{
  status: number;
  json: Record<string, unknown>;
  lookup: JobConversationLookup;
}>;

async function buildMessagingApp(
  actor: SafeUser,
  reader: ModuleStateReader = staticModuleStateReader(true),
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    reply.code(response.statusCode).send(response.body);
  });
  const authenticate: preHandlerHookHandler = async (request) => {
    (request as { currentUser?: SafeUser }).currentUser = actor;
  };
  await app.register(messagingRoutes, {
    prefix: '/api/messaging',
    service: messaging(),
    authenticate,
    gate: moduleGate(reader, 'MESSAGING'),
  });
  return app;
}

async function appFor(
  actor: SafeUser,
  reader?: ModuleStateReader,
): Promise<FastifyInstance> {
  const app = await buildMessagingApp(actor, reader);
  openApps.push(app);
  return app;
}

async function lookup(app: FastifyInstance, jobId: string): Promise<LookupResult> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/messaging/conversations/job/${jobId}`,
  });
  const json = JSON.parse(res.body) as Record<string, unknown>;
  return { status: res.statusCode, json, lookup: json as unknown as JobConversationLookup };
}

/**
 * Reads `assigneeSync` from a 200 lookup and asserts the key is present. The
 * contract type is `AssigneeSyncHint | null`, so an omitted key is a contract
 * violation even when the runtime value would be falsy.
 */
function assigneeSyncOf(result: LookupResult): AssigneeSyncHint | null {
  expect(
    Object.hasOwn(result.json, 'assigneeSync'),
    'JOB conversation lookup must always expose the assigneeSync key',
  ).toBe(true);
  return result.lookup.assigneeSync;
}

async function syncRequest(
  app: FastifyInstance,
  conversationId: string,
  body: { clientActionId: string; assignmentTransitionId: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/messaging/conversations/${conversationId}/job-assignee-sync`,
    payload: body,
  });
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> };
}

async function notificationIdsFor(userId: string): Promise<string[]> {
  return (await pool.query<{ id: string }>(
    `SELECT id FROM in_app_notifications WHERE recipient_user_id = $1 ORDER BY created_at, id`,
    [userId],
  )).rows.map((row) => row.id);
}

async function syncWritesSnapshot(conversationId: string): Promise<{
  activity: number;
  realtime: number;
  messages: number;
  participants: number;
}> {
  return (await pool.query<{
    activity: number; realtime: number; messages: number; participants: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM messaging_activity_logs
         WHERE conversation_id = $1 AND action = 'PARTICIPANTS_CHANGED') AS activity,
       (SELECT count(*)::int FROM realtime_events
         WHERE entity_id = $1 AND event_type = 'conversation.participants_changed') AS realtime,
       (SELECT count(*)::int FROM messages WHERE conversation_id = $1) AS messages,
       (SELECT count(*)::int FROM conversation_participants WHERE conversation_id = $1) AS participants`,
    [conversationId],
  )).rows[0]!;
}

/** Real session row for the full `buildApp` surface used by L5. */
async function sessionCookieFor(userId: string): Promise<string> {
  const token = createSessionToken();
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
    [userId, token.tokenHash],
  );
  return `${SESSION_COOKIE}=${token.rawToken}`;
}

async function buildFullApp() {
  const app = await buildApp(baseConfig as Parameters<typeof buildApp>[0], {
    pool,
    authRepository: new PostgresAuthRepository(pool),
  });
  openApps.push(app);
  return app;
}

// ---------------------------------------------------------------- L1

describe.skipIf(!databaseUrl)('MSG-002 L1 — pending A→B sync hint and sync', { timeout: 60_000 }, () => {
  it('P1: a pending A→B reassignment exposes assigneeSync to ADMIN and MANAGER but never to STAFF', async () => {
    const organizationId = await createOrganization('L1 hint org');
    const admin = await createUser(organizationId, 'L1 Admin', 'ADMIN');
    const manager = await createUser(organizationId, 'L1 Manager', 'MANAGER');
    const staffA = await createUser(organizationId, 'L1 Staff A', 'STAFF');
    const staffB = await createUser(organizationId, 'L1 Staff B', 'STAFF');
    const job = await createJob(organizationId, admin, 'L1 hint job', staffA.id);
    const conversationId = await createCanonicalConversation(admin, job.id, staffA);
    const transitionId = await reassign(admin, job.id, staffB.id, job.version);

    // transitionId is the immutable JOB_ASSIGNED activity id, not a client token.
    const activity = await pool.query<{ event_type: string; new_value: unknown }>(
      `SELECT event_type, new_value FROM job_card_activity_logs WHERE id = $1`,
      [transitionId],
    );
    expect(activity.rows[0]).toEqual({
      event_type: 'JOB_ASSIGNED',
      new_value: { assignedTo: staffB.id },
    });

    // P1 is read-only: the lookups below never mutate membership or audit.
    const participantsBeforeLookups = await participantIdsOf(conversationId);
    const activitiesBeforeLookups = (await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messaging_activity_logs WHERE conversation_id = $1`,
      [conversationId],
    )).rows[0]!.n;

    const adminLookup = await lookup(await appFor(admin), job.id);
    expect(adminLookup.status).toBe(200);
    const adminHint = assigneeSyncOf(adminLookup);
    expect(adminHint).toMatchObject({
      transitionId,
      previousAssignee: { id: staffA.id, name: staffA.name },
      newAssignee: { id: staffB.id, name: staffB.name },
    });

    // MANAGER is organization-wide but not a persisted participant.
    expect(await participantIdsOf(conversationId)).not.toContain(manager.id);
    const managerLookup = await lookup(await appFor(manager), job.id);
    expect(managerLookup.status).toBe(200);
    expect(assigneeSyncOf(managerLookup)).toMatchObject({
      transitionId,
      previousAssignee: { id: staffA.id, name: staffA.name },
      newAssignee: { id: staffB.id, name: staffB.name },
    });

    // STAFF never receives a hint: A is no longer assigned, B is not a member.
    for (const staff of [staffA, staffB]) {
      const staffLookup = await lookup(await appFor(staff), job.id);
      expect(staffLookup.status).toBe(404);
      expect(staffLookup.json.assigneeSync).toBeUndefined();
      expect(JSON.stringify(staffLookup.json)).not.toContain(transitionId);
    }

    // Every lookup above was read-only.
    expect(await participantIdsOf(conversationId)).toEqual(participantsBeforeLookups);
    expect((await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messaging_activity_logs WHERE conversation_id = $1`,
      [conversationId],
    )).rows[0]!.n).toBe(activitiesBeforeLookups);
  });

  it('P2: syncing the hinted transition joins B with unread 0, removes A and clears the hint', async () => {
    const organizationId = await createOrganization('L1 sync org');
    const admin = await createUser(organizationId, 'L1 Sync Admin', 'ADMIN');
    const staffA = await createUser(organizationId, 'L1 Sync Staff A', 'STAFF');
    const staffB = await createUser(organizationId, 'L1 Sync Staff B', 'STAFF');
    const job = await createJob(organizationId, admin, 'L1 sync job', staffA.id);
    const conversationId = await createCanonicalConversation(admin, job.id, staffA);

    // History exists before the join: the read marker must absorb it.
    await seedMessage(admin, conversationId, 'Atama öncesi ilk mesaj');
    await seedMessage(admin, conversationId, 'Atama öncesi ikinci mesaj');
    const latestBeforeJoin = await latestMessageId(conversationId);
    expect(latestBeforeJoin).not.toBeNull();

    const transitionId = await reassign(admin, job.id, staffB.id, job.version);
    const adminApp = await appFor(admin);
    const hint = assigneeSyncOf(await lookup(adminApp, job.id));
    expect(hint?.transitionId).toBe(transitionId);

    const sync = await syncRequest(adminApp, conversationId, {
      clientActionId: `l1-sync-${randomUUID()}`,
      assignmentTransitionId: hint!.transitionId,
    });
    expect(sync.status).toBe(200);
    expect(sync.json).toMatchObject({ conversationId, synced: true, changed: true });

    // A removed, B added and inserted with the latest-message read marker.
    expect(await participantIdsOf(conversationId)).toEqual([admin.id, staffB.id].sort());
    expect(await participantReadMarker(conversationId, staffB.id)).toEqual({
      last_read_message_id: latestBeforeJoin,
    });
    const service = messaging();
    expect(await service.getUnreadCount(staffB)).toBe(0);
    await seedMessage(admin, conversationId, 'Atama sonrası yeni mesaj');
    expect(await service.getUnreadCount(staffB)).toBe(1);

    // One audit + one realtime event, bound to the exact transition.
    const activityRows = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM messaging_activity_logs
        WHERE conversation_id = $1 AND action = 'PARTICIPANTS_CHANGED'`,
      [conversationId],
    );
    expect(activityRows.rows).toHaveLength(1);
    expect(activityRows.rows[0]!.details).toMatchObject({
      assignmentTransitionId: transitionId,
      addedUserIds: [staffB.id],
      removedUserIds: [staffA.id],
    });
    const realtimeRows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM realtime_events
        WHERE entity_id = $1 AND event_type = 'conversation.participants_changed'`,
      [conversationId],
    );
    expect(realtimeRows.rows[0]!.n).toBe(1);

    // The hint is gone once B is a participant.
    const after = await lookup(adminApp, job.id);
    expect(after.status).toBe(200);
    expect(assigneeSyncOf(after)).toBeNull();

    // STAFF lookup now succeeds for B and still reports a null hint.
    const staffBLookup = await lookup(await appFor(staffB), job.id);
    expect(staffBLookup.status).toBe(200);
    expect(assigneeSyncOf(staffBLookup)).toBeNull();

    // The stale previous assignee loses access even though the row survived.
    const staffALookup = await lookup(await appFor(staffA), job.id);
    expect(staffALookup.status).toBe(404);
  });
});

// ---------------------------------------------------------------- L2

describe.skipIf(!databaseUrl)('MSG-002 L2 — second reassignment before sync', { timeout: 60_000 }, () => {
  it('P2: the hint follows B→C and the older A→B token is STALE_REASSIGNMENT', async () => {
    const organizationId = await createOrganization('L2 org');
    const admin = await createUser(organizationId, 'L2 Admin', 'ADMIN');
    const staffA = await createUser(organizationId, 'L2 Staff A', 'STAFF');
    const staffB = await createUser(organizationId, 'L2 Staff B', 'STAFF');
    const staffC = await createUser(organizationId, 'L2 Staff C', 'STAFF');
    const job = await createJob(organizationId, admin, 'L2 job', staffA.id);
    const conversationId = await createCanonicalConversation(admin, job.id, staffA);

    const firstTransitionId = await reassign(admin, job.id, staffB.id, job.version);
    // A distinct transaction clock keeps "latest JOB_ASSIGNED" unambiguous:
    // findLatestAssignmentActivityId orders created_at DESC, id DESC, and the
    // id tiebreak is a random UUID.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondTransitionId = await reassign(
      admin, job.id, staffC.id, await jobVersion(job.id),
    );
    expect(secondTransitionId).not.toBe(firstTransitionId);

    const adminApp = await appFor(admin);
    const hint = assigneeSyncOf(await lookup(adminApp, job.id));
    expect(hint).toMatchObject({
      transitionId: secondTransitionId,
      previousAssignee: { id: staffB.id, name: staffB.name },
      newAssignee: { id: staffC.id, name: staffC.name },
    });

    const stale = await syncRequest(adminApp, conversationId, {
      clientActionId: `l2-stale-${randomUUID()}`,
      assignmentTransitionId: firstTransitionId,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('STALE_REASSIGNMENT');
    // A rejected stale token must not mutate membership.
    expect(await participantIdsOf(conversationId)).toEqual([admin.id, staffA.id].sort());

    const fresh = await syncRequest(adminApp, conversationId, {
      clientActionId: `l2-fresh-${randomUUID()}`,
      assignmentTransitionId: secondTransitionId,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.json).toMatchObject({ conversationId, synced: true, changed: true });

    const participants = await participantIdsOf(conversationId);
    expect(participants).toContain(staffC.id);
    expect(participants).not.toContain(staffB.id);
  });
});

// ---------------------------------------------------------------- L3

describe.skipIf(!databaseUrl)('MSG-002 L3 — terminal JobCards', { timeout: 90_000 }, () => {
  it('P1/P2: terminal jobs report a null hint and reject the sync with 409', async () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'INVALIDATED'] as const) {
      const organizationId = await createOrganization(`L3 hint ${status}`);
      const admin = await createUser(organizationId, `${status} Admin`, 'ADMIN');
      const staffA = await createUser(organizationId, `${status} Staff A`, 'STAFF');
      const staffB = await createUser(organizationId, `${status} Staff B`, 'STAFF');
      const job = await createJob(organizationId, admin, `L3 hint ${status}`, staffA.id);
      const conversationId = await createCanonicalConversation(admin, job.id, staffA);
      // The only reason the hint is suppressed is the terminal status: the
      // transition is latest, B is STAFF and B is not a participant.
      const transitionId = await reassign(admin, job.id, staffB.id, job.version);
      await setTerminalStatus(job.id, status, admin.id);

      const adminApp = await appFor(admin);
      const res = await lookup(adminApp, job.id);
      expect(res.status, status).toBe(200);
      expect(assigneeSyncOf(res), status).toBeNull();

      const sync = await syncRequest(adminApp, conversationId, {
        clientActionId: `l3-${status}-${randomUUID()}`,
        assignmentTransitionId: transitionId,
      });
      expect(sync.status, status).toBe(409);
      // Terminal rejection happens before any membership mutation.
      expect(await participantIdsOf(conversationId), status).toEqual(
        [admin.id, staffA.id].sort(),
      );
    }
  });

  it('read stays available and send is refused for terminal COMPLETED/CANCELLED/INVALIDATED conversations (assigned STAFF participant)', async () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'INVALIDATED'] as const) {
      const organizationId = await createOrganization(`L3 terminal ${status}`);
      const admin = await createUser(organizationId, `${status} Read Admin`, 'ADMIN');
      const staff = await createUser(organizationId, `${status} Read Staff`, 'STAFF');
      const job = await createJob(organizationId, admin, `L3 terminal ${status}`, staff.id);
      const conversationId = await createCanonicalConversation(admin, job.id, staff);
      await seedMessage(admin, conversationId, 'Terminal öncesi son mesaj');
      await setTerminalStatus(job.id, status, admin.id);

      // STAFF is still the assigned participant: history remains readable.
      const staffApp = await appFor(staff);
      expect((await lookup(staffApp, job.id)).status, status).toBe(200);
      const messages = await staffApp.inject({
        method: 'GET',
        url: `/api/messaging/conversations/${conversationId}/messages`,
      });
      expect(messages.statusCode, status).toBe(200);
      expect((JSON.parse(messages.body) as { items: unknown[] }).items).toHaveLength(1);

      // Operational coordination has ended: send is refused with no side effect.
      const send = await staffApp.inject({
        method: 'POST',
        url: `/api/messaging/conversations/${conversationId}/messages`,
        payload: {
          body: 'Terminal sonrası mesaj',
          clientActionId: `l3-send-${status}-${randomUUID()}`,
        },
      });
      expect(send.statusCode, status).toBe(403);
      expect(await messageCount(conversationId), status).toBe(1);
    }
  });
});

// ---------------------------------------------------------------- L4

describe.skipIf(!databaseUrl)('MSG-002 L4 — sync authority without persisted membership', { timeout: 60_000 }, () => {
  it('P2: a same-org non-participant MANAGER syncs (200/true); STAFF is 403; another org is 404', async () => {
    const organizationId = await createOrganization('L4 org');
    const otherOrganizationId = await createOrganization('L4 other org');
    const admin = await createUser(organizationId, 'L4 Admin', 'ADMIN');
    const manager = await createUser(organizationId, 'L4 Manager', 'MANAGER');
    const otherOrgManager = await createUser(otherOrganizationId, 'L4 Other Manager', 'MANAGER');
    const staffA = await createUser(organizationId, 'L4 Staff A', 'STAFF');
    const staffB = await createUser(organizationId, 'L4 Staff B', 'STAFF');
    const job = await createJob(organizationId, admin, 'L4 job', staffA.id);
    const conversationId = await createCanonicalConversation(admin, job.id, staffA);
    const transitionId = await reassign(admin, job.id, staffB.id, job.version);
    const clientActionId = `l4-manager-${randomUUID()}`;

    // Membership is genuinely absent before the authority test.
    expect(await participantIdsOf(conversationId)).not.toContain(manager.id);

    for (const staff of [staffA, staffB]) {
      const staffSync = await syncRequest(await appFor(staff), conversationId, {
        clientActionId: `l4-staff-${randomUUID()}`,
        assignmentTransitionId: transitionId,
      });
      expect(staffSync.status).toBe(403);
    }

    const crossOrgSync = await syncRequest(await appFor(otherOrgManager), conversationId, {
      clientActionId: `l4-other-${randomUUID()}`,
      assignmentTransitionId: transitionId,
    });
    expect(crossOrgSync.status).toBe(404);
    expect(JSON.stringify(crossOrgSync.json)).not.toContain(conversationId);

    const managerSync = await syncRequest(await appFor(manager), conversationId, {
      clientActionId,
      assignmentTransitionId: transitionId,
    });
    expect(managerSync.status).toBe(200);
    expect(managerSync.json).toMatchObject({ conversationId, synced: true, changed: true });

    expect(await participantIdsOf(conversationId)).toEqual([admin.id, staffB.id].sort());
    const activity = await pool.query<{ actor_user_id: string; details: Record<string, unknown> }>(
      `SELECT actor_user_id, details FROM messaging_activity_logs
        WHERE conversation_id = $1 AND action = 'PARTICIPANTS_CHANGED'`,
      [conversationId],
    );
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0]).toMatchObject({
      actor_user_id: manager.id,
      details: { addedUserIds: [staffB.id], removedUserIds: [staffA.id] },
    });
    // ADMIN/MANAGER are never inserted as participants.
    expect(await participantIdsOf(conversationId)).not.toContain(manager.id);
  });
});

// ---------------------------------------------------------------- L5

describe.skipIf(!databaseUrl)('MSG-002 L5 — reassignment while MESSAGING is disabled', { timeout: 90_000 }, () => {
  it('P1/P2: a reassignment performed while disabled is offered and syncable after the operator PUT re-enable', async () => {
    const organizationId = await createOrganization('L5 org');
    const admin = await createUser(organizationId, 'L5 Admin', 'ADMIN');
    const staffA = await createUser(organizationId, 'L5 Staff A', 'STAFF');
    const staffB = await createUser(organizationId, 'L5 Staff B', 'STAFF');
    const job = await createJob(organizationId, admin, 'L5 job', staffA.id);
    const conversationId = await createCanonicalConversation(admin, job.id, staffA);

    // MESSAGING starts enabled at version 1 (ENV_TAKEOVER). Both directions of
    // the switch below go through the real operator PUT, like the pilot tests.
    await pool.query(
      `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
       VALUES ('MESSAGING', TRUE, 1, 'ENV_TAKEOVER', NOW())`,
    );

    const app = await buildFullApp();
    const adminCookie = await sessionCookieFor(admin.id);

    const operatorService = new OperatorService(
      new PostgresOperatorRepository(pool),
      new PostgresModuleStateReader(pool),
    );
    const operatorEmail = `op-${randomUUID()}@msg002.test`;
    await operatorService.grantOperator({
      email: operatorEmail,
      name: 'MSG-002 Operator',
      password: OPERATOR_PASSWORD,
    });
    const operatorLogin = await operatorService.login(operatorEmail, OPERATOR_PASSWORD);
    const operatorCookie = `${OPERATOR_COOKIE}=${operatorLogin.rawToken}`;
    const putModule = (enabled: boolean, expectedVersion: number) => app.inject({
      method: 'PUT',
      url: '/api/operator/modules/MESSAGING',
      headers: { cookie: operatorCookie, origin: ORIGIN },
      payload: { enabled, expectedVersion },
    });

    // Operator "off" (v1 → v2): both lookup and sync are hidden at the gate.
    const disable = await putModule(false, 1);
    expect(disable.statusCode).toBe(200);
    expect((JSON.parse(disable.body) as { module: Record<string, unknown> }).module).toMatchObject({
      key: 'MESSAGING',
      enabled: false,
      version: 2,
      source: 'OPERATOR',
    });

    const hiddenLookup = await app.inject({
      method: 'GET',
      url: `/api/messaging/conversations/job/${job.id}`,
      headers: { cookie: adminCookie },
    });
    expect(hiddenLookup.statusCode).toBe(404);
    expect((JSON.parse(hiddenLookup.body) as { code?: string }).code).toBe('NOT_FOUND');
    const hiddenSync = await app.inject({
      method: 'POST',
      url: `/api/messaging/conversations/${conversationId}/job-assignee-sync`,
      headers: { cookie: adminCookie },
      payload: {
        clientActionId: `l5-hidden-${randomUUID()}`,
        assignmentTransitionId: randomUUID(),
      },
    });
    expect(hiddenSync.statusCode).toBe(404);

    // The reassignment itself is a JobCard operation and is not module-gated.
    const transitionId = await reassign(admin, job.id, staffB.id, job.version);

    // Operator "on" (v2 → v3): the database is the runtime source.
    const enable = await putModule(true, 2);
    expect(enable.statusCode).toBe(200);
    expect((JSON.parse(enable.body) as { module: Record<string, unknown> }).module).toMatchObject({
      key: 'MESSAGING',
      enabled: true,
      version: 3,
      source: 'OPERATOR',
    });

    // Hint is available after re-enable and the pending transition still syncs.
    const lookupRes = await app.inject({
      method: 'GET',
      url: `/api/messaging/conversations/job/${job.id}`,
      headers: { cookie: adminCookie },
    });
    expect(lookupRes.statusCode).toBe(200);
    const lookupJson = JSON.parse(lookupRes.body) as Record<string, unknown>;
    expect(lookupJson.assigneeSync).toMatchObject({
      transitionId,
      previousAssignee: { id: staffA.id, name: staffA.name },
      newAssignee: { id: staffB.id, name: staffB.name },
    });

    const sync = await app.inject({
      method: 'POST',
      url: `/api/messaging/conversations/${conversationId}/job-assignee-sync`,
      headers: { cookie: adminCookie },
      payload: {
        clientActionId: `l5-sync-${randomUUID()}`,
        assignmentTransitionId: transitionId,
      },
    });
    expect(sync.statusCode).toBe(200);
    expect(JSON.parse(sync.body)).toMatchObject({
      conversationId,
      synced: true,
      changed: true,
    });
    expect(await participantIdsOf(conversationId)).toEqual([admin.id, staffB.id].sort());
    expect(await messaging().getUnreadCount(staffB)).toBe(0);
  });
});

// ---------------------------------------------------------------- L6

describe.skipIf(!databaseUrl)('MSG-002 L6 — offboarding replacement read marker', { timeout: 90_000 }, () => {
  it('P3: the replacement STAFF participant starts at the latest message with unread 0', async () => {
    const at = new Date('2026-08-25T09:00:00.000Z');
    const organizationId = await createOrganization('L6 org');
    const admin = await createUser(organizationId, 'L6 Admin', 'ADMIN');
    const target = await createUser(organizationId, 'L6 Target', 'STAFF');
    const replacement = await createUser(organizationId, 'L6 Replacement', 'STAFF');
    const job = await createJob(organizationId, admin, 'L6 job', target.id);
    const conversationId = await createCanonicalConversation(admin, job.id, target);

    // Distinct, deterministic history timestamps make "latest" unambiguous.
    await seedMessageAt(conversationId, admin, 'Birinci geçmiş mesaj', '2020-01-01T08:00:00.000Z');
    await seedMessageAt(conversationId, admin, 'İkinci geçmiş mesaj', '2020-01-01T08:01:00.000Z');
    const latest = await latestMessageId(conversationId);
    expect(latest).not.toBeNull();

    const offboarding = new PostgresStaffOffboardingService(pool, undefined, () => at);
    const plan = await offboarding.preview(admin, target.id);
    expect(plan.jobConversations).toContainEqual({ jobCardId: job.id, conversationId });

    const response = await offboarding.execute(admin, target.id, {
      clientActionId: `l6-offboard-${randomUUID()}`,
      planHash: plan.planHash,
      reasonCode: 'ACCESS_ENDED',
      jobDecisions: plan.jobs.map((item) => ({
        jobCardId: item.id,
        replacementUserId: replacement.id,
      })),
      calendarDecisions: [],
      followUpDecisions: [],
      customerDecisions: [],
      reminderDecisions: [],
    });
    expect(response.status).toBe('OFFBOARDED');

    // Target removed, replacement inserted; ADMIN creator membership unchanged.
    expect(await participantIdsOf(conversationId)).toEqual([admin.id, replacement.id].sort());
    expect(await participantReadMarker(conversationId, target.id)).toBeNull();
    expect(await participantReadMarker(conversationId, replacement.id)).toEqual({
      last_read_message_id: latest,
    });

    // The read marker means unread 0, not "no messages".
    const service = messaging();
    expect(await service.getUnreadCount(replacement)).toBe(0);
    await seedMessage(admin, conversationId, 'Devir sonrası yeni mesaj');
    expect(await service.getUnreadCount(replacement)).toBe(1);

    // Offboarding keeps exactly one participant-change activity for the thread.
    const activity = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM messaging_activity_logs
        WHERE conversation_id = $1 AND action = 'PARTICIPANTS_CHANGED'`,
      [conversationId],
    );
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0]!.details).toMatchObject({
      addedUserIds: [replacement.id],
      removedUserIds: [target.id],
    });
  });
});

// ---------------------------------------------------------------- L7

describe.skipIf(!databaseUrl)('MSG-002 L7 — inactive participants and in-app notifications', { timeout: 60_000 }, () => {
  it('P4: a deactivated participant gets no new notification draft; active participants and history stay intact', async () => {
    const organizationId = await createOrganization('L7 org');
    const admin = await createUser(organizationId, 'L7 Admin', 'ADMIN');
    const inactiveStaff = await createUser(organizationId, 'L7 Inactive Staff', 'STAFF');
    const activeStaff = await createUser(organizationId, 'L7 Active Staff', 'STAFF');
    const service = messaging();
    const conversation = await service.createOrGetConversation(admin, {
      contextType: 'GENERAL',
      title: 'L7 vardiya koordinasyonu',
      participantUserIds: [inactiveStaff.id, activeStaff.id],
    });

    // Baseline while both participants are active.
    await service.sendMessage(admin, conversation.id, 'İlk mesaj', `l7-first-${randomUUID()}`);
    const inactiveBefore = await notificationIdsFor(inactiveStaff.id);
    const activeBefore = await notificationIdsFor(activeStaff.id);
    expect(inactiveBefore).toHaveLength(1);
    expect(activeBefore).toHaveLength(1);

    await pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [inactiveStaff.id]);
    await service.sendMessage(admin, conversation.id, 'İkinci mesaj', `l7-second-${randomUUID()}`);

    // Inactive: participant row + prior notification preserved, no new draft.
    expect(await participantIdsOf(conversation.id)).toEqual(
      [admin.id, inactiveStaff.id, activeStaff.id].sort(),
    );
    expect(await notificationIdsFor(inactiveStaff.id)).toEqual(inactiveBefore);
    // Active: still receives the new draft.
    const activeAfter = await notificationIdsFor(activeStaff.id);
    expect(activeAfter).toHaveLength(2);
    expect(activeAfter).toEqual(expect.arrayContaining(activeBefore));
    // The sender never notifies itself.
    expect(await notificationIdsFor(admin.id)).toEqual([]);

    // History and identity remain unchanged for the inactive participant.
    const messages = await service.getMessages(admin, conversation.id, null, 20);
    expect(messages.items).toHaveLength(2);
    expect(messages.items.map((message) => message.body)).toEqual(
      expect.arrayContaining(['İlk mesaj', 'İkinci mesaj']),
    );
  });
});

// ---------------------------------------------------------------- L8

describe.skipIf(!databaseUrl)('MSG-002 L8 — idempotent replay by a non-participant MANAGER', { timeout: 60_000 }, () => {
  it('P2: replay returns changed:false and writes no new participant-change state', async () => {
    const organizationId = await createOrganization('L8 org');
    const admin = await createUser(organizationId, 'L8 Admin', 'ADMIN');
    const manager = await createUser(organizationId, 'L8 Manager', 'MANAGER');
    const staffA = await createUser(organizationId, 'L8 Staff A', 'STAFF');
    const staffB = await createUser(organizationId, 'L8 Staff B', 'STAFF');
    const job = await createJob(organizationId, admin, 'L8 job', staffA.id);
    const conversationId = await createCanonicalConversation(admin, job.id, staffA);
    const transitionId = await reassign(admin, job.id, staffB.id, job.version);
    expect(await participantIdsOf(conversationId)).not.toContain(manager.id);

    const managerApp = await appFor(manager);
    const body = {
      clientActionId: `l8-replay-${randomUUID()}`,
      assignmentTransitionId: transitionId,
    };

    const first = await syncRequest(managerApp, conversationId, body);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ conversationId, synced: true, changed: true });
    expect(await syncWritesSnapshot(conversationId)).toMatchObject({
      activity: 1,
      realtime: 1,
      participants: 2,
    });
    const afterFirst = await syncWritesSnapshot(conversationId);
    const participantsAfterFirst = await participantIdsOf(conversationId);

    const replay = await syncRequest(managerApp, conversationId, body);
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ conversationId, synced: true, changed: false });

    expect(await syncWritesSnapshot(conversationId)).toEqual(afterFirst);
    expect(await participantIdsOf(conversationId)).toEqual(participantsAfterFirst);
    // A different clientActionId must not be needed, and the replay must not
    // insert the ADMIN/MANAGER actor as a participant.
    expect(await participantIdsOf(conversationId)).not.toContain(manager.id);
  });
});
