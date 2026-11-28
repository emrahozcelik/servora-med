import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  PostgresOverdueBreachScannerRepository,
  createOverdueBreachScanner,
} from '../src/modules/job-cards/overdue-breach-scanner.js';
import {
  PostgresOverdueReminderWorkerRepository,
  createOverdueReminderWorker,
} from '../src/modules/job-cards/overdue-reminder-worker.js';
import { ALWAYS_OPEN_NOTIFICATION_WINDOW } from '../src/modules/notifications/quiet-hours.js';
import { resolveOverdueReminderTiming } from '../src/modules/job-cards/overdue-reminder-policy.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, JobCardType } from '../src/modules/job-cards/types.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { ReportsService } from '../src/modules/reports/service.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { DAY_MS, MINUTE_MS, readDbBaseline, readReservedAt } from './support/db-clock-baseline.js';
import { passThroughReportReadSnapshot } from './support/report-read-snapshot.js';

/**
 * JOB-010 release 2a — PostgreSQL acceptance for Decision D1:
 * the Staff change/termination request, the management decision path, the
 * cancel/approve/invalidation closures, the OVR-4 freeze while a request is
 * open and the untouched Staff report metrics (acceptance A17, A20, A21).
 *
 * The contract is `docs/features/assignment-acceptance-sla.md`
 * ("Release 2a technical contract (D1)" and "Decision D1").
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const TIMING = resolveOverdueReminderTiming({});

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `job010cr_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, name = 'JOB-010 Değişiklik Klinik'): Promise<string> {
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
  isActive = true,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, $5) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role, isActive],
  )).rows[0]!.id;
}

async function insertCustomer(pool: Pool, organizationId: string, name = 'Özel Dent Klinik'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, name],
  )).rows[0]!.id;
}

type FixtureStatus =
  | 'NEW' | 'ACCEPTED' | 'IN_PROGRESS' | 'WAITING_APPROVAL' | 'COMPLETED' | 'CANCELLED';

type FixtureJob = {
  id: string;
  version: number;
  status: string;
  startedAt: string | null;
};

/**
 * Direct fixture insert. The change-request command is the unit under test, so
 * the job only has to satisfy the persisted lifecycle constraints; every
 * transition (cancel/approve/invalidate) then runs through the real service.
 */
