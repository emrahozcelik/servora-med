import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const path = fileURLToPath(new URL('../src/db/migrations/005_product_catalog.sql', import.meta.url));
let sql = '';
beforeAll(async () => { sql = await readFile(path, 'utf8'); });

describe('005 Product catalog migration contract', () => {
  it('versions Products and relaxes informational fields', () => {
    expect(sql).toMatch(/ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK \(version > 0\)/i);
    expect(sql).toMatch(/DROP CONSTRAINT products_organization_id_sku_key/i);
    expect(sql).toMatch(/ALTER COLUMN sku DROP NOT NULL/i);
    expect(sql).toMatch(/ALTER COLUMN unit DROP DEFAULT/i);
    expect(sql).toMatch(/ALTER COLUMN unit DROP NOT NULL/i);
  });

  it('allows unknown delivery units and rejects negative reference prices', () => {
    expect(sql).toMatch(/job_card_delivery_items[\s\S]*ALTER COLUMN unit DROP NOT NULL/i);
    expect(sql).toMatch(/default_price IS NULL OR default_price >= 0/i);
  });

  it('extends management audit values without ERP fields', () => {
    expect(sql).toContain("'PRODUCT'");
    expect(sql).toContain("'PRODUCT_CREATED'");
    expect(sql).toContain("'PRODUCT_FIELDS_UPDATED'");
    expect(sql).toContain("'PRODUCT_ACTIVATED'");
    expect(sql).toContain("'PRODUCT_DEACTIVATED'");
    expect(sql).not.toMatch(/stock|warehouse|cost|currency|barcode/i);
  });
});

describe('isolated Product catalog schema cleanup', () => {
  it('fails a successful test when cleanup fails and still releases the client', async () => {
    const statements: string[] = [];
    let released = false;
    const client = {
      async query(statement: string) {
        statements.push(statement);
        if (statement === 'RESET search_path') throw new Error('reset failed');
        return { rows: [] };
      },
      release() { released = true; },
    };

    await expect(cleanupIsolatedSchema(client, 'catalog_test', false)).rejects.toThrow(
      'Failed to clean up Product catalog test schema',
    );
    expect(statements).toEqual([
      'ROLLBACK',
      'RESET search_path',
      'DROP SCHEMA IF EXISTS catalog_test CASCADE',
    ]);
    expect(released).toBe(true);
  });

  it('preserves a primary test failure while attempting every cleanup step', async () => {
    const statements: string[] = [];
    let released = false;
    const client = {
      async query(statement: string) {
        statements.push(statement);
        throw new Error('cleanup failed');
      },
      release() { released = true; },
    };

    await expect(cleanupIsolatedSchema(client, 'catalog_test', true)).resolves.toBeUndefined();
    expect(statements).toEqual([
      'ROLLBACK',
      'RESET search_path',
      'DROP SCHEMA IF EXISTS catalog_test CASCADE',
    ]);
    expect(released).toBe(true);
  });
});

type SchemaCleanupClient = {
  query(statement: string): Promise<unknown>;
  release(): void;
};

async function cleanupIsolatedSchema(
  client: SchemaCleanupClient,
  schema: string,
  preservePrimaryFailure: boolean,
) {
  const cleanupErrors: unknown[] = [];

  for (const statement of [
    'ROLLBACK',
    'RESET search_path',
    `DROP SCHEMA IF EXISTS ${schema} CASCADE`,
  ]) {
    try {
      await client.query(statement);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  try {
    client.release();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (!preservePrimaryFailure && cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Failed to clean up Product catalog test schema');
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

afterAll(async () => { await pool?.end(); });

describe.skipIf(!databaseUrl)('005 Product catalog PostgreSQL migration', () => {
  it('applies catalog invariants while preserving delivery snapshots', async () => {
    const schema = `product_catalog_${randomUUID().replaceAll('-', '')}`;
    const client = await pool!.connect();
    let primaryTestFailed = false;

    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query('BEGIN');

      for (const migration of [
        '001_auth_foundation.sql',
        '002_delivery_tracer.sql',
        '003_people.sql',
        '004_crm_contacts.sql',
      ]) {
        const migrationPath = fileURLToPath(
          new URL(`../src/db/migrations/${migration}`, import.meta.url),
        );
        await client.query(await readFile(migrationPath, 'utf8'));
      }

      const organization = await client.query<{ id: string }>(
        "INSERT INTO organizations (name) VALUES ('Catalog Test') RETURNING id",
      );
      const organizationId = organization.rows[0]!.id;
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Catalog Staff', $2, 'test-hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      );
      const userId = user.rows[0]!.id;
      const customer = await client.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type)
         VALUES ($1, 'Catalog Clinic', 'clinic') RETURNING id`,
        [organizationId],
      );
      const customerId = customer.rows[0]!.id;
      const product = await client.query<{ id: string }>(
        `INSERT INTO products (organization_id, sku, name, unit)
         VALUES ($1, 'LEGACY-001', 'Legacy Implant', 'kutu') RETURNING id`,
        [organizationId],
      );
      const productId = product.rows[0]!.id;
      const jobCard = await client.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, title, customer_id, assigned_to, created_by
         ) VALUES ($1, 'PRODUCT_DELIVERY', 'Legacy delivery', $2, $3, $3) RETURNING id`,
        [organizationId, customerId, userId],
      );
      await client.query(
        `INSERT INTO job_card_delivery_items (
           organization_id, job_card_id, product_id, delivery_purpose,
           delivered_at, quantity, unit, product_name_snapshot,
           product_sku_snapshot, product_model_snapshot
         ) VALUES ($1, $2, $3, 'SALE', NOW(), 2, 'kutu',
           'Legacy Implant', 'LEGACY-001', 'Legacy Model')`,
        [organizationId, jobCard.rows[0]!.id, productId],
      );

      await client.query(sql);

      const legacy = await client.query<{
        version: number;
        unit: string | null;
        product_name_snapshot: string;
        product_sku_snapshot: string | null;
        product_model_snapshot: string | null;
      }>(
        `SELECT p.version, d.unit, d.product_name_snapshot,
                d.product_sku_snapshot, d.product_model_snapshot
         FROM products p
         JOIN job_card_delivery_items d ON d.product_id = p.id
         WHERE p.id = $1`,
        [productId],
      );
      expect(legacy.rows).toEqual([{
        version: 1,
        unit: 'kutu',
        product_name_snapshot: 'Legacy Implant',
        product_sku_snapshot: 'LEGACY-001',
        product_model_snapshot: 'Legacy Model',
      }]);

      await client.query(
        `INSERT INTO products (organization_id, sku, name)
         VALUES ($1, 'DUPLICATE', 'Duplicate One'),
                ($1, 'DUPLICATE', 'Duplicate Two')`,
        [organizationId],
      );
      const nameOnly = await client.query<{ sku: string | null; unit: string | null; version: number }>(
        `INSERT INTO products (organization_id, name)
         VALUES ($1, 'Name Only Product') RETURNING sku, unit, version`,
        [organizationId],
      );
      expect(nameOnly.rows).toEqual([{ sku: null, unit: null, version: 1 }]);

      await client.query('SAVEPOINT negative_price');
      await expect(client.query(
        `INSERT INTO products (organization_id, name, default_price)
         VALUES ($1, 'Negative Price', -0.01)`,
        [organizationId],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT negative_price');
    } catch (error) {
      primaryTestFailed = true;
      throw error;
    } finally {
      await cleanupIsolatedSchema(client, schema, primaryTestFailed);
    }
  });
});
