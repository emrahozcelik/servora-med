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
} from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

type Fixture = {
  pool: Pool;
  service: JobCardService;
  organizationId: string;
  admin: JobCardActor;
  manager: JobCardActor;
  staffA: JobCardActor;
  staffB: JobCardActor;
  contactId: string;
  createSource(): Promise<string>;
};

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: JobCardActor['role'],
  name: string,
) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `follow_up_closure_${randomUUID().replaceAll('-', '')}`;
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
      `INSERT INTO organizations (name) VALUES ('Follow-up Closure') RETURNING id`,
    )).rows[0]!.id;
    const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Admin');
    const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
    const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
    const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
    const customerId = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, 'Dünya Klinik', 'clinic', 'active') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
    const contactId = (await pool.query<{ id: string }>(
      `INSERT INTO contacts (organization_id, customer_id, name, title)
       VALUES ($1, $2, 'Dr. Deniz', 'Hekim') RETURNING id`,
      [organizationId, customerId],
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

    const createSource = async () => (await pool!.query<{ id: string }>(
      `INSERT INTO job_cards (
         organization_id, type, status, title, customer_id, contact_id,
         assigned_to, created_by,
         started_at, staff_completed_at, staff_completed_by,
         manager_approved_at, manager_approved_by
       ) VALUES (
         $1, 'GENERAL_TASK', 'COMPLETED', $2, $3, $4, $5, $6,
         $7, $8, $5, $9, $6
       ) RETURNING id`,
      [
        organizationId,
        `Source ${randomUUID()}`,
        customerId,
        contactId,
        staffAId,
        managerId,
        new Date('2026-07-30T08:00:00.000Z'),
        new Date('2026-07-30T09:00:00.000Z'),
        new Date('2026-07-30T10:00:00.000Z'),
      ],
    )).rows[0]!.id;

    await run({ pool, service, organizationId, admin, manager, staffA, staffB, contactId, createSource });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function input(assignedTo: string): FollowUpCreateInput {
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
    overrideReason: null,
  };
}

const appError = (code: string, statusCode: number) => expect.objectContaining({ code, statusCode });

describe.skipIf(!databaseUrl)('follow-up closure contract (D3)', () => {
  it('source stays COMPLETED and version-stable across child lifecycle transitions', async () => {
    await withFixture(async (fixture) => {
      const sourceId = await fixture.createSource();
      const before = await fixture.service.detail(fixture.admin, sourceId);
      expect(before.status).toBe('COMPLETED');

      const child = await fixture.service.createFollowUp(
        fixture.manager,
        sourceId,
        { ...input(fixture.staffA.id), contactId: fixture.contactId },
      );
      expect(child.status).toBe('NEW');
      const afterCreate = await fixture.service.detail(fixture.admin, sourceId);
      expect(afterCreate.status).toBe('COMPLETED');
      expect(afterCreate.version).toBe(before.version);

      let current = await fixture.service.acceptAssignment(fixture.staffA, child.id, {
        clientActionId: randomUUID(),
        expectedVersion: child.version,
      });
      current = await fixture.service.start(fixture.staffA, child.id, {
        clientActionId: randomUUID(),
        expectedVersion: current.version,
      });
      current = await fixture.service.submitForApproval(fixture.staffA, child.id, {
        clientActionId: randomUUID(),
        expectedVersion: current.version,
        note: 'Takip tamamlandı.',
      });
      current = await fixture.service.approve(fixture.manager, child.id, {
        clientActionId: randomUUID(),
        expectedVersion: current.version,
      });
      expect(current.status).toBe('COMPLETED');

      const afterChildCompleted = await fixture.service.detail(fixture.admin, sourceId);
      expect(afterChildCompleted.status).toBe('COMPLETED');
      expect(afterChildCompleted.version).toBe(before.version);

      const cancelled = await fixture.service.createFollowUp(
        fixture.manager,
        sourceId,
        { ...input(fixture.staffB.id), contactId: fixture.contactId },
      );
      const cancelledChild = await fixture.service.cancel(fixture.manager, cancelled.id, {
        clientActionId: randomUUID(),
        expectedVersion: cancelled.version,
        cancelReason: 'Takip gereksiz hale geldi.',
      });
      expect(cancelledChild.status).toBe('CANCELLED');

      const afterChildCancelled = await fixture.service.detail(fixture.admin, sourceId);
      expect(afterChildCancelled.status).toBe('COMPLETED');
      expect(afterChildCancelled.version).toBe(before.version);
    });
  });

  it('cancelled child is terminal and cannot source follow-ups; completed child can', async () => {
    await withFixture(async (fixture) => {
      const sourceId = await fixture.createSource();

      const toCancel = await fixture.service.createFollowUp(
        fixture.manager,
        sourceId,
        { ...input(fixture.staffA.id), contactId: fixture.contactId },
      );
      const cancelled = await fixture.service.cancel(fixture.manager, toCancel.id, {
        clientActionId: randomUUID(),
        expectedVersion: toCancel.version,
        cancelReason: 'Takip gereksiz hale geldi.',
      });
      expect(cancelled.status).toBe('CANCELLED');

      await expect(fixture.service.cancel(fixture.manager, cancelled.id, {
        clientActionId: randomUUID(),
        expectedVersion: cancelled.version,
        cancelReason: 'Tekrar iptal.',
      })).rejects.toMatchObject(appError('INVALID_TRANSITION', 409));
      await expect(fixture.service.createFollowUp(
        fixture.manager,
        cancelled.id,
        { ...input(fixture.staffB.id), contactId: fixture.contactId },
      )).rejects.toMatchObject(appError('FOLLOW_UP_SOURCE_NOT_COMPLETED', 409));

      const toComplete = await fixture.service.createFollowUp(
        fixture.manager,
        sourceId,
        { ...input(fixture.staffB.id), contactId: fixture.contactId },
      );
      let current = await fixture.service.acceptAssignment(fixture.staffB, toComplete.id, {
        clientActionId: randomUUID(),
        expectedVersion: toComplete.version,
      });
      current = await fixture.service.start(fixture.staffB, current.id, {
        clientActionId: randomUUID(),
        expectedVersion: current.version,
      });
      current = await fixture.service.submitForApproval(fixture.staffB, current.id, {
        clientActionId: randomUUID(),
        expectedVersion: current.version,
        note: 'Takip tamamlandı.',
      });
      current = await fixture.service.approve(fixture.manager, current.id, {
        clientActionId: randomUUID(),
        expectedVersion: current.version,
      });
      expect(current.status).toBe('COMPLETED');

      const grandchild = await fixture.service.createFollowUp(
        fixture.manager,
        current.id,
        { ...input(fixture.staffA.id), contactId: fixture.contactId },
      );
      expect(grandchild.followUpContext).toMatchObject({ sourceJobCardId: current.id });

      const root = await fixture.service.detail(fixture.admin, sourceId);
      expect(root.status).toBe('COMPLETED');
    });
  });
});
