import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, JobCardType } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const fixedNow = new Date('2026-09-10T08:00:00.000Z');

async function createSchemaPool(): Promise<{ pool: Pool; cleanup: () => Promise<void> }> {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const schema = `f1_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema},public` });
  await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
  const cleanup = async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  };
  return { pool, cleanup };
}

type Org = {
  organizationId: string;
  manager: { id: string; organizationId: string; role: 'MANAGER' };
  staff: { id: string; organizationId: string; role: 'STAFF' };
  customerId: string;
  productId: string;
};

async function setupOrg(pool: Pool): Promise<Org> {
  const organizationId = randomUUID();
  await pool.query(
    `INSERT INTO organizations (id, name, timezone) VALUES ($1, $2, $3)`,
    [organizationId, `F1 ${randomUUID()}`, 'Europe/Istanbul'],
  );
  const managerRow = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'F1 Manager', $2, 'test-hash', 'MANAGER') RETURNING id`,
    [organizationId, `${randomUUID()}@f1.test`],
  );
  const staffRow = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'F1 Staff', $2, 'test-hash', 'STAFF') RETURNING id`,
    [organizationId, `${randomUUID()}@f1.test`],
  );
  await pool.query(
    `INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, 'Field')`,
    [organizationId, staffRow.rows[0]!.id],
  );
  const customerRow = await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, 'F1 Clinic', 'clinic', 'active') RETURNING id`,
    [organizationId],
  );
  const productRow = await pool.query<{ id: string }>(
    `INSERT INTO products (organization_id, sku, name, unit)
     VALUES ($1, $2, 'F1 Product', 'adet') RETURNING id`,
    [organizationId, `F1-${randomUUID()}`],
  );
  return {
    organizationId,
    manager: { id: managerRow.rows[0]!.id, organizationId, role: 'MANAGER' },
    staff: { id: staffRow.rows[0]!.id, organizationId, role: 'STAFF' },
    customerId: customerRow.rows[0]!.id,
    productId: productRow.rows[0]!.id,
  };
}

function service(pool: Pool): JobCardService {
  return new JobCardService(new PostgresJobCardRepository(pool), () => fixedNow);
}

async function revisionRows(pool: Pool, organizationId: string, jobId: string) {
  return (
    await pool.query<{
      revision_no: number;
      scheduled_at: Date | null;
      scheduled_ends_at: Date | null;
      due_date: string | null;
      organization_timezone: string;
      source: string;
      created_by: string | null;
    }>(
      `SELECT revision_no, scheduled_at, scheduled_ends_at,
              to_char(due_date, 'YYYY-MM-DD') AS due_date, organization_timezone, source, created_by
         FROM job_card_schedule_revisions
        WHERE organization_id = $1 AND job_card_id = $2
        ORDER BY revision_no ASC`,
      [organizationId, jobId],
    )
  ).rows;
}

async function assignmentRows(pool: Pool, organizationId: string, jobId: string) {
  return (
    await pool.query<{
      from_user_id: string | null;
      to_user_id: string;
      changed_by: string | null;
      source: string;
      activity_id: string | null;
    }>(
      `SELECT from_user_id, to_user_id, changed_by, source, activity_id
         FROM job_card_assignment_history
        WHERE organization_id = $1 AND job_card_id = $2
        ORDER BY changed_at ASC, id ASC`,
      [organizationId, jobId],
    )
  ).rows;
}

async function jobCardVersion(pool: Pool, jobId: string): Promise<number> {
  const row = await pool.query<{ version: number }>(
    `SELECT version FROM job_cards WHERE id = $1`,
    [jobId],
  );
  return row.rows[0]!.version;
}

describe.skipIf(!databaseUrl)('FOUNDATION-1 migration + history on real PostgreSQL', () => {
  let pool: Pool | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const fixture = await createSchemaPool();
    pool = fixture.pool;
    cleanup = fixture.cleanup;
  });

  afterAll(async () => { await cleanup?.(); });

  it('passes on an empty database and leaves zero baseline rows', async () => {
    const emptyCount = await pool!.query(
      `SELECT
        (SELECT COUNT(*)::int FROM job_cards) AS jobs,
        (SELECT COUNT(*)::int FROM job_card_schedule_revisions) AS revisions,
        (SELECT COUNT(*)::int FROM job_card_assignment_history) AS assignments`,
    );
    expect(emptyCount.rows[0]).toEqual({ jobs: 0, revisions: 0, assignments: 0 });
  });

  it('enforces tenant FK, revision uniqueness and interval constraints', async () => {
    const org = await setupOrg(pool!);
    const otherOrgId = randomUUID();
    const jobId = randomUUID();
    const otherJobId = randomUUID();
    await pool!.query(
      `INSERT INTO organizations (id, name, timezone) VALUES ($1, $2, 'Europe/Istanbul')`,
      [otherOrgId, `F1 Other ${randomUUID()}`],
    );
    const otherUser = await pool!.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'F1 Other Admin', $2, 'test-hash', 'ADMIN') RETURNING id`,
      [otherOrgId, `${randomUUID()}@f1.test`],
    );
    await pool!.query(
      `INSERT INTO job_cards
         (organization_id, type, status, title, assigned_to, created_by, id)
       VALUES
         ($1, 'GENERAL_TASK', 'NEW', 'Primary job', $2, $2, $3),
         ($4, 'GENERAL_TASK', 'NEW', 'Other job', $5, $5, $6)`,
      [org.organizationId, org.manager.id, jobId, otherOrgId, otherUser.rows[0]!.id, otherJobId],
    );
    await expect(pool!.query(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, organization_timezone, source)
       VALUES ($1, $2, 1, 'Europe/Istanbul', 'CREATE')`,
      [org.organizationId, otherJobId],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(pool!.query(
      `INSERT INTO job_card_assignment_history
         (organization_id, job_card_id, from_user_id, to_user_id, source, changed_at)
       VALUES ($1, $2, NULL, $3, 'CREATE', NOW())`,
      [org.organizationId, jobId, '00000000-0000-0000-0000-000000000000'],
    )).rejects.toMatchObject({ code: '23503' });
    await pool!.query(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
          organization_timezone, source)
       VALUES ($1, $2, 1, NULL, NULL, 'Europe/Istanbul', 'CREATE')`,
      [org.organizationId, jobId],
    );
    await expect(pool!.query(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
          organization_timezone, source)
       VALUES ($1, $2, 1, NULL, NULL, 'Europe/Istanbul', 'RESCHEDULE')`,
      [org.organizationId, jobId],
    )).rejects.toMatchObject({ code: '23505' });
    await expect(pool!.query(
      `INSERT INTO job_card_assignment_history
         (organization_id, job_card_id, from_user_id, to_user_id, source, changed_at)
       VALUES ($1, $2, $3, $3, 'CREATE', NOW())`,
      [org.organizationId, jobId, org.manager.id],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool!.query(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
          organization_timezone, source)
       VALUES ($1, $2, 2, NULL, NOW(), 'Europe/Istanbul', 'RESCHEDULE')`,
      [org.organizationId, jobId],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool!.query(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
          organization_timezone, source)
       VALUES ($1, $2, 3, NOW(), NOW() - INTERVAL '1 minute', 'Europe/Istanbul', 'RESCHEDULE')`,
      [org.organizationId, jobId],
    )).rejects.toMatchObject({ code: '23514' });
    const accepted = await revisionRows(pool!, org.organizationId, jobId);
    expect(accepted.some((row) => row.revision_no === 1 && row.scheduled_at === null
      && row.scheduled_ends_at === null && row.source === 'CREATE')).toBe(true);
  });
});
describe.skipIf(!databaseUrl)('FOUNDATION-1 create matrix + patch semantics on real PostgreSQL', () => {
  let pool: Pool | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const fixture = await createSchemaPool();
    pool = fixture.pool;
    cleanup = fixture.cleanup;
  });

  afterAll(async () => { await cleanup?.(); });

  async function org(): Promise<Org> { return setupOrg(pool!); }

  it('creates SALES_MEETING / PRODUCT_DELIVERY / GENERAL_TASK / unscheduled GENERAL_TASK with revision #1 + assignment', async () => {
    const o = await org();
    const svc = service(pool!);

    const meeting = await svc.create(o.manager, {
      clientActionId: randomUUID(), type: 'SALES_MEETING',
      title: 'Meetings review', description: null, customerId: o.customerId, contactId: null,
      assignedTo: o.staff.id, priority: 'normal', dueDate: null,
      scheduledAt: '2026-09-11T10:00:00.000Z', engagementKind: 'SALES_MEETING', overrideReason: null,
    });
    const delivery = await svc.createProductDelivery(o.manager, {
      clientActionId: randomUUID(), type: 'PRODUCT_DELIVERY',
      title: 'Delivery', description: null, customerId: o.customerId, contactId: null,
      assignedTo: o.staff.id, priority: 'normal', dueDate: null,
      scheduledAt: '2026-09-13T13:00:00.000Z', scheduledEndsAt: '2026-09-13T13:30:00.000Z',
      overrideReason: null,
      deliveryPurpose: 'SALE', deliveryNote: null,
      items: [{ productId: o.productId, quantity: 1 }],
    });
    const task = await svc.create(o.manager, {
      clientActionId: randomUUID(), type: 'GENERAL_TASK',
      title: 'Task', description: null, customerId: null, contactId: null,
      assignedTo: o.staff.id, priority: 'normal', dueDate: '2026-09-20',
      scheduledAt: '2026-09-12T09:00:00.000Z', engagementKind: null,
    });
    const unscheduled = await svc.create(o.manager, {
      clientActionId: randomUUID(), type: 'GENERAL_TASK',
      title: 'Unscheduled task', description: null, customerId: null, contactId: null,
      assignedTo: o.staff.id, priority: 'normal', dueDate: null,
      scheduledAt: null, engagementKind: null,
    });

    for (const [jobId, source] of [
      [meeting.id, 'CREATE'] as const,
      [delivery.jobCardId, 'CREATE'] as const,
      [task.id, 'CREATE'] as const,
      [unscheduled.id, 'CREATE'] as const,
    ]) {
      const revs = await revisionRows(pool!, o.organizationId, jobId);
      expect(revs).toHaveLength(1);
      expect(revs[0]).toMatchObject({
        revision_no: 1, source, organization_timezone: 'Europe/Istanbul', created_by: o.manager.id,
      });
      const assigns = await assignmentRows(pool!, o.organizationId, jobId);
      expect(assigns).toHaveLength(1);
      expect(assigns[0]).toMatchObject({
        from_user_id: null, to_user_id: o.staff.id, changed_by: o.manager.id, source, activity_id: null,
      });
    }

    const meetingRevs = await revisionRows(pool!, o.organizationId, meeting.id);
    expect(meetingRevs[0]!.scheduled_at).toEqual(new Date('2026-09-11T10:00:00.000Z'));
    expect(meetingRevs[0]!.scheduled_ends_at).toEqual(new Date('2026-09-11T11:00:00.000Z'));
    const deliveryRevs = await revisionRows(pool!, o.organizationId, delivery.jobCardId);
    expect(deliveryRevs[0]!.scheduled_ends_at).toEqual(new Date('2026-09-13T13:30:00.000Z'));
    const taskRevs = await revisionRows(pool!, o.organizationId, task.id);
    expect(taskRevs[0]!.due_date).toBe('2026-09-20');
    const unscheduledRevs = await revisionRows(pool!, o.organizationId, unscheduled.id);
    expect(unscheduledRevs[0]!.scheduled_at).toBeNull();
    expect(unscheduledRevs[0]!.scheduled_ends_at).toBeNull();
    expect(unscheduledRevs[0]!.due_date).toBeNull();
  });
it('creates follow-up child history with FOLLOW_UP_CREATE source', async () => {
    const o = await org();
    const svc = service(pool!);
    const meeting = await svc.create(o.manager, {
      clientActionId: randomUUID(), type: 'SALES_MEETING',
      title: 'Source visit', description: null, customerId: o.customerId, contactId: null,
      assignedTo: o.staff.id, priority: 'normal', dueDate: null,
      scheduledAt: '2026-09-11T10:00:00.000Z', engagementKind: 'CUSTOMER_VISIT', overrideReason: null,
    });
    await pool!.query(
      `UPDATE job_cards
          SET started_at = '2026-09-11T10:00:00.000Z',
              staff_completed_at = '2026-09-11T10:30:00.000Z', staff_completed_by = $2,
              manager_approved_at = '2026-09-11T11:00:00.000Z', manager_approved_by = $1,
              status = 'COMPLETED', version = version + 1
        WHERE id = $3`,
      [o.manager.id, o.staff.id, meeting.id],
    );
    const child = await svc.createFollowUp(o.manager, meeting.id, {
      clientActionId: randomUUID(), type: 'GENERAL_TASK',
      title: 'Takip: source visit', followUpInstructions: 'Takip: source visit',
      scheduledAt: null, assignedTo: o.staff.id, priority: 'normal',
      dueDate: null, contactId: null, engagementKind: null,
    });
    const revs = await revisionRows(pool!, o.organizationId, child.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.source).toBe('FOLLOW_UP_CREATE');
    const assigns = await assignmentRows(pool!, o.organizationId, child.id);
    expect(assigns).toHaveLength(1);
    expect(assigns[0]!.source).toBe('FOLLOW_UP_CREATE');
    expect(assigns[0]!.to_user_id).toBe(o.staff.id);
  });

  it('reschedule, due-date change, reassign, combined and no-op patches', async () => {
    const o = await org();
    const svc = service(pool!);
    const created = await svc.create(o.manager, {
      clientActionId: randomUUID(), type: 'GENERAL_TASK',
      title: 'Patchable', description: null, customerId: null, contactId: null,
      assignedTo: o.staff.id, priority: 'normal', dueDate: null,
      scheduledAt: '2026-09-12T09:00:00.000Z', engagementKind: null,
    });
    const jobId = created.id;

    await svc.patch(o.manager, jobId, {
      expectedVersion: await jobCardVersion(pool!, jobId),
      scheduledAt: '2026-09-13T09:00:00.000Z',
    });
    let revs = await revisionRows(pool!, o.organizationId, jobId);
    expect(revs).toHaveLength(2);
    expect(revs[1]!.source).toBe('RESCHEDULE');
    expect(revs[1]!.scheduled_at).toEqual(new Date('2026-09-13T09:00:00.000Z'));
    expect(revs[0]!.scheduled_at).toEqual(new Date('2026-09-12T09:00:00.000Z'));
    expect(await assignmentRows(pool!, o.organizationId, jobId)).toHaveLength(1);

    await svc.patch(o.manager, jobId, {
      expectedVersion: await jobCardVersion(pool!, jobId),
      dueDate: '2026-09-25',
    });
    revs = await revisionRows(pool!, o.organizationId, jobId);
    expect(revs).toHaveLength(3);
    expect(revs[2]!.due_date).toBe('2026-09-25');
    expect(await assignmentRows(pool!, o.organizationId, jobId)).toHaveLength(1);

    const otherStaff = await pool!.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'F1 Staff B', $2, 'test-hash', 'STAFF') RETURNING id`,
      [o.organizationId, `${randomUUID()}@f1.test`],
    );
    await pool!.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, 'Field B')`,
      [o.organizationId, otherStaff.rows[0]!.id],
    );
    await svc.patch(o.manager, jobId, {
      expectedVersion: await jobCardVersion(pool!, jobId),
      assignedTo: otherStaff.rows[0]!.id,
    });
    expect(await revisionRows(pool!, o.organizationId, jobId)).toHaveLength(3);
    let assigns = await assignmentRows(pool!, o.organizationId, jobId);
    expect(assigns).toHaveLength(2);
    const reassignment = assigns.find((row) => row.source === 'PATCH_REASSIGN');
    expect(reassignment).toMatchObject({
      from_user_id: o.staff.id, to_user_id: otherStaff.rows[0]!.id,
      changed_by: o.manager.id, source: 'PATCH_REASSIGN',
    });
    expect(reassignment!.activity_id).not.toBeNull();

    await svc.patch(o.manager, jobId, {
      expectedVersion: await jobCardVersion(pool!, jobId),
      scheduledAt: '2026-09-14T09:00:00.000Z',
      assignedTo: o.staff.id,
    });
    expect(await revisionRows(pool!, o.organizationId, jobId)).toHaveLength(4);
    assigns = await assignmentRows(pool!, o.organizationId, jobId);
    expect(assigns).toHaveLength(3);
    expect(assigns).toContainEqual(expect.objectContaining({
      from_user_id: otherStaff.rows[0]!.id,
      to_user_id: o.staff.id,
      source: 'PATCH_REASSIGN',
    }));

    await svc.patch(o.manager, jobId, {
      expectedVersion: await jobCardVersion(pool!, jobId),
      scheduledAt: '2026-09-14T09:00:00.000Z',
      dueDate: '2026-09-25',
      assignedTo: o.staff.id,
    });
    expect(await revisionRows(pool!, o.organizationId, jobId)).toHaveLength(4);
    expect(await assignmentRows(pool!, o.organizationId, jobId)).toHaveLength(3);

    const repository = new PostgresJobCardRepository(pool!);
    const listedRevisions = await repository.listScheduleRevisions(o.organizationId, jobId);
    expect(listedRevisions.map((revision) => revision.revisionNo)).toEqual([1, 2, 3, 4]);
    expect((await repository.getCurrentScheduleRevision(o.organizationId, jobId))?.revisionNo).toBe(4);
    const listedAssignments = await repository.listAssignmentHistory(o.organizationId, jobId);
    expect(listedAssignments).toHaveLength(3);
    expect(listedAssignments.every((assignment) => assignment.jobCardId === jobId)).toBe(true);
  });
it('ACCEPTED->NEW manager change: revision on schedule change, assignment only on assignee change', async () => {
    const o = await org();
    const svc = service(pool!);
    const created = await svc.create(o.manager, {
      clientActionId: randomUUID(), type: 'GENERAL_TASK',
      title: 'Accepted job', description: null, customerId: null, contactId: null,
      assignedTo: o.staff.id, priority: 'normal', dueDate: null,
      scheduledAt: null, engagementKind: null,
    });
    await svc.acceptAssignment(
      { id: o.staff.id, organizationId: o.organizationId, role: 'STAFF' },
      created.id,
      { clientActionId: randomUUID(), expectedVersion: await jobCardVersion(pool!, created.id) },
    );
    await svc.patch(o.manager, created.id, {
      expectedVersion: await jobCardVersion(pool!, created.id),
      scheduledAt: '2026-09-14T10:00:00.000Z',
    });
    const state = await pool!.query<{ status: string; accepted_at: unknown }>(
      `SELECT status, accepted_at FROM job_cards WHERE id = $1`,
      [created.id],
    );
    expect(state.rows[0]!.status).toBe('NEW');
    expect(state.rows[0]!.accepted_at).toBeNull();
    expect(await revisionRows(pool!, o.organizationId, created.id)).toHaveLength(2);
    expect(await assignmentRows(pool!, o.organizationId, created.id)).toHaveLength(1);
  });

  it('create + patch are atomic (history failure rolls back the whole mutation)', async () => {
    const fixture = await createSchemaPool();
    const o = await setupOrg(fixture.pool);
    const svc = service(fixture.pool);
    const created = await svc.create(o.manager, {
      clientActionId: randomUUID(), type: 'GENERAL_TASK',
      title: 'Atomic create', description: null, customerId: null, contactId: null,
      assignedTo: o.staff.id, priority: 'normal', dueDate: null,
      scheduledAt: null, engagementKind: null,
    });
    await fixture.pool.query('DROP TABLE job_card_schedule_revisions CASCADE');
    await expect(svc.create(o.manager, {
      clientActionId: randomUUID(), type: 'GENERAL_TASK',
      title: 'Atomic create must roll back', description: null, customerId: null, contactId: null,
      assignedTo: o.staff.id, priority: 'normal', dueDate: null,
      scheduledAt: null, engagementKind: null,
    })).rejects.toThrow();
    const rolledBackCreate = await fixture.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM job_cards WHERE title = 'Atomic create must roll back'`,
    );
    expect(rolledBackCreate.rows[0]!.count).toBe('0');
    await expect(svc.patch(o.manager, created.id, {
      expectedVersion: await jobCardVersion(fixture.pool, created.id),
      scheduledAt: '2026-09-14T10:00:00.000Z',
      assignedTo: o.staff.id,
    })).rejects.toThrow();
    const assigns = await assignmentRows(fixture.pool, o.organizationId, created.id);
    expect(assigns).toHaveLength(1);
    const job = await fixture.pool.query<{ version: number }>(
      `SELECT version FROM job_cards WHERE id = $1`,
      [created.id],
    );
    expect(job.rows[0]!.version).toBe(1);
    await fixture.cleanup();
  });

  it('concurrent schedule mutations keep revision numbering unique', async () => {
    const o = await org();
    const svc = service(pool!);
    const created = await svc.create(o.manager, {
      clientActionId: randomUUID(), type: 'GENERAL_TASK',
      title: 'Concurrent', description: null, customerId: null, contactId: null,
      assignedTo: o.staff.id, priority: 'normal', dueDate: null,
      scheduledAt: '2026-09-12T09:00:00.000Z', engagementKind: null,
    });
    const version = await jobCardVersion(pool!, created.id);
    const results = await Promise.allSettled([
      svc.patch(o.manager, created.id, {
        expectedVersion: version, scheduledAt: '2026-09-15T09:00:00.000Z',
      }),
      svc.patch(o.manager, created.id, {
        expectedVersion: version, scheduledAt: '2026-09-16T09:00:00.000Z',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const revs = await revisionRows(pool!, o.organizationId, created.id);
    expect(revs).toHaveLength(2);
    expect(revs[1]!.revision_no).toBe(2);
  });
});