async function insertJob(pool: Pool, input: {
  organizationId: string;
  type: JobCardType;
  status: FixtureStatus;
  assignedTo: string;
  createdBy: string;
  title?: string;
  customerId?: string | null;
  scheduledAt?: string | null;
  scheduledEndsAt?: string | null;
  startedAt?: string | null;
}): Promise<FixtureJob> {
  const accepted = input.status !== 'NEW';
  const started = ['IN_PROGRESS', 'WAITING_APPROVAL', 'COMPLETED'].includes(input.status);
  const staffCompleted = ['WAITING_APPROVAL', 'COMPLETED'].includes(input.status);
  const approved = input.status === 'COMPLETED';
  const cancelled = input.status === 'CANCELLED';
  const startedAt = started ? input.startedAt ?? '2026-01-01T09:00:00.000Z' : null;
  const engagementKind = input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null;
  const row = (await pool.query<{ id: string; version: number; status: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, assigned_to, created_by,
        accepted_at, accepted_by, started_at,
        staff_completed_at, staff_completed_by,
        manager_approved_at, manager_approved_by,
        cancelled_at, cancelled_by, cancel_reason,
        scheduled_at, scheduled_ends_at, engagement_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8::timestamptz, $9::uuid, $10::timestamptz,
             $11::timestamptz, $12::uuid,
             $13::timestamptz, $14::uuid,
             $15::timestamptz, $16::uuid, $17,
             $18::timestamptz, $19::timestamptz, $20)
     RETURNING id, version, status`,
    [
      input.organizationId, input.type, input.status,
      input.title ?? 'JOB-010 planlanmış iş', input.customerId ?? null,
      input.assignedTo, input.createdBy,
      accepted ? '2026-01-01T08:00:00.000Z' : null,
      accepted ? input.assignedTo : null,
      startedAt,
      staffCompleted ? '2026-01-01T10:00:00.000Z' : null,
      staffCompleted ? input.assignedTo : null,
      approved ? '2026-01-01T11:00:00.000Z' : null,
      approved ? input.createdBy : null,
      cancelled ? '2026-01-01T12:00:00.000Z' : null,
      cancelled ? input.createdBy : null,
      cancelled ? 'Fixture iptal nedeni' : null,
      input.scheduledAt ?? null, input.scheduledEndsAt ?? null, engagementKind,
    ],
  )).rows[0]!;
  if (input.scheduledAt) {
    await pool.query(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
          organization_timezone, source, created_by)
       VALUES ($1, $2, 1, $3, $4, 'Europe/Istanbul', 'CREATE', $5)`,
      [input.organizationId, row.id, input.scheduledAt, input.scheduledEndsAt ?? null, input.createdBy],
    );
  }
  return {
    id: row.id,
    version: Number(row.version),
    status: String(row.status),
    startedAt,
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

type JobRow = {
  status: string;
  version: number;
  assigned_to: string;
  started_at: Date | null;
  staff_completed_at: Date | null;
  manager_approved_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  scheduled_at: Date | null;
  scheduled_ends_at: Date | null;
};

async function readJob(pool: Pool, jobCardId: string): Promise<JobRow> {
  return (await pool.query<JobRow>(
    `SELECT status, version, assigned_to, started_at, staff_completed_at,
            manager_approved_at, cancelled_at, cancelled_by, cancel_reason,
            scheduled_at, scheduled_ends_at
       FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

type ChangeRequestRow = {
  id: string;
  organization_id: string;
  job_card_id: string;
  requested_by: string;
  requested_at: Date;
  job_status_at_request: string;
  reason_code: string;
  reason_text: string;
  client_action_id: string;
  state: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  linked_job_card_id: string | null;
};

async function readChangeRequests(pool: Pool, jobCardId: string): Promise<ChangeRequestRow[]> {
  return (await pool.query<ChangeRequestRow>(
    `SELECT id, organization_id, job_card_id, requested_by, requested_at,
            job_status_at_request, reason_code, reason_text, client_action_id,
            state, resolution, resolved_by, resolved_at, resolution_note,
            linked_job_card_id
       FROM job_card_change_requests
      WHERE job_card_id = $1
      ORDER BY requested_at ASC, id ASC`,
    [jobCardId],
  )).rows;
}

async function selectNotifications(
  pool: Pool, organizationId: string, jobId: string,
): Promise<Array<{ recipient_user_id: string; kind: string }>> {
  return (await pool.query(
    `SELECT recipient_user_id, kind FROM in_app_notifications
      WHERE organization_id = $1 AND entity_type = 'job-card' AND entity_id = $2
      ORDER BY created_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as Array<{ recipient_user_id: string; kind: string }>;
}

async function selectActivities(pool: Pool, jobId: string): Promise<string[]> {
  return (await pool.query<{ event_type: string }>(
    `SELECT event_type FROM job_card_activity_logs
      WHERE job_card_id = $1
      ORDER BY created_at ASC, id ASC`,
    [jobId],
  )).rows.map((row) => row.event_type);
}

async function selectActivity(
  pool: Pool, jobId: string, eventType: string,
): Promise<Array<{ actor_id: string | null; metadata: Record<string, unknown> }>> {
  return (await pool.query(
    `SELECT actor_id, metadata FROM job_card_activity_logs
      WHERE job_card_id = $1 AND event_type = $2
      ORDER BY created_at ASC, id ASC`,
    [jobId, eventType],
  )).rows as Array<{ actor_id: string | null; metadata: Record<string, unknown> }>;
}

function actor(id: string, organizationId: string, role: 'ADMIN' | 'MANAGER' | 'STAFF'): JobCardActor {
  return { id, organizationId, role };
}

type CreateChangeRequestInput = Parameters<JobCardService['createChangeRequest']>[2];

async function createRequest(
  service: JobCardService,
  staff: JobCardActor,
  jobCardId: string,
  overrides: Partial<CreateChangeRequestInput> = {},
) {
  return service.createChangeRequest(staff, jobCardId, {
    clientActionId: randomUUID(),
    reasonCode: 'CUSTOMER_POSTPONED',
    reasonText: 'Müşteri görüşmeyi ileri bir tarihe erteledi.',
    ...overrides,
  });
}

describe.skipIf(!databaseUrl)('JOB-010 release 2a — Staff change/termination request', () => {
  it('applies migration 064 and creates the change-request table', async () => {
    await withSchema(async (pool) => {
      const head = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      expect(head.rows[0]?.version).toBe('077_backup_worker_trusted_time_evidence');
      const table = await pool.query<{ table: string | null }>(
        "SELECT to_regclass('job_card_change_requests')::text AS table",
      );
      expect(table.rows[0]?.table).not.toBeNull();
    });
  });

  it('A17: an assigned Staff request leaves the job untouched and notifies every active manager', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const inactiveManagerId = await insertUser(
        pool, organizationId, 'MANAGER', 'Pasif Müdür', false,
      );
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const otherStaffId = await insertUser(pool, organizationId, 'STAFF', 'Diğer Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const scheduledAt = new Date(baseline.getTime() + 60 * MINUTE_MS).toISOString();
      const job = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId, customerId,
        scheduledAt, scheduledEndsAt: new Date(baseline.getTime() + 120 * MINUTE_MS).toISOString(),
        startedAt: new Date(baseline.getTime() - 10 * MINUTE_MS).toISOString(),
      });
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const staff = actor(staffId, organizationId, 'STAFF');
      const before = await readJob(pool, job.id);
      // Without an open request the assignee may open one.
      expect((await service.detail(staff, job.id)).workflowContext.allowedActions)
        .toContain('REQUEST_CHANGE');

      const response = await createRequest(service, staff, job.id, {
        reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
        reasonText: '  Depoda uygun implant seti yok.  ',
      });

      expect(response).toMatchObject({
        jobCardId: job.id,
        changeRequestId: expect.any(String),
        requestedAt: clock.now.toISOString(),
      });

      // The request never changes the JobCard row, status or version.
      expect(await readJob(pool, job.id)).toEqual(before);

      const rows = await readChangeRequests(pool, job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organization_id: organizationId,
        job_card_id: job.id,
        requested_by: staffId,
        job_status_at_request: 'IN_PROGRESS',
        reason_code: 'MISSING_STOCK_OR_EQUIPMENT',
        reason_text: 'Depoda uygun implant seti yok.',
        state: 'OPEN',
        resolution: null,
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
        linked_job_card_id: null,
      });
      expect(rows[0]!.id).toBe(response.changeRequestId);
      expect(rows[0]!.requested_at).toEqual(clock.now);

      const activities = await selectActivity(pool, job.id, 'JOB_CHANGE_REQUESTED');
      expect(activities).toHaveLength(1);
      expect(activities[0]!.actor_id).toBe(staffId);
      expect(activities[0]!.metadata).toMatchObject({
        requestId: response.changeRequestId,
        reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
        jobStatusAtRequest: 'IN_PROGRESS',
      });

      // Same recipient query as the OVR-4 escalation: every active
      // MANAGER/ADMIN and no one else.
      const requested = (await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.change_requested');
      expect(requested.map((notification) => notification.recipient_user_id).sort())
        .toEqual([adminId, managerId].sort());
      expect(requested.map((notification) => notification.recipient_user_id))
        .not.toContain(staffId);
      expect(requested.map((notification) => notification.recipient_user_id))
        .not.toContain(otherStaffId);
      expect(requested.map((notification) => notification.recipient_user_id))
        .not.toContain(inactiveManagerId);

      // Job detail DTO: the open request is visible to the assignee, and the
      // workflow actions follow the contract.
      const detail = await service.detail(staff, job.id);
      expect(detail.changeRequest).toEqual({
        id: response.changeRequestId,
        reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
        reasonText: 'Depoda uygun implant seti yok.',
        requestedAt: clock.now.toISOString(),
        requestedBy: { id: staffId, name: 'Saha Personeli' },
      });
      expect(detail.workflowContext.allowedActions).not.toContain('REQUEST_CHANGE');
      expect(detail.workflowContext.allowedActions).not.toContain('RESOLVE_CHANGE_REQUEST');
      const managerDetail = await service.detail(actor(managerId, organizationId, 'MANAGER'), job.id);
      expect(managerDetail.changeRequest).toEqual(detail.changeRequest);
      expect(managerDetail.workflowContext.allowedActions).toContain('RESOLVE_CHANGE_REQUEST');
      expect(managerDetail.workflowContext.allowedActions).not.toContain('REQUEST_CHANGE');
    });
  });

  it('rejects non-assignee Staff, managers, cross-org actors and terminal jobs', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const otherOrganizationId = await insertOrg(pool, 'Komşu Klinik');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const otherStaffId = await insertUser(pool, organizationId, 'STAFF', 'Diğer Personel');
      const otherOrgStaffId = await insertUser(pool, otherOrganizationId, 'STAFF', 'Komşu Personel');
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const active = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
      });
      const terminal = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'CANCELLED',
        assignedTo: staffId, createdBy: managerId,
      });

      // STAFF only, and only the current assignee: a non-assignee STAFF stays
      // concealed as 404 (the existing STAFF reach rule).
      await expect(createRequest(service, actor(otherStaffId, organizationId, 'STAFF'), active.id))
        .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      await expect(createRequest(service, actor(managerId, organizationId, 'MANAGER'), active.id))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      // Cross-org and unknown jobs stay concealed.
      await expect(createRequest(service, actor(otherOrgStaffId, otherOrganizationId, 'STAFF'), active.id))
        .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      await expect(createRequest(service, actor(staffId, organizationId, 'STAFF'), randomUUID()))
        .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      // Terminal jobs cannot open a request.
      await expect(createRequest(service, actor(staffId, organizationId, 'STAFF'), terminal.id))
        .rejects.toMatchObject({ code: 'JOB_NOT_ACTIVE', statusCode: 409 });

      expect(await readChangeRequests(pool, active.id)).toHaveLength(0);
      expect(await readChangeRequests(pool, terminal.id)).toHaveLength(0);
      expect(await selectActivity(pool, active.id, 'JOB_CHANGE_REQUESTED')).toHaveLength(0);
      expect((await selectNotifications(pool, organizationId, active.id))
        .filter((notification) => notification.kind === 'job.change_requested')).toHaveLength(0);
    });
  });

  it('allows exactly one open request per job and validates the structured reason', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const staff = actor(staffId, organizationId, 'STAFF');
      const first = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
      });
      const duplicate = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
      });
      const boundary = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
      });

      // Unknown reason code, empty/whitespace text and over-long text are
      // request-shape failures: nothing is written.
      await expect(createRequest(service, staff, first.id, { reasonCode: 'UNKNOWN_REASON' as never }))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(createRequest(service, staff, first.id, { reasonText: '' }))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(createRequest(service, staff, first.id, { reasonText: '   ' }))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(createRequest(service, staff, first.id, { reasonText: 'a'.repeat(2_001) }))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(await readChangeRequests(pool, first.id)).toHaveLength(0);

      // 1..2000 code points is the accepted envelope.
      const accepted = await createRequest(service, staff, boundary.id, {
        reasonCode: 'OTHER',
        reasonText: 'b'.repeat(2_000),
      });
      expect(accepted.changeRequestId).toBeDefined();
      const boundaryRows = await readChangeRequests(pool, boundary.id);
      expect(boundaryRows).toHaveLength(1);
      expect(boundaryRows[0]!.reason_text).toHaveLength(2_000);

      await createRequest(service, staff, duplicate.id, {
        reasonCode: 'VISIT_NOT_POSSIBLE',
        reasonText: 'Klinik kapalıydı, ziyaret gerçekleşmedi.',
      });
      await expect(createRequest(service, staff, duplicate.id, {
        reasonCode: 'CUSTOMER_ABSENT',
        reasonText: 'Müşteri yerinde yoktu.',
      })).rejects.toMatchObject({ code: 'CHANGE_REQUEST_ALREADY_OPEN', statusCode: 409 });
      expect(await readChangeRequests(pool, duplicate.id)).toHaveLength(1);
      expect(await selectActivity(pool, duplicate.id, 'JOB_CHANGE_REQUESTED')).toHaveLength(1);

      // The database also protects the invariant for any other writer.
      await expect(pool.query(
        `INSERT INTO job_card_change_requests
           (organization_id, job_card_id, requested_by, requested_at,
            job_status_at_request, reason_code, reason_text, client_action_id, state)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', 'OTHER', 'İkinci açık öneri', $5, 'OPEN')`,
        [organizationId, duplicate.id, staffId, clock.now, randomUUID()],
      )).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('replays the same clientActionId without writing again and rejects a changed body', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const staff = actor(staffId, organizationId, 'STAFF');
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
      });
      const clientActionId = randomUUID();

      const first = await createRequest(service, staff, job.id, {
        clientActionId,
        reasonCode: 'CUSTOMER_CHANGED_MIND',
        reasonText: 'Müşteri ürünü almaktan vazgeçti.',
      });
      const replay = await createRequest(service, staff, job.id, {
        clientActionId,
        reasonCode: 'CUSTOMER_CHANGED_MIND',
        reasonText: 'Müşteri ürünü almaktan vazgeçti.',
      });
      expect(replay).toEqual(first);

      expect(await readChangeRequests(pool, job.id)).toHaveLength(1);
      expect(await selectActivity(pool, job.id, 'JOB_CHANGE_REQUESTED')).toHaveLength(1);
      const notifications = (await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.change_requested');
      expect(notifications.map((notification) => notification.recipient_user_id).sort())
        .toEqual([adminId, managerId].sort());

      await expect(createRequest(service, staff, job.id, {
        clientActionId,
        reasonCode: 'WRONG_PRODUCT',
        reasonText: 'Yanlış ürün hazırlanmış.',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await readChangeRequests(pool, job.id)).toHaveLength(1);
      expect(await selectActivity(pool, job.id, 'JOB_CHANGE_REQUESTED')).toHaveLength(1);
    });
  });

  it('refuses Staff resolutions and the incomplete rejection/linked-job shapes', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const otherOrganizationId = await insertOrg(pool, 'Komşu Klinik');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const otherManagerId = await insertUser(pool, otherOrganizationId, 'MANAGER', 'Komşu Müdür');
      const otherStaffId = await insertUser(pool, otherOrganizationId, 'STAFF', 'Komşu Personel');
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const staff = actor(staffId, organizationId, 'STAFF');
      const manager = actor(managerId, organizationId, 'MANAGER');
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
      });
      const foreignJob = await insertJob(pool, {
        organizationId: otherOrganizationId, type: 'GENERAL_TASK', status: 'NEW',
        assignedTo: otherStaffId, createdBy: otherManagerId,
      });
      const request = await createRequest(service, staff, job.id);
      const before = await readJob(pool, job.id);

      // Management only, before any lookup.
      await expect(service.resolveChangeRequest(staff, job.id, request.changeRequestId, {
        clientActionId: randomUUID(), resolution: 'CORRECTED',
      })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(service.resolveChangeRequest(staff, job.id, randomUUID(), {
        clientActionId: randomUUID(), resolution: 'CORRECTED',
      })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      // Cross-org requests stay concealed.
      await expect(service.resolveChangeRequest(
        actor(otherManagerId, otherOrganizationId, 'MANAGER'),
        job.id, request.changeRequestId, { clientActionId: randomUUID(), resolution: 'CORRECTED' },
      )).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });

      await expect(service.resolveChangeRequest(manager, job.id, request.changeRequestId, {
        clientActionId: randomUUID(), resolution: 'REJECTED',
      })).rejects.toMatchObject({ statusCode: 400 });
      await expect(service.resolveChangeRequest(manager, job.id, request.changeRequestId, {
        clientActionId: randomUUID(), resolution: 'REJECTED', note: '   ',
      })).rejects.toMatchObject({ statusCode: 400 });
      await expect(service.resolveChangeRequest(manager, job.id, request.changeRequestId, {
        clientActionId: randomUUID(), resolution: 'LINKED_JOB_CREATED',
      })).rejects.toMatchObject({ statusCode: 400 });
      await expect(service.resolveChangeRequest(manager, job.id, request.changeRequestId, {
        clientActionId: randomUUID(), resolution: 'LINKED_JOB_CREATED', linkedJobCardId: job.id,
      })).rejects.toMatchObject({ statusCode: 400 });
      await expect(service.resolveChangeRequest(manager, job.id, request.changeRequestId, {
        clientActionId: randomUUID(), resolution: 'LINKED_JOB_CREATED', linkedJobCardId: foreignJob.id,
      })).rejects.toMatchObject({ statusCode: 400 });

      const rows = await readChangeRequests(pool, job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: 'OPEN', resolution: null, resolved_by: null, resolved_at: null,
        resolution_note: null, linked_job_card_id: null,
      });
      expect(await readJob(pool, job.id)).toEqual(before);
      expect(await selectActivity(pool, job.id, 'JOB_CHANGE_REQUEST_RESOLVED')).toHaveLength(0);
      expect((await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.change_request_resolved')).toHaveLength(0);
    });
  });

  it('each valid resolution closes the request without touching the job', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const staff = actor(staffId, organizationId, 'STAFF');
      const manager = actor(managerId, organizationId, 'MANAGER');
      const linkedJob = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'NEW',
        assignedTo: staffId, createdBy: managerId,
      });
      const resolutions = [
        { resolution: 'CORRECTED', note: 'Müşteri telefonla arandı ve randevu düzeltildi.' },
        { resolution: 'RESCHEDULED', note: 'Ziyaret önümüzdeki haftaya alındı.' },
        { resolution: 'REJECTED', note: 'Öneri reddedildi; teslim yönetici onayına hazır.' },
        { resolution: 'LINKED_JOB_CREATED', note: 'Aynı müşteri için bağlı yeni iş oluşturuldu.' },
      ] as const;

      for (const [index, entry] of resolutions.entries()) {
        const job = await insertJob(pool, {
          organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
          assignedTo: staffId, createdBy: managerId, title: `Talep ${index + 1}`,
        });
        clock.now = new Date(baseline.getTime() + (5 + index) * MINUTE_MS);
        const request = await createRequest(service, staff, job.id);
        const before = await readJob(pool, job.id);
        const previousNotifications = (await selectNotifications(pool, organizationId, job.id))
          .filter((notification) => notification.kind === 'job.change_request_resolved');
        expect(previousNotifications).toHaveLength(0);

        clock.now = new Date(baseline.getTime() + (20 + index) * MINUTE_MS);
        const response = await service.resolveChangeRequest(manager, job.id, request.changeRequestId, {
          clientActionId: randomUUID(),
          resolution: entry.resolution,
          note: entry.note,
          ...(entry.resolution === 'LINKED_JOB_CREATED'
            ? { linkedJobCardId: linkedJob.id }
            : {}),
        });
        expect(response).toMatchObject({
          jobCardId: job.id,
          changeRequestId: request.changeRequestId,
          resolution: entry.resolution,
          resolvedAt: clock.now.toISOString(),
        });

        const rows = await readChangeRequests(pool, job.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          state: 'CLOSED',
          resolution: entry.resolution,
          resolved_by: managerId,
          resolution_note: entry.note,
          linked_job_card_id: entry.resolution === 'LINKED_JOB_CREATED' ? linkedJob.id : null,
          reason_text: 'Müşteri görüşmeyi ileri bir tarihe erteledi.',
        });
        expect(rows[0]!.resolved_at).toEqual(clock.now);

        // The decision records itself only: the JobCard is never rewritten by
        // the resolution (D1).
        expect(await readJob(pool, job.id)).toEqual(before);

        const activities = await selectActivity(pool, job.id, 'JOB_CHANGE_REQUEST_RESOLVED');
        expect(activities).toHaveLength(1);
        expect(activities[0]!.actor_id).toBe(managerId);
        expect(activities[0]!.metadata).toMatchObject({
          requestId: request.changeRequestId,
          resolution: entry.resolution,
        });
        if (entry.resolution === 'LINKED_JOB_CREATED') {
          expect(activities[0]!.metadata.linkedJobCardId).toBe(linkedJob.id);
        }

        const resolved = (await selectNotifications(pool, organizationId, job.id))
          .filter((notification) => notification.kind === 'job.change_request_resolved');
        expect(resolved).toHaveLength(1);
        expect(resolved[0]!.recipient_user_id).toBe(staffId);
      }
    });
  });

  it('rejects resolving a request that is no longer open', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const manager = actor(managerId, organizationId, 'MANAGER');
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
      });
      const request = await createRequest(service, actor(staffId, organizationId, 'STAFF'), job.id);

      clock.now = new Date(baseline.getTime() + 15 * MINUTE_MS);
      await service.resolveChangeRequest(manager, job.id, request.changeRequestId, {
        clientActionId: randomUUID(), resolution: 'CORRECTED', note: 'Düzeltildi.',
      });
      const closed = await readChangeRequests(pool, job.id);

      await expect(service.resolveChangeRequest(manager, job.id, request.changeRequestId, {
        clientActionId: randomUUID(), resolution: 'REJECTED', note: 'İkinci karar.',
      })).rejects.toMatchObject({ code: 'CHANGE_REQUEST_NOT_OPEN', statusCode: 409 });

      expect(await readChangeRequests(pool, job.id)).toEqual(closed);
      expect(await selectActivity(pool, job.id, 'JOB_CHANGE_REQUEST_RESOLVED')).toHaveLength(1);
      expect((await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.change_request_resolved')).toHaveLength(1);
    });
  });

  it('A17: a manager cancellation on a started job closes the request and keeps its own reason', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const customerId = await insertCustomer(pool, organizationId);
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const manager = actor(managerId, organizationId, 'MANAGER');
      const job = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId, customerId,
        scheduledAt: new Date(baseline.getTime() - 30 * MINUTE_MS).toISOString(),
        scheduledEndsAt: new Date(baseline.getTime() + 30 * MINUTE_MS).toISOString(),
        startedAt: new Date(baseline.getTime() - 20 * MINUTE_MS).toISOString(),
      });
      const startedAt = (await readJob(pool, job.id)).started_at;
      const request = await createRequest(service, actor(staffId, organizationId, 'STAFF'), job.id, {
        reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
        reasonText: 'Teslim edilecek ürün depoda yok.',
      });

      clock.now = new Date(baseline.getTime() + 10 * MINUTE_MS);
      const cancelReason = 'Müşteri teslimi iptal etti; ürün tedarik edilemedi.';
      const cancelled = await service.cancel(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version, cancelReason,
      });
      expect(cancelled.status).toBe('CANCELLED');

      const persisted = await readJob(pool, job.id);
      expect(persisted).toMatchObject({
        status: 'CANCELLED',
        cancelled_by: managerId,
        cancel_reason: cancelReason,
        staff_completed_at: null,
        manager_approved_at: null,
      });
      expect(persisted.started_at).toEqual(startedAt);
      // No delivery fact is fabricated for the cancelled delivery.
      const deliveries = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM job_card_delivery_items WHERE job_card_id = $1',
        [job.id],
      );
      expect(deliveries.rows[0]!.count).toBe('0');

      const rows = await readChangeRequests(pool, job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: 'CLOSED',
        resolution: 'CANCELLED',
        resolved_by: managerId,
        reason_text: 'Teslim edilecek ürün depoda yok.',
      });
      expect(rows[0]!.resolved_at).not.toBeNull();
      expect(rows[0]!.id).toBe(request.changeRequestId);

      const activities = await selectActivities(pool, job.id);
      expect(activities).toContain('JOB_CANCELLED');
      expect(activities).toContain('JOB_CHANGE_REQUEST_RESOLVED');
      const closure = await selectActivity(pool, job.id, 'JOB_CHANGE_REQUEST_RESOLVED');
      expect(closure).toHaveLength(1);
      expect(closure[0]!.metadata).toMatchObject({
        requestId: request.changeRequestId,
        resolution: 'CANCELLED',
      });
    });
  });

  it('STAFF CANCEL still works in 2a and closes the request as cancelled', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const staff = actor(staffId, organizationId, 'STAFF');
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
      });
      const request = await createRequest(service, staff, job.id);

      clock.now = new Date(baseline.getTime() + 12 * MINUTE_MS);
      const cancelReason = 'Personel işi kendi üzerinden kapatmak istedi.';
      const cancelled = await service.cancel(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version, cancelReason,
      });
      expect(cancelled.status).toBe('CANCELLED');

      const persisted = await readJob(pool, job.id);
      expect(persisted).toMatchObject({
        status: 'CANCELLED', cancelled_by: staffId, cancel_reason: cancelReason,
      });

      const rows = await readChangeRequests(pool, job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: 'CLOSED', resolution: 'CANCELLED', resolved_by: staffId,
      });
      expect(rows[0]!.resolved_at).not.toBeNull();
      expect(rows[0]!.id).toBe(request.changeRequestId);
    });
  });

  it('APPROVE closes an open request as superseded', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const manager = actor(managerId, organizationId, 'MANAGER');
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        assignedTo: staffId, createdBy: managerId,
      });
      const request = await createRequest(service, actor(staffId, organizationId, 'STAFF'), job.id);

      clock.now = new Date(baseline.getTime() + 20 * MINUTE_MS);
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(approved.status).toBe('COMPLETED');

      const rows = await readChangeRequests(pool, job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: 'CLOSED', resolution: 'SUPERSEDED', resolved_by: managerId,
      });
      expect(rows[0]!.resolved_at).not.toBeNull();
      expect(rows[0]!.id).toBe(request.changeRequestId);
      const persisted = await readJob(pool, job.id);
      expect(persisted.status).toBe('COMPLETED');
      expect(persisted.manager_approved_at).toEqual(
        await readReservedAt(pool, job.id, 'APPROVE'),
      );
    });
  });

  it('ADMIN invalidation closes an open request as superseded', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const admin = actor(adminId, organizationId, 'ADMIN');
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
      });
      const request = await createRequest(service, actor(staffId, organizationId, 'STAFF'), job.id);

      clock.now = new Date(baseline.getTime() + 25 * MINUTE_MS);
      await service.invalidate(admin, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        reasonCode: 'DUPLICATE', note: 'Aynı iş ikinci kez açılmış.',
      });
      const persisted = await readJob(pool, job.id);
      expect(persisted.status).toBe('INVALIDATED');

      const rows = await readChangeRequests(pool, job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: 'CLOSED', resolution: 'SUPERSEDED', resolved_by: adminId,
      });
      expect(rows[0]!.resolved_at).not.toBeNull();
      expect(rows[0]!.id).toBe(request.changeRequestId);
    });
  });

  it('lists open requests for management only', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const staff = actor(staffId, organizationId, 'STAFF');
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
      });
      await createRequest(service, staff, job.id);

      await expect(service.listOpenChangeRequests(staff, { limit: 25, offset: 0 }))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      const managerList = await service.listOpenChangeRequests(
        actor(managerId, organizationId, 'MANAGER'), { limit: 25, offset: 0 },
      );
      expect(managerList.total).toBe(1);
    });
  });

  it('lists open requests oldest first, paginates, isolates organizations and hides closed ones', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const otherOrganizationId = await insertOrg(pool, 'Komşu Klinik');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const otherManagerId = await insertUser(pool, otherOrganizationId, 'MANAGER', 'Komşu Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const otherStaffId = await insertUser(pool, otherOrganizationId, 'STAFF', 'Komşu Personel');
      const customerId = await insertCustomer(pool, organizationId, 'Marmara Diş Kliniği');
      const clock = { now: new Date(baseline.getTime() + 5 * MINUTE_MS) };
      const { service } = buildService(pool, clock);
      const staff = actor(staffId, organizationId, 'STAFF');
      const older = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId, title: 'Eski talep',
      });
      const newer = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId, title: 'Yeni teslim talebi', customerId,
        scheduledAt: new Date(baseline.getTime() + 60 * MINUTE_MS).toISOString(),
        scheduledEndsAt: new Date(baseline.getTime() + 120 * MINUTE_MS).toISOString(),
      });
      const closed = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId, title: 'Kapanan talep',
      });
      const foreign = await insertJob(pool, {
        organizationId: otherOrganizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: otherStaffId, createdBy: otherManagerId, title: 'Komşu talep',
      });

      clock.now = new Date(baseline.getTime() + 5 * MINUTE_MS);
      const olderRequest = await createRequest(service, staff, older.id, {
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Müşteri ziyareti öteledi.',
      });
      clock.now = new Date(baseline.getTime() + 10 * MINUTE_MS);
      const newerRequest = await createRequest(service, staff, newer.id, {
        reasonCode: 'WRONG_PRODUCT',
        reasonText: 'Yanlış ürün hazırlanmış.',
      });
      clock.now = new Date(baseline.getTime() + 15 * MINUTE_MS);
      const closedRequest = await createRequest(service, staff, closed.id, {
        reasonCode: 'OTHER',
        reasonText: 'Diğer neden.',
      });
      await service.resolveChangeRequest(
        actor(managerId, organizationId, 'MANAGER'), closed.id, closedRequest.changeRequestId,
        { clientActionId: randomUUID(), resolution: 'CORRECTED' },
      );
      await createRequest(
        service, actor(otherStaffId, otherOrganizationId, 'STAFF'), foreign.id,
      );

      const manager = actor(managerId, organizationId, 'MANAGER');
      const page = await service.listOpenChangeRequests(manager, { limit: 10, offset: 0 });
      expect(page).toMatchObject({ total: 2, limit: 10, offset: 0 });
      expect(page.items.map((item: { changeRequestId: string }) => item.changeRequestId))
        .toEqual([olderRequest.changeRequestId, newerRequest.changeRequestId]);
      expect(page.items[0]).toMatchObject({
        jobCardId: older.id,
        jobTitle: 'Eski talep',
        jobType: 'GENERAL_TASK',
        jobStatus: 'IN_PROGRESS',
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Müşteri ziyareti öteledi.',
        requestedAt: new Date(baseline.getTime() + 5 * MINUTE_MS).toISOString(),
        requestedBy: { id: staffId, name: 'Saha Personeli' },
        customer: null,
        jobPath: `/jobs/${older.id}`,
      });
      expect(page.items[1]).toMatchObject({
        jobCardId: newer.id,
        jobType: 'PRODUCT_DELIVERY',
        customer: { id: customerId, name: 'Marmara Diş Kliniği' },
        jobPath: `/jobs/${newer.id}`,
      });
      expect(page.items.map((item: { changeRequestId: string }) => item.changeRequestId))
        .not.toContain(closedRequest.changeRequestId);

      const firstPage = await service.listOpenChangeRequests(manager, { limit: 1, offset: 0 });
      expect(firstPage).toMatchObject({ total: 2, limit: 1, offset: 0 });
      expect(firstPage.items.map((item: { changeRequestId: string }) => item.changeRequestId))
        .toEqual([olderRequest.changeRequestId]);
      const secondPage = await service.listOpenChangeRequests(manager, { limit: 1, offset: 1 });
      expect(secondPage).toMatchObject({ total: 2, limit: 1, offset: 1 });
      expect(secondPage.items.map((item: { changeRequestId: string }) => item.changeRequestId))
        .toEqual([newerRequest.changeRequestId]);

      // Cross-org isolation: the neighbour sees only its own request.
      const foreignPage = await service.listOpenChangeRequests(
        actor(otherManagerId, otherOrganizationId, 'MANAGER'), { limit: 10, offset: 0 },
      );
      expect(foreignPage.total).toBe(1);
      expect(foreignPage.items[0]!.jobCardId).toBe(foreign.id);
    });
  });

  describe('OVR-4 while a change request is open', () => {
    async function openLateTask(pool: Pool, clock: { now: Date }, organizationId: string, staffId: string) {
      const { service } = buildService(pool, clock);
      const staff = actor(staffId, organizationId, 'STAFF');
      const dueDate = new Date(clock.now.getTime() - 3 * DAY_MS).toISOString().slice(0, 10);
      const created = await createTask(service, staff, 'Geç kalan saha görevi', dueDate);
      const started = await service.start(staff, created.id, {
        clientActionId: randomUUID(), expectedVersion: created.version,
      });
      return { service, staff, job: started };
    }

    it('A20: a request freezes the automatic Staff reminder and keeps the incident untouched', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool, 'OVR4 Değişiklik Org');
        await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
        const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
        await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
        const clock = { now: await readDbBaseline(pool) };
        const { service, staff, job } = await openLateTask(pool, clock, organizationId, staffAId);
        await scanOnce(pool, await dbBaseline(pool));
        const incidentsBefore = await selectIncidents(pool, organizationId, job.id);
        expect(incidentsBefore).toHaveLength(1);
        const breachedAt = incidentsBefore[0]!.breached_at;

        clock.now = new Date(breachedAt.getTime() + 5 * MINUTE_MS);
        const request = await service.createChangeRequest(staff, job.id, {
          clientActionId: randomUUID(),
          reasonCode: 'CUSTOMER_ABSENT',
          reasonText: 'Müşteri kliniğe gelmedi, iş tamamlanamadı.',
        });

        const snapshot = await service.getSubmissionLateness(staff, job.id);
        expect(snapshot.open).not.toBeNull();
        expect(snapshot.open!.changeRequestOpenSince).toBe(clock.now.toISOString());

        const report = await reminderWorker(pool, [])
          .runOnce(new Date(breachedAt.getTime() + 16 * MINUTE_MS));
        expect(report.candidates).toBe(0);
        expect(report.sent).toBe(0);

        // The escalation clock is frozen as well while the request is open.
        const escalationTick = await reminderWorker(pool, [])
          .runOnce(new Date(breachedAt.getTime() + 61 * MINUTE_MS));
        expect(escalationTick.candidates).toBe(0);
        expect(escalationTick.sent).toBe(0);

        // The worker re-checks under the JobCard lock even when a stale
        // candidate list still contains the job.
        const candidate = { organizationId, jobCardId: job.id };
        const processed = await new PostgresOverdueReminderWorkerRepository(
          new PostgresJobCardRepository(pool), false, ALWAYS_OPEN_NOTIFICATION_WINDOW,
        ).processCandidate({
          candidate,
          scanTime: new Date(breachedAt.getTime() + 17 * MINUTE_MS),
          timing: TIMING,
        });
        expect(processed.outcome.kind).toBe('skipped-change-request-open');
        expect(processed.realtimeEvents).toHaveLength(0);

        expect(await selectIncidents(pool, organizationId, job.id)).toEqual(incidentsBefore);
        expect(await selectDeliveries(pool, organizationId, job.id)).toHaveLength(0);
        expect((await selectNotifications(pool, organizationId, job.id))
          .filter((notification) => notification.kind.startsWith('job.submission_'))).toHaveLength(0);
        expect(request.changeRequestId).toBeDefined();
      });
    });

    it('A20: reminders resume unchanged once the request is resolved', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool, 'OVR4 Değişiklik Org');
        const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
        const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
        await insertUser(pool, organizationId, 'STAFF', 'Mehmet');
        const clock = { now: await readDbBaseline(pool) };
        const { service, staff, job } = await openLateTask(pool, clock, organizationId, staffAId);
        await scanOnce(pool, await dbBaseline(pool));
        const incidentsBefore = await selectIncidents(pool, organizationId, job.id);
        const breachedAt = incidentsBefore[0]!.breached_at;

        clock.now = new Date(breachedAt.getTime() + 5 * MINUTE_MS);
        const request = await service.createChangeRequest(staff, job.id, {
          clientActionId: randomUUID(),
          reasonCode: 'CUSTOMER_ABSENT',
          reasonText: 'Müşteri kliniğe gelmedi, iş tamamlanamadı.',
        });

        clock.now = new Date(breachedAt.getTime() + 10 * MINUTE_MS);
        await service.resolveChangeRequest(
          actor(managerId, organizationId, 'MANAGER'), job.id, request.changeRequestId,
          {
            clientActionId: randomUUID(),
            resolution: 'REJECTED',
            note: 'Görev tamamlanmalı; ek süre verildi.',
          },
        );
        const snapshot = await service.getSubmissionLateness(staff, job.id);
        expect(snapshot.open!.changeRequestOpenSince).toBeNull();

        const staffTick = await reminderWorker(pool, [])
          .runOnce(new Date(breachedAt.getTime() + 16 * MINUTE_MS));
        expect(staffTick.sent).toBe(1);
        expect(staffTick.byKind).toMatchObject({ STAFF_REMINDER: 1, MANAGEMENT_ESCALATION: 0 });
        const reminded = (await selectNotifications(pool, organizationId, job.id))
          .filter((notification) => notification.kind === 'job.submission_auto_reminder');
        expect(reminded).toHaveLength(1);
        expect(reminded[0]!.recipient_user_id).toBe(staffAId);

        const escalation = await reminderWorker(pool, [])
          .runOnce(new Date(breachedAt.getTime() + 61 * MINUTE_MS));
        expect(escalation.byKind).toMatchObject({ MANAGEMENT_ESCALATION: 1 });

        expect(await selectIncidents(pool, organizationId, job.id)).toEqual(incidentsBefore);
      });
    });
  });

  it('A21: a manager cancellation on a Staff request leaves the Staff report metrics unchanged', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const clock = { now: new Date(baseline.getTime() + 10 * MINUTE_MS) };
      const range = {
        from: istanbulDate(clock.now),
        to: istanbulDate(clock.now),
      };

      const requested = await runCancellationScenario(pool, clock, true);
      const control = await runCancellationScenario(pool, clock, false);

      const reportsRepository = new PostgresReportsRepository(pool);
      const reports = new ReportsService(
        reportsRepository,
        passThroughReportReadSnapshot(reportsRepository, null),
        () => clock.now,
      );

      const requestedReport = await reports.getStaffReport(
        requested.manager, requested.staffId, { requestedRange: range, includeSaleCapability: true },
      );
      const controlReport = await reports.getStaffReport(
        control.manager, control.staffId, { requestedRange: range, includeSaleCapability: true },
      );
      const { staff: _requestedStaff, ...requestedMetrics } = requestedReport;
      const { staff: _controlStaff, ...controlMetrics } = controlReport;
      expect(requestedMetrics).toEqual(controlMetrics);

      // The comparison is only meaningful because the request path really ran
      // and the cancelled job never became a completion.
      expect(requestedReport.performance.completedJobs).toBe(0);
      expect(requestedReport.onTime.onTimeCompletedJobs).toBe(0);
      expect(requestedReport.onTime.lateCompletedJobs).toBe(0);
      expect(requestedReport.staffExecution.staffCompletedJobs).toBe(0);
      expect(await selectActivity(pool, requested.jobId, 'JOB_CHANGE_REQUESTED')).toHaveLength(1);
      expect(await selectActivity(pool, control.jobId, 'JOB_CHANGE_REQUESTED')).toHaveLength(0);
      expect((await readJob(pool, requested.jobId)).status).toBe('CANCELLED');
      expect((await readJob(pool, control.jobId)).status).toBe('CANCELLED');

      const requestedPerformance = await reports.getStaffPerformance(
        requested.manager, { requestedRange: range, includeSaleCapability: true },
      );
      const controlPerformance = await reports.getStaffPerformance(
        control.manager, { requestedRange: range, includeSaleCapability: true },
      );
      const requestedItem = requestedPerformance.items.find(
        (item) => item.staff.userId === requested.staffId,
      )!;
      const controlItem = controlPerformance.items.find(
        (item) => item.staff.userId === control.staffId,
      )!;
      expect({
        performance: requestedItem.performance,
        staffExecution: requestedItem.staffExecution,
        staffSubmissionAttribution: requestedItem.staffSubmissionAttribution,
        onTime: requestedItem.onTime,
        currentWorkload: requestedItem.currentWorkload,
        currentWorkloadByType: requestedItem.currentWorkloadByType,
      }).toEqual({
        performance: controlItem.performance,
        staffExecution: controlItem.staffExecution,
        staffSubmissionAttribution: controlItem.staffSubmissionAttribution,
        onTime: controlItem.onTime,
        currentWorkload: controlItem.currentWorkload,
        currentWorkloadByType: controlItem.currentWorkloadByType,
      });
    });
  });
});

