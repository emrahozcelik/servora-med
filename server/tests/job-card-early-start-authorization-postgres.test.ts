import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, JobCardListQuery, JobCardType } from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { readDbBaseline, readReservedAt, MINUTE_MS } from './support/db-clock-baseline.js';

/**
 * JOB-010 release 1 — PostgreSQL acceptance (A8–A12):
 * accept before start, the 30-minute START tolerance, the durable management
 * early-start authorization and its one-way voiding.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `job010_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      store: new PostgresMigrationStore(pool),
    });
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function insertOrg(pool: Pool, name = 'JOB-010 Klinik'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [name],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
  name = `${role} User`,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

type FixtureJob = {
  id: string;
  version: number;
  status: string;
  scheduledAt: string;
  scheduledEndsAt: string;
};

async function insertJob(pool: Pool, input: {
  organizationId: string;
  type: JobCardType;
  status?: 'NEW' | 'ACCEPTED' | 'IN_PROGRESS';
  assignedTo: string;
  createdBy: string;
  scheduledAt: string;
  scheduledEndsAt: string;
  accepted?: boolean;
}): Promise<FixtureJob> {
  const status = input.status ?? 'ACCEPTED';
  const engagementKind = input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null;
  const row = (await pool.query<{ id: string; version: number; status: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        accepted_at, accepted_by, scheduled_at, scheduled_ends_at, engagement_kind)
     VALUES ($1, $2, $3, 'JOB-010 zamanlanmış iş', $4, $5,
             $6::timestamptz, $7::uuid, $8::timestamptz, $9::timestamptz, $10)
     RETURNING id, version, status`,
    [
      input.organizationId, input.type, status, input.assignedTo, input.createdBy,
      input.accepted === false || status === 'NEW' ? null : '2026-01-01T09:00:00.000Z',
      input.accepted === false || status === 'NEW' ? null : input.assignedTo,
      input.scheduledAt, input.scheduledEndsAt, engagementKind,
    ],
  )).rows[0]!;
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
        organization_timezone, source, created_by)
     VALUES ($1, $2, 1, $3, $4, 'Europe/Istanbul', 'CREATE', $5)`,
    [input.organizationId, row.id, input.scheduledAt, input.scheduledEndsAt, input.createdBy],
  );
  return {
    id: row.id,
    version: Number(row.version),
    status: String(row.status),
    scheduledAt: input.scheduledAt,
    scheduledEndsAt: input.scheduledEndsAt,
  };
}

function buildService(pool: Pool, clock: { now: Date }) {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  const service = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    publisher,
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
  return { service, published };
}

async function readJob(pool: Pool, jobCardId: string) {
  return (await pool.query<{
    status: string;
    version: number;
    scheduled_at: Date | null;
    scheduled_ends_at: Date | null;
    started_at: Date | null;
    assigned_to: string;
  }>(
    `SELECT status, version, scheduled_at, scheduled_ends_at, started_at, assigned_to
       FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

async function readAuthorizations(pool: Pool, jobCardId: string) {
  return (await pool.query<{
    id: string;
    assignee_user_id: string;
    schedule_revision_no: number;
    scheduled_at: Date;
    scheduled_ends_at: Date | null;
    granted_by: string;
    granted_at: Date;
    voided_at: Date | null;
    void_reason: string | null;
  }>(
    `SELECT id, assignee_user_id, schedule_revision_no, scheduled_at, scheduled_ends_at,
            granted_by, granted_at, voided_at, void_reason
       FROM job_card_early_start_authorizations
      WHERE job_card_id = $1
      ORDER BY granted_at, id`,
    [jobCardId],
  )).rows;
}

function listQuery(overrides: Partial<JobCardListQuery> = {}): JobCardListQuery {
  return {
    q: null, type: null, status: 'all', assignedTo: null, customerId: null,
    priority: null, dueBefore: null, dueAfter: null, limit: 25, offset: 0,
    overdue: false, ...overrides,
  };
}

describe.skipIf(!databaseUrl)('JOB-010 release 1 — early start and tolerance', () => {
  it('applies migration 063 and keeps the schema head there', async () => {
    await withSchema(async (pool) => {
      const head = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      expect(head.rows[0]?.version).toBe('063_job_card_early_start_authorizations');
      const table = await pool.query<{ table: string | null }>(
        "SELECT to_regclass('job_card_early_start_authorizations')::text AS table",
      );
      expect(table.rows[0]?.table).not.toBeNull();
    });
  });

  it('A8: START at scheduledAt - 30 minutes is allowed and keeps the planned interval', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const scheduledAt = new Date(baseline.getTime() + 30 * MINUTE_MS).toISOString();
      const scheduledEndsAt = new Date(baseline.getTime() + 90 * MINUTE_MS).toISOString();
      const job = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt,
      });
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);
      const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };

      const started = await service.start(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });

      expect(started.status).toBe('IN_PROGRESS');
      const reservedAt = await readReservedAt(pool, job.id, 'START');
      const persisted = await readJob(pool, job.id);
      expect(persisted.scheduled_at?.toISOString()).toBe(scheduledAt);
      expect(persisted.scheduled_ends_at?.toISOString()).toBe(scheduledEndsAt);
      expect(persisted.started_at?.toISOString()).toBe(reservedAt.toISOString());
      expect(persisted.started_at!.getTime()).toBeGreaterThanOrEqual(
        Date.parse(scheduledAt) - 30 * MINUTE_MS,
      );
      expect(persisted.started_at!.getTime()).toBeLessThan(Date.parse(scheduledAt));
    });
  });

  it('A9: START before the 30-minute tolerance is rejected without side effects', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      // 31 minutes ahead keeps the request strictly inside the refused zone
      // even with scheduling jitter; the exact -30min / -30min-1ms boundary is
      // pinned deterministically by the policy unit tests.
      const scheduledAt = new Date(baseline.getTime() + 31 * MINUTE_MS).toISOString();
      const scheduledEndsAt = new Date(baseline.getTime() + 61 * MINUTE_MS).toISOString();
      const job = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt,
      });
      const { service } = buildService(pool, { now: baseline });
      const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };

      await expect(service.start(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      })).rejects.toMatchObject({ code: 'INVALID_TRANSITION', statusCode: 409 });

      const persisted = await readJob(pool, job.id);
      expect(persisted).toMatchObject({ status: 'ACCEPTED', version: job.version, started_at: null });
      expect(await readAuthorizations(pool, job.id)).toHaveLength(0);
      const events = await pool.query(
        "SELECT 1 FROM job_card_activity_logs WHERE job_card_id = $1 AND event_type = 'JOB_STARTED'",
        [job.id],
      );
      expect(events.rows).toHaveLength(0);
      const incidents = await pool.query(
        "SELECT 1 FROM job_card_overdue_incidents WHERE job_card_id = $1",
        [job.id],
      );
      expect(incidents.rows).toHaveLength(0);
    });
  });

  it('A10: an authorization lets START earlier than the tolerance and records actor, instant and revision', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      // Planned 60 minutes out; the early start happens at the clock instant.
      const scheduledAt = new Date(baseline.getTime() + 60 * MINUTE_MS).toISOString();
      const scheduledEndsAt = new Date(baseline.getTime() + 120 * MINUTE_MS).toISOString();
      const job = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt,
      });
      const clock = { now: baseline };
      const { service, published } = buildService(pool, clock);
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };

      const receipt = await service.grantEarlyStartAuthorization(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(receipt).toMatchObject({
        jobCardId: job.id,
        grantedAt: baseline.toISOString(),
      });

      const rows = await readAuthorizations(pool, job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        assignee_user_id: staffId,
        schedule_revision_no: 1,
        granted_by: managerId,
        voided_at: null,
        void_reason: null,
      });
      expect(rows[0]!.scheduled_at.toISOString()).toBe(scheduledAt);
      expect(rows[0]!.scheduled_ends_at?.toISOString()).toBe(scheduledEndsAt);
      expect(rows[0]!.granted_at.toISOString()).toBe(baseline.toISOString());

      const detail = await service.detail(staff, job.id);
      expect(detail.earlyStartAuthorization).toEqual({
        grantedAt: baseline.toISOString(),
        grantedBy: { id: managerId, name: 'Müdür' },
      });
      expect(detail.workflowContext.allowedCommands).toContain('START');

      const started = await service.start(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version + 1,
      });
      expect(started.status).toBe('IN_PROGRESS');
      const reservedAt = await readReservedAt(pool, job.id, 'START');
      const persisted = await readJob(pool, job.id);
      expect(persisted.scheduled_at?.toISOString()).toBe(scheduledAt);
      expect(persisted.scheduled_ends_at?.toISOString()).toBe(scheduledEndsAt);
      expect(persisted.started_at?.toISOString()).toBe(reservedAt.toISOString());

      const activity = await pool.query<{ id: string; actor_id: string; metadata: Record<string, unknown> }>(
        `SELECT id, actor_id, metadata FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_EARLY_START_AUTHORIZED'`,
        [job.id],
      );
      expect(activity.rows).toHaveLength(1);
      expect(activity.rows[0]!.actor_id).toBe(managerId);
      expect(activity.rows[0]!.metadata).toMatchObject({
        authorizationId: rows[0]!.id,
        assigneeUserId: staffId,
        scheduleRevisionNo: 1,
        scheduledAt,
        scheduledEndsAt,
        grantedAt: baseline.toISOString(),
      });
      // The grant refreshes the job views through the established transport.
      const grantEvent = published.find(
        (event) => event.sourceActivityId === activity.rows[0]!.id,
      );
      expect(grantEvent).toMatchObject({ type: 'job.updated', entityId: job.id });
      expect(grantEvent!.resourceKeys).toContain(`job-detail:${job.id}`);
    });
  });

  it('A11: reassignment and reschedule void the authorization, a dueDate-only revision does not', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Personel A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Personel B');
      const scheduledAt = new Date(baseline.getTime() + 60 * MINUTE_MS).toISOString();
      const scheduledEndsAt = new Date(baseline.getTime() + 120 * MINUTE_MS).toISOString();
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };

      const createAuthorizedJob = async () => {
        const job = await insertJob(pool, {
          organizationId, type: 'PRODUCT_DELIVERY', assignedTo: staffAId, createdBy: managerId,
          scheduledAt, scheduledEndsAt,
        });
        await service.grantEarlyStartAuthorization(manager, job.id, {
          clientActionId: randomUUID(), expectedVersion: job.version,
        });
        return job;
      };

      // Reassignment.
      const reassigned = await createAuthorizedJob();
      const afterReassign = await service.patch(manager, reassigned.id, {
        expectedVersion: reassigned.version + 1,
        assignedTo: staffBId,
      });
      expect(afterReassign.earlyStartAuthorization).toBeNull();
      expect((await readAuthorizations(pool, reassigned.id))[0]).toMatchObject({
        void_reason: 'REASSIGNED',
      });

      // Planned interval change.
      const rescheduled = await createAuthorizedJob();
      await service.patch(manager, rescheduled.id, {
        expectedVersion: rescheduled.version + 1,
        scheduledAt: new Date(baseline.getTime() + 180 * MINUTE_MS).toISOString(),
      });
      expect((await readAuthorizations(pool, rescheduled.id))[0]).toMatchObject({
        void_reason: 'RESCHEDULED',
      });

      // dueDate-only revision keeps the authorization valid.
      const dueDateOnly = await createAuthorizedJob();
      const kept = await service.patch(manager, dueDateOnly.id, {
        expectedVersion: dueDateOnly.version + 1,
        dueDate: '2026-12-31',
      });
      expect(kept.earlyStartAuthorization).not.toBeNull();
      expect((await readAuthorizations(pool, dueDateOnly.id))[0]).toMatchObject({
        voided_at: null,
        void_reason: null,
      });
    });
  });

  it('A12: an early start creates no LATE_START incident', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const scheduledAt = new Date(baseline.getTime() + 90 * MINUTE_MS).toISOString();
      const scheduledEndsAt = new Date(baseline.getTime() + 150 * MINUTE_MS).toISOString();
      const job = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt,
      });
      const { service } = buildService(pool, { now: baseline });
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };

      await service.grantEarlyStartAuthorization(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      await service.start(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version + 1,
      });

      const incidents = await pool.query(
        "SELECT delay_type FROM job_card_overdue_incidents WHERE job_card_id = $1",
        [job.id],
      );
      expect(incidents.rows).toHaveLength(0);
    });
  });

  it('authorization endpoint: STAFF 403 before lookup, cross-org 404, not-applicable 409', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const otherOrganizationId = await insertOrg(pool, 'Diğer Klinik');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const otherManagerId = await insertUser(pool, otherOrganizationId, 'MANAGER', 'Diğer Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const scheduledAt = new Date(baseline.getTime() + 60 * MINUTE_MS).toISOString();
      const job = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt: new Date(baseline.getTime() + 120 * MINUTE_MS).toISOString(),
      });
      const task = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', assignedTo: staffId, createdBy: managerId,
        scheduledAt: new Date(baseline.getTime() + 60 * MINUTE_MS).toISOString(),
        scheduledEndsAt: new Date(baseline.getTime() + 90 * MINUTE_MS).toISOString(),
      });
      const { service } = buildService(pool, { now: baseline });
      const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const otherManager: JobCardActor = { id: otherManagerId, organizationId: otherOrganizationId, role: 'MANAGER' };

      // STAFF is refused before any lookup: even an unknown id cannot leak existence.
      await expect(service.grantEarlyStartAuthorization(staff, randomUUID(), {
        clientActionId: randomUUID(), expectedVersion: 1,
      })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(service.grantEarlyStartAuthorization(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

      // Cross-org jobs stay concealed.
      await expect(service.grantEarlyStartAuthorization(otherManager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      await expect(service.grantEarlyStartAuthorization(manager, randomUUID(), {
        clientActionId: randomUUID(), expectedVersion: job.version,
      })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });

      // Only planned interval jobs in the assignment stage are eligible.
      await expect(service.grantEarlyStartAuthorization(manager, task.id, {
        clientActionId: randomUUID(), expectedVersion: task.version,
      })).rejects.toMatchObject({ code: 'EARLY_START_NOT_APPLICABLE', statusCode: 409 });

      expect(await readAuthorizations(pool, job.id)).toHaveLength(0);
      expect(await readAuthorizations(pool, task.id)).toHaveLength(0);
    });
  });

  it('authorization endpoint: version conflict, already-authorized and idempotent replay', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const scheduledAt = new Date(baseline.getTime() + 60 * MINUTE_MS).toISOString();
      const job = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt: new Date(baseline.getTime() + 120 * MINUTE_MS).toISOString(),
      });
      const { service } = buildService(pool, { now: baseline });
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };

      await expect(service.grantEarlyStartAuthorization(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version + 1,
      })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
      expect(await readAuthorizations(pool, job.id)).toHaveLength(0);

      const clientActionId = randomUUID();
      const first = await service.grantEarlyStartAuthorization(manager, job.id, {
        clientActionId, expectedVersion: job.version,
      });
      const replay = await service.grantEarlyStartAuthorization(manager, job.id, {
        clientActionId, expectedVersion: job.version,
      });
      expect(replay).toEqual(first);
      // The same clientActionId with a different request identity is rejected,
      // never silently replayed.
      await expect(service.grantEarlyStartAuthorization(manager, job.id, {
        clientActionId, expectedVersion: job.version + 1,
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      const rows = await readAuthorizations(pool, job.id);
      expect(rows).toHaveLength(1);
      const persisted = await readJob(pool, job.id);
      expect(persisted.version).toBe(job.version + 1);

      await expect(service.grantEarlyStartAuthorization(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: persisted.version,
      })).rejects.toMatchObject({ code: 'EARLY_START_ALREADY_AUTHORIZED', statusCode: 409 });
      expect(await readAuthorizations(pool, job.id)).toHaveLength(1);

      const activities = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_EARLY_START_AUTHORIZED'`,
        [job.id],
      );
      expect(activities.rows[0]?.count).toBe('1');
    });
  });

  it('projects the same authorization fact on the list and never serializes the internal flag', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const scheduledAt = new Date(baseline.getTime() + 60 * MINUTE_MS).toISOString();
      const job = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt: new Date(baseline.getTime() + 120 * MINUTE_MS).toISOString(),
      });
      const { service } = buildService(pool, { now: baseline });
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };

      const before = await service.list(staff, listQuery());
      expect(before.items.find((item) => item.id === job.id)?.allowedCommands)
        .not.toContain('START');

      await service.grantEarlyStartAuthorization(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });

      const after = await service.list(staff, listQuery());
      const item = after.items.find((entry) => entry.id === job.id);
      expect(item?.allowedCommands).toContain('START');
      expect(item).not.toHaveProperty('earlyStartAuthorized');

      const board = await service.board(staff, {
        q: null, type: null, assignedTo: null, customerId: null, priority: null,
        dueBefore: null, dueAfter: null, limit: 10,
      });
      const boardItem = board.columns.ACCEPTED.items.find((entry) => entry.id === job.id);
      expect(boardItem?.allowedCommands).toContain('START');
      expect(boardItem).not.toHaveProperty('earlyStartAuthorized');
    });
  });

  it('enforces at most one live authorization per job and keeps voided history', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const scheduledAt = '2026-12-01T14:00:00.000Z';
      const job = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt: '2026-12-01T15:00:00.000Z',
      });
      const insert = (clientActionId: string) => pool.query(
        `INSERT INTO job_card_early_start_authorizations
           (organization_id, job_card_id, assignee_user_id, schedule_revision_no,
            scheduled_at, scheduled_ends_at, granted_by, granted_at, client_action_id)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
        [organizationId, job.id, staffId, scheduledAt, '2026-12-01T15:00:00.000Z',
          managerId, '2026-11-30T10:00:00.000Z', clientActionId],
      );

      const first = await insert(randomUUID());
      expect(first.rowCount).toBe(1);
      await expect(insert(randomUUID())).rejects.toMatchObject({ code: '23505' });

      await pool.query(
        `UPDATE job_card_early_start_authorizations
            SET voided_at = '2026-11-30T11:00:00.000Z', void_reason = 'RESCHEDULED'
          WHERE job_card_id = $1`,
        [job.id],
      );
      const second = await insert(randomUUID());
      expect(second.rowCount).toBe(1);
      expect(await readAuthorizations(pool, job.id)).toHaveLength(2);
    });
  });
});
