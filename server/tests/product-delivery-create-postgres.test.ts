import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const requestTime = new Date('2026-08-18T07:00:00.000Z');

describe.skipIf(!databaseUrl)('Product Delivery atomic create PostgreSQL contract', () => {
  it('creates one JobCard plus N items, replays idempotently, and rolls back invalid batches', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `product_delivery_create_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone)
         VALUES ('Product Delivery batch', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const otherOrganizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone)
         VALUES ('Other organization', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      async function createUser(name: string, role: 'MANAGER' | 'STAFF', orgId = organizationId) {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO users (organization_id, name, email, password_hash, role)
           VALUES ($1, $2, $3, 'test-hash', $4) RETURNING id`,
          [orgId, name, `${randomUUID()}@test.local`, role],
        )).rows[0]!.id;
      }
      const managerId = await createUser('Batch Manager', 'MANAGER');
      const staffId = await createUser('Batch Staff', 'STAFF');
      const otherOrgStaffId = await createUser('Other Staff', 'STAFF', otherOrganizationId);
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Batch Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      const invalidBatchCustomerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Invalid Batch Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      const productIds = await Promise.all(['Matrix Sistem', 'Cycles Kit', 'Greft Seti'].map(async (name) => {
        const result = await pool!.query<{ id: string }>(
          `INSERT INTO products (organization_id, name, unit, is_active)
           VALUES ($1, $2, 'adet', TRUE) RETURNING id`,
          [organizationId, name],
        );
        return result.rows[0]!.id;
      }));
      const otherProductId = (await pool.query<{ id: string }>(
        `INSERT INTO products (organization_id, name, unit, is_active)
         VALUES ($1, 'Cross Org Product', 'adet', TRUE) RETURNING id`,
        [otherOrganizationId],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
         VALUES ($1, $2, $3)`,
        [organizationId, staffId, managerId],
      );

      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const service = new JobCardService(new PostgresJobCardRepository(pool), () => requestTime);
      const input = {
        clientActionId: 'postgres-product-delivery-batch', type: 'PRODUCT_DELIVERY' as const,
        title: 'Üç ürünlü teslim', description: null, customerId, contactId: null,
        assignedTo: staffId, priority: 'normal' as const, dueDate: null,
        scheduledAt: '2026-08-18T10:00:00.000Z', scheduledEndsAt: '2026-08-18T10:30:00.000Z',
        overrideReason: null, deliveryPurpose: 'SALE' as const, deliveryNote: 'Ortak not',
        items: productIds.map((productId, index) => ({ productId, quantity: [2, 1, 0.5][index]! })),
      };

      const first = await service.createProductDelivery(manager, input);
      expect(first).toMatchObject({ version: 4 });
      const countsAfterCreate = await pool.query<{ jobs: string; items: string; activities: string; actions: string }>(
        `SELECT
           (SELECT COUNT(*) FROM job_cards WHERE organization_id = $1)::text AS jobs,
           (SELECT COUNT(*) FROM job_card_delivery_items WHERE organization_id = $1)::text AS items,
           (SELECT COUNT(*) FROM job_card_activity_logs WHERE organization_id = $1)::text AS activities,
           (SELECT COUNT(*) FROM processed_actions WHERE organization_id = $1)::text AS actions`,
        [organizationId],
      );
      expect(countsAfterCreate.rows[0]).toEqual({ jobs: '1', items: '3', activities: '4', actions: '1' });
      expect((await pool.query<{ version: number }>(
        `SELECT version FROM job_cards WHERE id = $1`, [first.jobCardId],
      )).rows[0]!.version).toBe(4);
      expect((await pool.query<{ purpose: string; note: string | null; quantity: string }>(
        `SELECT delivery_purpose AS purpose, delivery_note AS note, quantity::text
           FROM job_card_delivery_items WHERE job_card_id = $1 ORDER BY sort_order`,
        [first.jobCardId],
      )).rows).toEqual([
        { purpose: 'SALE', note: 'Ortak not', quantity: '2.000' },
        { purpose: 'SALE', note: 'Ortak not', quantity: '1.000' },
        { purpose: 'SALE', note: 'Ortak not', quantity: '0.500' },
      ]);

      await expect(service.createProductDelivery(manager, input)).resolves.toEqual(first);
      const countsAfterReplay = await pool.query<{ jobs: string; items: string; activities: string; actions: string }>(
        `SELECT
           (SELECT COUNT(*) FROM job_cards WHERE organization_id = $1)::text AS jobs,
           (SELECT COUNT(*) FROM job_card_delivery_items WHERE organization_id = $1)::text AS items,
           (SELECT COUNT(*) FROM job_card_activity_logs WHERE organization_id = $1)::text AS activities,
           (SELECT COUNT(*) FROM processed_actions WHERE organization_id = $1)::text AS actions`,
        [organizationId],
      );
      expect(countsAfterReplay.rows[0]).toEqual(countsAfterCreate.rows[0]);

      await expect(service.createProductDelivery(manager, {
        ...input,
        clientActionId: 'postgres-invalid-batch',
        customerId: invalidBatchCustomerId,
        scheduledAt: '2026-08-18T11:00:00.000Z',
        scheduledEndsAt: '2026-08-18T11:30:00.000Z',
        items: [{ productId: productIds[0]!, quantity: 1 }, { productId: otherProductId, quantity: 1 }],
      })).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND', statusCode: 404 });
      const countsAfterInvalid = await pool.query<{ jobs: string; items: string; activities: string; actions: string }>(
        `SELECT
           (SELECT COUNT(*) FROM job_cards WHERE organization_id = $1)::text AS jobs,
           (SELECT COUNT(*) FROM job_card_delivery_items WHERE organization_id = $1)::text AS items,
           (SELECT COUNT(*) FROM job_card_activity_logs WHERE organization_id = $1)::text AS activities,
           (SELECT COUNT(*) FROM processed_actions WHERE organization_id = $1)::text AS actions`,
        [organizationId],
      );
      expect(countsAfterInvalid.rows[0]).toEqual(countsAfterCreate.rows[0]);

      await expect(service.createProductDelivery({
        id: otherOrgStaffId, organizationId: otherOrganizationId, role: 'STAFF',
      }, { ...input, clientActionId: 'other-org-actor', customerId, assignedTo: staffId }))
        .rejects.toMatchObject({ code: 'ASSIGNEE_NOT_FOUND', statusCode: 404 });
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
