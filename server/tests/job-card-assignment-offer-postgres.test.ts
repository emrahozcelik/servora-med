import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { parseJobCardCreateInput } from '../src/modules/job-cards/create-input.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, JobCardType } from '../src/modules/job-cards/types.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import {
  PostgresStaffOffboardingService,
  type OffboardingDecisionInput,
} from '../src/modules/people/offboarding.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { MINUTE_MS, readDbBaseline, readReservedAt } from './support/db-clock-baseline.js';
import { gatePoolStatements } from './support/lifecycle-intent-harness.js';

/**
 * JOB-010 release 2b — PostgreSQL acceptance for the assignment offer.
 *
 * Contract: `docs/features/assignment-acceptance-sla.md`, "Release 2b
 * technical contract" plus §3–§9 and the A1–A7, A13, A14, A14b, A15, A18
 * acceptance scenarios. Everything here is inert while
 * `assignmentWindow: { enabled: false }` (the production default).
 *
 * Timing convention (A-scenarios): a job planned 14:00–15:00, assigned at
 * 12:00, has `acceptanceDueAt = max(scheduledAt - 60 min, openedAt + 10 min)
 * = 13:00`. PostgreSQL fixtures are placed relative to the DB arbitration
 * clock so the suite never ages.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const WINDOW_ON = { enabled: true } as const;
const WINDOW_OFF = { enabled: false } as const;

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `job010off_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, name = 'JOB-010 2b Klinik'): Promise<string> {
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
  const id = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, $5) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role, isActive],
  )).rows[0]!.id;
  if (role === 'STAFF') {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, 'Saha Personeli')`,
      [organizationId, id],
    );
  }
  return id;
}

async function insertCustomer(pool: Pool, organizationId: string, name = 'Özel Dent Klinik'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, name],
  )).rows[0]!.id;
}

type FixtureStatus =
  | 'NEW' | 'ACCEPTED' | 'IN_PROGRESS' | 'WAITING_APPROVAL' | 'REVISION_REQUESTED';

type FixtureJob = {
  id: string;
  version: number;
  status: string;
  scheduledAt: string | null;
  scheduledEndsAt: string | null;
  acceptedAt: string | null;
};

/**
 * Direct fixture insert. The commands under test are the unit here; the job
 * only has to satisfy the persisted lifecycle constraints. Lifecycle
 * transitions then run through the real service.
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
  dueDate?: string | null;
  acceptedAt?: string | null;
  startedAt?: string | null;
  staffCompletedAt?: string | null;
}): Promise<FixtureJob> {
  const accepted = input.status !== 'NEW';
  const acceptedAt = input.acceptedAt ?? (accepted ? '2026-01-01T08:00:00.000Z' : null);
  const started = ['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'].includes(input.status)
    ? input.startedAt ?? '2026-01-01T09:00:00.000Z'
    : null;
  const staffCompleted = ['WAITING_APPROVAL', 'REVISION_REQUESTED'].includes(input.status)
    ? input.staffCompletedAt ?? '2026-01-01T10:00:00.000Z'
    : null;
  const revisionRequested = input.status === 'REVISION_REQUESTED';
  const engagementKind = input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null;
  const row = (await pool.query<{ id: string; version: number; status: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, assigned_to, created_by,
        accepted_at, accepted_by, started_at, staff_completed_at, staff_completed_by,
        revision_requested_at, revision_requested_by, revision_reason,
        scheduled_at, scheduled_ends_at, due_date, engagement_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8::timestamptz, $9::uuid, $10::timestamptz, $11::timestamptz, $12::uuid,
             $13::timestamptz, $14::uuid, $15,
             $16::timestamptz, $17::timestamptz, $18::date, $19)
     RETURNING id, version, status`,
    [
      input.organizationId, input.type, input.status,
      input.title ?? 'JOB-010 atama penceresi işi', input.customerId ?? null,
      input.assignedTo, input.createdBy,
      acceptedAt, acceptedAt === null ? null : input.assignedTo,
      started, staffCompleted, staffCompleted === null ? null : input.assignedTo,
      revisionRequested ? '2026-01-01T10:30:00.000Z' : null,
      revisionRequested ? input.createdBy : null,
      revisionRequested ? 'Fixture düzeltme nedeni' : null,
      input.scheduledAt ?? null, input.scheduledEndsAt ?? null, input.dueDate ?? null,
      engagementKind,
    ],
  )).rows[0]!;
  if (input.scheduledAt) {
    await pool.query(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
          organization_timezone, source, created_by, created_at)
       VALUES ($1, $2, 1, $3, $4, 'Europe/Istanbul', 'CREATE', $5, $6)`,
      [
        input.organizationId, row.id, input.scheduledAt, input.scheduledEndsAt ?? null,
        input.createdBy, new Date(Date.parse(input.scheduledAt) - 60 * MINUTE_MS),
      ],
    );
    await pool.query(
      `INSERT INTO job_card_assignment_history
         (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
       VALUES ($1, $2, NULL, $3, $4, 'CREATE', $5)`,
      [
        input.organizationId, row.id, input.assignedTo, input.createdBy,
        new Date(Date.parse(input.scheduledAt) - 60 * MINUTE_MS),
      ],
    );
  }
  return {
    id: row.id,
    version: Number(row.version),
    status: String(row.status),
    scheduledAt: input.scheduledAt ?? null,
    scheduledEndsAt: input.scheduledEndsAt ?? null,
    acceptedAt,
  };
}

type OfferRow = {
  id: string;
  organization_id: string;
  job_card_id: string;
  assignee_user_id: string;
  opened_at: Date;
  opened_reason: string;
  opened_by: string;
  assignment_history_id: string | null;
  acceptance_due_at: Date;
  urgent_reason: string | null;
  ack_code: string | null;
  ack_text: string | null;
  state: string;
  closed_at: Date | null;
  closed_by: string | null;
  close_reason: string | null;
  close_text: string | null;
  proposed_scheduled_at: Date | null;
  proposal_accepted_at: Date | null;
  proposal_accepted_by: string | null;
};

type OfferState = 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'RELEASED' | 'EXPIRED' | 'WITHDRAWN';

type OfferFixtureInput = {
  organizationId: string;
  jobCardId: string;
  assigneeUserId: string;
  openedBy: string;
  openedAt: Date;
  acceptanceDueAt: Date;
  openedReason?: string;
  urgentReason?: 'SHORT_NOTICE' | 'START_PASSED' | null;
  ackCode?: 'CUSTOMER_CONFIRMED_LATER_TIME' | 'CUSTOMER_WAITING' | 'OTHER' | null;
  ackText?: string | null;
  state?: OfferState;
  closedAt?: Date | null;
  closedBy?: string | null;
  closeReason?: string | null;
  closeText?: string | null;
};

type OfferFixtureOverrides = Omit<
  OfferFixtureInput,
  'organizationId' | 'jobCardId' | 'assigneeUserId' | 'openedBy'
>;

async function insertOffer(pool: Pool, input: OfferFixtureInput): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_assignment_offers
       (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason, opened_by,
        acceptance_due_at, urgent_reason, ack_code, ack_text, state, closed_at, closed_by,
        close_reason, close_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      input.organizationId, input.jobCardId, input.assigneeUserId, input.openedAt,
      input.openedReason ?? 'CREATE', input.openedBy, input.acceptanceDueAt,
      input.urgentReason ?? null, input.ackCode ?? null, input.ackText ?? null,
      input.state ?? 'OPEN', input.closedAt ?? null, input.closedBy ?? null,
      input.closeReason ?? null, input.closeText ?? null,
    ],
  )).rows[0]!.id;
}

async function readOffers(pool: Pool, jobCardId: string): Promise<OfferRow[]> {
  return (await pool.query<OfferRow>(
    `SELECT id, organization_id, job_card_id, assignee_user_id, opened_at, opened_reason,
            opened_by, assignment_history_id, acceptance_due_at, urgent_reason, ack_code,
            ack_text, state, closed_at, closed_by, close_reason, close_text,
            proposed_scheduled_at, proposal_accepted_at, proposal_accepted_by
       FROM job_card_assignment_offers
      WHERE job_card_id = $1
      ORDER BY opened_at ASC, id ASC`,
    [jobCardId],
  )).rows;
}

type JobRow = {
  status: string;
  version: number;
  assigned_to: string;
  accepted_at: Date | null;
  accepted_by: string | null;
  started_at: Date | null;
  scheduled_at: Date | null;
  scheduled_ends_at: Date | null;
  due_date: Date | null;
};

async function readJob(pool: Pool, jobCardId: string): Promise<JobRow> {
  return (await pool.query<JobRow>(
    `SELECT status, version, assigned_to, accepted_at, accepted_by, started_at,
            scheduled_at, scheduled_ends_at, due_date
       FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

async function selectActivities(pool: Pool, jobCardId: string): Promise<string[]> {
  return (await pool.query<{ event_type: string }>(
    `SELECT event_type FROM job_card_activity_logs
      WHERE job_card_id = $1 ORDER BY created_at ASC, id ASC`,
    [jobCardId],
  )).rows.map((row) => row.event_type);
}

async function selectActivity(
  pool: Pool, jobCardId: string, eventType: string,
): Promise<Array<{ actor_id: string | null; metadata: Record<string, unknown> | null }>> {
  return (await pool.query(
    `SELECT actor_id, metadata FROM job_card_activity_logs
      WHERE job_card_id = $1 AND event_type = $2
      ORDER BY created_at ASC, id ASC`,
    [jobCardId, eventType],
  )).rows as Array<{ actor_id: string | null; metadata: Record<string, unknown> | null }>;
}

async function selectNotifications(
  pool: Pool, organizationId: string, jobCardId: string,
): Promise<Array<{ recipient_user_id: string; kind: string }>> {
  return (await pool.query(
    `SELECT recipient_user_id, kind FROM in_app_notifications
      WHERE organization_id = $1 AND entity_type = 'job-card' AND entity_id = $2
      ORDER BY created_at ASC, id ASC`,
    [organizationId, jobCardId],
  )).rows as Array<{ recipient_user_id: string; kind: string }>;
}

async function readOverdueIncidents(pool: Pool, jobCardId: string) {
  return (await pool.query<{
    delay_type: string;
    schedule_revision_no: number;
    deadline_at: Date;
    breached_at: Date;
    accountable_user_id: string | null;
    recovered_at: Date | null;
  }>(
    `SELECT delay_type, schedule_revision_no, deadline_at, breached_at,
            accountable_user_id, recovered_at
       FROM job_card_overdue_incidents WHERE job_card_id = $1 ORDER BY recorded_at`,
    [jobCardId],
  )).rows;
}

function buildService(
  pool: Pool,
  clock: { now: Date },
  assignmentWindow: { enabled: boolean },
) {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  const service = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    publisher,
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
    {},
    assignmentWindow,
  );
  return { service, published };
}

function actor(id: string, organizationId: string, role: 'ADMIN' | 'MANAGER' | 'STAFF'): JobCardActor {
  return { id, organizationId, role };
}

async function createMeetingJob(
  service: JobCardService,
  manager: JobCardActor,
  input: { customerId: string; assignedTo: string; scheduledAt: string; scheduledEndsAt: string },
) {
  return service.create(manager, parseJobCardCreateInput({
    clientActionId: randomUUID(),
    type: 'SALES_MEETING',
    title: 'Klinik ziyareti',
    customerId: input.customerId,
    assignedTo: input.assignedTo,
    priority: 'normal',
    scheduledAt: input.scheduledAt,
    scheduledEndsAt: input.scheduledEndsAt,
    engagementKind: 'SALES_MEETING',
  }));
}

function isoOffset(baseline: Date, offsetMs: number): string {
  return new Date(baseline.getTime() + offsetMs).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    }),
  ]);
}

describe.skipIf(!databaseUrl)('JOB-010 release 2b — assignment offer', () => {
  it('applies migration 065, creates the offer tables and widens the lifecycle command check', async () => {
    await withSchema(async (pool) => {
      const head = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      expect(head.rows[0]?.version).toMatch(/^077_/);
      for (const table of ['job_card_assignment_offers', 'job_card_assignment_offer_notifications']) {
        const found = await pool.query<{ name: string | null }>(
          'SELECT to_regclass($1)::text AS name', [table],
        );
        expect(found.rows[0]?.name, table).not.toBeNull();
      }

      // JOB-012 (073): the three proposal columns, their CHECKs and the new
      // offer reason are in place.
      const proposalColumns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'job_card_assignment_offers'
            AND column_name IN ('proposed_scheduled_at', 'proposal_accepted_at', 'proposal_accepted_by')`,
      );
      expect(proposalColumns.rows.map((row) => row.column_name).sort()).toEqual([
        'proposal_accepted_at', 'proposal_accepted_by', 'proposed_scheduled_at',
      ]);
      const openedReasonCheck = await pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'job_card_assignment_offers'::regclass
            AND conname = 'job_card_assignment_offers_opened_reason_check'`,
      );
      expect(openedReasonCheck.rows[0]?.definition).toContain('PROPOSAL_ACCEPTED');
      expect(openedReasonCheck.rows[0]?.definition).toContain('SALE_APPROVAL');

      // 049 command CHECK widened with the two new lifecycle commands.
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const job = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId,
      });
      for (const command of ['DECLINE_ASSIGNMENT', 'RELEASE_ASSIGNMENT']) {
        await pool.query(
          `INSERT INTO job_card_lifecycle_intents
             (organization_id, job_card_id, user_id, client_action_id, operation_key,
              command, expected_version, state, reserved_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, 'PENDING', NOW(), NOW() + INTERVAL '60 seconds')`,
          [organizationId, job.id, staffId, randomUUID(), `TEST:${command}`, command],
        );
      }
    });
  });

  it('flag off: no offer is recorded and the release 2a runtime is unchanged', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const customerId = await insertCustomer(pool, organizationId);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_OFF);
      const manager = actor(managerId, organizationId, 'MANAGER');
      const staff = actor(staffId, organizationId, 'STAFF');
      const scheduledAt = isoOffset(baseline, 120 * MINUTE_MS);
      const scheduledEndsAt = isoOffset(baseline, 180 * MINUTE_MS);

      const created = await createMeetingJob(service, manager, {
        customerId, assignedTo: staffId, scheduledAt, scheduledEndsAt,
      });

      expect(await readOffers(pool, created.id)).toHaveLength(0);

      const detail = await service.detail(staff, created.id);
      expect(detail.assignmentOffer).toBeNull();
      expect(detail.workflowContext.allowedCommands).toContain('ACCEPT_ASSIGNMENT');
      expect(detail.workflowContext.allowedCommands).toContain('CANCEL');
      expect(detail.workflowContext.allowedCommands).not.toContain('DECLINE_ASSIGNMENT');
      expect(detail.workflowContext.allowedCommands).not.toContain('RELEASE_ASSIGNMENT');

      // Staff scheduling edits and Staff CANCEL keep the 2a rules.
      const patched = await service.patch(staff, created.id, {
        expectedVersion: created.version,
        scheduledAt: isoOffset(baseline, 150 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 210 * MINUTE_MS),
      });
      expect(patched.version).toBe(created.version + 1);

      const accepted = await service.acceptAssignment(staff, created.id, {
        clientActionId: randomUUID(), expectedVersion: created.version + 1,
      });
      expect(accepted.status).toBe('ACCEPTED');

      const cancellable = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
      });
      const cancelled = await service.cancel(staff, cancellable.id, {
        clientActionId: randomUUID(),
        expectedVersion: cancellable.version,
        cancelReason: 'Personel işi kendi üzerinden kapattı.',
      });
      expect(cancelled.status).toBe('CANCELLED');
      expect(await readOffers(pool, cancellable.id)).toHaveLength(0);
    });
  });

  it('A1/A2: an on-time acceptance closes the OPEN offer as ACCEPTED', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const customerId = await insertCustomer(pool, organizationId);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const manager = actor(managerId, organizationId, 'MANAGER');
      const staff = actor(staffId, organizationId, 'STAFF');

      // Planned 14:00-15:00 (60 minutes after the baseline is 15:00, so the
      // canonical SALES_MEETING interval is used verbatim).
      const scheduledAt = isoOffset(baseline, 120 * MINUTE_MS);
      const scheduledEndsAt = isoOffset(baseline, 180 * MINUTE_MS);
      const created = await createMeetingJob(service, manager, {
        customerId, assignedTo: staffId, scheduledAt, scheduledEndsAt,
      });

      const offers = await readOffers(pool, created.id);
      expect(offers).toHaveLength(1);
      const offer = offers[0]!;
      expect(offer).toMatchObject({
        state: 'OPEN',
        opened_reason: 'CREATE',
        opened_by: managerId,
        assignee_user_id: staffId,
        urgent_reason: null,
        ack_code: null,
        ack_text: null,
        closed_at: null,
        closed_by: null,
        close_reason: null,
        close_text: null,
      });
      expect(offer.acceptance_due_at.getTime()).toBe(
        Date.parse(scheduledAt) - 60 * MINUTE_MS,
      );

      const offeredDetail = await service.detail(staff, created.id);
      expect(offeredDetail.assignmentOffer).toEqual({
        id: offer.id,
        state: 'OPEN',
        acceptanceDueAt: isoOffset(baseline, 60 * MINUTE_MS),
        openedAt: offer.opened_at.toISOString(),
        urgentReason: null,
        assignee: { id: staffId, name: 'Saha Personeli' },
        closedAt: null,
        closeReason: null,
        closeText: null,
        proposedScheduledAt: null,
        proposedScheduledEndsAt: null,
        suggestedSolution: null,
        proposalAcceptedAt: null,
      });
      expect(offeredDetail.workflowContext.allowedCommands).toContain('ACCEPT_ASSIGNMENT');
      expect(offeredDetail.workflowContext.allowedCommands).toContain('DECLINE_ASSIGNMENT');
      expect(offeredDetail.workflowContext.allowedCommands).not.toContain('CANCEL');

      // A2 boundary: accept one second before the deadline (the strict
      // `reservedAt < acceptanceDueAt` comparison is shared with A3).
      clock.now = new Date(baseline.getTime() + 60 * MINUTE_MS - 1_000);
      const accepted = await service.acceptAssignment(staff, created.id, {
        clientActionId: randomUUID(), expectedVersion: created.version,
      });
      expect(accepted.status).toBe('ACCEPTED');
      expect((await service.detail(staff, created.id)).assignmentOffer)
        .toMatchObject({ state: 'ACCEPTED' });

      const reservedAt = await readReservedAt(pool, created.id, 'ACCEPT_ASSIGNMENT');
      const persisted = await readJob(pool, created.id);
      expect(persisted).toMatchObject({ status: 'ACCEPTED', version: created.version + 1 });
      expect(persisted.accepted_at?.toISOString()).toBe(reservedAt.toISOString());
      expect(persisted.accepted_by).toBe(staffId);
      expect(reservedAt.getTime()).toBeLessThan(offer.acceptance_due_at.getTime());

      const closed = (await readOffers(pool, created.id))[0]!;
      expect(closed).toMatchObject({
        state: 'ACCEPTED',
        closed_by: staffId,
        close_reason: null,
        close_text: null,
      });
      expect(closed.closed_at?.toISOString()).toBe(reservedAt.toISOString());

      const activities = await selectActivities(pool, created.id);
      expect(activities).toContain('JOB_ASSIGNMENT_OFFER_OPENED');
      expect(activities).toContain('JOB_ACCEPTED');
      // A1: accepting on time never creates a lateness incident.
      expect(await readOverdueIncidents(pool, created.id)).toHaveLength(0);
    });
  });

  it('A3: a late acceptance with the expiry worker off is rejected and writes nothing', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const staff = actor(staffId, organizationId, 'STAFF');
      const manager = actor(managerId, organizationId, 'MANAGER');

      // Planned 14:00-15:00 as seen at 13:00: the deadline (13:00) is already
      // behind the reservation instant.
      const scheduledAt = isoOffset(baseline, 59 * MINUTE_MS);
      const job = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt: isoOffset(baseline, 119 * MINUTE_MS),
      });
      const offerId = await insertOffer(pool, {
        organizationId, jobCardId: job.id, assigneeUserId: staffId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 120 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() - 60_000),
      });

      // Reads present the overdue OPEN offer as expired; the job is in the
      // management recovery list without waiting for the worker.
      const detail = await service.detail(staff, job.id);
      expect(detail.assignmentOffer).toMatchObject({ id: offerId, state: 'EXPIRED' });
      expect(detail.workflowContext.allowedCommands).not.toContain('ACCEPT_ASSIGNMENT');
      const needsAction = await service.listAssignmentOffersNeedingAction(manager, { limit: 10, offset: 0 });
      expect(needsAction.items.map((item) => item.jobCardId)).toContain(job.id);

      await expect(service.acceptAssignment(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      })).rejects.toMatchObject({ code: 'ACCEPTANCE_WINDOW_CLOSED', statusCode: 409 });

      const persisted = await readJob(pool, job.id);
      expect(persisted).toMatchObject({ status: 'NEW', version: job.version });
      expect(persisted.accepted_at).toBeNull();
      expect(persisted.accepted_by).toBeNull();
      const offer = (await readOffers(pool, job.id))[0]!;
      expect(offer).toMatchObject({ id: offerId, state: 'OPEN', closed_at: null, closed_by: null });
      expect(await selectActivities(pool, job.id)).not.toContain('JOB_ACCEPTED');
    });
  });

  it('A4/A15: a decline before the deadline closes the offer and notifies every active manager', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const inactiveManagerId = await insertUser(pool, organizationId, 'MANAGER', 'Pasif Müdür', false);
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const otherStaffId = await insertUser(pool, organizationId, 'STAFF', 'Diğer Personel');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const staff = actor(staffId, organizationId, 'STAFF');
      const job = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt: isoOffset(baseline, 120 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 180 * MINUTE_MS),
      });
      const offerId = await insertOffer(pool, {
        organizationId, jobCardId: job.id, assigneeUserId: staffId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 60 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() + 60 * MINUTE_MS),
      });
      clock.now = new Date(baseline.getTime() + 30 * MINUTE_MS);

      const clientActionId = randomUUID();
      // JOB-012 (Q1): a SCHEDULE_CONFLICT answer must propose an alternative
      // time; it is stored on the offer the answer closes.
      const proposedScheduledAt = isoOffset(baseline, 240 * MINUTE_MS);
      const declined = await service.declineAssignment(staff, job.id, {
        clientActionId,
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Aynı saatte başka bir klinik teslimi var.',
        proposedScheduledAt,
      });
      expect(declined).toMatchObject({ status: 'NEW', version: job.version + 1 });

      const reservedAt = await readReservedAt(pool, job.id, 'DECLINE_ASSIGNMENT');
      const persisted = await readJob(pool, job.id);
      // The job stays NEW and assigned: declining never removes the JobCard.
      expect(persisted).toMatchObject({
        status: 'NEW', version: job.version + 1, assigned_to: staffId,
      });
      expect(persisted.accepted_at).toBeNull();

      const offer = (await readOffers(pool, job.id))[0]!;
      expect(offer).toMatchObject({
        id: offerId,
        state: 'DECLINED',
        closed_by: staffId,
        close_reason: 'SCHEDULE_CONFLICT',
        close_text: 'Aynı saatte başka bir klinik teslimi var.',
      });
      expect(offer.closed_at?.toISOString()).toBe(reservedAt.toISOString());
      expect(offer.proposed_scheduled_at?.toISOString()).toBe(proposedScheduledAt);
      expect(offer.proposal_accepted_at).toBeNull();
      expect(offer.proposal_accepted_by).toBeNull();

      const activities = await selectActivity(pool, job.id, 'JOB_ASSIGNMENT_DECLINED');
      expect(activities).toHaveLength(1);
      expect(activities[0]!.actor_id).toBe(staffId);
      expect(activities[0]!.metadata).toMatchObject({
        offerId,
        reasonCode: 'SCHEDULE_CONFLICT',
        proposedScheduledAt,
      });
      expect(await selectActivities(pool, job.id)).not.toContain('JOB_CANCELLED');

      const declinedNotifications = (await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.assignment_declined');
      expect(declinedNotifications.map((notification) => notification.recipient_user_id).sort())
        .toEqual([adminId, managerId].sort());
      for (const excluded of [staffId, otherStaffId, inactiveManagerId]) {
        expect(declinedNotifications.map((notification) => notification.recipient_user_id))
          .not.toContain(excluded);
      }

      // A15: the job lands in the management recovery list.
      const manager = actor(managerId, organizationId, 'MANAGER');
      const needsAction = await service.listAssignmentOffersNeedingAction(manager, { limit: 10, offset: 0 });
      const item = needsAction.items.find((entry) => entry.jobCardId === job.id);
      expect(item).toMatchObject({
        offerId,
        state: 'DECLINED',
        closeReason: 'SCHEDULE_CONFLICT',
        closeText: 'Aynı saatte başka bir klinik teslimi var.',
        proposedScheduledAt,
      });

      // The job detail management reads carries the same close fact.
      expect((await service.detail(manager, job.id)).assignmentOffer).toMatchObject({
        id: offerId,
        state: 'DECLINED',
        closedAt: reservedAt.toISOString(),
        closeReason: 'SCHEDULE_CONFLICT',
        closeText: 'Aynı saatte başka bir klinik teslimi var.',
        proposedScheduledAt,
        // The planned interval is 60 minutes, so the derived end is +60 min.
        proposedScheduledEndsAt: new Date(Date.parse(proposedScheduledAt) + 60 * MINUTE_MS).toISOString(),
        proposalAcceptedAt: null,
      });

      // Idempotent replay: the same identity returns the identical receipt and
      // writes nothing again; a changed body is refused.
      const replay = await service.declineAssignment(staff, job.id, {
        clientActionId,
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Aynı saatte başka bir klinik teslimi var.',
        proposedScheduledAt,
      });
      expect(replay).toEqual(declined);
      expect(await selectActivity(pool, job.id, 'JOB_ASSIGNMENT_DECLINED')).toHaveLength(1);
      expect((await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.assignment_declined')).toHaveLength(2);

      await expect(service.declineAssignment(staff, job.id, {
        clientActionId,
        expectedVersion: job.version,
        reasonCode: 'ON_LEAVE',
        reasonText: 'İzinliyim.',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await readOffers(pool, job.id)).toHaveLength(1);
    });
  });

  it('A4: a decline at or after the deadline is rejected with nothing written', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const staff = actor(staffId, organizationId, 'STAFF');
      const job = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', status: 'NEW',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt: isoOffset(baseline, 59 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 89 * MINUTE_MS),
      });
      await insertOffer(pool, {
        organizationId, jobCardId: job.id, assigneeUserId: staffId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 120 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() - 60_000),
      });

      await expect(service.declineAssignment(staff, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'ON_LEAVE',
        reasonText: 'İzin günüme denk geldi.',
      })).rejects.toMatchObject({ code: 'ACCEPTANCE_WINDOW_CLOSED', statusCode: 409 });

      expect(await readJob(pool, job.id)).toMatchObject({
        status: 'NEW', version: job.version, accepted_at: null,
      });
      expect((await readOffers(pool, job.id))[0]).toMatchObject({ state: 'OPEN', closed_at: null });
      expect(await selectActivities(pool, job.id)).not.toContain('JOB_ASSIGNMENT_DECLINED');
      expect(await selectActivities(pool, job.id)).not.toContain('JOB_CANCELLED');
      expect((await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.assignment_declined')).toHaveLength(0);
    });
  });

  it('A5: a reservation taken before the deadline wins over a finalize after it', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const job = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt: isoOffset(baseline, 120 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 180 * MINUTE_MS),
      });
      // A couple of seconds of slack: the reservation lands well inside it,
      // then the finalize is held past the deadline on purpose.
      const offerDueAt = new Date(baseline.getTime() + 2_500);
      await insertOffer(pool, {
        organizationId, jobCardId: job.id, assigneeUserId: staffId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 60 * MINUTE_MS),
        acceptanceDueAt: offerDueAt,
      });

      const gate = gatePoolStatements(pool, 'UPDATE job_cards');
      const { service } = buildService(gate.pool, { now: baseline }, WINDOW_ON);
      const staff = actor(staffId, organizationId, 'STAFF');
      const acceptPromise = service.acceptAssignment(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      try {
        await within(gate.arrived, 5_000, 'the ACCEPT finalize');
        // The deadline passes while the finalize transaction is in flight.
        while (Date.now() < offerDueAt.getTime() + 200) {
          await sleep(25);
        }
      } finally {
        gate.release();
      }

      const accepted = await acceptPromise;
      expect(accepted.status).toBe('ACCEPTED');
      const reservedAt = await readReservedAt(pool, job.id, 'ACCEPT_ASSIGNMENT');
      expect(reservedAt.getTime()).toBeLessThan(offerDueAt.getTime());
      expect(Date.now()).toBeGreaterThan(offerDueAt.getTime());
      expect((await readOffers(pool, job.id))[0]).toMatchObject({ state: 'ACCEPTED' });
      expect((await readJob(pool, job.id)).accepted_at?.toISOString())
        .toBe(reservedAt.toISOString());
    });
  });

  it('release: materializes LATE_START, returns the job to NEW and closes the offer RELEASED', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const staff = actor(staffId, organizationId, 'STAFF');
      const scheduledAt = isoOffset(baseline, -60 * MINUTE_MS);
      const scheduledEndsAt = isoOffset(baseline, -30 * MINUTE_MS);

      // Accepted commitment, planned interval already ended: releasing must
      // not hide the breach.
      const job = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt,
        acceptedAt: isoOffset(baseline, -180 * MINUTE_MS),
      });
      const offerId = await insertOffer(pool, {
        organizationId, jobCardId: job.id, assigneeUserId: staffId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 240 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() - 120 * MINUTE_MS),
        state: 'ACCEPTED',
        closedAt: new Date(baseline.getTime() - 180 * MINUTE_MS),
        closedBy: staffId,
      });
      expect((await service.detail(staff, job.id)).workflowContext.allowedCommands)
        .toContain('RELEASE_ASSIGNMENT');

      const released = await service.releaseAssignment(staff, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
        reasonText: 'Teslim edilecek implant seti depoda yok.',
      });
      expect(released).toMatchObject({ status: 'NEW', version: job.version + 1 });

      const reservedAt = await readReservedAt(pool, job.id, 'RELEASE_ASSIGNMENT');
      const persisted = await readJob(pool, job.id);
      expect(persisted).toMatchObject({
        status: 'NEW', version: job.version + 1, assigned_to: staffId,
      });
      expect(persisted.accepted_at).toBeNull();
      expect(persisted.accepted_by).toBeNull();
      // The planned interval is never rewritten by a release.
      expect(persisted.scheduled_at?.toISOString()).toBe(scheduledAt);
      expect(persisted.scheduled_ends_at?.toISOString()).toBe(scheduledEndsAt);

      // OVR-2: the pre-release acceptance is materialized, not erased.
      const incidents = await readOverdueIncidents(pool, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        accountable_user_id: staffId,
        recovered_at: null,
      });
      expect(incidents[0]!.deadline_at.toISOString()).toBe(scheduledEndsAt);

      const offers = await readOffers(pool, job.id);
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        id: offerId,
        state: 'RELEASED',
        closed_by: staffId,
        close_reason: 'MISSING_STOCK_OR_EQUIPMENT',
        close_text: 'Teslim edilecek implant seti depoda yok.',
      });
      expect(offers[0]!.closed_at?.toISOString()).toBe(reservedAt.toISOString());

      const activities = await selectActivities(pool, job.id);
      expect(activities).toContain('JOB_ASSIGNMENT_RELEASED');
      const releasedActivity = await selectActivity(pool, job.id, 'JOB_ASSIGNMENT_RELEASED');
      expect(releasedActivity).toHaveLength(1);
      expect(releasedActivity[0]!.metadata).toMatchObject({
        offerId,
        reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
      });

      // The job detail management reads carries the release close fact.
      expect((await service.detail(actor(managerId, organizationId, 'MANAGER'), job.id))
        .assignmentOffer).toMatchObject({
        id: offerId,
        state: 'RELEASED',
        closedAt: reservedAt.toISOString(),
        closeReason: 'MISSING_STOCK_OR_EQUIPMENT',
        closeText: 'Teslim edilecek implant seti depoda yok.',
      });

      const managementNotified = (await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.assignment_declined');
      expect(managementNotified.map((notification) => notification.recipient_user_id).sort())
        .toEqual([adminId, managerId].sort());

      // A release opens no new offer until management acts.
      expect(await service.listAssignmentOffersNeedingAction(
        actor(managerId, organizationId, 'MANAGER'), { limit: 10, offset: 0 },
      )).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ jobCardId: job.id })]) });
      await expect(service.releaseAssignment(staff, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version + 1,
        reasonCode: 'OTHER',
        reasonText: 'İkinci kez geri bırakma.',
      })).rejects.toMatchObject({ statusCode: 409 });
      expect(await readOffers(pool, job.id)).toHaveLength(1);
    });
  });

  it('A6: re-offer closes the overdue OPEN offer as EXPIRED and opens a new deadline', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const manager = actor(managerId, organizationId, 'MANAGER');
      const staff = actor(staffId, organizationId, 'STAFF');

      // 13:10, planned 14:00-15:00: the old deadline (13:00) is overdue and
      // the new one is openedAt + 10 min (13:20).
      const scheduledAt = isoOffset(baseline, 50 * MINUTE_MS);
      const job = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt: isoOffset(baseline, 110 * MINUTE_MS),
      });
      const overdueOfferId = await insertOffer(pool, {
        organizationId, jobCardId: job.id, assigneeUserId: staffId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 80 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() - 10 * MINUTE_MS),
      });

      const receipt = await service.reofferAssignment(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(receipt).toMatchObject({
        jobCardId: job.id,
        acceptanceDueAt: isoOffset(baseline, 10 * MINUTE_MS),
        urgentReason: 'SHORT_NOTICE',
      });
      expect(receipt.offerId).not.toBe(overdueOfferId);

      const offers = await readOffers(pool, job.id);
      expect(offers).toHaveLength(2);
      expect(offers[0]).toMatchObject({
        id: overdueOfferId, state: 'EXPIRED', closed_by: null, close_reason: null,
      });
      expect(offers[0]!.closed_at?.toISOString()).toBe(baseline.toISOString());
      expect(offers[1]).toMatchObject({
        id: receipt.offerId,
        state: 'OPEN',
        opened_reason: 'REOFFER',
        opened_by: managerId,
        assignee_user_id: staffId,
        urgent_reason: 'SHORT_NOTICE',
      });
      expect(offers[1]!.acceptance_due_at.toISOString()).toBe(isoOffset(baseline, 10 * MINUTE_MS));
      expect((await readJob(pool, job.id)).version).toBe(job.version + 1);

      const activities = await selectActivities(pool, job.id);
      expect(activities.filter((event) => event === 'JOB_ASSIGNMENT_OFFER_OPENED')).toHaveLength(1);
      expect(activities.filter((event) => event === 'JOB_ASSIGNMENT_OFFER_EXPIRED')).toHaveLength(1);

      // Staff can accept the fresh offer.
      const accepted = await service.acceptAssignment(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version + 1,
      });
      expect(accepted.status).toBe('ACCEPTED');
      expect((await readOffers(pool, job.id))[1]).toMatchObject({ state: 'ACCEPTED' });

      // A live OPEN offer cannot be re-offered: nothing is written.
      const liveJob = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt: isoOffset(baseline, 120 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 180 * MINUTE_MS),
      });
      const liveOfferId = await insertOffer(pool, {
        organizationId, jobCardId: liveJob.id, assigneeUserId: staffId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 30 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() + 60 * MINUTE_MS),
      });
      await expect(service.reofferAssignment(manager, liveJob.id, {
        clientActionId: randomUUID(), expectedVersion: liveJob.version,
      })).rejects.toMatchObject({ code: 'ASSIGNMENT_OFFER_ALREADY_OPEN', statusCode: 409 });
      const liveOffers = await readOffers(pool, liveJob.id);
      expect(liveOffers).toHaveLength(1);
      expect(liveOffers[0]).toMatchObject({ id: liveOfferId, state: 'OPEN', closed_at: null });
      expect((await readJob(pool, liveJob.id)).version).toBe(liveJob.version);

      // Management only, before any lookup.
      await expect(service.reofferAssignment(staff, liveJob.id, {
        clientActionId: randomUUID(), expectedVersion: liveJob.version,
      })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(service.reofferAssignment(manager, randomUUID(), {
        clientActionId: randomUUID(), expectedVersion: liveJob.version,
      })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
    });
  });

  it('A7: Staff cannot move the customer time of a job in the window', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const staff = actor(staffId, organizationId, 'STAFF');
      const manager = actor(managerId, organizationId, 'MANAGER');

      const job = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId, dueDate: '2026-12-15',
        scheduledAt: isoOffset(baseline, 120 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 180 * MINUTE_MS),
      });
      await insertOffer(pool, {
        organizationId, jobCardId: job.id, assigneeUserId: staffId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 60 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() + 60 * MINUTE_MS),
      });
      const before = await readJob(pool, job.id);

      for (const patch of [
        { scheduledAt: isoOffset(baseline, 150 * MINUTE_MS) },
        { scheduledEndsAt: isoOffset(baseline, 210 * MINUTE_MS) },
        { dueDate: '2026-12-20' },
      ]) {
        await expect(service.patch(staff, job.id, {
          expectedVersion: job.version, ...patch,
        })).rejects.toMatchObject({
          code: 'CUSTOMER_TIME_MANAGEMENT_ONLY', statusCode: 403,
        });
      }
      expect(await readJob(pool, job.id)).toEqual(before);
      expect(await selectActivities(pool, job.id)).not.toContain('JOB_FIELDS_UPDATED');

      // A non-customer-time field stays editable for the assignee.
      const retitled = await service.patch(staff, job.id, {
        expectedVersion: job.version, title: 'Klinik ziyareti (güncel)',
      });
      expect(retitled.version).toBe(job.version + 1);

      // The same rule holds in ACCEPTED.
      const acceptedJob = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt: isoOffset(baseline, 120 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 150 * MINUTE_MS),
      });
      await insertOffer(pool, {
        organizationId, jobCardId: acceptedJob.id, assigneeUserId: staffId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 60 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() + 60 * MINUTE_MS),
        state: 'ACCEPTED',
        closedAt: new Date(baseline.getTime() - 30 * MINUTE_MS),
        closedBy: staffId,
      });
      await expect(service.patch(staff, acceptedJob.id, {
        expectedVersion: acceptedJob.version,
        scheduledAt: isoOffset(baseline, 180 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 210 * MINUTE_MS),
      })).rejects.toMatchObject({
        code: 'CUSTOMER_TIME_MANAGEMENT_ONLY', statusCode: 403,
      });
      expect((await readJob(pool, acceptedJob.id)).version).toBe(acceptedJob.version);

      // Management reschedules: the live offer is withdrawn and a fresh one
      // carries the new deadline.
      const rescheduledAt = isoOffset(baseline, 240 * MINUTE_MS);
      await service.patch(manager, job.id, {
        expectedVersion: job.version + 1,
        scheduledAt: rescheduledAt,
        scheduledEndsAt: isoOffset(baseline, 300 * MINUTE_MS),
      });
      const offers = await readOffers(pool, job.id);
      expect(offers).toHaveLength(2);
      expect(offers[0]).toMatchObject({
        state: 'WITHDRAWN', close_reason: 'RESCHEDULED', closed_by: managerId,
      });
      expect(offers[1]).toMatchObject({
        state: 'OPEN', opened_reason: 'RESCHEDULE', assignee_user_id: staffId,
      });
      expect(offers[1]!.acceptance_due_at.getTime()).toBe(Date.parse(rescheduledAt) - 60 * MINUTE_MS);
    });
  });

  it('A13: assigning after the planned start needs the explicit acknowledgement', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Personel A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Personel B');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const manager = actor(managerId, organizationId, 'MANAGER');

      // Planned 14:00-15:00; the reassignment happens at 14:10.
      const scheduledAt = isoOffset(baseline, 120 * MINUTE_MS);
      const scheduledEndsAt = isoOffset(baseline, 180 * MINUTE_MS);
      const job = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffAId, createdBy: managerId,
        scheduledAt, scheduledEndsAt,
      });
      clock.now = new Date(baseline.getTime() + 130 * MINUTE_MS);

      await expect(service.patch(manager, job.id, {
        expectedVersion: job.version, assignedTo: staffBId,
      })).rejects.toMatchObject({
        code: 'PAST_START_ACKNOWLEDGEMENT_REQUIRED', statusCode: 409,
      });
      expect(await readOffers(pool, job.id)).toHaveLength(0);
      expect(await readJob(pool, job.id)).toMatchObject({
        version: job.version, assigned_to: staffAId,
      });

      const assigned = await service.patch(manager, job.id, {
        expectedVersion: job.version,
        assignedTo: staffBId,
        pastStartAcknowledgement: {
          code: 'CUSTOMER_WAITING',
          text: 'Müşteri klinikte bekliyor, teslim bugün yapılabilir.',
        },
      });
      expect(assigned.version).toBe(job.version + 1);
      expect((await readJob(pool, job.id)).assigned_to).toBe(staffBId);

      const offers = await readOffers(pool, job.id);
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        state: 'OPEN',
        opened_reason: 'REASSIGN',
        opened_by: managerId,
        assignee_user_id: staffBId,
        urgent_reason: 'START_PASSED',
        ack_code: 'CUSTOMER_WAITING',
        ack_text: 'Müşteri klinikte bekliyor, teslim bugün yapılabilir.',
      });
      // 14:20 = openedAt + 10 minutes (the minimum window wins here).
      expect(offers[0]!.acceptance_due_at.toISOString())
        .toBe(isoOffset(baseline, 140 * MINUTE_MS));

      const notified = (await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.reassigned');
      expect(notified.map((notification) => notification.recipient_user_id)).toEqual([staffBId]);
    });
  });

  it('A14/A14b: the planned window must fit the minimum response window', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Personel A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Personel B');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const manager = actor(managerId, organizationId, 'MANAGER');
      const scheduledAt = isoOffset(baseline, 120 * MINUTE_MS);
      const scheduledEndsAt = isoOffset(baseline, 180 * MINUTE_MS);

      // A14: 14:55 with a 15:00 end cannot fit ten minutes.
      const tooLate = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffAId, createdBy: managerId,
        scheduledAt, scheduledEndsAt,
      });
      clock.now = new Date(baseline.getTime() + 175 * MINUTE_MS);
      await expect(service.patch(manager, tooLate.id, {
        expectedVersion: tooLate.version, assignedTo: staffBId,
      })).rejects.toMatchObject({ code: 'ASSIGNMENT_WINDOW_TOO_SHORT', statusCode: 409 });
      expect(await readOffers(pool, tooLate.id)).toHaveLength(0);
      expect(await readJob(pool, tooLate.id)).toMatchObject({
        version: tooLate.version, assigned_to: staffAId,
      });

      // A14b: 13:30 is before the start but inside the short-notice band.
      const shortNotice = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffAId, createdBy: managerId,
        scheduledAt, scheduledEndsAt,
      });
      clock.now = new Date(baseline.getTime() + 90 * MINUTE_MS);
      await service.patch(manager, shortNotice.id, {
        expectedVersion: shortNotice.version, assignedTo: staffBId,
      });
      const offers = await readOffers(pool, shortNotice.id);
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        state: 'OPEN',
        urgent_reason: 'SHORT_NOTICE',
        assignee_user_id: staffBId,
      });
      expect(offers[0]!.acceptance_due_at.toISOString())
        .toBe(isoOffset(baseline, 100 * MINUTE_MS));
    });
  });

  it('withdraws the live offer on reassignment and opens one for the new assignee', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Personel A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Personel B');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const manager = actor(managerId, organizationId, 'MANAGER');
      const job = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffAId, createdBy: managerId,
        scheduledAt: isoOffset(baseline, 120 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 180 * MINUTE_MS),
      });
      const previousOfferId = await insertOffer(pool, {
        organizationId, jobCardId: job.id, assigneeUserId: staffAId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 60 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() + 60 * MINUTE_MS),
      });
      clock.now = new Date(baseline.getTime() + 30 * MINUTE_MS);

      await service.patch(manager, job.id, {
        expectedVersion: job.version, assignedTo: staffBId,
      });

      const offers = await readOffers(pool, job.id);
      expect(offers).toHaveLength(2);
      expect(offers[0]).toMatchObject({
        id: previousOfferId,
        state: 'WITHDRAWN',
        close_reason: 'REASSIGNED',
        closed_by: managerId,
      });
      expect(offers[0]!.closed_at?.toISOString())
        .toBe(new Date(baseline.getTime() + 30 * MINUTE_MS).toISOString());
      expect(offers[1]).toMatchObject({
        state: 'OPEN',
        opened_reason: 'REASSIGN',
        assignee_user_id: staffBId,
      });

      const activities = await selectActivities(pool, job.id);
      expect(activities).toContain('JOB_ASSIGNMENT_OFFER_WITHDRAWN');
      expect(activities).toContain('JOB_ASSIGNMENT_OFFER_OPENED');

      const notified = (await selectNotifications(pool, organizationId, job.id))
        .filter((notification) => notification.kind === 'job.reassigned');
      expect(notified.map((notification) => notification.recipient_user_id)).toEqual([staffBId]);

      // Staff B now owns the window; Staff A can no longer reach the job.
      const detailForB = await service.detail(
        actor(staffBId, organizationId, 'STAFF'), job.id,
      );
      expect(detailForB.assignmentOffer).toMatchObject({ id: offers[1]!.id, state: 'OPEN' });
      await expect(service.detail(actor(staffAId, organizationId, 'STAFF'), job.id))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it.each(['SALES_MEETING', 'PRODUCT_DELIVERY'] as const)(
    'RESCUE-003: moves the %s assignment and interval with one new offer',
    async (type) => {
      await withSchema(async (pool) => {
        const baseline = await readDbBaseline(pool);
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const original = await insertUser(pool, organizationId, 'STAFF', 'Original staff');
        const replacement = await insertUser(pool, organizationId, 'STAFF', 'Replacement staff');
        const customerId = await insertCustomer(pool, organizationId);
        const otherCustomerId = await insertCustomer(pool, organizationId, 'Other clinic');
        const time = (minutes: number) => isoOffset(baseline, minutes * MINUTE_MS);
        const manager = actor(managerId, organizationId, 'MANAGER');
        const { service } = buildService(pool, { now: new Date(time(90)) }, WINDOW_ON);
        const job = await insertJob(pool, {
          organizationId, customerId, type, status: 'NEW', assignedTo: original,
          createdBy: managerId, scheduledAt: time(120), scheduledEndsAt: time(180),
        });
        const previousOffer = await insertOffer(pool, {
          organizationId, jobCardId: job.id, assigneeUserId: original, openedBy: managerId,
          openedAt: new Date(time(60)), acceptanceDueAt: new Date(time(100)),
        });
        await insertJob(pool, {
          organizationId, customerId: otherCustomerId, type, status: 'ACCEPTED', assignedTo: replacement,
          createdBy: managerId, scheduledAt: time(240), scheduledEndsAt: time(300),
          acceptedAt: time(70),
        });

        const moving = {
          expectedVersion: job.version, assignedTo: replacement,
          scheduledAt: time(360),
        };
        await expect(service.patch(manager, job.id, {
          ...moving, scheduledAt: time(240),
        })).rejects.toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
        await expect(readJob(pool, job.id)).resolves.toMatchObject({
          version: job.version, assigned_to: original,
          scheduled_at: new Date(time(120)), scheduled_ends_at: new Date(time(180)),
        });
        await expect(readOffers(pool, job.id)).resolves.toMatchObject([
          { id: previousOffer, state: 'OPEN' },
        ]);
        expect(await selectNotifications(pool, organizationId, job.id)).toEqual([]);

        // The request lookup runs after the job and revision writes. Its
        // failure must roll back the entire edit, including history.
        await expect(service.patch(manager, job.id, {
          ...moving,
          changeRequestResolution: { changeRequestId: randomUUID(), resolution: 'RESCHEDULED' },
        })).rejects.toMatchObject({ code: 'CHANGE_REQUEST_NOT_FOUND', statusCode: 404 });
        await expect(readJob(pool, job.id)).resolves.toMatchObject({
          version: job.version, assigned_to: original,
          scheduled_at: new Date(time(120)), scheduled_ends_at: new Date(time(180)),
        });
        await expect(readOffers(pool, job.id)).resolves.toMatchObject([
          { id: previousOffer, state: 'OPEN' },
        ]);
        expect(await selectActivities(pool, job.id)).toEqual([]);
        expect(await selectNotifications(pool, organizationId, job.id)).toEqual([]);

        const updated = await service.patch(manager, job.id, moving);
        expect(updated).toMatchObject({
          version: job.version + 1, status: 'NEW', assignedTo: replacement,
          scheduledAt: time(360), scheduledEndsAt: time(420),
          assignmentOffer: { state: 'OPEN', assignee: { id: replacement } },
        });
        await expect(service.patch(manager, job.id, moving))
          .rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
        await expect(readOffers(pool, job.id)).resolves.toMatchObject([
          { id: previousOffer, state: 'WITHDRAWN', close_reason: 'REASSIGNED' },
          { state: 'OPEN', opened_reason: 'REASSIGN', assignee_user_id: replacement },
        ]);
        const notificationRecipients = (await selectNotifications(pool, organizationId, job.id))
          .filter((notification) => notification.kind === 'job.reassigned')
          .map((notification) => notification.recipient_user_id);
        expect(notificationRecipients).toEqual([replacement]);
        const revisions = await pool.query<{ revision_no: number; scheduled_at: Date }>(
          `SELECT revision_no, scheduled_at FROM job_card_schedule_revisions
            WHERE organization_id = $1 AND job_card_id = $2 ORDER BY revision_no`,
          [organizationId, job.id],
        );
        expect(revisions.rows).toEqual([
          { revision_no: 1, scheduled_at: new Date(time(120)) },
          { revision_no: 2, scheduled_at: new Date(time(360)) },
        ]);
        const assignments = await pool.query<{ to_user_id: string }>(
          `SELECT to_user_id FROM job_card_assignment_history
            WHERE organization_id = $1 AND job_card_id = $2 ORDER BY changed_at, id`,
          [organizationId, job.id],
        );
        expect(assignments.rows.map((row) => row.to_user_id)).toEqual([original, replacement]);
      });
    },
  );

  it('manager cancel withdraws the live offer', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const manager = actor(managerId, organizationId, 'MANAGER');
      const job = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt: isoOffset(baseline, 120 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 180 * MINUTE_MS),
      });
      const offerId = await insertOffer(pool, {
        organizationId, jobCardId: job.id, assigneeUserId: staffId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 60 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() + 60 * MINUTE_MS),
      });
      clock.now = new Date(baseline.getTime() + 10 * MINUTE_MS);

      const cancelled = await service.cancel(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        cancelReason: 'Klinik teslimi iptal etti, ürün iade edildi.',
      });
      expect(cancelled.status).toBe('CANCELLED');

      const offer = (await readOffers(pool, job.id))[0]!;
      expect(offer).toMatchObject({
        id: offerId,
        state: 'WITHDRAWN',
        close_reason: 'CANCELLED',
        closed_by: managerId,
      });
      // §9 / 049: the close instant is the lifecycle reservation instant
      // sampled under the JobCard lock, not the in-memory service clock.
      expect(offer.closed_at?.toISOString())
        .toBe((await readReservedAt(pool, job.id, 'CANCEL')).toISOString());
      expect(await selectActivities(pool, job.id)).toContain('JOB_ASSIGNMENT_OFFER_WITHDRAWN');
      expect(await service.listAssignmentOffersNeedingAction(manager, { limit: 10, offset: 0 }))
        .toMatchObject({ total: 0 });
    });
  });

  it('D1: Staff CANCEL is rejected on every type and active status with the flag on', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const staff = actor(staffId, organizationId, 'STAFF');
      const manager = actor(managerId, organizationId, 'MANAGER');
      const types: JobCardType[] = ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING'];
      const statuses: FixtureStatus[] = [
        'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
      ];

      const fixtures: FixtureJob[] = [];
      for (const type of types) {
        for (const status of statuses) {
          fixtures.push(await insertJob(pool, {
            organizationId, type, status, assignedTo: staffId, createdBy: managerId,
            scheduledAt: type === 'GENERAL_TASK' ? null : isoOffset(baseline, 120 * MINUTE_MS),
            scheduledEndsAt: type === 'GENERAL_TASK' ? null : isoOffset(baseline, 180 * MINUTE_MS),
          }));
        }
      }

      const before = new Map<string, JobRow>();
      for (const fixture of fixtures) before.set(fixture.id, await readJob(pool, fixture.id));

      for (const fixture of fixtures) {
        await expect(service.cancel(staff, fixture.id, {
          clientActionId: randomUUID(),
          expectedVersion: fixture.version,
          cancelReason: 'Personel işi kapatmak istedi.',
        })).rejects.toMatchObject({ statusCode: 409 });
        expect(await readJob(pool, fixture.id)).toEqual(before.get(fixture.id));
      }
      const cancelledActivities = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_activity_logs
          WHERE organization_id = $1 AND event_type = 'JOB_CANCELLED'`,
        [organizationId],
      );
      expect(cancelledActivities.rows[0]!.count).toBe('0');

      // Management keeps reasoned cancellation.
      const managerTarget = fixtures[0]!;
      const cancelled = await service.cancel(manager, managerTarget.id, {
        clientActionId: randomUUID(),
        expectedVersion: managerTarget.version,
        cancelReason: 'Müşteri randevuyu iptal etti.',
      });
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  it('lists the management recovery queue oldest deadline first', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool);
      const otherOrganizationId = await insertOrg(pool, 'Komşu Klinik');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const otherManagerId = await insertUser(pool, otherOrganizationId, 'MANAGER', 'Komşu Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');
      const otherStaffId = await insertUser(pool, otherOrganizationId, 'STAFF', 'Komşu Personel');
      const customerId = await insertCustomer(pool, organizationId, 'Marmara Diş Kliniği');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);
      const manager = actor(managerId, organizationId, 'MANAGER');

      const scheduledAt = isoOffset(baseline, 120 * MINUTE_MS);
      const scheduledEndsAt = isoOffset(baseline, 180 * MINUTE_MS);
      const makeJob = (title: string, status: FixtureStatus = 'NEW') => insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status, title,
        assignedTo: staffId, createdBy: managerId, customerId,
        scheduledAt, scheduledEndsAt,
      });
      const offer = (jobId: string, overrides: Partial<OfferFixtureOverrides> = {}) => insertOffer(pool, {
        organizationId, jobCardId: jobId, assigneeUserId: staffId, openedBy: managerId,
        openedAt: new Date(baseline.getTime() - 60 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() + 60 * MINUTE_MS),
        ...overrides,
      });

      // Six jobs in the queue, ordered by acceptance_due_at ascending.
      const pastDue = await makeJob('Süresi geçen teklif');
      await offer(pastDue.id, {
        acceptanceDueAt: new Date(baseline.getTime() - 10 * MINUTE_MS),
      });
      const expired = await makeJob('Süresi dolan teklif');
      const expiredOfferId = await offer(expired.id, {
        acceptanceDueAt: new Date(baseline.getTime() + 10 * MINUTE_MS),
        state: 'EXPIRED', closedAt: new Date(baseline.getTime() - 5 * MINUTE_MS), closedBy: null,
      });
      const urgent = await makeJob('Acil teklif');
      await offer(urgent.id, {
        acceptanceDueAt: new Date(baseline.getTime() + 15 * MINUTE_MS),
        urgentReason: 'SHORT_NOTICE',
      });
      const released = await makeJob('Geri bırakılan teklif');
      await offer(released.id, {
        acceptanceDueAt: new Date(baseline.getTime() + 20 * MINUTE_MS),
        state: 'RELEASED', closedAt: new Date(baseline.getTime() - 20 * MINUTE_MS), closedBy: staffId,
        closeReason: 'SCHEDULE_CONFLICT', closeText: 'Aynı saatte başka iş var.',
      });
      const declined = await makeJob('Reddedilen teklif');
      await offer(declined.id, {
        acceptanceDueAt: new Date(baseline.getTime() + 30 * MINUTE_MS),
        state: 'DECLINED', closedAt: new Date(baseline.getTime() - 30 * MINUTE_MS), closedBy: staffId,
        closeReason: 'ON_LEAVE', closeText: 'İzinliyim.',
      });
      const plannedWindowPassed = await makeJob('Planlanan pencere geçti');
      await offer(plannedWindowPassed.id, {
        acceptanceDueAt: new Date(baseline.getTime() + 40 * MINUTE_MS),
        state: 'WITHDRAWN', closedAt: new Date(baseline.getTime() - 40 * MINUTE_MS), closedBy: managerId,
        closeReason: 'PLANNED_WINDOW_PASSED', closeText: null,
      });

      // Excluded: a live non-urgent OPEN offer, an accepted job, a job with no
      // offer and another organization's job.
      const healthy = await makeJob('Sağlıklı teklif');
      await offer(healthy.id, { acceptanceDueAt: new Date(baseline.getTime() + 50 * MINUTE_MS) });
      const acceptedJob = await makeJob('Kabul edilen iş', 'ACCEPTED');
      await offer(acceptedJob.id, {
        acceptanceDueAt: new Date(baseline.getTime() + 10 * MINUTE_MS),
        state: 'ACCEPTED', closedAt: new Date(baseline.getTime() - 40 * MINUTE_MS), closedBy: staffId,
      });
      await makeJob('Teklifsiz iş');
      const foreign = await insertJob(pool, {
        organizationId: otherOrganizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: otherStaffId, createdBy: otherManagerId,
        scheduledAt, scheduledEndsAt,
      });
      await insertOffer(pool, {
        organizationId: otherOrganizationId, jobCardId: foreign.id, assigneeUserId: otherStaffId,
        openedBy: otherManagerId, openedAt: new Date(baseline.getTime() - 60 * MINUTE_MS),
        acceptanceDueAt: new Date(baseline.getTime() + 10 * MINUTE_MS),
        state: 'DECLINED', closedAt: new Date(baseline.getTime() - 30 * MINUTE_MS), closedBy: otherStaffId,
        closeReason: 'OTHER', closeText: 'Komşu personel reddetti.',
      });

      const page = await service.listAssignmentOffersNeedingAction(manager, { limit: 10, offset: 0 });
      expect(page).toMatchObject({ total: 6, limit: 10, offset: 0 });
      expect(page.items.map((item) => item.jobCardId)).toEqual([
        pastDue.id, expired.id, urgent.id, released.id, declined.id, plannedWindowPassed.id,
      ]);
      expect(page.items.map((item) => item.state)).toEqual([
        expect.stringMatching(/^(OPEN|EXPIRED)$/),
        'EXPIRED',
        'OPEN',
        'RELEASED',
        'DECLINED',
        'WITHDRAWN',
      ]);
      expect(page.items[1]).toMatchObject({
        offerId: expiredOfferId,
        jobTitle: 'Süresi dolan teklif',
        jobType: 'SALES_MEETING',
        closeReason: null,
        urgentReason: null,
        acceptanceDueAt: isoOffset(baseline, 10 * MINUTE_MS),
        scheduledAt,
        assignee: { id: staffId, name: 'Saha Personeli' },
        customer: { id: customerId, name: 'Marmara Diş Kliniği' },
        jobPath: `/jobs/${expired.id}`,
      });
      expect(page.items[2]).toMatchObject({ urgentReason: 'SHORT_NOTICE' });
      expect(page.items[3]).toMatchObject({
        closeReason: 'SCHEDULE_CONFLICT', closeText: 'Aynı saatte başka iş var.',
      });
      expect(page.items[5]).toMatchObject({ closeReason: 'PLANNED_WINDOW_PASSED' });

      const firstPage = await service.listAssignmentOffersNeedingAction(manager, { limit: 2, offset: 0 });
      expect(firstPage).toMatchObject({ total: 6, limit: 2, offset: 0 });
      expect(firstPage.items.map((item) => item.jobCardId)).toEqual([pastDue.id, expired.id]);
      const lastPage = await service.listAssignmentOffersNeedingAction(manager, { limit: 2, offset: 4 });
      expect(lastPage).toMatchObject({ total: 6, limit: 2, offset: 4 });
      expect(lastPage.items.map((item) => item.jobCardId)).toEqual([declined.id, plannedWindowPassed.id]);

      await expect(service.listAssignmentOffersNeedingAction(
        actor(staffId, organizationId, 'STAFF'), { limit: 10, offset: 0 },
      )).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });
  });

  it('A18: offboarding transfer opens no offer for a started job and flags a too-short window', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool, 'JOB-010 Devir Klinik');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const targetId = await insertUser(pool, organizationId, 'STAFF', 'Ayrılan Personel');
      const replacementId = await insertUser(pool, organizationId, 'STAFF', 'Yeni Personel');
      const clock = { now: baseline };
      const { service } = buildService(pool, clock, WINDOW_ON);

      const started = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'IN_PROGRESS',
        assignedTo: targetId, createdBy: adminId,
        scheduledAt: isoOffset(baseline, 120 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 180 * MINUTE_MS),
        startedAt: isoOffset(baseline, -10 * MINUTE_MS),
      });
      // Compound producer that must not fail: the planned window is already
      // too short, so the offer is recorded and closed at once.
      const tooShort = await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: targetId, createdBy: adminId,
        scheduledAt: isoOffset(baseline, 2 * MINUTE_MS),
        scheduledEndsAt: isoOffset(baseline, 8 * MINUTE_MS),
      });

      const admin = (await pool.query<SafeUser>(
        `SELECT id, organization_id AS "organizationId", name, email, role,
                must_change_password AS "mustChangePassword", is_active AS "isActive", version
           FROM users WHERE id = $1`,
        [adminId],
      )).rows[0]!;
      const offboarding = new PostgresStaffOffboardingService(
        pool,
        undefined,
        () => clock.now,
        WINDOW_ON,
      );
      const plan = await offboarding.preview(admin, targetId);
      expect(plan.jobs.map((job) => job.id).sort()).toEqual([started.id, tooShort.id].sort());

      const decisions: OffboardingDecisionInput = {
        clientActionId: randomUUID(),
        planHash: plan.planHash,
        reasonCode: 'ACCESS_ENDED',
        jobDecisions: plan.jobs.map((job) => ({
          jobCardId: job.id, replacementUserId: replacementId,
        })),
        calendarDecisions: [],
        followUpDecisions: [],
        customerDecisions: [],
        reminderDecisions: [],
      };
      const response = await offboarding.execute(admin, targetId, decisions);
      expect(response.summary.jobCardsTransferred).toBe(2);

      // A18: the started job got no offer at all.
      expect(await readOffers(pool, started.id)).toHaveLength(0);
      expect(await readJob(pool, started.id)).toMatchObject({
        status: 'IN_PROGRESS', assigned_to: replacementId,
      });

      // The too-short compound producer records and withdraws at once.
      const wrappedOffers = await readOffers(pool, tooShort.id);
      expect(wrappedOffers).toHaveLength(1);
      expect(wrappedOffers[0]).toMatchObject({
        state: 'WITHDRAWN',
        opened_reason: 'OFFBOARDING_TRANSFER',
        assignee_user_id: replacementId,
        close_reason: 'PLANNED_WINDOW_PASSED',
      });
      expect(wrappedOffers[0]!.closed_at).not.toBeNull();

      // The started job never enters the management recovery list; the
      // too-short one does.
      const manager = actor(adminId, organizationId, 'ADMIN');
      const needsAction = await service.listAssignmentOffersNeedingAction(manager, { limit: 10, offset: 0 });
      expect(needsAction.items.map((item) => item.jobCardId)).toContain(tooShort.id);
      expect(needsAction.items.map((item) => item.jobCardId)).not.toContain(started.id);

      // Offboarding transfer sends the existing reassignment notification.
      const notified = (await selectNotifications(pool, organizationId, tooShort.id))
        .filter((notification) => notification.kind === 'job.reassigned');
      expect(notified.map((notification) => notification.recipient_user_id)).toEqual([replacementId]);
    });
  });
});
