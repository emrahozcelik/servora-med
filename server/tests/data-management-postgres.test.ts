import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresDataManagementRepository } from '../src/modules/data-management/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

afterAll(async () => { await adminPool?.end(); });

async function withIsolatedDatabase(run: (pool: Pool) => Promise<void>) {
  const schema = `data_management_${randomUUID().replaceAll('-', '')}`;
  await adminPool!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  try {
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
      logger: { info() {}, error() {} },
    });
    await run(pool);
  } finally {
    await pool.end();
    await adminPool!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

async function createOrganization(pool: Pool, name: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [name],
  )).rows[0]!.id;
}

async function createUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
  options: { active?: boolean; dataClass?: 'BUSINESS' | 'DEMO'; demoDatasetId?: string | null } = {},
) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users
       (organization_id, name, email, password_hash, role, is_active, data_class, demo_dataset_id)
     VALUES ($1, $2, $3, 'test-hash', $4, $5, $6, $7)
     RETURNING id`,
    [organizationId, `${role}-${randomUUID()}`, `${randomUUID()}@test.local`, role,
      options.active ?? true, options.dataClass ?? 'BUSINESS', options.demoDatasetId ?? null],
  )).rows[0]!.id;
}

async function createDataset(pool: Pool, organizationId: string, createdBy: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO demo_datasets
       (organization_id, dataset_key, seed_version, created_by)
     VALUES ($1, $2, 'u2-test', $3)
     RETURNING id`,
    [organizationId, `u2-${randomUUID()}`, createdBy],
  )).rows[0]!.id;
}

async function createCustomer(
  pool: Pool,
  organizationId: string,
  status: 'prospect' | 'active' | 'inactive',
  dataClass: 'BUSINESS' | 'DEMO' = 'BUSINESS',
  demoDatasetId: string | null = null,
) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers
       (organization_id, name, customer_type, status, data_class, demo_dataset_id)
     VALUES ($1, $2, 'clinic', $3, $4, $5)
     RETURNING id`,
    [organizationId, `Customer ${randomUUID()}`, status, dataClass, demoDatasetId],
  )).rows[0]!.id;
}

async function createContact(pool: Pool, organizationId: string, customerId: string, active: boolean) {
  await pool.query(
    `INSERT INTO contacts (organization_id, customer_id, name, is_active)
     VALUES ($1, $2, $3, $4)`,
    [organizationId, customerId, `Contact ${randomUUID()}`, active],
  );
}

async function createProduct(
  pool: Pool,
  organizationId: string,
  active: boolean,
  dataClass: 'BUSINESS' | 'DEMO' = 'BUSINESS',
  demoDatasetId: string | null = null,
) {
  await pool.query(
    `INSERT INTO products
       (organization_id, sku, name, unit, is_active, data_class, demo_dataset_id)
     VALUES ($1, $2, $3, 'adet', $4, $5, $6)`,
    [organizationId, `U2-${randomUUID()}`, `Product ${randomUUID()}`, active, dataClass, demoDatasetId],
  );
}

describe.skipIf(!databaseUrl)('Data Management summary PostgreSQL contract', () => {
  it('keeps tenant, BUSINESS/DEMO, Contact ownership, and read-only semantics isolated', async () => {
    await withIsolatedDatabase(async (pool) => {
      const organizationA = await createOrganization(pool, 'U2 Organization A');
      const organizationB = await createOrganization(pool, 'U2 Organization B');
      const adminA = await createUser(pool, organizationA, 'ADMIN');
      const adminB = await createUser(pool, organizationB, 'ADMIN');
      const activeDatasetA = await createDataset(pool, organizationA, adminA);
      const activeDatasetB = await createDataset(pool, organizationB, adminB);

      await createUser(pool, organizationA, 'STAFF');
      await createUser(pool, organizationA, 'STAFF', { active: false });
      await createUser(pool, organizationA, 'STAFF', { dataClass: 'DEMO', demoDatasetId: activeDatasetA });
      await createUser(pool, organizationB, 'STAFF');

      const businessActiveCustomer = await createCustomer(pool, organizationA, 'active');
      await createCustomer(pool, organizationA, 'prospect');
      await createCustomer(pool, organizationA, 'inactive');
      const demoCustomer = await createCustomer(pool, organizationA, 'active', 'DEMO', activeDatasetA);
      await createCustomer(pool, organizationB, 'active');

      await createContact(pool, organizationA, businessActiveCustomer, true);
      await createContact(pool, organizationA, businessActiveCustomer, false);
      await createContact(pool, organizationA, demoCustomer, true);
      await createContact(pool, organizationB, (await createCustomer(pool, organizationB, 'active')), true);
      await createProduct(pool, organizationA, true);
      await createProduct(pool, organizationA, false);
      await createProduct(pool, organizationA, true, 'DEMO', activeDatasetA);
      await createProduct(pool, organizationB, true);

      const before = await pool.query<{ users: string; customers: string; contacts: string; products: string; audits: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM users) AS users,
           (SELECT COUNT(*)::text FROM customers) AS customers,
           (SELECT COUNT(*)::text FROM contacts) AS contacts,
           (SELECT COUNT(*)::text FROM products) AS products,
           (SELECT COUNT(*)::text FROM audit_events) AS audits`,
      );

      const repository = new PostgresDataManagementRepository(pool);
      await expect(repository.getSummary(organizationA)).resolves.toEqual({
        customers: { total: 3, prospect: 1, active: 1, inactive: 1 },
        contacts: { total: 2, active: 1, inactive: 1 },
        products: { total: 2, active: 1, inactive: 1 },
        staff: { total: 2, active: 1, inactive: 1 },
        demoDataset: { total: 1, active: 1 },
      });
      await expect(repository.getSummary(organizationB)).resolves.toEqual({
        customers: { total: 2, prospect: 0, active: 2, inactive: 0 },
        contacts: { total: 1, active: 1, inactive: 0 },
        products: { total: 1, active: 1, inactive: 0 },
        staff: { total: 1, active: 1, inactive: 0 },
        demoDataset: { total: 1, active: 1 },
      });

      const after = await pool.query<{ users: string; customers: string; contacts: string; products: string; audits: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM users) AS users,
           (SELECT COUNT(*)::text FROM customers) AS customers,
           (SELECT COUNT(*)::text FROM contacts) AS contacts,
           (SELECT COUNT(*)::text FROM products) AS products,
           (SELECT COUNT(*)::text FROM audit_events) AS audits`,
      );
      expect(after.rows).toEqual(before.rows);
    });
  });
});
