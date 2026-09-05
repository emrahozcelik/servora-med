import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { createSessionToken } from '../src/modules/auth/crypto.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';
import { PostgresCalendarReminderWorkerRepository } from '../src/modules/calendar/reminder-worker.js';
import { InMemoryRealtimeEventBus } from '../src/modules/realtime/event-bus.js';
import { PostgresRealtimeEventRepository } from '../src/modules/realtime/repository.js';
import { RealtimeService } from '../src/modules/realtime/service.js';
import {
  PostgresStaffOffboardingService,
  type OffboardingDecisionInput,
  type StaffOffboardingPlan,
} from '../src/modules/people/offboarding.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const at = new Date('2026-08-25T09:00:00.000Z');

const sseConfig = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 0,
  databaseUrl: databaseUrl ?? 'postgresql://unused-r4a-sse',
  logLevel: 'silent',
  corsOrigin: 'http://127.0.0.1:5173',
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
};

type SseClient = Readonly<{
  firstFrame: Promise<string>;
  ended: Promise<void>;
  abort: () => Promise<void>;
}>;

function timeout<T>(promise: Promise<T>, label: string, milliseconds = 2_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function openSse(url: string, token: string): Promise<SseClient> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { cookie: `servora_session=${token}` },
    signal: controller.signal,
  });
  if (response.status !== 200 || !response.body) {
    controller.abort();
    throw new Error(`Expected SSE 200, received ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resolveFirst!: (frame: string) => void;
  const firstFrame = new Promise<string>((resolve) => { resolveFirst = resolve; });
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
  void (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        while (true) {
          const separator = buffer.indexOf('\n\n');
          if (separator < 0) break;
          resolveFirst(buffer.slice(0, separator));
          resolveFirst = () => undefined;
          buffer = buffer.slice(separator + 2);
        }
      }
    } catch {
      // Aborting a test stream is expected.
    } finally {
      resolveEnded();
    }
  })();
  return {
    firstFrame,
    ended,
    async abort() { controller.abort(); await ended; },
  };
}

type Fixture = Readonly<{
  pool: Pool;
  organizationId: string;
  otherOrganizationId: string;
  admin: SafeUser;
  manager: SafeUser;
  target: SafeUser;
  replacementB: SafeUser;
  replacementC: SafeUser;
  otherAdmin: SafeUser;
  service: PostgresStaffOffboardingService;
  disconnectUser: ReturnType<typeof vi.fn>;
  ids: Readonly<{
    activeJob: string;
    acceptedJob: string;
    waitingJob: string;
    completedJob: string;
    cancelledJob: string;
    invalidatedJob: string;
    customer: string;
    futureCalendar: string;
    pastCalendar: string;
    pendingReminder: string;
    claimedReminder: string;
    claimedLease: string;
    jobConversation: string;
    directConversation: string;
  }>;
}>;

async function insertUser(pool: Pool, organizationId: string, role: SafeUser['role'], name: string, isActive = true) {
  const row = (await pool.query<SafeUser>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'r4a-test-hash', $4, $5)
     RETURNING id, organization_id AS "organizationId", name, email, role,
       must_change_password AS "mustChangePassword", is_active AS "isActive", version`,
    [organizationId, name, `${randomUUID()}@r4a.test`, role, isActive],
  )).rows[0]!;
  if (role === 'STAFF') {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, 'Field Staff')`,
      [organizationId, row.id],
    );
  }
  return row;
}

async function insertSession(pool: Pool, userId: string) {
  const token = createSessionToken();
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, '2099-01-01T00:00:00Z', '2026-08-25T08:00:00Z')`,
    [userId, token.tokenHash],
  );
  return token.rawToken;
}

