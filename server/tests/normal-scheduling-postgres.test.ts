import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const CLOCK = new Date('2026-08-01T10:00:00.000Z');

async function insertUser(pool: Pool, organizationId: string, role: JobCardActor['role'], name: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

describe.skipIf(!databaseUrl)('normal customer scheduling PostgreSQL contract', () => {
  it('NJS-12: concurrent same-Customer/day create serializes; exactly one succeeds', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `normal_sched_${randomUUID().replaceAll('-', '')}`;
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
        `INSERT INTO organizations (name, timezone)
         VALUES ('Normal scheduling', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Staff');
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Dünya Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;

      const published: RealtimeEventRecord[] = [];
      const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
      const service = new JobCardService(
        new PostgresJobCardRepository(pool),
        () => CLOCK,
        publisher,
      );
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const meetingInput = {
        clientActionId: randomUUID(),
        type: 'SALES_MEETING' as const,
        title: 'Görüşme',
        description: null,
        customerId,
        contactId: null,
        assignedTo: staffId,
        priority: 'normal' as const,
        dueDate: null,
        scheduledAt: '2026-08-21T10:00:00.000Z',
        engagementKind: 'SALES_MEETING' as const,
      };
      const deliveryInput = {
        clientActionId: randomUUID(),
        type: 'PRODUCT_DELIVERY' as const,
        title: 'Teslim',
        description: null,
        customerId,
        contactId: null,
        assignedTo: staffId,
        priority: 'normal' as const,
        dueDate: null,
        scheduledAt: '2026-08-21T11:00:00.000Z',
      };

      const results = await Promise.allSettled([
        service.create(manager, meetingInput),
        service.create(manager, deliveryInput),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'CUSTOMER_SCHEDULE_CONFLICT',
        statusCode: 409,
      });

      const count = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM job_cards
          WHERE organization_id = $1 AND customer_id = $2
            AND status NOT IN ('COMPLETED', 'CANCELLED')`,
        [organizationId, customerId],
      );
      expect(Number(count.rows[0]!.total)).toBe(1);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('NJS-13: cross-org customer id does not contribute to evaluation', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `normal_sched_xorg_${randomUUID().replaceAll('-', '')}`;
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
        `INSERT INTO organizations (name, timezone)
         VALUES ('Normal scheduling A', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const otherOrganizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone)
         VALUES ('Normal scheduling B', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const otherManagerId = await insertUser(pool, otherOrganizationId, 'MANAGER', 'Other Manager');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Staff');
      const otherStaffId = await insertUser(pool, otherOrganizationId, 'STAFF', 'Other Staff');
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Dünya Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      const otherCustomerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Rakip Klinik', 'clinic', 'active') RETURNING id`,
        [otherOrganizationId],
      )).rows[0]!.id;

      const service = new JobCardService(new PostgresJobCardRepository(pool), () => CLOCK);
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const otherManager: JobCardActor = {
        id: otherManagerId, organizationId: otherOrganizationId, role: 'MANAGER',
      };

      // A same-org preview works; a cross-org customer id must fail closed.
      await expect(service.previewCustomerSchedule(manager, {
        type: 'SALES_MEETING',
        customerId,
        scheduledAt: '2026-08-21T10:00:00.000Z',
      })).resolves.toMatchObject({ level: 'CLEAR' });
      await expect(service.previewCustomerSchedule(manager, {
        type: 'SALES_MEETING',
        customerId: otherCustomerId,
        scheduledAt: '2026-08-21T10:00:00.000Z',
      })).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
      void otherManager;
      void staffId;
      void otherStaffId;
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