function dbBaseline(pool: Pool): Promise<Date> {
  return readDbBaseline(pool);
}

function istanbulDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

type ServiceJob = { id: string; version: number; status: string };

async function createTask(
  service: JobCardService,
  staff: JobCardActor,
  title: string,
  dueDate: string,
): Promise<ServiceJob> {
  return service.create(staff, {
    clientActionId: randomUUID(),
    type: 'GENERAL_TASK',
    title,
    description: null,
    customerId: null,
    contactId: null,
    assignedTo: staff.id,
    priority: 'normal',
    dueDate,
    scheduledAt: null,
    scheduledEndsAt: undefined,
    engagementKind: undefined,
  } as never);
}

async function scanOnce(pool: Pool, scanTime: Date) {
  const repository = new PostgresJobCardRepository(pool);
  const scanner = createOverdueBreachScanner(
    new PostgresOverdueBreachScannerRepository(repository), { batchSize: 50 },
  );
  return scanner.runOnce(scanTime);
}

function reminderWorker(pool: Pool, published: RealtimeEventRecord[]) {
  const repository = new PostgresJobCardRepository(pool);
  return createOverdueReminderWorker(
    new PostgresOverdueReminderWorkerRepository(
      repository, false, ALWAYS_OPEN_NOTIFICATION_WINDOW,
    ),
    {
      publisher: { publish: (event) => published.push(event) },
      timing: {},
      batchSize: 50,
    },
  );
}