async function insertJob(
  pool: Pool,
  input: Readonly<{
    organizationId: string;
    assignedTo: string;
    createdBy: string;
    status: string;
    customerId?: string;
    scheduledAt?: Date;
    scheduledEndsAt?: Date;
    followUpAssignee?: string;
  }>,
) {
  const id = randomUUID();
  const fields = {
    startedAt: ['IN_PROGRESS', 'WAITING_APPROVAL', 'COMPLETED'].includes(input.status) ? at : null,
    acceptedAt: input.status === 'ACCEPTED' ? at : null,
    acceptedBy: input.status === 'ACCEPTED' ? input.assignedTo : null,
    staffCompletedAt: ['WAITING_APPROVAL', 'COMPLETED'].includes(input.status) ? at : null,
    staffCompletedBy: ['WAITING_APPROVAL', 'COMPLETED'].includes(input.status) ? input.assignedTo : null,
    managerApprovedAt: input.status === 'COMPLETED' ? at : null,
    managerApprovedBy: input.status === 'COMPLETED' ? input.createdBy : null,
    cancelledAt: input.status === 'CANCELLED' ? at : null,
    cancelledBy: input.status === 'CANCELLED' ? input.createdBy : null,
    cancelReason: input.status === 'CANCELLED' ? 'R4A test cancellation' : null,
    invalidatedAt: input.status === 'INVALIDATED' ? at : null,
    invalidatedBy: input.status === 'INVALIDATED' ? input.createdBy : null,
    invalidationReasonCode: input.status === 'INVALIDATED' ? 'DUPLICATE' : null,
    revisionRequestedAt: null,
    revisionRequestedBy: null,
    revisionReason: null,
    followUpAt: input.followUpAssignee ? new Date('2026-08-26T09:00:00.000Z') : null,
    followUpType: input.followUpAssignee ? 'GENERAL_TASK' : null,
    followUpOrigin: input.followUpAssignee ? 'SYSTEM' : null,
    followUpBy: input.followUpAssignee ? input.createdBy : null,
    followUpInstructions: input.followUpAssignee ? 'R4A follow-up responsibility' : null,
  };
  await pool.query(
    `INSERT INTO job_cards (
       id, organization_id, type, status, title, customer_id, assigned_to, created_by,
       scheduled_at, scheduled_ends_at, started_at, accepted_at, accepted_by,
       staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by,
       cancelled_at, cancelled_by, cancel_reason, invalidated_at, invalidated_by,
       invalidation_reason_code, revision_requested_at, revision_requested_by, revision_reason,
       follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
       follow_up_proposal_instructions, follow_up_proposal_origin, follow_up_proposed_by
     ) VALUES (
       $1, $2, 'GENERAL_TASK', $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17, $18, $19, $20, $21, $22, $23, $24, $25,
       $26, $27, $28, $29, $30, $31
     )`,
    [id, input.organizationId, input.status, `R4A ${input.status}`, input.customerId ?? null,
      input.assignedTo, input.createdBy, input.scheduledAt ?? null, input.scheduledEndsAt ?? null,
      fields.startedAt, fields.acceptedAt, fields.acceptedBy, fields.staffCompletedAt,
      fields.staffCompletedBy, fields.managerApprovedAt, fields.managerApprovedBy,
      fields.cancelledAt, fields.cancelledBy, fields.cancelReason, fields.invalidatedAt,
      fields.invalidatedBy, fields.invalidationReasonCode, fields.revisionRequestedAt,
      fields.revisionRequestedBy, fields.revisionReason, fields.followUpAt, fields.followUpType,
      input.followUpAssignee ?? null, fields.followUpInstructions, fields.followUpOrigin,
      fields.followUpBy],
  );
  return id;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `r4a_offboarding_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });

    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone) VALUES ('R4A Organization', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const otherOrganizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone) VALUES ('R4A Other', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const admin = await insertUser(pool, organizationId, 'ADMIN', 'R4A Admin');
    const manager = await insertUser(pool, organizationId, 'MANAGER', 'R4A Manager');
    const target = await insertUser(pool, organizationId, 'STAFF', 'R4A Target');
    const replacementB = await insertUser(pool, organizationId, 'STAFF', 'R4A Replacement B');
    const replacementC = await insertUser(pool, organizationId, 'STAFF', 'R4A Replacement C');
    const otherAdmin = await insertUser(pool, otherOrganizationId, 'ADMIN', 'Other Admin');

    const customer = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status, assigned_staff_user_id)
       VALUES ($1, 'R4A Clinic', 'clinic', 'active', $2) RETURNING id`,
      [organizationId, target.id],
    )).rows[0]!.id;
    const activeJob = await insertJob(pool, {
      organizationId, assignedTo: target.id, createdBy: admin.id, status: 'IN_PROGRESS', customerId: customer,
      scheduledAt: new Date('2026-08-26T11:00:00.000Z'), scheduledEndsAt: new Date('2026-08-26T12:00:00.000Z'),
      followUpAssignee: target.id,
    });
    const acceptedJob = await insertJob(pool, {
      organizationId, assignedTo: target.id, createdBy: admin.id, status: 'ACCEPTED', customerId: customer,
    });
    const waitingJob = await insertJob(pool, {
      organizationId, assignedTo: target.id, createdBy: admin.id, status: 'WAITING_APPROVAL',
    });
    const completedJob = await insertJob(pool, {
      organizationId, assignedTo: target.id, createdBy: admin.id, status: 'COMPLETED',
    });
    const cancelledJob = await insertJob(pool, {
      organizationId, assignedTo: target.id, createdBy: admin.id, status: 'CANCELLED',
    });
    const invalidatedJob = await insertJob(pool, {
      organizationId, assignedTo: target.id, createdBy: admin.id, status: 'INVALIDATED',
    });

    const futureCalendar = (await pool.query<{ id: string }>(
      `INSERT INTO calendar_events
        (organization_id, assigned_user_id, title, starts_at, ends_at, timezone, created_by, updated_by)
       VALUES ($1, $2, 'Future event', '2026-08-27T10:00:00Z', '2026-08-27T11:00:00Z', 'Europe/Istanbul', $3, $3)
       RETURNING id`,
      [organizationId, target.id, admin.id],
    )).rows[0]!.id;
    const pastCalendar = (await pool.query<{ id: string }>(
      `INSERT INTO calendar_events
        (organization_id, assigned_user_id, title, starts_at, ends_at, timezone, created_by, updated_by)
       VALUES ($1, $2, 'Past event', '2026-08-24T10:00:00Z', '2026-08-24T11:00:00Z', 'Europe/Istanbul', $3, $3)
       RETURNING id`,
      [organizationId, target.id, admin.id],
    )).rows[0]!.id;
    const pendingReminder = (await pool.query<{ id: string }>(
      `INSERT INTO calendar_reminders
        (organization_id, calendar_event_id, recipient_user_id, remind_at, next_attempt_at, dedupe_key)
       VALUES ($1, $2, $3, '2026-08-27T09:30:00Z', '2026-08-27T09:30:00Z', $4)
       RETURNING id`,
      [organizationId, futureCalendar, target.id, `R4A:PENDING:${randomUUID()}`],
    )).rows[0]!.id;
    const claimedLease = randomUUID();
    const claimedReminder = (await pool.query<{ id: string }>(
      `INSERT INTO calendar_reminders
        (organization_id, job_card_id, recipient_user_id, remind_at, next_attempt_at,
         state, lease_token, lease_until, dedupe_key)
       VALUES ($1, $2, $3, '2026-08-26T10:30:00Z', '2026-08-26T10:30:00Z',
         'CLAIMED', $4, '2026-08-26T10:45:00Z', $5)
       RETURNING id`,
      [organizationId, activeJob, target.id, claimedLease, `R4A:CLAIMED:${randomUUID()}`],
    )).rows[0]!.id;

    const jobConversation = randomUUID();
    await pool.query(
      `INSERT INTO conversations (id, organization_id, direct_key, context_type, job_id)
       VALUES ($1, $2, $3, 'JOB', $4)`,
      [jobConversation, organizationId, `R4A:JOB:${activeJob}`, activeJob],
    );
    await pool.query(
      `INSERT INTO conversation_participants (organization_id, conversation_id, user_id)
       VALUES ($1, $2, $3)`,
      [organizationId, jobConversation, target.id],
    );
    const directConversation = randomUUID();
    await pool.query(
      `INSERT INTO conversations (id, organization_id, direct_key, context_type)
       VALUES ($1, $2, $3, 'GENERAL')`,
      [directConversation, organizationId, `R4A:GENERAL:${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO conversation_participants (organization_id, conversation_id, user_id)
       VALUES ($1, $2, $3)`,
      [organizationId, directConversation, target.id],
    );
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, '2099-01-01T00:00:00Z', '2026-08-25T08:00:00Z')`,
      [target.id, randomUUID().replaceAll('-', '').padEnd(64, '0')],
    );

    const disconnectUser = vi.fn();
    const service = new PostgresStaffOffboardingService(pool, { disconnectUser }, () => new Date(at));
    await run({
      pool, organizationId, otherOrganizationId, admin, manager, target, replacementB, replacementC,
      otherAdmin, service, disconnectUser,
      ids: {
        activeJob, acceptedJob, waitingJob, completedJob, cancelledJob, invalidatedJob,
        customer, futureCalendar, pastCalendar, pendingReminder, claimedReminder,
        jobConversation, directConversation,
        claimedLease,
      },
    });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function decisions(plan: StaffOffboardingPlan, input: Partial<OffboardingDecisionInput> = {}): OffboardingDecisionInput {
  return {
    clientActionId: 'r4a-happy-path',
    planHash: plan.planHash,
    reasonCode: 'ACCESS_ENDED',
    jobDecisions: plan.jobs.map((item) => ({ jobCardId: item.id, replacementUserId: 'replacement-b' })),
    calendarDecisions: plan.calendar.map((item) => ({ calendarEventId: item.id, replacementUserId: 'replacement-c' })),
    followUpDecisions: plan.followUps.map((item) => ({ jobCardId: item.jobCardId, replacementUserId: 'replacement-b' })),
    customerDecisions: plan.customers.map((item) => ({ customerId: item.id, action: 'REASSIGN' as const, replacementUserId: 'replacement-b' })),
    reminderDecisions: plan.reminders.map((item) => ({ reminderId: item.id, action: 'TRANSFER' as const, replacementUserId: 'replacement-c' })),
    ...input,
  };
}

function actualDecisions(fixture: Fixture, plan: StaffOffboardingPlan, clientActionId: string): OffboardingDecisionInput {
  return decisions(plan, {
    clientActionId,
    jobDecisions: plan.jobs.map((item) => ({ jobCardId: item.id, replacementUserId: fixture.replacementB.id })),
    calendarDecisions: plan.calendar.map((item) => ({ calendarEventId: item.id, replacementUserId: fixture.replacementC.id })),
    followUpDecisions: plan.followUps.map((item) => ({ jobCardId: item.jobCardId, replacementUserId: fixture.replacementB.id })),
    customerDecisions: plan.customers.map((item) => ({ customerId: item.id, action: 'REASSIGN' as const, replacementUserId: fixture.replacementB.id })),
    reminderDecisions: plan.reminders.map((item) => ({ reminderId: item.id, action: 'TRANSFER' as const, replacementUserId: fixture.replacementC.id })),
  });
}

describe.skipIf(!databaseUrl)('R4A Staff offboarding on real PostgreSQL', () => {
  it('previews and atomically transfers only active responsibilities, preserves history, and replays exactly', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      expect(plan.jobs.map((item) => item.id)).toEqual(expect.arrayContaining([
        fixture.ids.activeJob, fixture.ids.acceptedJob, fixture.ids.waitingJob,
      ]));
      expect(plan.jobs.map((item) => item.id)).not.toEqual(expect.arrayContaining([
        fixture.ids.completedJob, fixture.ids.cancelledJob, fixture.ids.invalidatedJob,
      ]));
      expect(plan.customers.map((item) => item.id)).toContain(fixture.ids.customer);
      expect(plan.calendar.map((item) => item.id)).toEqual([fixture.ids.futureCalendar]);
      expect(plan.reminders.map((item) => item.id)).toEqual(expect.arrayContaining([
        fixture.ids.pendingReminder, fixture.ids.claimedReminder,
      ]));

      const input = decisions(plan, {
        jobDecisions: plan.jobs.map((item) => ({ jobCardId: item.id, replacementUserId: fixture.replacementB.id })),
        calendarDecisions: plan.calendar.map((item) => ({ calendarEventId: item.id, replacementUserId: fixture.replacementC.id })),
        followUpDecisions: plan.followUps.map((item) => ({ jobCardId: item.jobCardId, replacementUserId: fixture.replacementB.id })),
        customerDecisions: plan.customers.map((item) => ({ customerId: item.id, action: 'REASSIGN' as const, replacementUserId: fixture.replacementB.id })),
        reminderDecisions: plan.reminders.map((item) => ({ reminderId: item.id, action: 'TRANSFER' as const, replacementUserId: fixture.replacementC.id })),
      });
      const response = await fixture.service.execute(fixture.admin, fixture.target.id, input);
      expect(response.status).toBe('OFFBOARDED');
      expect(fixture.disconnectUser).toHaveBeenCalledWith(fixture.organizationId, fixture.target.id);

      const state = await fixture.pool.query<{
        target_active: boolean; active_job_assignee: string; accepted_status: string; accepted_by: string;
        completed_assignee: string; cancelled_assignee: string; invalidated_assignee: string;
        customer_assignee: string; calendar_assignee: string; past_calendar_assignee: string;
        follow_up_assignee: string; pending_recipient: string; claimed_recipient: string;
        revoked_sessions: string; audit_count: string; completed_receipts: string;
      }>(
        `SELECT
          (SELECT is_active FROM users WHERE id = $1) AS target_active,
          (SELECT assigned_to FROM job_cards WHERE id = $2) AS active_job_assignee,
          (SELECT status FROM job_cards WHERE id = $3) AS accepted_status,
          (SELECT accepted_by FROM job_cards WHERE id = $3) AS accepted_by,
          (SELECT assigned_to FROM job_cards WHERE id = $4) AS completed_assignee,
          (SELECT assigned_to FROM job_cards WHERE id = $5) AS cancelled_assignee,
          (SELECT assigned_to FROM job_cards WHERE id = $6) AS invalidated_assignee,
          (SELECT assigned_staff_user_id FROM customers WHERE id = $7) AS customer_assignee,
          (SELECT assigned_user_id FROM calendar_events WHERE id = $8) AS calendar_assignee,
          (SELECT assigned_user_id FROM calendar_events WHERE id = $9) AS past_calendar_assignee,
          (SELECT follow_up_proposed_assignee FROM job_cards WHERE id = $2) AS follow_up_assignee,
          (SELECT recipient_user_id FROM calendar_reminders WHERE id = $10) AS pending_recipient,
          (SELECT recipient_user_id FROM calendar_reminders WHERE id = $11) AS claimed_recipient,
          (SELECT count(*)::text FROM sessions WHERE user_id = $1 AND revoked_at IS NOT NULL) AS revoked_sessions,
          (SELECT count(*)::text FROM audit_events WHERE subject_id = $1 AND event_type = 'USER_OFFBOARDED') AS audit_count,
          (SELECT count(*)::text FROM processed_actions WHERE operation_key = $12 AND status = 'completed') AS completed_receipts`,
        [fixture.target.id, fixture.ids.activeJob, fixture.ids.acceptedJob, fixture.ids.completedJob,
          fixture.ids.cancelledJob, fixture.ids.invalidatedJob, fixture.ids.customer,
          fixture.ids.futureCalendar, fixture.ids.pastCalendar, fixture.ids.pendingReminder,
          fixture.ids.claimedReminder, `USER_OFFBOARDING:${fixture.target.id}`],
      );
      expect(state.rows[0]).toMatchObject({
        target_active: false,
        active_job_assignee: fixture.replacementB.id,
        accepted_status: 'ACCEPTED', accepted_by: fixture.target.id,
        completed_assignee: fixture.target.id, cancelled_assignee: fixture.target.id,
        invalidated_assignee: fixture.target.id,
        customer_assignee: fixture.replacementB.id,
        calendar_assignee: fixture.replacementC.id, past_calendar_assignee: fixture.target.id,
        follow_up_assignee: fixture.replacementB.id,
        pending_recipient: fixture.replacementC.id, claimed_recipient: fixture.replacementC.id,
        revoked_sessions: '1', audit_count: '1', completed_receipts: '1',
      });

      const participants = await fixture.pool.query<{ user_id: string }>(
        `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 ORDER BY user_id`,
        [fixture.ids.jobConversation],
      );
      expect(participants.rows.map((row) => row.user_id)).toEqual([fixture.replacementB.id]);
      const directParticipants = await fixture.pool.query<{ user_id: string }>(
        `SELECT user_id FROM conversation_participants WHERE conversation_id = $1`,
        [fixture.ids.directConversation],
      );
      expect(directParticipants.rows.map((row) => row.user_id)).toEqual([fixture.target.id]);

      const replay = await fixture.service.execute(fixture.admin, fixture.target.id, input);
      expect(replay).toEqual(response);
      expect(fixture.disconnectUser).toHaveBeenCalledTimes(1);
      await expect(fixture.service.execute(fixture.admin, fixture.target.id, {
        ...input, reasonCode: 'ROLE_CHANGED',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      await fixture.pool.query(`UPDATE users SET role = 'MANAGER' WHERE id = $1`, [fixture.admin.id]);
      await expect(fixture.service.execute(fixture.admin, fixture.target.id, input))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      expect((await fixture.pool.query(
        `SELECT count(*)::text AS count FROM audit_events WHERE subject_id = $1 AND event_type = 'USER_OFFBOARDED'`,
        [fixture.target.id],
      )).rows[0]!.count).toBe('1');
    });
  });

  it('rejects stale plans, invalid replacements, wrong roles, and cross-organization targets without mutation', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      const invalidReplacementInput = decisions(plan, {
        jobDecisions: plan.jobs.map((item) => ({ jobCardId: item.id, replacementUserId: fixture.replacementB.id })),
        calendarDecisions: plan.calendar.map((item) => ({ calendarEventId: item.id, replacementUserId: fixture.replacementC.id })),
        followUpDecisions: plan.followUps.map((item) => ({ jobCardId: item.jobCardId, replacementUserId: fixture.replacementB.id })),
        customerDecisions: plan.customers.map((item) => ({ customerId: item.id, action: 'REASSIGN' as const, replacementUserId: fixture.replacementB.id })),
        reminderDecisions: plan.reminders.map((item) => ({ reminderId: item.id, action: 'TRANSFER' as const, replacementUserId: fixture.replacementC.id })),
      });
      await fixture.pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [fixture.replacementB.id]);
      await expect(fixture.service.execute(fixture.admin, fixture.target.id, invalidReplacementInput))
        .rejects.toMatchObject({ code: 'INVALID_REPLACEMENT_STAFF', statusCode: 409 });
      expect((await fixture.pool.query(`SELECT is_active FROM users WHERE id = $1`, [fixture.target.id])).rows[0]!.is_active).toBe(true);
      expect((await fixture.pool.query(`SELECT count(*)::text AS count FROM audit_events WHERE subject_id = $1`, [fixture.target.id])).rows[0]!.count).toBe('0');

      await expect(fixture.service.preview(fixture.manager, fixture.target.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(fixture.service.preview(fixture.admin, fixture.otherAdmin.id)).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
      await expect(fixture.service.preview(fixture.admin, fixture.manager.id)).rejects.toMatchObject({ code: 'OFFBOARDING_TARGET_NOT_STAFF' });

      await fixture.pool.query(`UPDATE users SET is_active = TRUE WHERE id = $1`, [fixture.replacementB.id]);
      const stalePlan = await fixture.service.preview(fixture.admin, fixture.target.id);
      await fixture.pool.query(`UPDATE customers SET name = 'Changed customer', version = version + 1 WHERE id = $1`, [fixture.ids.customer]);
      const staleInput = decisions(stalePlan, {
        jobDecisions: stalePlan.jobs.map((item) => ({ jobCardId: item.id, replacementUserId: fixture.replacementB.id })),
        calendarDecisions: stalePlan.calendar.map((item) => ({ calendarEventId: item.id, replacementUserId: fixture.replacementC.id })),
        followUpDecisions: stalePlan.followUps.map((item) => ({ jobCardId: item.jobCardId, replacementUserId: fixture.replacementB.id })),
        customerDecisions: stalePlan.customers.map((item) => ({ customerId: item.id, action: 'REASSIGN' as const, replacementUserId: fixture.replacementB.id })),
        reminderDecisions: stalePlan.reminders.map((item) => ({ reminderId: item.id, action: 'TRANSFER' as const, replacementUserId: fixture.replacementC.id })),
      });
      await expect(fixture.service.execute(fixture.admin, fixture.target.id, staleInput))
        .rejects.toMatchObject({ code: 'STALE_PLAN', statusCode: 409 });
      expect((await fixture.pool.query(`SELECT is_active FROM users WHERE id = $1`, [fixture.target.id])).rows[0]!.is_active).toBe(true);
      expect((await fixture.pool.query(`SELECT count(*)::text AS count FROM processed_actions WHERE status = 'completed'`, [])).rows[0]!.count).toBe('0');
    });
  });

  it('serializes same-action and different-action concurrency to one durable completion', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      const sameAction = actualDecisions(fixture, plan, 'r4a-concurrent-same');
      const sameResults = await Promise.all([
        fixture.service.execute(fixture.admin, fixture.target.id, sameAction).then((response) => ({ ok: true as const, response })).catch((error: unknown) => ({ ok: false as const, error })),
        fixture.service.execute(fixture.admin, fixture.target.id, sameAction).then((response) => ({ ok: true as const, response })).catch((error: unknown) => ({ ok: false as const, error })),
      ]);
      expect(sameResults.filter((item) => item.ok)).toHaveLength(2);
      expect(sameResults.filter((item) => item.ok).map((item) => item.response)).toHaveLength(2);

      const secondTarget = await insertUser(fixture.pool, fixture.organizationId, 'STAFF', 'R4A Second Target');
      const secondPlan = await fixture.service.preview(fixture.admin, secondTarget.id);
      const differentResults = await Promise.all([
        fixture.service.execute(fixture.admin, secondTarget.id, actualDecisions(fixture, secondPlan, 'r4a-concurrent-a')).then(() => ({ ok: true as const })).catch((error: unknown) => ({ ok: false as const, error })),
        fixture.service.execute(fixture.admin, secondTarget.id, actualDecisions(fixture, secondPlan, 'r4a-concurrent-b')).then(() => ({ ok: true as const })).catch((error: unknown) => ({ ok: false as const, error })),
      ]);
      expect(differentResults.filter((item) => item.ok)).toHaveLength(1);
      expect(differentResults.find((item) => !item.ok)).toBeDefined();
      expect((await fixture.pool.query(
        `SELECT count(*)::text AS count FROM audit_events WHERE subject_id = $1 AND event_type = 'USER_OFFBOARDED'`,
        [secondTarget.id],
      )).rows[0]!.count).toBe('1');
    });
  });

  it('rolls back the complete graph, sessions, audit, and receipt when the final deactivation fails', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      await fixture.pool.query(`
        CREATE FUNCTION fail_r4a_offboarding() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.is_active = TRUE AND NEW.is_active = FALSE THEN
            RAISE EXCEPTION 'injected R4A rollback failure';
          END IF;
          RETURN NEW;
        END
        $$;
      `);
      await fixture.pool.query(`
        CREATE TRIGGER fail_r4a_offboarding
        BEFORE UPDATE OF is_active ON users
        FOR EACH ROW EXECUTE FUNCTION fail_r4a_offboarding()
      `);

      await expect(fixture.service.execute(
        fixture.admin,
        fixture.target.id,
        actualDecisions(fixture, plan, 'r4a-rollback'),
      )).rejects.toThrow('injected R4A rollback failure');

      const state = await fixture.pool.query<{
        target_active: boolean; job_assignee: string; customer_assignee: string;
        calendar_assignee: string; reminder_recipient: string; revoked_sessions: string;
        audit_count: string; receipt_count: string;
      }>(
        `SELECT
          (SELECT is_active FROM users WHERE id = $1) AS target_active,
          (SELECT assigned_to FROM job_cards WHERE id = $2) AS job_assignee,
          (SELECT assigned_staff_user_id FROM customers WHERE id = $3) AS customer_assignee,
          (SELECT assigned_user_id FROM calendar_events WHERE id = $4) AS calendar_assignee,
          (SELECT recipient_user_id FROM calendar_reminders WHERE id = $5) AS reminder_recipient,
          (SELECT count(*)::text FROM sessions WHERE user_id = $1 AND revoked_at IS NOT NULL) AS revoked_sessions,
          (SELECT count(*)::text FROM audit_events WHERE subject_id = $1 AND event_type = 'USER_OFFBOARDED') AS audit_count,
          (SELECT count(*)::text FROM processed_actions WHERE client_action_id = 'r4a-rollback') AS receipt_count`,
        [fixture.target.id, fixture.ids.activeJob, fixture.ids.customer, fixture.ids.futureCalendar, fixture.ids.pendingReminder],
      );
      expect(state.rows[0]).toMatchObject({
        target_active: true,
        job_assignee: fixture.target.id,
        customer_assignee: fixture.target.id,
        calendar_assignee: fixture.target.id,
        reminder_recipient: fixture.target.id,
        revoked_sessions: '0', audit_count: '0', receipt_count: '0',
      });
      expect(fixture.disconnectUser).not.toHaveBeenCalled();
    });
  });

  it('uses the real reminder worker boundary so worker projection becomes stale and offboarding wins suppress delivery', async () => {
    await withFixture(async (fixture) => {
      const worker = new PostgresCalendarReminderWorkerRepository(fixture.pool);
      const claim = {
        id: fixture.ids.claimedReminder,
        organizationId: fixture.organizationId,
        recipientUserId: fixture.target.id,
        jobCardId: fixture.ids.activeJob,
        calendarEventId: null,
        attemptCount: 1,
        leaseToken: fixture.ids.claimedLease,
      };
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      const projected = await worker.project(claim, at, false);
      expect(projected).not.toBeNull();
      await expect(fixture.service.execute(
        fixture.admin,
        fixture.target.id,
        actualDecisions(fixture, plan, 'r4a-worker-wins'),
      )).rejects.toMatchObject({ code: 'STALE_PLAN', statusCode: 409 });
      expect((await fixture.pool.query(`SELECT is_active FROM users WHERE id = $1`, [fixture.target.id])).rows[0]!.is_active).toBe(true);
    });

    await withFixture(async (fixture) => {
      const worker = new PostgresCalendarReminderWorkerRepository(fixture.pool);
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      const input = actualDecisions(fixture, plan, 'r4a-offboarding-wins-reminder');
      const cancelInput = {
        ...input,
        reminderDecisions: plan.reminders.map((item) => ({ reminderId: item.id, action: 'CANCEL' as const })),
      };
      await fixture.service.execute(fixture.admin, fixture.target.id, cancelInput);
      const suppressed = await worker.project({
        id: fixture.ids.claimedReminder,
        organizationId: fixture.organizationId,
        recipientUserId: fixture.target.id,
        jobCardId: fixture.ids.activeJob,
        calendarEventId: null,
        attemptCount: 1,
        leaseToken: fixture.ids.claimedLease,
      }, at, false);
      expect(suppressed).toBeNull();
      expect((await fixture.pool.query(`SELECT state FROM calendar_reminders WHERE id = $1`, [fixture.ids.claimedReminder])).rows[0]!.state).toBe('CANCELLED');
    });
  });

  it('closes only the target user network SSE streams after commit and rejects target reconnects', async () => {
    await withFixture(async (fixture) => {
      const bus = new InMemoryRealtimeEventBus();
      const realtime = new RealtimeService(new PostgresRealtimeEventRepository(fixture.pool), bus);
      const app = await buildApp(sseConfig, {
        authRepository: new PostgresAuthRepository(fixture.pool),
        realtimeService: realtime,
      });
      const targetTokenA = await insertSession(fixture.pool, fixture.target.id);
      const targetTokenB = await insertSession(fixture.pool, fixture.target.id);
      const unrelatedToken = await insertSession(fixture.pool, fixture.replacementB.id);
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('SSE acceptance server did not expose a TCP address');
      const url = `http://127.0.0.1:${address.port}/api/realtime/events`;
      const targetA = await openSse(url, targetTokenA);
      const targetB = await openSse(url, targetTokenB);
      const unrelated = await openSse(url, unrelatedToken);
      try {
        expect(await timeout(targetA.firstFrame, 'target A initial frame')).toContain('sync.required');
        expect(await timeout(targetB.firstFrame, 'target B initial frame')).toContain('sync.required');
        expect(await timeout(unrelated.firstFrame, 'unrelated initial frame')).toContain('sync.required');

        const service = new PostgresStaffOffboardingService(
          fixture.pool,
          { disconnectUser: realtime.disconnectUser.bind(realtime) },
          () => new Date(at),
        );
        const plan = await service.preview(fixture.admin, fixture.target.id);
        await service.execute(fixture.admin, fixture.target.id, actualDecisions(fixture, plan, 'r4a-real-sse'));

        await timeout(targetA.ended, 'target A network EOF');
        await timeout(targetB.ended, 'target B network EOF');
        const unrelatedStillOpen = await Promise.race([
          unrelated.ended.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100)),
        ]);
        expect(unrelatedStillOpen).toBe(true);
        expect(realtime.disconnectUser(fixture.organizationId, fixture.replacementB.id)).toBe(1);
        await timeout(unrelated.ended, 'unrelated network EOF');

        const reconnect = await fetch(url, { headers: { cookie: `servora_session=${targetTokenA}` } });
        expect(reconnect.status).toBe(401);
        await reconnect.body?.cancel();
      } finally {
        await Promise.all([targetA.abort(), targetB.abort(), unrelated.abort()]);
        await app.close();
      }
    });
  });
});
