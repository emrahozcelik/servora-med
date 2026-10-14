import { describe, expect, it } from 'vitest';
import { withIntentSchema } from './support/lifecycle-intent-harness.js';
import { withSaleFixture } from './support/sale-harness.js';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Sale PostgreSQL schema', () => {
  it('upgrades the real 056 catalog without changing an existing job and never reapplies 057', async () => {
    const directory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
    const previous = await mkdtemp(path.join(tmpdir(), 'sale-head056-'));
    const admin = new Pool({ connectionString: databaseUrl });
    const schema = `saleupgrade_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      for (const filename of (await readdir(directory)).filter((name) => /^\d{3}_.+\.sql$/.test(name) && Number(name.slice(0, 3)) <= 56)) {
        await copyFile(path.join(directory, filename), path.join(previous, filename));
      }
      expect((await loadMigrationCatalog(previous)).head!.version).toBe('056_meeting_met_contact');
      const store = new PostgresMigrationStore(pool);
      await runMigrations({ migrationsDirectory: previous, store });
      const org = (await pool.query("INSERT INTO organizations(name) VALUES ('Existing organization') RETURNING id")).rows[0].id;
      const user = (await pool.query("INSERT INTO users(organization_id,name,email,password_hash,role) VALUES ($1,'Existing staff','existing@test.local','test-hash','STAFF') RETURNING id", [org])).rows[0].id;
      const job = (await pool.query("INSERT INTO job_cards(organization_id,type,status,title,assigned_to,created_by) VALUES ($1,'GENERAL_TASK','NEW','Existing task',$2,$2) RETURNING *", [org, user])).rows[0];
      const upgraded = await runMigrations({ migrationsDirectory: directory, store });
      expect(upgraded.appliedVersions).toEqual(['057_sale_from_visit']);
      const after = (await pool.query('SELECT * FROM job_cards WHERE id=$1', [job.id])).rows[0];
      const { sale_source_visit_id, ...oldColumns } = after;
      expect(sale_source_visit_id).toBeNull();
      expect(oldColumns).toEqual(job);
      const history = (await pool.query('SELECT version,applied_at,xmin::text FROM schema_migrations ORDER BY version')).rows;
      expect(await runMigrations({ migrationsDirectory: directory, store })).toEqual({ appliedVersions: [] });
      expect((await pool.query('SELECT version,applied_at,xmin::text FROM schema_migrations ORDER BY version')).rows).toEqual(history);
      expect(history).toHaveLength(57);
    } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); await rm(previous, { recursive: true, force: true }); }
  });
  it('enforces same-org foreign keys, duplicate products and numeric bounds in PostgreSQL', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const item = (await f.pool.query('SELECT id FROM job_card_sale_items WHERE job_card_id=$1', [sale.jobCardId])).rows[0].id;
      for (const quantity of ['0', '-1', 'NaN', 'Infinity', '1000000000']) {
        await expect(f.pool.query('UPDATE job_card_sale_items SET quantity=$2 WHERE id=$1', [item, quantity]))
          .rejects.toMatchObject({ code: quantity === '1000000000' || quantity === 'Infinity' ? '22003' : '23514' });
      }
      await expect(f.pool.query(`INSERT INTO job_card_sale_items(organization_id,job_card_id,product_id,quantity,product_name_snapshot,sort_order)
        VALUES ($1,$2,$3,1,'Duplicate',3)`, [f.organizationId, sale.jobCardId, f.products[0]])).rejects.toMatchObject({ code: '23505' });
      const org = (await f.pool.query("INSERT INTO organizations(name) VALUES ('Foreign FK') RETURNING id")).rows[0].id;
      const product = (await f.pool.query("INSERT INTO products(organization_id,name) VALUES ($1,'Foreign product') RETURNING id", [org])).rows[0].id;
      await expect(f.pool.query('UPDATE job_card_sale_items SET product_id=$2 WHERE id=$1', [item, product])).rejects.toMatchObject({ code: '23503' });
      const user = await f.user('STAFF', org);
      const source = (await f.pool.query("INSERT INTO job_cards(organization_id,type,status,title,assigned_to,created_by) VALUES ($1,'GENERAL_TASK','NEW','Foreign source',$2,$2) RETURNING id", [org, user.id])).rows[0].id;
      await expect(f.pool.query('UPDATE job_cards SET sale_source_visit_id=$2 WHERE id=$1', [sale.jobCardId, source])).rejects.toMatchObject({ code: '23503' });
      await expect(f.pool.query('UPDATE job_cards SET sale_source_visit_id=id WHERE id=$1', [sale.jobCardId])).rejects.toMatchObject({ code: '23514' });
      await expect(f.pool.query('DELETE FROM products WHERE id=$1', [f.products[0]])).rejects.toMatchObject({ code: '23503' });
      expect((await f.pool.query('SELECT quantity::text FROM job_card_sale_items WHERE id=$1', [item])).rows[0].quantity).toMatch(/^(0\.500|0\.001)$/);
    });
  });
  it('installs separate sale details/items with an exact three-decimal quantity column', async () => {
    await withIntentSchema(databaseUrl, async (pool, schema) => {
      const quantity = await pool.query(
        `SELECT numeric_precision, numeric_scale FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='job_card_sale_items' AND column_name='quantity'`,
        [schema],
      );
      expect(quantity.rows).toEqual([{ numeric_precision: 12, numeric_scale: 3 }]);
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema=$1 AND table_name IN ('job_card_sale_details','job_card_sale_items')
         ORDER BY table_name`, [schema],
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(['job_card_sale_details', 'job_card_sale_items']);
    });
  });
});
