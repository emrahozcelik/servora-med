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
import { parseJobCardCreateInput } from '../src/modules/job-cards/create-input.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { gatePoolStatements, waitFor } from './support/lifecycle-intent-harness.js';
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
    startedAt: ['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED'].includes(input.status) ? at : null,
    acceptedAt: input.status === 'ACCEPTED' ? at : null,
    acceptedBy: input.status === 'ACCEPTED' ? input.assignedTo : null,
    staffCompletedAt: ['WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED'].includes(input.status) ? at : null,
    staffCompletedBy: ['WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED'].includes(input.status) ? input.assignedTo : null,
    managerApprovedAt: input.status === 'COMPLETED' ? at : null,
    managerApprovedBy: input.status === 'COMPLETED' ? input.createdBy : null,
    cancelledAt: input.status === 'CANCELLED' ? at : null,
    cancelledBy: input.status === 'CANCELLED' ? input.createdBy : null,
    cancelReason: input.status === 'CANCELLED' ? 'R4A test cancellation' : null,
    invalidatedAt: input.status === 'INVALIDATED' ? at : null,
    invalidatedBy: input.status === 'INVALIDATED' ? input.createdBy : null,
    invalidationReasonCode: input.status === 'INVALIDATED' ? 'DUPLICATE' : null,
    revisionRequestedAt: input.status === 'REVISION_REQUESTED' ? at : null,
    revisionRequestedBy: input.status === 'REVISION_REQUESTED' ? input.createdBy : null,
    revisionReason: input.status === 'REVISION_REQUESTED' ? 'Clarify clinic outcome' : null,
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
        target_active: boolean; active_job_assignee: string; accepted_status: string;
        accepted_at: Date | null; accepted_by: string | null;
        completed_assignee: string; cancelled_assignee: string; invalidated_assignee: string;
        customer_assignee: string; calendar_assignee: string; past_calendar_assignee: string;
        follow_up_assignee: string; pending_recipient: string; claimed_recipient: string;
        revoked_sessions: string; audit_count: string; completed_receipts: string;
      }>(
        `SELECT
          (SELECT is_active FROM users WHERE id = $1) AS target_active,
          (SELECT assigned_to FROM job_cards WHERE id = $2) AS active_job_assignee,
          (SELECT status FROM job_cards WHERE id = $3) AS accepted_status,
          (SELECT accepted_at FROM job_cards WHERE id = $3) AS accepted_at,
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
        accepted_status: 'NEW', accepted_at: null, accepted_by: null,
        completed_assignee: fixture.target.id, cancelled_assignee: fixture.target.id,
        invalidated_assignee: fixture.target.id,
        customer_assignee: fixture.replacementB.id,
        calendar_assignee: fixture.replacementC.id, past_calendar_assignee: fixture.target.id,
        follow_up_assignee: fixture.replacementB.id,
        pending_recipient: fixture.replacementC.id, claimed_recipient: fixture.replacementC.id,
        revoked_sessions: '1', audit_count: '1', completed_receipts: '1',
      });

      // FOUNDATION-1: every assigned_to change through offboarding writes an
      // OFFBOARDING assignment-history row atomically with the mutation.
      const offboardingHistory = await fixture.pool.query<{
        job_card_id: string; from_user_id: string; to_user_id: string;
        changed_by: string; source: string; activity_id: string | null;
      }>(
        `SELECT job_card_id, from_user_id, to_user_id, changed_by, source, activity_id
           FROM job_card_assignment_history
          WHERE source = 'OFFBOARDING'
          ORDER BY job_card_id`,
      );
      expect(offboardingHistory.rows).toHaveLength(plan.jobs.length);
      for (const row of offboardingHistory.rows) {
        expect(row).toMatchObject({
          from_user_id: fixture.target.id,
          to_user_id: fixture.replacementB.id,
          changed_by: fixture.admin.id,
          source: 'OFFBOARDING',
        });
        expect(row.activity_id).not.toBeNull();
      }
      const completedHistory = await fixture.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM job_card_assignment_history
          WHERE job_card_id = ANY($1::uuid[])`,
        [[fixture.ids.completedJob, fixture.ids.cancelledJob, fixture.ids.invalidatedJob]],
      );
      expect(completedHistory.rows[0]!.count).toBe('0');

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

  it('resets current acceptance while preserving prior events and requiring the replacement to accept before start', async () => {
    await withFixture(async (f) => {
      const jobs = new JobCardService(new PostgresJobCardRepository(f.pool), () => new Date(at));
      const created = await jobs.create(f.manager, parseJobCardCreateInput({
        clientActionId: randomUUID(), type: 'GENERAL_TASK', title: 'Dental clinic coordination', assignedTo: f.target.id,
      }));
      const accepted = await jobs.acceptAssignment(f.target, created.id, {
        clientActionId: randomUUID(), expectedVersion: created.version,
      });
      const historyBefore = await snapshotJobHistory(f.pool, created.id);
      const plan = await f.service.preview(f.admin, f.target.id);
      const request = actualDecisions(f, plan, randomUUID());
      const response = await f.service.execute(f.admin, f.target.id, request);
      const transferred = await jobs.detail(f.replacementB, created.id);
      expect(transferred).toMatchObject({ status: 'NEW', version: accepted.version + 1,
        workflowContext: { lifecycle: { acceptedAt: null, acceptedBy: null } } });
      expect(transferred.workflowContext.allowedCommands).toContain('ACCEPT_ASSIGNMENT');
      expect(transferred.workflowContext.allowedCommands).not.toContain('START');
      await expect(jobs.start(f.replacementB, created.id, {
        clientActionId: randomUUID(), expectedVersion: transferred.version,
      })).rejects.toMatchObject({ code: 'INVALID_TRANSITION', statusCode: 409 });
      await expect(jobs.acceptAssignment(f.target, created.id, {
        clientActionId: randomUUID(), expectedVersion: transferred.version,
      })).rejects.toMatchObject({ statusCode: 403 });
      const priorActivities = await f.pool.query(
        `SELECT to_jsonb(t) AS row FROM job_card_activity_logs t
          WHERE job_card_id = $1 AND event_type <> 'JOB_ASSIGNED' ORDER BY to_jsonb(t)::text`, [created.id],
      );
      expect(priorActivities.rows).toEqual(historyBefore.job_card_activity_logs);
      const assignment = (await f.pool.query(
        `SELECT old_value, new_value FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_ASSIGNED'`, [created.id],
      )).rows;
      expect(assignment).toEqual([{
        old_value: { assignedTo: f.target.id, status: 'ACCEPTED' },
        new_value: { assignedTo: f.replacementB.id, status: 'NEW' },
      }]);
      const acceptInput = { clientActionId: randomUUID(), expectedVersion: transferred.version };
      const reaccepted = await jobs.acceptAssignment(f.replacementB, created.id, acceptInput);
      expect(reaccepted).toMatchObject({ status: 'ACCEPTED', workflowContext: { lifecycle: { acceptedBy: { id: f.replacementB.id } } } });
      expect(await jobs.acceptAssignment(f.replacementB, created.id, acceptInput)).toMatchObject({ version: reaccepted.version });
      const started = await jobs.start(f.replacementB, created.id, {
        clientActionId: randomUUID(), expectedVersion: reaccepted.version,
      });
      expect(started.status).toBe('IN_PROGRESS');
      const after = await snapshotOffboardingState(f.pool);
      expect(await f.service.execute(f.admin, f.target.id, request)).toEqual(response);
      expect(await snapshotOffboardingState(f.pool)).toEqual(after);
      expect((await f.pool.query(
        `SELECT actor_id FROM job_card_activity_logs WHERE job_card_id = $1 AND event_type = 'JOB_ACCEPTED'
          ORDER BY created_at, id`, [created.id],
      )).rows.map((row) => row.actor_id)).toEqual([f.target.id, f.replacementB.id]);
    });
  });

  it('preserves a breached late-start commitment before clearing the old acceptance', async () => {
    await withFixture(async (f) => {
      const baseline = (await f.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      const jobs = new JobCardService(new PostgresJobCardRepository(f.pool), () => new Date(baseline.getTime() - 7_200_000));
      const created = await jobs.create(f.target, parseJobCardCreateInput({
        clientActionId: randomUUID(), type: 'PRODUCT_DELIVERY', title: 'Accepted clinic delivery', assignedTo: f.target.id,
        customerId: f.ids.customer, scheduledAt: new Date(baseline.getTime() - 3_600_000).toISOString(),
      }));
      expect(created.status).toBe('ACCEPTED');
      const offboarding = new PostgresStaffOffboardingService(f.pool, undefined, () => baseline);
      const plan = await offboarding.preview(f.admin, f.target.id);
      const input = actualDecisions(f, plan, randomUUID());
      const before = await snapshotOffboardingState(f.pool);
      await f.pool.query(`CREATE FUNCTION of01_fail_deactivation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'OF01 late rollback'; END $$;
        CREATE TRIGGER of01_fail_deactivation BEFORE UPDATE OF is_active ON users
        FOR EACH ROW WHEN (NOT NEW.is_active) EXECUTE FUNCTION of01_fail_deactivation()`);
      await expect(offboarding.execute(f.admin, f.target.id, input)).rejects.toThrow('OF01 late rollback');
      expect(await snapshotOffboardingState(f.pool)).toEqual(before);
      await f.pool.query('DROP TRIGGER of01_fail_deactivation ON users');
      await offboarding.execute(f.admin, f.target.id, input);
      const incidents = await f.pool.query(`SELECT delay_type, accountable_user_id, accountable_source, recovered_at
        FROM job_card_overdue_incidents WHERE job_card_id=$1`, [created.id]);
      expect(incidents.rows).toEqual([{ delay_type: 'LATE_START', accountable_user_id: f.target.id,
        accountable_source: 'ASSIGNMENT_AT_BREACH', recovered_at: null }]);
      await offboarding.execute(f.admin, f.target.id, input);
      expect((await f.pool.query('SELECT count(*)::int AS n FROM job_card_overdue_incidents WHERE job_card_id=$1',
        [created.id])).rows[0]!.n).toBe(1);
    });
  });

  it('fails atomically if a breached acceptance has no provable governing schedule revision', async () => {
    await withFixture(async (f) => {
      await f.pool.query(`UPDATE job_cards SET type='PRODUCT_DELIVERY', customer_id=$2,
        scheduled_at='2026-08-25T07:00:00Z', scheduled_ends_at='2026-08-25T07:30:00Z' WHERE id=$1`,
      [f.ids.acceptedJob, f.ids.customer]);
      const plan = await f.service.preview(f.admin, f.target.id);
      const before = await snapshotOffboardingState(f.pool);
      await expect(f.service.execute(f.admin, f.target.id, actualDecisions(f, plan, randomUUID())))
        .rejects.toMatchObject({ code: 'OVERDUE_INCIDENT_REVISION_MISSING', statusCode: 500 });
      expect(await snapshotOffboardingState(f.pool)).toEqual(before);
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

  it.each(['ACCEPT_ASSIGNMENT', 'START'] as const)('rejects a stale %s waiting behind an offboarding reset', async (command) => {
    await withFixture(async (f) => {
      const gate = gatePoolStatements(f.pool, 'UPDATE users SET is_active = FALSE');
      const offboarding = new PostgresStaffOffboardingService(gate.pool, undefined, () => new Date(at));
      const plan = await offboarding.preview(f.admin, f.target.id);
      const execution = offboarding.execute(f.admin, f.target.id, actualDecisions(f, plan, randomUUID()));
      const jobs = new JobCardService(new PostgresJobCardRepository(f.pool));
      let mutation: Promise<unknown> | undefined;
      try {
        await timeout(gate.arrived, 'offboarding holds the job row before commit');
        const input = { clientActionId: randomUUID(), expectedVersion: plan.jobs.find((j) => j.id === f.ids.acceptedJob)!.version };
        mutation = (command === 'START' ? jobs.start(f.target, f.ids.acceptedJob, input)
          : jobs.acceptAssignment(f.replacementB, f.ids.acceptedJob, input)).catch((error: unknown) => error);
        await waitFor(async () => (await f.pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%job_cards%') AS blocked`)).rows[0]!.blocked,
        2_000, 'lifecycle request waiting on the offboarding row lock');
        gate.release();
        await execution;
        expect(await mutation).toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
        const detail = await jobs.detail(f.replacementB, f.ids.acceptedJob);
        expect(detail).toMatchObject({ status: 'NEW', workflowContext: { lifecycle: { acceptedAt: null, acceptedBy: null } } });
        expect((await f.pool.query(`SELECT count(*)::int AS n FROM job_card_activity_logs
          WHERE job_card_id=$1 AND event_type IN ('JOB_STARTED','JOB_ACCEPTED')`, [f.ids.acceptedJob])).rows[0]!.n).toBe(0);
      } finally { gate.release(); await execution; await mutation; }
    });
  });

  it.each(['ACCEPT_ASSIGNMENT', 'START', 'REASSIGN'] as const)('rejects the stale offboarding plan when concurrent %s commits first', async (command) => {
    await withFixture(async (f) => {
      const jobs = new JobCardService(new PostgresJobCardRepository(f.pool));
      const created = await jobs.create(f.manager, parseJobCardCreateInput({ clientActionId: randomUUID(),
        type: 'GENERAL_TASK', title: 'Concurrent clinic task', assignedTo: f.target.id }));
      const current = command === 'ACCEPT_ASSIGNMENT' ? created : await jobs.acceptAssignment(f.target, created.id,
        { clientActionId: randomUUID(), expectedVersion: created.version });
      const plan = await f.service.preview(f.admin, f.target.id);
      const gate = gatePoolStatements(f.pool, command === 'REASSIGN' ? 'UPDATE job_cards SET' : 'SET status = $4::varchar(30)');
      const concurrentJobs = new JobCardService(new PostgresJobCardRepository(gate.pool));
      const input = { clientActionId: randomUUID(), expectedVersion: current.version };
      const mutation = command === 'ACCEPT_ASSIGNMENT' ? concurrentJobs.acceptAssignment(f.target, created.id, input)
        : command === 'START' ? concurrentJobs.start(f.target, created.id, input)
          : concurrentJobs.patch(f.manager, created.id, { expectedVersion: current.version, assignedTo: f.replacementC.id });
      let execution: Promise<unknown> | undefined;
      try {
        await timeout(gate.arrived, 'concurrent job mutation holds its locks');
        execution = f.service.execute(f.admin, f.target.id, actualDecisions(f, plan, randomUUID())).catch((error: unknown) => error);
        await waitFor(async () => (await f.pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE cardinality(pg_blocking_pids(pid)) > 0 AND (query LIKE '%users%' OR query LIKE '%job_cards%')) AS blocked`)).rows[0]!.blocked,
        2_000, 'offboarding waiting on concurrent mutation');
        gate.release();
        const result = await mutation;
        expect(await execution).toMatchObject({ code: 'STALE_PLAN', statusCode: 409 });
        expect((await f.pool.query('SELECT is_active FROM users WHERE id=$1', [f.target.id])).rows[0]!.is_active).toBe(true);
        const owner = command === 'REASSIGN' ? f.replacementC : f.target;
        const detail = await jobs.detail(owner, created.id);
        expect(detail.version).toBe(result.version);
        expect(detail.status).toBe(command === 'START' ? 'IN_PROGRESS' : command === 'REASSIGN' ? 'NEW' : 'ACCEPTED');
        expect((await f.pool.query(`SELECT count(*)::int AS n FROM audit_events
          WHERE event_type='USER_OFFBOARDED' AND subject_id=$1`, [f.target.id])).rows[0]!.n).toBe(0);
      } finally { gate.release(); await mutation; await execution; }
    });
  });

  it.each(['GENERAL_TASK', 'PRODUCT_DELIVERY', 'SALES_MEETING', 'SALE'])('resets accepted %s ownership without rewriting historical acceptance', async (type) => {
    await withFixture(async (f) => {
      if (type === 'SALE') await f.pool.query(`UPDATE job_cards SET type='SALES_MEETING',
        engagement_kind='CUSTOMER_VISIT', customer_id=$2 WHERE id=$1`, [f.ids.completedJob, f.ids.customer]);
      await f.pool.query(`UPDATE job_cards SET type=$2::varchar(30), customer_id=$3,
        engagement_kind=CASE WHEN $2::varchar(30)='SALES_MEETING' THEN 'CUSTOMER_VISIT' ELSE NULL END,
        sale_source_visit_id=CASE WHEN $2::varchar(30)='SALE' THEN $4::uuid ELSE NULL END WHERE id=$1`,
      [f.ids.acceptedJob, type, f.ids.customer, f.ids.completedJob]);
      const plan = await f.service.preview(f.admin, f.target.id);
      await f.service.execute(f.admin, f.target.id, actualDecisions(f, plan, randomUUID()));
      expect((await f.pool.query('SELECT status, accepted_at, accepted_by FROM job_cards WHERE id=$1',
        [f.ids.acceptedJob])).rows).toEqual([{ status: 'NEW', accepted_at: null, accepted_by: null }]);
    });
  });

  it.each(['NEW', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'])('preserves %s lifecycle facts during the existing active-work transfer exception', async (status) => {
    await withFixture(async (f) => {
      const id = await insertJob(f.pool, { organizationId: f.organizationId, assignedTo: f.target.id, createdBy: f.admin.id, status });
      if (status !== 'NEW') await f.pool.query('UPDATE job_cards SET accepted_at=$2, accepted_by=$3 WHERE id=$1', [id, at, f.target.id]);
      const facts = async () => (await f.pool.query(`SELECT status, accepted_at, accepted_by, started_at,
        staff_completed_at, staff_completed_by, revision_requested_at, revision_requested_by FROM job_cards WHERE id=$1`, [id])).rows;
      const before = await facts();
      const plan = await f.service.preview(f.admin, f.target.id);
      await f.service.execute(f.admin, f.target.id, actualDecisions(f, plan, randomUUID()));
      expect(await facts()).toEqual(before);
    });
  });

  it('leaves another active assignee acceptance intact when only their follow-up proposal is transferred', async () => {
    await withFixture(async (f) => {
      const id = await insertJob(f.pool, { organizationId: f.organizationId, assignedTo: f.replacementC.id,
        createdBy: f.admin.id, status: 'ACCEPTED', followUpAssignee: f.target.id });
      const plan = await f.service.preview(f.admin, f.target.id);
      expect(plan.jobs.map((j) => j.id)).not.toContain(id);
      await f.service.execute(f.admin, f.target.id, actualDecisions(f, plan, randomUUID()));
      expect((await f.pool.query('SELECT status, accepted_at, accepted_by, assigned_to FROM job_cards WHERE id=$1', [id])).rows)
        .toEqual([{ status: 'ACCEPTED', accepted_at: at, accepted_by: f.replacementC.id, assigned_to: f.replacementC.id }]);
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
      const before = await snapshotOffboardingState(fixture.pool);
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
      expect(await snapshotOffboardingState(fixture.pool)).toEqual(before);

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

async function snapshotJobHistory(pool: Pick<Pool, 'query'>, jobId: string) {
  const job = (await pool.query('SELECT * FROM job_cards WHERE id = $1', [jobId])).rows[0];
  const related: Record<string, unknown> = {};
  for (const table of ['job_card_activity_logs', 'job_card_assignment_history', 'job_card_accountability_facts']) {
    related[table] = (await pool.query(
      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE job_card_id = $1 ORDER BY to_jsonb(t)::text`, [jobId],
    )).rows;
  }
  return { job, ...related };
}

async function snapshotOffboardingState(pool: Pool) {
  const state: Record<string, unknown> = {};
  for (const table of ['users', 'sessions', 'job_cards', 'job_card_activity_logs', 'job_card_assignment_history',
    'job_card_accountability_facts', 'job_card_overdue_incidents', 'audit_events', 'processed_actions',
    'customers', 'calendar_events', 'calendar_reminders', 'conversation_participants', 'messaging_activity_logs',
    'realtime_events']) {
    state[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return state;
}

const terminalVariants = ['COMPLETED', 'CANCELLED', 'INVALIDATED'].flatMap((status) => (
  [true, false].map((sameAssignee) => ({ status, sameAssignee }))
));

describe.skipIf(!databaseUrl)('SOF-1 terminal offboarding history integrity', () => {
  it.each(terminalVariants)('blocks unresolved future proposal without changing $status history (same assignee=$sameAssignee)', async ({ status, sameAssignee }) => {
    await withFixture(async (fixture) => {
      const jobId = await insertJob(fixture.pool, {
        organizationId: fixture.organizationId,
        assignedTo: sameAssignee ? fixture.target.id : fixture.replacementC.id,
        createdBy: fixture.admin.id, status, followUpAssignee: fixture.target.id,
      });
      const before = await snapshotJobHistory(fixture.pool, jobId);
      const allBefore = await snapshotOffboardingState(fixture.pool);
      let failure: unknown;
      try {
        const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
        await fixture.service.execute(fixture.admin, fixture.target.id, actualDecisions(fixture, plan, randomUUID()));
      } catch (error) { failure = error; }
      expect(await snapshotJobHistory(fixture.pool, jobId)).toEqual(before);
      expect(failure).toMatchObject({ code: 'OFFBOARDING_TERMINAL_FOLLOW_UP_REQUIRES_REVIEW', statusCode: 409 });
      expect(await snapshotOffboardingState(fixture.pool)).toEqual(allBefore);
      expect(fixture.disconnectUser).not.toHaveBeenCalled();
    });
  });
  it.each(terminalVariants)('preserves $status without a future proposal while transferring active work and replaying (same assignee=$sameAssignee)', async ({ status, sameAssignee }) => {
    await withFixture(async (fixture) => {
      const jobId = await insertJob(fixture.pool, {
        organizationId: fixture.organizationId, assignedTo: sameAssignee ? fixture.target.id : fixture.replacementC.id,
        createdBy: fixture.admin.id, status,
      });
      const before = await snapshotJobHistory(fixture.pool, jobId);
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      expect(plan.jobs.some((job) => job.id === jobId)).toBe(false);
      expect(plan.followUps.some((job) => job.jobCardId === jobId)).toBe(false);
      const request = actualDecisions(fixture, plan, randomUUID());
      const result = await fixture.service.execute(fixture.admin, fixture.target.id, request);
      expect(await snapshotJobHistory(fixture.pool, jobId)).toEqual(before);
      expect((await snapshotJobHistory(fixture.pool, fixture.ids.activeJob)).job).toMatchObject({
        assigned_to: fixture.replacementB.id, follow_up_proposed_assignee: fixture.replacementB.id,
      });
      const after = await snapshotOffboardingState(fixture.pool);
      expect(await fixture.service.execute(fixture.admin, fixture.target.id, request)).toEqual(result);
      expect(await snapshotOffboardingState(fixture.pool)).toEqual(after);
    });
  });

  it.each(['COMPLETED', 'CANCELLED', 'INVALIDATED'])('preserves historical past proposals on %s', async (status) => {
    await withFixture(async (fixture) => {
      const jobId = await insertJob(fixture.pool, { organizationId: fixture.organizationId, assignedTo: fixture.target.id,
        createdBy: fixture.admin.id, status, followUpAssignee: fixture.target.id });
      await fixture.pool.query('UPDATE job_cards SET follow_up_proposed_at=$2 WHERE id=$1', [jobId, at]);
      const before = await snapshotJobHistory(fixture.pool, jobId);
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      await fixture.service.execute(fixture.admin, fixture.target.id, actualDecisions(fixture, plan, randomUUID()));
      expect(await snapshotJobHistory(fixture.pool, jobId)).toEqual(before);
    });
  });

  it('preserves a future terminal proposal owned by another active staff member', async () => {
    await withFixture(async (fixture) => {
      const jobId = await insertJob(fixture.pool, { organizationId: fixture.organizationId, assignedTo: fixture.target.id,
        createdBy: fixture.admin.id, status: 'COMPLETED', followUpAssignee: fixture.replacementC.id });
      const before = await snapshotJobHistory(fixture.pool, jobId);
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      await fixture.service.execute(fixture.admin, fixture.target.id, actualDecisions(fixture, plan, randomUUID()));
      expect(await snapshotJobHistory(fixture.pool, jobId)).toEqual(before);
    });
  });

  it('rechecks a terminal proposal at execute and rolls back the claim without partially offboarding', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      const jobId = await insertJob(fixture.pool, { organizationId: fixture.organizationId, assignedTo: fixture.target.id,
        createdBy: fixture.admin.id, status: 'COMPLETED', followUpAssignee: fixture.target.id });
      // A child link alone is not a proposal-consumption witness.
      await fixture.pool.query('UPDATE job_cards SET source_job_card_id=$2,follow_up_instructions=$3 WHERE id=$1',
        [fixture.ids.activeJob, jobId, 'Live child remains independently assigned']);
      const before = await snapshotOffboardingState(fixture.pool);
      await expect(fixture.service.execute(fixture.admin, fixture.target.id, actualDecisions(fixture, plan, randomUUID())))
        .rejects.toMatchObject({ code: 'OFFBOARDING_TERMINAL_FOLLOW_UP_REQUIRES_REVIEW', statusCode: 409 });
      expect(await snapshotOffboardingState(fixture.pool)).toEqual(before);
      expect(fixture.disconnectUser).not.toHaveBeenCalled();
    });
  });

  it('keeps stale-plan rejection atomic alongside preserved terminal history', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      await fixture.pool.query('UPDATE job_cards SET version=version+1 WHERE id=$1', [fixture.ids.activeJob]);
      const before = await snapshotOffboardingState(fixture.pool);
      await expect(fixture.service.execute(fixture.admin, fixture.target.id, actualDecisions(fixture, plan, randomUUID())))
        .rejects.toMatchObject({ code: 'STALE_PLAN', statusCode: 409 });
      expect(await snapshotOffboardingState(fixture.pool)).toEqual(before);
    });
  });

  it('rechecks status after a concurrent terminal transition wins the job row lock', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      const before = await snapshotOffboardingState(fixture.pool);
      delete before.job_cards; // The competing writer owns its explicit transition below.
      const writer = await fixture.pool.connect();
      let execution: Promise<unknown> | undefined;
      try {
        await writer.query('BEGIN');
        const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await writer.query('SELECT id FROM job_cards WHERE id=$1 FOR UPDATE', [fixture.ids.activeJob]);
        execution = fixture.service.execute(fixture.admin, fixture.target.id, actualDecisions(fixture, plan, randomUUID()))
          .then((result) => result, (error: unknown) => error);
        await timeout((async () => {
          const deadline = Date.now() + 1_500;
          while (Date.now() < deadline) {
            const waiting = await fixture.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%job_cards%') AS blocked`, [writerPid]);
            if (waiting.rows[0]!.blocked) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error('Offboarding did not reach the competing job row lock');
        })(), 'offboarding waiting on the concurrent job row');
        await writer.query(`UPDATE job_cards SET status='CANCELLED',cancelled_at=$2,cancelled_by=$3,
          cancel_reason='Concurrent cancellation',version=version+1 WHERE id=$1`,
          [fixture.ids.activeJob, at, fixture.admin.id]);
        const terminal = await snapshotJobHistory(writer, fixture.ids.activeJob);
        await writer.query('COMMIT');
        expect(await execution).toMatchObject({ code: 'OFFBOARDING_TERMINAL_FOLLOW_UP_REQUIRES_REVIEW', statusCode: 409 });
        expect(await snapshotJobHistory(fixture.pool, fixture.ids.activeJob)).toEqual(terminal);
        const after = await snapshotOffboardingState(fixture.pool);
        delete after.job_cards;
        expect(after).toEqual(before);
        expect(fixture.disconnectUser).not.toHaveBeenCalled();
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
        await execution;
      }
    });
  });

  it('rolls back all successful responsibility writes when the final deactivation fails', async () => {
    await withFixture(async (fixture) => {
      await fixture.pool.query(`CREATE FUNCTION sof1_fail_deactivation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'SOF1 injected late failure'; END $$`);
      await fixture.pool.query(`CREATE TRIGGER sof1_fail_deactivation BEFORE UPDATE OF is_active ON users
        FOR EACH ROW WHEN (NOT NEW.is_active) EXECUTE FUNCTION sof1_fail_deactivation()`);
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      const before = await snapshotOffboardingState(fixture.pool);
      await expect(fixture.service.execute(fixture.admin, fixture.target.id, actualDecisions(fixture, plan, randomUUID())))
        .rejects.toThrow('SOF1 injected late failure');
      expect(await snapshotOffboardingState(fixture.pool)).toEqual(before);
      expect(fixture.disconnectUser).not.toHaveBeenCalled();
    });
  });

  it('does not expose a terminal blocker across role or organization boundaries', async () => {
    await withFixture(async (fixture) => {
      const otherTarget = await insertUser(fixture.pool, fixture.otherOrganizationId, 'STAFF', 'Other target');
      const otherJob = await insertJob(fixture.pool, { organizationId: fixture.otherOrganizationId, assignedTo: otherTarget.id,
        createdBy: fixture.otherAdmin.id, status: 'COMPLETED', followUpAssignee: otherTarget.id });
      const before = await snapshotOffboardingState(fixture.pool);
      await expect(fixture.service.preview(fixture.manager, otherTarget.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(fixture.service.preview(fixture.admin, otherTarget.id)).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      await expect(fixture.service.execute(fixture.otherAdmin, fixture.target.id, actualDecisions(fixture, plan, randomUUID())))
        .rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
      expect(await snapshotOffboardingState(fixture.pool)).toEqual(before);
      const original = await snapshotJobHistory(fixture.pool, otherJob);
      await fixture.service.execute(fixture.admin, fixture.target.id, actualDecisions(fixture, plan, randomUUID()));
      expect(await snapshotJobHistory(fixture.pool, otherJob)).toEqual(original);
    });
  });

  it('preserves populated terminal activity, assignment and accountability facts when blocked', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.service.preview(fixture.admin, fixture.target.id);
      const jobId = await insertJob(fixture.pool, { organizationId: fixture.organizationId, assignedTo: fixture.target.id,
        createdBy: fixture.admin.id, status: 'COMPLETED', followUpAssignee: fixture.target.id });
      await fixture.pool.query(`INSERT INTO job_card_schedule_revisions
        (organization_id,job_card_id,revision_no,organization_timezone,source,created_by,created_at)
        VALUES($1,$2,1,'Europe/Istanbul','CREATE',$3,$4)`, [fixture.organizationId, jobId, fixture.admin.id, at]);
      const activityId = (await fixture.pool.query(`INSERT INTO job_card_activity_logs
        (organization_id,job_card_id,actor_id,event_type) VALUES($1,$2,$3,'JOB_STARTED') RETURNING id`,
        [fixture.organizationId, jobId, fixture.target.id])).rows[0]!.id;
      await fixture.pool.query(`INSERT INTO job_card_assignment_history
        (organization_id,job_card_id,to_user_id,changed_by,source,changed_at)
        VALUES($1,$2,$3,$4,'CREATE',$5)`, [fixture.organizationId, jobId, fixture.target.id, fixture.admin.id, at]);
      await fixture.pool.query(`INSERT INTO job_card_accountability_facts
        (organization_id,job_card_id,fact_type,seq_no,occurred_at,schedule_revision_no,responsible_user_id,actor_user_id,source_activity_id)
        VALUES($1,$2,'STARTED',1,$3,1,$4,$4,$5)`, [fixture.organizationId, jobId, at, fixture.target.id, activityId]);
      const before = await snapshotOffboardingState(fixture.pool);
      await expect(fixture.service.execute(fixture.admin, fixture.target.id, actualDecisions(fixture, plan, randomUUID())))
        .rejects.toMatchObject({ code: 'OFFBOARDING_TERMINAL_FOLLOW_UP_REQUIRES_REVIEW' });
      expect(await snapshotOffboardingState(fixture.pool)).toEqual(before);
    });
  });

});
