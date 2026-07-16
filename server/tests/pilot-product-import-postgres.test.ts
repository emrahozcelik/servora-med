import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  importPilotProducts,
  parsePilotProductDocument,
} from '../src/modules/products/pilot-import.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

async function applyMigrations(pool: Pool) {
  for (const migration of [
    '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
    '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
    '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
  ]) {
    const path = fileURLToPath(new URL(`../src/db/migrations/${migration}`, import.meta.url));
    await pool.query(await readFile(path, 'utf8'));
  }
}

const document = parsePilotProductDocument({
  version: 1, description: 'test', fieldGuide: {}, categories: ['Protez'],
  products: [
    { name: 'Mevcut', sku: 'SKU-1', brand: 'A', category: 'Protez', model: null,
      unit: 'adet', referencePrice: null, isActive: true },
    { name: 'Yeni 1', sku: 'SKU-2', brand: 'B', category: 'Protez', model: null,
      unit: 'adet', referencePrice: null, isActive: true },
    { name: 'Yeni 2', sku: null, brand: 'C', category: 'Protez', model: null,
      unit: 'set', referencePrice: 12.5, isActive: true },
  ],
});

describe.skipIf(!databaseUrl)('pilot Product PostgreSQL import', () => {
  it('dry-runs, applies atomically, audits, repeats idempotently, and rejects invalid actors', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `pilot_import_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
      await applyMigrations(pool);
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Pilot import') RETURNING id`,
      )).rows[0]!.id;
      async function user(role: 'ADMIN' | 'MANAGER' | 'STAFF', active = true) {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO users (organization_id,name,email,password_hash,role,is_active)
           VALUES ($1,$2,$3,'unused',$4,$5) RETURNING id`,
          [organizationId, role, `${randomUUID()}@test.local`, role, active],
        )).rows[0]!.id;
      }
      const adminId = await user('ADMIN');
      const staffId = await user('STAFF');
      const inactiveManagerId = await user('MANAGER', false);
      await pool.query(
        `INSERT INTO products (organization_id,name,sku,brand,category,model,unit,default_price)
         VALUES ($1,'Mevcut','SKU-1','A','Protez',NULL,'adet',NULL)`, [organizationId],
      );

      await expect(importPilotProducts(pool, {
        organizationId, actorUserId: adminId, document, apply: false,
      })).resolves.toEqual({ sourceCount: 3, matchedCount: 1, insertedCount: 2, dryRun: true });
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM products`)).rows[0].count).toBe(1);

      await expect(importPilotProducts(pool, {
        organizationId, actorUserId: adminId, document, apply: true,
      })).resolves.toEqual({ sourceCount: 3, matchedCount: 1, insertedCount: 2, dryRun: false });
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM products`)).rows[0].count).toBe(3);
      expect((await pool.query(
        `SELECT COUNT(*)::int AS count FROM audit_events WHERE event_type='PRODUCT_CREATED'`,
      )).rows[0].count).toBe(2);

      await expect(importPilotProducts(pool, {
        organizationId, actorUserId: adminId, document, apply: true,
      })).resolves.toEqual({ sourceCount: 3, matchedCount: 3, insertedCount: 0, dryRun: false });
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM products`)).rows[0].count).toBe(3);

      for (const actorUserId of [staffId, inactiveManagerId, randomUUID()]) {
        await expect(importPilotProducts(pool, {
          organizationId, actorUserId, document, apply: false,
        })).rejects.toMatchObject({ code: 'PILOT_PRODUCT_IMPORT_FORBIDDEN' });
      }

      await pool.query(`DELETE FROM audit_events WHERE event_type='PRODUCT_CREATED'`);
      await pool.query(`DELETE FROM products WHERE sku <> 'SKU-1' OR sku IS NULL`);
      await pool.query(`
        CREATE FUNCTION reject_second_product_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event_type = 'PRODUCT_CREATED' AND EXISTS (
            SELECT 1 FROM audit_events WHERE event_type = 'PRODUCT_CREATED'
          ) THEN RAISE EXCEPTION 'injected audit failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_second_product_audit_trigger BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION reject_second_product_audit();
      `);
      await expect(importPilotProducts(pool, {
        organizationId, actorUserId: adminId, document, apply: true,
      })).rejects.toThrow('injected audit failure');
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM products`)).rows[0].count).toBe(1);
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM audit_events`)).rows[0].count).toBe(0);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
