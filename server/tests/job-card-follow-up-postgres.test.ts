import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  FollowUpCreateInput,
  JobCardActor,
  JobCardStatus,
  JobCardType,
} from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

type Fixture = {
  pool: Pool;
  service: JobCardService;
  published: RealtimeEventRecord[];
  organizationId: string;
  otherOrganizationId: string;
  admin: JobCardActor;
  manager: JobCardActor;
  staffA: JobCardActor;
  staffB: JobCardActor;
  inactiveStaffId: string;
  otherStaffId: string;
  customerId: string;
  inactiveCustomerId: string;
  otherCustomerId: string;
  contactId: string;
  inactiveContactId: string;
  otherCustomerContactId: string;
  createSource(input?: {
    type?: JobCardType;
    status?: JobCardStatus;
    customerId?: string | null;
    contactId?: string | null;
    assignedTo?: string;
    sourceJobCardId?: string | null;
    title?: string;
  }): Promise<string>;
};

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: JobCardActor['role'],
  name: string,
  isActive = true,
) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, $5) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role, isActive],
  )).rows[0]!.id;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `follow_up_f1_${randomUUID().replaceAll('-', '')}`;
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

    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Follow-up F1') RETURNING id`,
    )).rows[0]!.id;
    const otherOrganizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Other organization') RETURNING id`,
    )).rows[0]!.id;
    const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Admin');
    const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
    const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
    const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
    const inactiveStaffId = await insertUser(
      pool,
      organizationId,
      'STAFF',
      'Inactive Staff',
      false,
    );
    const otherStaffId = await insertUser(pool, otherOrganizationId, 'STAFF', 'Other Staff');

    const customerId = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, 'Dünya Klinik', 'clinic', 'active') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
    const inactiveCustomerId = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, 'Pasif Klinik', 'clinic', 'inactive') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
    const otherCustomerId = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, 'Diğer Klinik', 'clinic', 'active') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
    const contactId = (await pool.query<{ id: string }>(
      `INSERT INTO contacts (organization_id, customer_id, name, title)
       VALUES ($1, $2, 'Dr. Deniz', 'Hekim') RETURNING id`,
      [organizationId, customerId],
    )).rows[0]!.id;
    const inactiveContactId = (await pool.query<{ id: string }>(
      `INSERT INTO contacts (organization_id, customer_id, name, is_active)
       VALUES ($1, $2, 'Pasif İlgili', FALSE) RETURNING id`,
      [organizationId, customerId],
    )).rows[0]!.id;
    const otherCustomerContactId = (await pool.query<{ id: string }>(
      `INSERT INTO contacts (organization_id, customer_id, name)
       VALUES ($1, $2, 'Başka Müşteri İlgilisi') RETURNING id`,
      [organizationId, otherCustomerId],
    )).rows[0]!.id;

    const published: RealtimeEventRecord[] = [];
    const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
    const service = new JobCardService(
      new PostgresJobCardRepository(pool),
      () => new Date('2026-08-01T10:00:00.000Z'),
      publisher,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    );
    const admin = { id: adminId, organizationId, role: 'ADMIN' as const };
    const manager = { id: managerId, organizationId, role: 'MANAGER' as const };
    const staffA = { id: staffAId, organizationId, role: 'STAFF' as const };
    const staffB = { id: staffBId, organizationId, role: 'STAFF' as const };

    const createSource: Fixture['createSource'] = async (input = {}) => {
      const type = input.type ?? 'GENERAL_TASK';
      const status = input.status ?? 'COMPLETED';
      const assignedTo = input.assignedTo ?? staffAId;
      const completed = status === 'COMPLETED';
      const sourceJobCardId = input.sourceJobCardId ?? null;
      const result = await pool!.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, customer_id, contact_id,
           assigned_to, created_by, engagement_kind,
           started_at, staff_completed_at, staff_completed_by,
           manager_approved_at, manager_approved_by,
           source_job_card_id, follow_up_instructions
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15, $16
         ) RETURNING id`,
        [
          organizationId,
          type,
          status,
          input.title ?? `Source ${randomUUID()}`,
          input.customerId === undefined ? customerId : input.customerId,
          input.contactId === undefined ? contactId : input.contactId,
          assignedTo,
          managerId,
          type === 'SALES_MEETING' ? 'SALES_MEETING' : null,
          status === 'NEW' ? null : new Date('2026-07-30T08:00:00.000Z'),
          completed ? new Date('2026-07-30T09:00:00.000Z') : null,
          completed ? assignedTo : null,
          completed ? new Date('2026-07-30T10:00:00.000Z') : null,
          completed ? managerId : null,
          sourceJobCardId,
          sourceJobCardId === null ? null : `Depth link ${randomUUID()}`,
        ],
      );
      if (type === 'SALES_MEETING') {
        await pool!.query(
          `INSERT INTO job_card_meeting_details
             (organization_id, job_card_id, meeting_at, outcome, meeting_summary)
           VALUES ($1, $2, $3, 'FOLLOW_UP_REQUIRED', 'Private source summary')`,
          [organizationId, result.rows[0]!.id, new Date('2026-07-30T08:30:00.000Z')],
        );
      }
      return result.rows[0]!.id;
    };

    await run({
      pool,
      service,
      published,
      organizationId,
      otherOrganizationId,
      admin,
      manager,
      staffA,
      staffB,
      inactiveStaffId,
      otherStaffId,
      customerId,
      inactiveCustomerId,
      otherCustomerId,
      contactId,
      inactiveContactId,
      otherCustomerContactId,
      createSource,
    });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function input(
  assignedTo: string,
  overrides: Partial<FollowUpCreateInput> = {},
): FollowUpCreateInput {
  return {
    clientActionId: randomUUID(),
    type: 'GENERAL_TASK',
    title: 'Takip görevi',
    followUpInstructions: 'Klinikle karar durumunu teyit edin.',
    scheduledAt: null,
    assignedTo,
    priority: 'normal',
    dueDate: null,
    contactId: null,
    engagementKind: null,
    ...overrides,
  };
}

const appError = (code: string, statusCode: number) => expect.objectContaining({ code, statusCode });

describe.skipIf(!databaseUrl)('linked follow-up F1 PostgreSQL contract', () => {
  it('creates siblings, presents one safe DTO, lists children for management, and replays once', async () => {
    await withFixture(async (fixture) => {
      const sourceId = await fixture.createSource({ type: 'SALES_MEETING' });
      const firstInput = input(fixture.staffA.id, {
        clientActionId: randomUUID(),
        contactId: fixture.contactId,
      });
      const first = await fixture.service.createFollowUp(fixture.admin, sourceId, firstInput);
      const second = await fixture.service.createFollowUp(
        fixture.manager,
        sourceId,
        input(fixture.staffB.id, { contactId: fixture.contactId }),
      );

      const rootDetail = await fixture.service.detail(fixture.admin, sourceId);
      expect(rootDetail.followUpContext).toBeNull();
      expect(rootDetail).not.toHaveProperty('sourceJobCardId');
      expect(rootDetail).not.toHaveProperty('followUpInstructions');
      expect(first).not.toHaveProperty('sourceJobCardId');
      expect(first).not.toHaveProperty('followUpInstructions');
      expect(first.followUpContext).toMatchObject({
        sourceJobCardId: sourceId,
        followUpInstructions: firstInput.followUpInstructions,
        sourceAccess: 'FULL',
        sourceJobPath: `/jobs/${sourceId}`,
        sourceSummary: {
          sourceType: 'SALES_MEETING',
          sourcePlannedAt: null,
          sourceOccurredAt: '2026-07-30T08:30:00.000Z',
          sourceCompletedAt: '2026-07-30T10:00:00.000Z',
          outcome: 'FOLLOW_UP_REQUIRED',
        },
      });
      expect(JSON.stringify(first.followUpContext)).not.toContain('Private source summary');
      expect(Object.keys(first.followUpContext!.sourceSummary).sort()).toEqual([
        'contact',
        'customer',
        'outcome',
        'sourceCompletedAt',
        'sourceOccurredAt',
        'sourcePlannedAt',
        'sourceType',
      ]);
      expect((await fixture.service.detail(fixture.staffA, first.id)).followUpContext)
        .toMatchObject({ sourceAccess: 'FULL', sourceJobPath: `/jobs/${sourceId}` });
      expect((await fixture.service.detail(fixture.staffB, second.id)).followUpContext)
        .toMatchObject({ sourceAccess: 'RESTRICTED', sourceJobPath: null });

      const children = await fixture.service.listFollowUps(
        fixture.manager,
        sourceId,
        { limit: 20, offset: 0 },
      );
      expect(children.total).toBe(2);
      expect(children.items.map((item) => item.followUp)).toEqual([
        { sourceJobCardId: sourceId },
        { sourceJobCardId: sourceId },
      ]);
      await expect(fixture.service.listFollowUps(
        fixture.staffA,
        sourceId,
        { limit: 20, offset: 0 },
      )).rejects.toMatchObject(appError('FORBIDDEN', 403));

      const beforeReplayPublishCount = fixture.published.length;
      const replay = await fixture.service.createFollowUp(fixture.admin, sourceId, firstInput);
      expect(replay.id).toBe(first.id);
      expect(fixture.published).toHaveLength(beforeReplayPublishCount);

      const mutation = await fixture.pool.query<{
        response_body: Record<string, unknown>;
      }>(
        `SELECT response_body FROM processed_actions
          WHERE user_id = $1 AND client_action_id = $2
            AND operation_key = $3 AND status = 'completed'`,
        [fixture.admin.id, firstInput.clientActionId, `JOB_FOLLOW_UP_CREATE:${sourceId}`],
      );
      expect(mutation.rows[0]!.response_body).toEqual({ jobCardId: first.id });
      expect(JSON.stringify(mutation.rows[0]!.response_body)).not.toContain('followUpInstructions');

      const activity = await fixture.pool.query<{
        metadata: Record<string, unknown>;
        new_value: Record<string, unknown>;
      }>(
        `SELECT metadata, new_value FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_CREATED'`,
        [first.id],
      );
      expect(activity.rows).toHaveLength(1);
      expect(activity.rows[0]!.metadata).toEqual({ sourceJobCardId: sourceId });
      expect(activity.rows[0]!.new_value).not.toHaveProperty('sourceJobCardId');
      expect(JSON.stringify(activity.rows[0])).not.toContain(firstInput.followUpInstructions);

      const events = await fixture.pool.query<{ resource_keys: string[] }>(
        `SELECT resource_keys FROM realtime_events WHERE entity_id = $1`,
        [first.id],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]!.resource_keys).toEqual(expect.arrayContaining([
        `job-detail:${sourceId}`,
        `customer-detail:${fixture.customerId}`,
      ]));
      const notifications = await fixture.pool.query(
        `SELECT kind, entity_id FROM in_app_notifications WHERE entity_id = $1`,
        [first.id],
      );
      expect(notifications.rows).toEqual([
        expect.objectContaining({ kind: 'job.assigned', entity_id: first.id }),
      ]);
    });
  });

  it('enforces the customerless matrix and creates every supported type', async () => {
    await withFixture(async (fixture) => {
      const customerless = await fixture.createSource({ customerId: null, contactId: null });
      const general = await fixture.service.createFollowUp(
        fixture.admin,
        customerless,
        input(fixture.staffA.id),
      );
      expect(general.customerId).toBeNull();
      expect(general).toMatchObject({ scheduledAt: null, scheduledEndsAt: null });
      const event = fixture.published.find((candidate) => candidate.entityId === general.id)!;
      expect(event.resourceKeys).toContain(`job-detail:${customerless}`);
      expect(event.resourceKeys.some((key) => key.startsWith('customer-detail:'))).toBe(false);

      for (const type of ['PRODUCT_DELIVERY', 'SALES_MEETING'] as const) {
        await expect(fixture.service.createFollowUp(
          fixture.admin,
          customerless,
          input(fixture.staffA.id, {
            type,
            scheduledAt: '2026-08-03T09:00:00.000Z',
            engagementKind: type === 'SALES_MEETING' ? 'FOLLOW_UP' : null,
          }),
        )).rejects.toMatchObject(appError('FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED', 409));
      }

      const customerSource = await fixture.createSource();
      const delivery = await fixture.service.createFollowUp(
        fixture.manager,
        customerSource,
        input(fixture.staffB.id, {
          type: 'PRODUCT_DELIVERY',
          scheduledAt: '2026-08-03T09:00:00.000Z',
        }),
      );
      const meeting = await fixture.service.createFollowUp(
        fixture.manager,
        customerSource,
        input(fixture.staffB.id, {
          type: 'SALES_MEETING',
          scheduledAt: '2026-08-04T09:00:00.000Z',
          engagementKind: 'FOLLOW_UP',
        }),
      );
      expect(delivery).toMatchObject({ type: 'PRODUCT_DELIVERY', customerId: fixture.customerId });
      expect(delivery.scheduledEndsAt).toBe('2026-08-03T09:30:00.000Z');
      expect(meeting).toMatchObject({
        type: 'SALES_MEETING',
        customerId: fixture.customerId,
        engagementKind: 'FOLLOW_UP',
      });
      expect(meeting.scheduledEndsAt).toBe('2026-08-04T10:00:00.000Z');
      expect((await fixture.pool.query(
        `SELECT 1 FROM job_card_meeting_details WHERE job_card_id = $1`,
        [meeting.id],
      )).rows).toHaveLength(1);
    });
  });

  it('D2-5/6/8: gates future acceptance at exact scheduledAt and preserves null schedules', async () => {
    await withFixture(async (fixture) => {
      const source = await fixture.createSource();
      const future = await fixture.service.createFollowUp(
        fixture.admin,
        source,
        input(fixture.staffA.id, { scheduledAt: '2026-08-08T10:00:00.000Z' }),
      );

      await expect(fixture.service.acceptAssignment(fixture.staffA, future.id, {
        clientActionId: randomUUID(),
        expectedVersion: future.version,
      })).rejects.toMatchObject(appError('INVALID_TRANSITION', 409));
      await expect(fixture.service.detail(fixture.staffA, future.id)).resolves.toMatchObject({
        status: 'NEW',
        version: future.version,
        workflowContext: { allowedCommands: ['CANCEL'] },
      });

      const atScheduledTime = new JobCardService(
        new PostgresJobCardRepository(fixture.pool),
        () => new Date('2026-08-08T10:00:00.000Z'),
      );
      await expect(atScheduledTime.acceptAssignment(fixture.staffA, future.id, {
        clientActionId: randomUUID(),
        expectedVersion: future.version,
      })).resolves.toMatchObject({ status: 'ACCEPTED', version: future.version + 1 });

      const unscheduled = await fixture.service.createFollowUp(
        fixture.admin,
        source,
        input(fixture.staffA.id),
      );
      await expect(fixture.service.acceptAssignment(fixture.staffA, unscheduled.id, {
        clientActionId: randomUUID(),
        expectedVersion: unscheduled.version,
      })).resolves.toMatchObject({ status: 'ACCEPTED', version: unscheduled.version + 1 });
    });
  });

  it('D4-FUP-POSTHOC: enforces assignee availability for an interval follow-up', async () => {
    await withFixture(async (fixture) => {
      const source = await fixture.createSource();
      await fixture.pool.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at, scheduled_ends_at, engagement_kind
         ) VALUES ($1, 'SALES_MEETING', 'NEW', 'Çakışan takip', $2, $3, $4, $5, $6, 'SALES_MEETING')`,
        [
          fixture.organizationId,
          fixture.otherCustomerId,
          fixture.staffB.id,
          fixture.manager.id,
          '2026-08-03T09:00:00.000Z',
          '2026-08-03T10:00:00.000Z',
        ],
      );

      await expect(fixture.service.createFollowUp(
        fixture.manager,
        source,
        input(fixture.staffB.id, {
          type: 'SALES_MEETING',
          scheduledAt: '2026-08-03T09:00:00.000Z',
          engagementKind: 'FOLLOW_UP',
        }),
      )).rejects.toMatchObject(appError('CALENDAR_CONFLICT', 409));
    });
  });

  it('re-presents lifecycle replays with current follow-up authorization', async () => {
    await withFixture(async (fixture) => {
      const source = await fixture.createSource({ assignedTo: fixture.staffA.id });
      const followUp = await fixture.service.createFollowUp(
        fixture.admin,
        source,
        input(fixture.staffB.id),
      );
      const command = { clientActionId: randomUUID(), expectedVersion: followUp.version };
      const accepted = await fixture.service.acceptAssignment(
        fixture.staffB,
        followUp.id,
        command,
      );
      expect(accepted.followUpContext).toMatchObject({
        sourceAccess: 'RESTRICTED',
        sourceJobPath: null,
      });
      const sideEffectsBeforeReplay = await fixture.pool.query<{
        activities: number;
        notifications: number;
        realtime_events: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM job_card_activity_logs WHERE job_card_id = $1) AS activities,
           (SELECT COUNT(*)::int FROM in_app_notifications WHERE entity_id = $1) AS notifications,
           (SELECT COUNT(*)::int FROM realtime_events WHERE entity_id = $1) AS realtime_events`,
        [followUp.id],
      );

      await fixture.pool.query(`UPDATE users SET role = 'MANAGER' WHERE id = $1`, [
        fixture.staffB.id,
      ]);
      const promoted = await fixture.service.acceptAssignment(
        { ...fixture.staffB, role: 'MANAGER' },
        followUp.id,
        command,
      );
      expect(promoted.followUpContext).toMatchObject({
        sourceAccess: 'FULL',
        sourceJobPath: `/jobs/${source}`,
      });
      expect((await fixture.pool.query(
        `SELECT response_body FROM processed_actions
          WHERE user_id = $1 AND client_action_id = $2
            AND operation_key = $3`,
        [fixture.staffB.id, command.clientActionId, `JOB_ACCEPT_ASSIGNMENT:${followUp.id}`],
      )).rows[0]!.response_body).toEqual({
        jobCardId: followUp.id,
        evaluatedAt: expect.any(String),
      });
      expect((await fixture.pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM job_card_activity_logs WHERE job_card_id = $1) AS activities,
           (SELECT COUNT(*)::int FROM in_app_notifications WHERE entity_id = $1) AS notifications,
           (SELECT COUNT(*)::int FROM realtime_events WHERE entity_id = $1) AS realtime_events`,
        [followUp.id],
      )).rows).toEqual(sideEffectsBeforeReplay.rows);
    });

    await withFixture(async (fixture) => {
      const source = await fixture.createSource({ assignedTo: fixture.staffA.id });
      const followUp = await fixture.service.createFollowUp(
        fixture.admin,
        source,
        input(fixture.staffB.id),
      );
      const command = { clientActionId: randomUUID(), expectedVersion: followUp.version };
      const accepted = await fixture.service.acceptAssignment(
        fixture.staffB,
        followUp.id,
        command,
      );
      await fixture.service.patch(fixture.manager, followUp.id, {
        expectedVersion: accepted.version,
        assignedTo: fixture.staffA.id,
      });
      const sideEffectsBeforeReplay = await fixture.pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM job_card_activity_logs WHERE job_card_id = $1) AS activities,
           (SELECT COUNT(*)::int FROM in_app_notifications WHERE entity_id = $1) AS notifications,
           (SELECT COUNT(*)::int FROM realtime_events WHERE entity_id = $1) AS realtime_events`,
        [followUp.id],
      );

      await expect(fixture.service.acceptAssignment(
        fixture.staffB,
        followUp.id,
        command,
      )).rejects.toMatchObject(appError('JOB_CARD_NOT_FOUND', 404));
      expect((await fixture.pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM job_card_activity_logs WHERE job_card_id = $1) AS activities,
           (SELECT COUNT(*)::int FROM in_app_notifications WHERE entity_id = $1) AS notifications,
           (SELECT COUNT(*)::int FROM realtime_events WHERE entity_id = $1) AS realtime_events`,
        [followUp.id],
      )).rows).toEqual(sideEffectsBeforeReplay.rows);
    });
  });

  it('returns the canonical actor, source, assignee, customer, and contact errors', async () => {
    await withFixture(async (fixture) => {
      const source = await fixture.createSource();
      await expect(fixture.service.createFollowUp(
        fixture.staffA,
        source,
        input(fixture.staffA.id),
      )).rejects.toMatchObject(appError('FORBIDDEN', 403));
      await expect(fixture.service.createFollowUp(
        fixture.admin,
        randomUUID(),
        input(fixture.staffA.id),
      )).rejects.toMatchObject(appError('JOB_CARD_NOT_FOUND', 404));
      const crossOrgSource = (await fixture.pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'NEW', 'Other source', $2, $2) RETURNING id`,
        [fixture.otherOrganizationId, fixture.otherStaffId],
      )).rows[0]!.id;
      await expect(fixture.service.createFollowUp(
        fixture.admin,
        crossOrgSource,
        input(fixture.staffA.id),
      )).rejects.toMatchObject(appError('JOB_CARD_NOT_FOUND', 404));

      const unfinished = await fixture.createSource({ status: 'IN_PROGRESS' });
      await expect(fixture.service.createFollowUp(
        fixture.manager,
        unfinished,
        input(fixture.staffA.id),
      )).rejects.toMatchObject(appError('FOLLOW_UP_SOURCE_NOT_COMPLETED', 409));
      const cancelled = (await fixture.pool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           cancelled_at, cancelled_by, cancel_reason
         ) VALUES (
           $1, 'GENERAL_TASK', 'CANCELLED', 'Cancelled source', $2, $3,
           NOW(), $3, 'İş iptal edildi.'
         ) RETURNING id`,
        [fixture.organizationId, fixture.staffA.id, fixture.manager.id],
      )).rows[0]!.id;
      await expect(fixture.service.createFollowUp(
        fixture.manager,
        cancelled,
        input(fixture.staffA.id),
      )).rejects.toMatchObject(appError('FOLLOW_UP_SOURCE_NOT_COMPLETED', 409));
      await expect(fixture.service.createFollowUp(
        fixture.manager,
        source,
        input(randomUUID()),
      )).rejects.toMatchObject(appError('ASSIGNEE_NOT_FOUND', 404));
      await expect(fixture.service.createFollowUp(
        fixture.manager,
        source,
        input(fixture.otherStaffId),
      )).rejects.toMatchObject(appError('ASSIGNEE_NOT_FOUND', 404));
      await expect(fixture.service.createFollowUp(
        fixture.manager,
        source,
        input(fixture.inactiveStaffId),
      )).rejects.toMatchObject(appError('FORBIDDEN', 403));
      await expect(fixture.service.createFollowUp(
        fixture.admin,
        source,
        input(fixture.manager.id),
      )).rejects.toMatchObject(appError('FORBIDDEN', 403));

      await expect(fixture.service.createFollowUp(
        fixture.admin,
        source,
        input(fixture.staffA.id, { contactId: randomUUID() }),
      )).rejects.toMatchObject(appError('CONTACT_NOT_FOUND', 404));
      await expect(fixture.service.createFollowUp(
        fixture.admin,
        source,
        input(fixture.staffA.id, { contactId: fixture.inactiveContactId }),
      )).rejects.toMatchObject(appError('CONTACT_INACTIVE', 409));
      await expect(fixture.service.createFollowUp(
        fixture.admin,
        source,
        input(fixture.staffA.id, { contactId: fixture.otherCustomerContactId }),
      )).rejects.toMatchObject(appError('CONTACT_NOT_IN_CUSTOMER', 409));

      const inactiveCustomerSource = await fixture.createSource({
        customerId: fixture.inactiveCustomerId,
        contactId: null,
      });
      await expect(fixture.service.createFollowUp(
        fixture.admin,
        inactiveCustomerSource,
        input(fixture.staffA.id),
      )).rejects.toMatchObject(appError('CUSTOMER_INACTIVE', 409));
      await expect(fixture.service.createFollowUp(
        fixture.admin,
        inactiveCustomerSource,
        input(randomUUID()),
      )).rejects.toMatchObject(appError('CUSTOMER_INACTIVE', 409));
      const customerless = await fixture.createSource({ customerId: null, contactId: null });
      await expect(fixture.service.createFollowUp(
        fixture.admin,
        customerless,
        input(fixture.staffA.id, { contactId: fixture.contactId }),
      )).rejects.toMatchObject(appError('FOLLOW_UP_CONTACT_REQUIRES_CUSTOMER', 409));
    });
  });

  it('enforces depth, immutable relationships, current replay access, and rollback', async () => {
    await withFixture(async (fixture) => {
      const root = await fixture.createSource({ contactId: null });
      let depthNine = root;
      let depthTen = root;
      for (let depth = 1; depth <= 10; depth += 1) {
        depthTen = await fixture.createSource({
          sourceJobCardId: depthTen,
          contactId: null,
          title: `Depth ${depth}`,
        });
        if (depth === 9) depthNine = depthTen;
      }
      await expect(fixture.service.createFollowUp(
        fixture.admin,
        depthTen,
        input(fixture.staffA.id),
      )).rejects.toMatchObject(appError('FOLLOW_UP_MAX_DEPTH_REACHED', 409));
      const depthTenChild = await fixture.service.createFollowUp(
        fixture.admin,
        depthNine,
        input(fixture.staffA.id),
      );
      expect(depthTenChild).not.toHaveProperty('sourceJobCardId');
      expect(depthTenChild.followUpContext).toMatchObject({ sourceJobCardId: depthNine });

      const replayInput = input(fixture.staffB.id, { clientActionId: randomUUID() });
      const created = await fixture.service.createFollowUp(fixture.manager, root, replayInput);
      await fixture.pool.query(`UPDATE users SET role = 'STAFF' WHERE id = $1`, [fixture.manager.id]);
      await fixture.pool.query(`UPDATE job_cards SET assigned_to = $2 WHERE id = $1`, [
        created.id,
        fixture.manager.id,
      ]);
      const demotedManager = { ...fixture.manager, role: 'STAFF' as const };
      expect((await fixture.service.createFollowUp(
        demotedManager,
        root,
        replayInput,
      )).followUpContext).toMatchObject({ sourceAccess: 'RESTRICTED', sourceJobPath: null });
      await fixture.pool.query(`UPDATE job_cards SET assigned_to = $2 WHERE id = $1`, [
        root,
        fixture.manager.id,
      ]);
      expect((await fixture.service.createFollowUp(
        demotedManager,
        root,
        replayInput,
      )).followUpContext).toMatchObject({
        sourceAccess: 'FULL',
        sourceJobPath: `/jobs/${root}`,
      });
      await fixture.pool.query(`UPDATE job_cards SET assigned_to = $2 WHERE id = $1`, [
        created.id,
        fixture.staffB.id,
      ]);
      await expect(fixture.service.createFollowUp(
        demotedManager,
        root,
        replayInput,
      )).rejects.toMatchObject(appError('JOB_CARD_NOT_FOUND', 404));

      await expect(fixture.service.patch(fixture.admin, created.id, {
        expectedVersion: created.version,
        customerId: fixture.otherCustomerId,
      })).rejects.toMatchObject(appError('VALIDATION_ERROR', 400));
      const currentCreated = await fixture.service.detail(fixture.admin, created.id);
      await expect(fixture.service.patch(fixture.admin, created.id, {
        expectedVersion: currentCreated.version,
        followUpInstructions: 'Talimatı değiştirme girişimi',
      } as never)).rejects.toMatchObject(appError('VALIDATION_ERROR', 400));
      const editableRoot = await fixture.createSource({
        status: 'NEW',
        title: 'Editable root',
      });
      await expect(fixture.service.patch(fixture.admin, editableRoot, {
        expectedVersion: 1,
        customerId: fixture.otherCustomerId,
      })).resolves.toMatchObject({ customerId: fixture.otherCustomerId });

      const processingActionId = randomUUID();
      await fixture.pool.query(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, status)
         VALUES ($1, $2, $3, $4, 'processing')`,
        [
          fixture.organizationId,
          fixture.admin.id,
          processingActionId,
          `JOB_FOLLOW_UP_CREATE:${root}`,
        ],
      );
      await expect(fixture.service.createFollowUp(
        fixture.admin,
        root,
        input(fixture.staffA.id, { clientActionId: processingActionId }),
      )).rejects.toMatchObject(appError('ACTION_IN_PROGRESS', 409));

      await fixture.pool.query(`CREATE FUNCTION fail_follow_up_realtime() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced realtime failure'; END $$`);
      await fixture.pool.query(`CREATE TRIGGER fail_follow_up_realtime
        BEFORE INSERT ON realtime_events FOR EACH ROW EXECUTE FUNCTION fail_follow_up_realtime()`);
      const rollbackSource = await fixture.createSource({ title: 'Rollback source' });
      const rollbackInput = input(fixture.staffA.id, {
        clientActionId: randomUUID(),
        title: 'Rollback candidate',
      });
      await expect(fixture.service.createFollowUp(
        fixture.admin,
        rollbackSource,
        rollbackInput,
      )).rejects.toThrow(/forced realtime failure/);
      expect((await fixture.pool.query(
        `SELECT 1 FROM job_cards WHERE title = 'Rollback candidate'`,
      )).rows).toHaveLength(0);
      expect((await fixture.pool.query(
        `SELECT 1 FROM processed_actions WHERE client_action_id = $1`,
        [rollbackInput.clientActionId],
      )).rows).toHaveLength(0);
    });
  });

  it('uses the follow-up-specific invariant diagnostic for corrupt ancestor chains', async () => {
    const expected = {
      code: 'INVARIANT_VIOLATION',
      statusCode: 500,
      message: 'Takip işinin kaynak bağlantısı geçersizdir.',
    };
    await withFixture(async (fixture) => {
      const first = await fixture.createSource({ contactId: null });
      const second = await fixture.createSource({
        sourceJobCardId: first,
        contactId: null,
      });
      await fixture.pool.query(
        `UPDATE job_cards
            SET source_job_card_id = $2, follow_up_instructions = 'Cycle link'
          WHERE id = $1`,
        [first, second],
      );

      await expect(fixture.service.createFollowUp(
        fixture.admin,
        first,
        input(fixture.staffA.id),
      )).rejects.toMatchObject(expected);
    });

    await withFixture(async (fixture) => {
      const source = await fixture.createSource({ contactId: null });
      await fixture.pool.query(
        'ALTER TABLE job_cards DROP CONSTRAINT job_cards_follow_up_source_fk',
      );
      await fixture.pool.query(
        `UPDATE job_cards
            SET source_job_card_id = $2, follow_up_instructions = 'Missing ancestor'
          WHERE id = $1`,
        [source, randomUUID()],
      );

      await expect(fixture.service.createFollowUp(
        fixture.admin,
        source,
        input(fixture.staffA.id),
      )).rejects.toMatchObject(expected);
    });
  });
});