type IncidentRow = {
  id: string;
  delay_type: string;
  episode_no: number;
  deadline_at: Date;
  breached_at: Date;
  recovered_at: Date | null;
};

async function selectIncidents(
  pool: Pool, organizationId: string, jobId: string,
): Promise<IncidentRow[]> {
  return (await pool.query(
    `SELECT id, delay_type, episode_no, deadline_at, breached_at, recovered_at
       FROM job_card_overdue_incidents
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY breached_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as IncidentRow[];
}

async function selectDeliveries(
  pool: Pool, organizationId: string, jobId: string,
): Promise<Array<{ kind: string; episode_no: number; sent_at: Date }>> {
  return (await pool.query(
    `SELECT kind, episode_no, sent_at
       FROM job_card_overdue_notification_deliveries
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY sent_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as Array<{ kind: string; episode_no: number; sent_at: Date }>;
}

/**
 * A21 comparison scenario. Both runs create, start and manager-cancel the same
 * late task with the same manager reason; the only difference is the Staff
 * change request and its closure.
 */
async function runCancellationScenario(
  pool: Pool,
  clock: { now: Date },
  withRequest: boolean,
) {
  const name = withRequest ? 'Talep A.Ş.' : 'Kontrol A.Ş.';
  const organizationId = await insertOrg(pool, name);
  const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
  const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
  await pool.query(
    'INSERT INTO staff_profiles (organization_id, user_id) VALUES ($1, $2)',
    [organizationId, staffId],
  );
  const staff = actor(staffId, organizationId, 'STAFF');
  const manager = actor(managerId, organizationId, 'MANAGER');
  const { service } = buildService(pool, clock);
  const dueDate = new Date(clock.now.getTime() - 3 * DAY_MS).toISOString().slice(0, 10);
  const created = await createTask(service, staff, 'Değişiklik talebi senaryosu', dueDate);
  const started = await service.start(staff, created.id, {
    clientActionId: randomUUID(), expectedVersion: created.version,
  });

  clock.now = new Date(clock.now.getTime() + 5 * MINUTE_MS);
  if (withRequest) {
    await service.createChangeRequest(staff, started.id, {
      clientActionId: randomUUID(),
      reasonCode: 'CUSTOMER_POSTPONED',
      reasonText: 'Müşteri operasyonu durdurdu, iş tamamlanamadı.',
    });
  }
  clock.now = new Date(clock.now.getTime() + 5 * MINUTE_MS);
  await service.cancel(manager, started.id, {
    clientActionId: randomUUID(),
    expectedVersion: started.version,
    cancelReason: 'Müşteri operasyonu durdurdu.',
  });

  const safeUser: SafeUser = {
    id: managerId,
    organizationId,
    name: 'Müdür',
    email: `manager-${randomUUID()}@test.local`,
    role: 'MANAGER',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
  return { organizationId, manager: safeUser, staffId, jobId: started.id };
}
