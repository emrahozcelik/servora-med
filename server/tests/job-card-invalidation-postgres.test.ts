import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { PostgresCalendarReminderWorkerRepository } from '../src/modules/calendar/reminder-worker.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { jobCardInvalidationRequestHash } from '../src/modules/job-cards/invalidation-input.js';
import { PostgresOverviewRepository } from '../src/modules/overview/repository.js';
import type {
  FollowUpCreateInput,
  JobCardActor,
  JobCardStatus,
  JobCardType,
} from '../src/modules/job-cards/types.js';
import { MessagingService } from '../src/modules/messaging/service.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const now = new Date('2026-08-24T09:00:00.000Z');

type SourceStatus = Exclude<JobCardStatus, 'INVALIDATED'>;
type Fixture = {
  pool: Pool;
  organizationId: string;
  otherOrganizationId: string;
  admin: JobCardActor;
  manager: JobCardActor;
  staff: JobCardActor;
  otherOrgAdmin: JobCardActor;
  safeAdmin: SafeUser;
  customerId: string;
  productId: string;
  service: JobCardService;
  repository: PostgresJobCardRepository;
  published: unknown[];
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `r3a_invalidated_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
    });

    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone)
       VALUES ('R3A Organization', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const otherOrganizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone)
       VALUES ('R3A Other Organization', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;

    async function insertUser(
      organization: string,
      name: string,
      role: SafeUser['role'],
      isActive = true,
    ) {
      const row = (await pool!.query<{
        id: string; organization_id: string; name: string; email: string;
        role: SafeUser['role']; is_active: boolean; version: number;
      }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
         VALUES ($1, $2, $3, 'r3a-test-hash', $4, $5)
         RETURNING id, organization_id, name, email, role, is_active, version`,
        [organization, name, `${randomUUID()}@r3a.test`, role, isActive],
      )).rows[0]!;
      if (role === 'STAFF') {
        await pool!.query(
          `INSERT INTO staff_profiles (organization_id, user_id, title)
           VALUES ($1, $2, 'Field Staff')`,
          [organization, row.id],
        );
      }
      return row;
    }

    const adminRow = await insertUser(organizationId, 'R3A Admin', 'ADMIN');
    const managerRow = await insertUser(organizationId, 'R3A Manager', 'MANAGER');
    const staffRow = await insertUser(organizationId, 'R3A Staff', 'STAFF');
    const otherAdminRow = await insertUser(otherOrganizationId, 'Other Admin', 'ADMIN');
    const customerId = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, 'R3A Klinik', 'clinic', 'active') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
    const productId = (await pool.query<{ id: string }>(
      `INSERT INTO products (organization_id, sku, name, unit)
       VALUES ($1, 'R3A-001', 'R3A Ürün', 'adet') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;

    const published: unknown[] = [];
    const repository = new PostgresJobCardRepository(pool);
    const service = new JobCardService(
      repository,
      () => new Date(now),
      { publish: (event) => published.push(event) },
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    );
    await run({
      pool,
      organizationId,
      otherOrganizationId,
      admin: { id: adminRow.id, organizationId, role: 'ADMIN' },
      manager: { id: managerRow.id, organizationId, role: 'MANAGER' },
      staff: { id: staffRow.id, organizationId, role: 'STAFF' },
      otherOrgAdmin: { id: otherAdminRow.id, organizationId: otherOrganizationId, role: 'ADMIN' },
      safeAdmin: {
        id: adminRow.id,
        organizationId,
        name: adminRow.name,
        email: adminRow.email,
        role: adminRow.role,
        mustChangePassword: false,
        isActive: adminRow.is_active,
        version: adminRow.version,
      },
      customerId,
      productId,
      service,
      repository,
      published,
    });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function insertJob(
  pool: Pool,
  input: {
    organizationId: string;
    assignedTo: string;
    createdBy: string;
    customerId: string | null;
    status: SourceStatus;
    type?: JobCardType;
    title?: string;
    sourceJobCardId?: string | null;
    scheduledAt?: Date | null;
    scheduledEndsAt?: Date | null;
    dueDate?: string | null;
    createdAt?: Date;
  },
) {
  const status = input.status;
  const started = ['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED']
    .includes(status);
  const staffCompleted = ['WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED']
    .includes(status);
  const accepted = status !== 'NEW';
  const approved = status === 'COMPLETED';
  const revised = status === 'REVISION_REQUESTED';
  const cancelled = status === 'CANCELLED';
  const at = new Date('2026-08-24T08:00:00.000Z');
  const result = await pool.query<{ id: string }>(
    `INSERT INTO job_cards (
       organization_id, type, status, title, customer_id, assigned_to, created_by,
       priority, due_date, started_at, staff_completed_at, staff_completed_by,
       staff_completion_note, manager_approved_at, manager_approved_by,
       manager_approval_note, revision_requested_at, revision_requested_by,
       revision_reason, cancelled_at, cancelled_by, cancel_reason,
       accepted_at, accepted_by, scheduled_at, scheduled_ends_at,
       engagement_kind, source_job_card_id, follow_up_instructions, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'normal', $8,
       $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
       $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
     ) RETURNING id`,
    [
      input.organizationId,
      input.type ?? 'GENERAL_TASK',
      status,
      input.title ?? `R3A ${status}`,
      input.customerId,
      input.assignedTo,
      input.createdBy,
      input.dueDate ?? null,
      started ? at : null,
      staffCompleted ? new Date(at.valueOf() + 60_000) : null,
      staffCompleted ? input.assignedTo : null,
      staffCompleted ? 'R3A completion' : null,
      approved ? new Date(at.valueOf() + 120_000) : null,
      approved ? input.createdBy : null,
      approved ? 'R3A approval' : null,
      revised ? new Date(at.valueOf() + 120_000) : null,
      revised ? input.createdBy : null,
      revised ? 'R3A revision' : null,
      cancelled ? new Date(at.valueOf() + 120_000) : null,
      cancelled ? input.createdBy : null,
      cancelled ? 'R3A cancellation' : null,
      accepted ? at : null,
      accepted ? input.assignedTo : null,
      input.scheduledAt ?? null,
      input.scheduledEndsAt ?? null,
      input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null,
      input.sourceJobCardId ?? null,
      input.sourceJobCardId === null || input.sourceJobCardId === undefined
        ? null : 'R3A follow-up history',
      input.createdAt ?? at,
      input.createdAt ?? at,
    ],
  );
  return result.rows[0]!.id;
}

async function insertLegacyNote(pool: Pool, organizationId: string, jobCardId: string, authorId: string) {
  await pool.query(
    `INSERT INTO job_card_notes
       (organization_id, job_card_id, author_id, note, record_version)
     VALUES ($1, $2, $3, 'Preserved historical note', 0)`,
    [organizationId, jobCardId, authorId],
  );
}

async function insertDelivery(pool: Pool, organizationId: string, jobCardId: string, productId: string) {
  await pool.query(
    `INSERT INTO job_card_delivery_items
       (organization_id, job_card_id, product_id, delivery_purpose, delivered_at,
        quantity, unit, product_name_snapshot, product_sku_snapshot)
     VALUES ($1, $2, $3, 'SALE', $4, 2, 'adet', 'R3A Ürün', 'R3A-001')`,
    [organizationId, jobCardId, productId, new Date('2026-08-24T08:30:00.000Z')],
  );
}

async function insertMeeting(pool: Pool, organizationId: string, jobCardId: string) {
  await pool.query(
    `INSERT INTO job_card_meeting_details
       (organization_id, job_card_id, meeting_at, outcome, meeting_summary)
     VALUES ($1, $2, $3, 'POSITIVE', 'Preserved meeting history')`,
    [organizationId, jobCardId, new Date('2026-08-24T08:30:00.000Z')],
  );
}

async function followUpInput(assignedTo: string, clientActionId: string): Promise<FollowUpCreateInput> {
  return {
    clientActionId,
    type: 'GENERAL_TASK',
    title: 'R3A takip işi',
    followUpInstructions: 'R3A takip talimatı',
    scheduledAt: null,
    assignedTo,
    priority: 'normal',
    dueDate: null,
    contactId: null,
    engagementKind: null,
    overrideReason: null,
  };
}

describe.skipIf(!databaseUrl)('R3A JobCard INVALIDATED PostgreSQL acceptance', () => {
  it('invalidates all seven source states with authorization and semantic idempotency', async () => {
    await withFixture(async (fixture) => {
      const sourceIds = await Promise.all(([
        'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
        'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED',
      ] as const).map((status) => insertJob(fixture.pool, {
        organizationId: fixture.organizationId,
        assignedTo: fixture.staff.id,
        createdBy: fixture.manager.id,
        customerId: fixture.customerId,
        status,
      })));

      const results = await Promise.all(sourceIds.map((jobCardId, index) =>
        fixture.service.invalidate(fixture.admin, jobCardId, {
          clientActionId: `r3a-state-${index}`,
          expectedVersion: 1,
          reasonCode: 'DUPLICATE',
          note: null,
        }),
      ));
      expect(results.map((result) => result.status)).toEqual([
        'INVALIDATED', 'INVALIDATED', 'INVALIDATED', 'INVALIDATED',
        'INVALIDATED', 'INVALIDATED', 'INVALIDATED',
      ]);

      const rows = await fixture.pool.query<{
        status: string; version: number; invalidated_at: Date | null;
        invalidated_by: string | null; invalidation_reason_code: string | null;
      }>(
        `SELECT status, version, invalidated_at, invalidated_by, invalidation_reason_code
           FROM job_cards WHERE organization_id = $1 ORDER BY created_at, id`,
        [fixture.organizationId],
      );
      expect(rows.rows).toHaveLength(7);
      expect(rows.rows.every((row) => row.status === 'INVALIDATED')).toBe(true);
      expect(rows.rows.every((row) => row.version === 2)).toBe(true);
      expect(rows.rows.every((row) => row.invalidated_at !== null)).toBe(true);
      expect(rows.rows.every((row) => row.invalidated_by === fixture.admin.id)).toBe(true);
      expect(rows.rows.every((row) => row.invalidation_reason_code === 'DUPLICATE')).toBe(true);

      const manager = await fixture.service.invalidate(fixture.manager, sourceIds[0]!, {
        clientActionId: 'r3a-manager-denied', expectedVersion: 2,
        reasonCode: 'DUPLICATE', note: null,
      }).catch((error: unknown) => error);
      expect(manager).toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      const staff = await fixture.service.invalidate(fixture.staff, sourceIds[1]!, {
        clientActionId: 'r3a-staff-denied', expectedVersion: 2,
        reasonCode: 'DUPLICATE', note: null,
      }).catch((error: unknown) => error);
      expect(staff).toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      const crossOrganization = await fixture.service.invalidate(fixture.otherOrgAdmin, sourceIds[0]!, {
        clientActionId: 'r3a-cross-org', expectedVersion: 2,
        reasonCode: 'DUPLICATE', note: null,
      }).catch((error: unknown) => error);
      expect(crossOrganization).toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });

      const replay = await fixture.service.invalidate(fixture.admin, sourceIds[0]!, {
        clientActionId: 'r3a-state-0', expectedVersion: 1,
        reasonCode: 'DUPLICATE', note: null,
      });
      expect(replay).toEqual(results[0]);
      const changedReason = await fixture.service.invalidate(fixture.admin, sourceIds[0]!, {
        clientActionId: 'r3a-state-0', expectedVersion: 1,
        reasonCode: 'WRONG_CUSTOMER', note: null,
      }).catch((error: unknown) => error);
      expect(changedReason).toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      const changedNote = await fixture.service.invalidate(fixture.admin, sourceIds[0]!, {
        clientActionId: 'r3a-state-0', expectedVersion: 1,
        reasonCode: 'DUPLICATE', note: 'Farklı canonical not',
      }).catch((error: unknown) => error);
      expect(changedNote).toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      const alreadyInvalidated = await fixture.service.invalidate(fixture.admin, sourceIds[0]!, {
        clientActionId: 'r3a-new-id', expectedVersion: 2,
        reasonCode: 'DUPLICATE', note: null,
      }).catch((error: unknown) => error);
      expect(alreadyInvalidated).toMatchObject({ code: 'JOB_ALREADY_INVALIDATED', statusCode: 409 });
      const normalMutation = await fixture.service.cancel(fixture.admin, sourceIds[0]!, {
        clientActionId: 'r3a-normal-after-invalidation', expectedVersion: 2,
        cancelReason: 'Normal mutation must be rejected',
      }).catch((error: unknown) => error);
      expect(normalMutation).toMatchObject({ code: 'INVALID_TRANSITION', statusCode: 409 });

      await fixture.pool.query(
        `UPDATE users SET role = 'MANAGER' WHERE organization_id = $1 AND id = $2`,
        [fixture.organizationId, fixture.admin.id],
      );
      const demotedReplay = await fixture.service.invalidate(
        { ...fixture.admin, role: 'MANAGER' },
        sourceIds[0]!,
        {
          clientActionId: 'r3a-state-0', expectedVersion: 1,
          reasonCode: 'DUPLICATE', note: null,
        },
      ).catch((error: unknown) => error);
      expect(demotedReplay).toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });
  });

  it('returns ACTION_IN_PROGRESS for a live invalidation claim and completes only one concurrent invalidation', async () => {
    await withFixture(async (fixture) => {
      const processingJob = await insertJob(fixture.pool, {
        organizationId: fixture.organizationId, assignedTo: fixture.staff.id,
        createdBy: fixture.manager.id, customerId: fixture.customerId, status: 'NEW',
      });
      const processingInput = {
        clientActionId: 'r3a-processing', expectedVersion: 1,
        reasonCode: 'DUPLICATE' as const, note: null,
      };
      await fixture.pool.query(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, request_hash, status)
         VALUES ($1, $2, $3, $4, $5, 'processing')`,
        [
          fixture.organizationId,
          fixture.admin.id,
          processingInput.clientActionId,
          `JOB_INVALIDATE:${processingJob}`,
          jobCardInvalidationRequestHash(processingJob, processingInput),
        ],
      );
      await expect(fixture.service.invalidate(fixture.admin, processingJob, processingInput))
        .rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS', statusCode: 409 });

      const concurrentJob = await insertJob(fixture.pool, {
        organizationId: fixture.organizationId, assignedTo: fixture.staff.id,
        createdBy: fixture.manager.id, customerId: fixture.customerId, status: 'COMPLETED',
      });
      const attempts = await Promise.all([
        fixture.service.invalidate(fixture.admin, concurrentJob, {
          clientActionId: 'r3a-concurrent-a', expectedVersion: 1,
          reasonCode: 'DUPLICATE', note: null,
        }).then(() => ({ ok: true as const })).catch((error: unknown) => ({ ok: false as const, error })),
        fixture.service.invalidate(fixture.admin, concurrentJob, {
          clientActionId: 'r3a-concurrent-b', expectedVersion: 1,
          reasonCode: 'WRONG_CUSTOMER', note: null,
        }).then(() => ({ ok: true as const })).catch((error: unknown) => ({ ok: false as const, error })),
      ]);
      expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
      const failure = attempts.find((attempt) => !attempt.ok);
      expect(failure && !failure.ok ? failure.error : null).toMatchObject({ statusCode: 409 });

      const final = await fixture.pool.query<{
        status: string; version: number; activities: string; audits: string; completed_actions: string;
      }>(
        `SELECT j.status, j.version,
           (SELECT COUNT(*)::text FROM job_card_activity_logs a
             WHERE a.organization_id = j.organization_id AND a.job_card_id = j.id
               AND a.event_type = 'JOB_INVALIDATED') AS activities,
           (SELECT COUNT(*)::text FROM audit_events a
             WHERE a.organization_id = j.organization_id AND a.subject_id = j.id
               AND a.event_type = 'JOB_CARD_INVALIDATED') AS audits,
           (SELECT COUNT(*)::text FROM processed_actions p
             WHERE p.organization_id = j.organization_id
               AND p.operation_key = 'JOB_INVALIDATE:' || j.id
               AND p.status = 'completed') AS completed_actions
         FROM job_cards j WHERE j.organization_id = $1 AND j.id = $2`,
        [fixture.organizationId, concurrentJob],
      );
      expect(final.rows[0]).toMatchObject({
        status: 'INVALIDATED', version: 2, activities: '1', audits: '1', completed_actions: '1',
      });
    });
  });

  it('serializes follow-up child creation and parent invalidation without an active-child race', async () => {
    await withFixture(async (fixture) => {
      const parent = await insertJob(fixture.pool, {
        organizationId: fixture.organizationId, assignedTo: fixture.staff.id,
        createdBy: fixture.manager.id, customerId: fixture.customerId, status: 'COMPLETED',
      });
      const child = await fixture.service.createFollowUp(
        fixture.manager,
        parent,
        await followUpInput(fixture.staff.id, 'r3a-child-block'),
      );
      const blocked = await fixture.service.invalidate(fixture.admin, parent, {
        clientActionId: 'r3a-parent-blocked', expectedVersion: 1,
        reasonCode: 'DUPLICATE', note: null,
      }).catch((error: unknown) => error);
      expect(blocked).toMatchObject({ code: 'JOB_HAS_ACTIVE_FOLLOW_UPS', statusCode: 409 });

      await fixture.service.invalidate(fixture.admin, child.id, {
        clientActionId: 'r3a-child-invalidated', expectedVersion: 1,
        reasonCode: 'CREATED_BY_MISTAKE', note: null,
      });
      await expect(fixture.service.invalidate(fixture.admin, parent, {
        clientActionId: 'r3a-parent-after-child', expectedVersion: 1,
        reasonCode: 'DUPLICATE', note: null,
      })).resolves.toMatchObject({ status: 'INVALIDATED' });

      const followUpReport = await new PostgresReportsRepository(fixture.pool).getSalesFollowUpReport({
        organizationId: fixture.organizationId,
        requestedRange: { from: '2026-08-24', to: '2026-08-24' },
        requestTime: now,
        limit: 50,
        offset: 0,
        proposalLimit: 50,
        proposalOffset: 0,
      });
      expect(followUpReport.current.followUpChildren.total).toBe(0);
      expect(followUpReport.period.followUpChildrenCreated).toBe(0);
      expect(followUpReport.relationships.directFollowUpLinks).toBe(0);

      const concurrentParent = await insertJob(fixture.pool, {
        organizationId: fixture.organizationId, assignedTo: fixture.staff.id,
        createdBy: fixture.manager.id, customerId: fixture.customerId, status: 'COMPLETED',
      });
      const [childResult, invalidationResult] = await Promise.all([
        fixture.service.createFollowUp(
          fixture.manager,
          concurrentParent,
          await followUpInput(fixture.staff.id, 'r3a-concurrent-child'),
        ).then((value) => ({ ok: true, value })).catch((error: unknown) => ({ ok: false, error })),
        fixture.service.invalidate(fixture.admin, concurrentParent, {
          clientActionId: 'r3a-concurrent-invalidation', expectedVersion: 1,
          reasonCode: 'DUPLICATE', note: null,
        }).then((value) => ({ ok: true, value })).catch((error: unknown) => ({ ok: false, error })),
      ]);
      expect(childResult.ok && invalidationResult.ok).toBe(false);
      const final = await fixture.pool.query<{ status: string }>(
        `SELECT status FROM job_cards WHERE organization_id = $1 AND id = $2`,
        [fixture.organizationId, concurrentParent],
      );
      const activeChildren = await fixture.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_cards
          WHERE organization_id = $1 AND source_job_card_id = $2
            AND status IN ('NEW','ACCEPTED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED')`,
        [fixture.organizationId, concurrentParent],
      );
      expect(!(final.rows[0]!.status === 'INVALIDATED' && Number(activeChildren.rows[0]!.count) > 0))
        .toBe(true);
    });
  });

  it('preserves history while excluding invalidated work from reports, calendar, reminders, and messaging writes', async () => {
    await withFixture(async (fixture) => {
      const scheduled = await insertJob(fixture.pool, {
        organizationId: fixture.organizationId, assignedTo: fixture.staff.id,
        createdBy: fixture.manager.id, customerId: fixture.customerId, status: 'NEW',
        type: 'PRODUCT_DELIVERY',
        scheduledAt: new Date('2026-08-24T10:00:00.000Z'),
        scheduledEndsAt: new Date('2026-08-24T10:30:00.000Z'),
        dueDate: '2026-08-23',
      });
      const completedDelivery = await insertJob(fixture.pool, {
        organizationId: fixture.organizationId, assignedTo: fixture.staff.id,
        createdBy: fixture.manager.id, customerId: fixture.customerId, status: 'COMPLETED',
        type: 'PRODUCT_DELIVERY',
      });
      await insertDelivery(fixture.pool, fixture.organizationId, completedDelivery, fixture.productId);
      const completedMeeting = await insertJob(fixture.pool, {
        organizationId: fixture.organizationId, assignedTo: fixture.staff.id,
        createdBy: fixture.manager.id, customerId: fixture.customerId, status: 'COMPLETED',
        type: 'SALES_MEETING',
      });
      await insertMeeting(fixture.pool, fixture.organizationId, completedMeeting);
      await insertDelivery(fixture.pool, fixture.organizationId, scheduled, fixture.productId);
      await insertLegacyNote(fixture.pool, fixture.organizationId, scheduled, fixture.staff.id);
      await fixture.pool.query(
        `INSERT INTO calendar_reminders
           (organization_id, job_card_id, recipient_user_id, remind_at, next_attempt_at, dedupe_key)
         VALUES ($1, $2, $3, $4, $4, $5)`,
        [fixture.organizationId, scheduled, fixture.staff.id, now, `R3A:${scheduled}`],
      );

      const messaging = new MessagingService(fixture.pool, true);
      const conversation = await messaging.createOrGetConversation(fixture.safeAdmin, {
        contextType: 'JOB', jobId: scheduled, participantUserIds: [fixture.staff.id],
      });
      await messaging.sendMessage(fixture.safeAdmin, conversation.id, 'Korunmuş mesaj', 'r3a-message-1');

      const reports = new PostgresReportsRepository(fixture.pool);
      const beforeWorkType = await reports.getWorkTypeDistribution({
        organizationId: fixture.organizationId, from: '2026-08-24', to: '2026-08-24', staffUserId: null,
      });
      const beforeCustomer = await reports.getCustomerReport({
        organizationId: fixture.organizationId,
        requestedRange: { from: '2026-08-24', to: '2026-08-24' },
        requestTime: now, search: null, status: null, customerType: null, limit: 50, offset: 0,
      });
      const beforeStaff = await reports.getStaffExecutionMany({
        organizationId: fixture.organizationId, staffUserIds: [fixture.staff.id],
        requestedRange: { from: '2026-08-24', to: '2026-08-24' }, requestTime: now,
      });
      const beforeDeliveries = await reports.getDeliveryReport({
        organizationId: fixture.organizationId,
        requestedRange: { from: '2026-08-24', to: '2026-08-24' },
        requestTime: now, groupBy: 'purpose', staffUserId: null, limit: 50, offset: 0,
      });
      const beforeMeetings = await reports.getStaffMeetingsByOutcome({
        organizationId: fixture.organizationId, staffUserId: fixture.staff.id,
        requestedRange: { from: '2026-08-24', to: '2026-08-24' }, requestTime: now,
      });
      const calendar = new PostgresCalendarRepository(fixture.pool);
      expect((await calendar.list(fixture.admin, {
        from: new Date('2026-08-24T09:00:00.000Z'), to: new Date('2026-08-24T11:00:00.000Z'),
        assignedTo: null,
      }))).toHaveLength(1);

      const worker = new PostgresCalendarReminderWorkerRepository(fixture.pool);
      const claims = await worker.claimDue(now, randomUUID(), new Date(now.valueOf() + 60_000), 10);
      expect(claims).toHaveLength(1);
      await fixture.service.invalidate(fixture.admin, scheduled, {
        clientActionId: 'r3a-scheduled-invalidation', expectedVersion: 1,
        reasonCode: 'WRONG_CUSTOMER', note: 'Yanlış müşteri kaydı.',
      });
      await fixture.service.invalidate(fixture.admin, completedDelivery, {
        clientActionId: 'r3a-completed-delivery-invalidation', expectedVersion: 1,
        reasonCode: 'CREATED_BY_MISTAKE', note: null,
      });
      await fixture.service.invalidate(fixture.admin, completedMeeting, {
        clientActionId: 'r3a-completed-meeting-invalidation', expectedVersion: 1,
        reasonCode: 'DUPLICATE', note: null,
      });
      expect(await worker.project(claims[0]!, now, false)).toBeNull();

      const currentReminder = await fixture.pool.query<{ state: string }>(
        `SELECT state FROM calendar_reminders WHERE organization_id = $1 AND job_card_id = $2`,
        [fixture.organizationId, scheduled],
      );
      expect(currentReminder.rows[0]!.state).toBe('CANCELLED');
      expect((await calendar.list(fixture.admin, {
        from: new Date('2026-08-24T09:00:00.000Z'), to: new Date('2026-08-24T11:00:00.000Z'),
        assignedTo: null,
      }))).toHaveLength(0);

      const afterWorkType = await reports.getWorkTypeDistribution({
        organizationId: fixture.organizationId, from: '2026-08-24', to: '2026-08-24', staffUserId: null,
      });
      expect(afterWorkType).toEqual([]);
      const afterCustomer = await reports.getCustomerReport({
        organizationId: fixture.organizationId,
        requestedRange: { from: '2026-08-24', to: '2026-08-24' },
        requestTime: now, search: null, status: null, customerType: null, limit: 50, offset: 0,
      });
      const customer = afterCustomer.items.find((item) => item.customer.id === fixture.customerId)!;
      expect(customer.activity.period.created).toBe(beforeCustomer.items
        .find((item) => item.customer.id === fixture.customerId)!.activity.period.created - 3);
      const afterStaff = await reports.getStaffExecutionMany({
        organizationId: fixture.organizationId, staffUserIds: [fixture.staff.id],
        requestedRange: { from: '2026-08-24', to: '2026-08-24' }, requestTime: now,
      });
      expect(afterStaff.get(fixture.staff.id)!.recordedSubmissionCount)
        .toBe(beforeStaff.get(fixture.staff.id)!.recordedSubmissionCount - 2);
      expect(beforeDeliveries.total).toBe(1);
      const afterDeliveries = await reports.getDeliveryReport({
        organizationId: fixture.organizationId,
        requestedRange: { from: '2026-08-24', to: '2026-08-24' },
        requestTime: now, groupBy: 'purpose', staffUserId: null, limit: 50, offset: 0,
      });
      expect(afterDeliveries.total).toBe(0);
      expect(beforeMeetings.some((row) => row.outcome === 'POSITIVE' && row.count === 1)).toBe(true);
      const afterMeetings = await reports.getStaffMeetingsByOutcome({
        organizationId: fixture.organizationId, staffUserId: fixture.staff.id,
        requestedRange: { from: '2026-08-24', to: '2026-08-24' }, requestTime: now,
      });
      expect(afterMeetings.find((row) => row.outcome === 'POSITIVE')?.count).toBe(0);

      const overview = new PostgresOverviewRepository(fixture.pool, reports);
      await expect(overview.getUpcomingWork(fixture.safeAdmin, now)).resolves.toMatchObject({
        items: [],
      });
      const managementOverview = await overview.getManagementOverview(
        fixture.safeAdmin,
        { requestedRange: { from: '2026-08-24', to: '2026-08-24' } },
        now,
      );
      expect(managementOverview.recentNotes).toEqual([]);

      const preserved = await fixture.pool.query<{ notes: string; deliveries: string; messages: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM job_card_notes WHERE organization_id = $1 AND job_card_id = $2) AS notes,
           (SELECT COUNT(*)::text FROM job_card_delivery_items WHERE organization_id = $1 AND job_card_id = $2) AS deliveries,
           (SELECT COUNT(*)::text FROM messages m JOIN conversations c ON c.id = m.conversation_id
             WHERE c.organization_id = $1 AND c.job_id = $2) AS messages`,
        [fixture.organizationId, scheduled],
      );
      expect(preserved.rows[0]).toEqual({ notes: '2', deliveries: '1', messages: '1' });
      await expect(messaging.sendMessage(fixture.safeAdmin, conversation.id, 'Yeni mesaj', 'r3a-message-2'))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(messaging.createOrGetConversation(fixture.safeAdmin, {
        contextType: 'JOB', jobId: scheduled, participantUserIds: [fixture.staff.id],
      })).rejects.toMatchObject({ code: 'JOB_NOT_OPERATIONAL', statusCode: 409 });
      await expect(messaging.getJobConversation(fixture.safeAdmin, scheduled)).resolves.toMatchObject({
        id: conversation.id, jobId: scheduled,
      });

      const realtime = await fixture.pool.query<{ event_type: string }>(
        `SELECT event_type FROM realtime_events
          WHERE organization_id = $1 AND entity_id = $2 ORDER BY created_at`,
        [fixture.organizationId, scheduled],
      );
      expect(realtime.rows.map((row) => row.event_type)).toContain('job.invalidated');
      const notification = await fixture.pool.query<{ kind: string; title: string }>(
        `SELECT n.kind, 'safe' AS title FROM in_app_notifications n
          WHERE n.organization_id = $1 AND n.entity_id = $2`,
        [fixture.organizationId, scheduled],
      );
      expect(notification.rows.some((row) => row.kind === 'job.invalidated')).toBe(true);
      expect(JSON.stringify(notification.rows)).not.toContain('Yanlış müşteri');
    });
  });

  it('rolls back every invalidation side effect and preserves legacy critical-action replay', async () => {
    await withFixture(async (fixture) => {
      const jobCardId = await insertJob(fixture.pool, {
        organizationId: fixture.organizationId, assignedTo: fixture.staff.id,
        createdBy: fixture.manager.id, customerId: fixture.customerId, status: 'NEW',
        scheduledAt: new Date('2026-08-24T10:00:00.000Z'),
        scheduledEndsAt: new Date('2026-08-24T10:30:00.000Z'),
      });
      await fixture.pool.query(
        `INSERT INTO calendar_reminders
           (organization_id, job_card_id, recipient_user_id, remind_at, next_attempt_at, dedupe_key)
         VALUES ($1, $2, $3, $4, $4, $5)`,
        [fixture.organizationId, jobCardId, fixture.staff.id, now, `R3A:rollback:${jobCardId}`],
      );
      await fixture.pool.query(`
        CREATE OR REPLACE FUNCTION r3a_fail_invalidated_realtime()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event_type = 'job.invalidated' THEN
            RAISE EXCEPTION 'R3A injected realtime failure';
          END IF;
          RETURN NEW;
        END;
        $$`);
      await fixture.pool.query(`
        CREATE TRIGGER r3a_fail_invalidated_realtime_trigger
        BEFORE INSERT ON realtime_events
        FOR EACH ROW EXECUTE FUNCTION r3a_fail_invalidated_realtime()`);

      await expect(fixture.service.invalidate(fixture.admin, jobCardId, {
        clientActionId: 'r3a-rollback', expectedVersion: 1,
        reasonCode: 'OTHER', note: 'Rollback notu',
      })).rejects.toThrow('R3A injected realtime failure');

      await fixture.pool.query('DROP TRIGGER r3a_fail_invalidated_realtime_trigger ON realtime_events');
      await fixture.pool.query('DROP FUNCTION r3a_fail_invalidated_realtime()');
      const state = await fixture.pool.query<{
        status: string; version: number; invalidated_at: Date | null;
        activities: string; audits: string; reminders: string; realtime: string; receipt: string;
      }>(
        `SELECT j.status, j.version, j.invalidated_at,
           (SELECT COUNT(*)::text FROM job_card_activity_logs a
             WHERE a.organization_id = j.organization_id AND a.job_card_id = j.id
               AND a.event_type = 'JOB_INVALIDATED') AS activities,
           (SELECT COUNT(*)::text FROM audit_events a
             WHERE a.organization_id = j.organization_id AND a.subject_id = j.id
               AND a.event_type = 'JOB_CARD_INVALIDATED') AS audits,
           (SELECT COUNT(*)::text FROM calendar_reminders r
             WHERE r.organization_id = j.organization_id AND r.job_card_id = j.id
               AND r.state = 'PENDING') AS reminders,
           (SELECT COUNT(*)::text FROM realtime_events e
             WHERE e.organization_id = j.organization_id AND e.entity_id = j.id) AS realtime,
           (SELECT COUNT(*)::text FROM processed_actions p
             WHERE p.organization_id = j.organization_id AND p.client_action_id = 'r3a-rollback') AS receipt
         FROM job_cards j WHERE j.organization_id = $1 AND j.id = $2`,
        [fixture.organizationId, jobCardId],
      );
      expect(state.rows[0]).toMatchObject({
        status: 'NEW', version: 1, invalidated_at: null,
        activities: '0', audits: '0', reminders: '1', realtime: '0', receipt: '0',
      });

      const legacyAction = randomUUID();
      await fixture.pool.query(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, status_code,
            status, response_body, completed_at)
         VALUES ($1, $2, $3, 'LEGACY_R3A', 200, 'completed', $4::jsonb, $5)`,
        [fixture.organizationId, fixture.admin.id, legacyAction, JSON.stringify({ legacy: true }), now],
      );
      const replay = await fixture.repository.executeCriticalAction<{ legacy: boolean }>(
        {
          organizationId: fixture.organizationId, userId: fixture.admin.id,
          clientActionId: legacyAction, operationKey: 'LEGACY_R3A',
        },
        async () => { throw new Error('legacy replay must not execute work'); },
      );
      expect(replay).toMatchObject({ kind: 'replay', response: { legacy: true } });
    });
  });
});
