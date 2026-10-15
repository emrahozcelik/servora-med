import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { saleFixture } from './support/sale-harness.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const directory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function at057(run: (pool: Pool, store: PostgresMigrationStore) => Promise<void>) {
  const previous = await mkdtemp(path.join(tmpdir(), 'sale-qty-head057-'));
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `saleqty_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const filename of (await readdir(directory)).filter((name) => /^\d{3}_.+\.sql$/.test(name) && Number(name.slice(0, 3)) <= 57)) {
      await copyFile(path.join(directory, filename), path.join(previous, filename));
    }
    const store = new PostgresMigrationStore(pool);
    await runMigrations({ migrationsDirectory: previous, store });
    await run(pool, store);
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end(); await rm(previous, { recursive: true, force: true });
  }
}

describe.skipIf(!databaseUrl)('SALE-QTY-001 forward migration', () => {
  it('upgrades integer history from 057 without rewriting rows or prior receipts and rejects direct fractional writes', async () => {
    await at057(async (pool, store) => {
      const f = await saleFixture(pool);
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const before = (await pool.query('SELECT *,xmin::text FROM job_card_sale_items ORDER BY id')).rows;
      const receipts = (await pool.query('SELECT *,xmin::text FROM processed_actions ORDER BY id')).rows;
      expect(await runMigrations({ migrationsDirectory: directory, store }))
        .toEqual({ appliedVersions: ['058_sale_integer_quantity'] });
      expect((await pool.query('SELECT *,xmin::text FROM job_card_sale_items ORDER BY id')).rows).toEqual(before);
      expect((await pool.query('SELECT *,xmin::text FROM processed_actions ORDER BY id')).rows).toEqual(receipts);
      expect(await f.service.createSaleFromVisit(f.staff, f.visitId, f.input)).toEqual(sale);
      const product = (await pool.query("INSERT INTO products(organization_id,name) VALUES ($1,'New product') RETURNING id", [f.organizationId])).rows[0].id;
      for (const quantity of ['0', '-1', '0.001', '0.5', '1.5', '2.75', '999999999.999']) {
        await expect(pool.query('UPDATE job_card_sale_items SET quantity=$2 WHERE id=$1', [before[0].id, quantity]))
          .rejects.toMatchObject({ code: '23514', constraint: 'job_card_sale_items_integer_quantity_check' });
        await expect(pool.query(`INSERT INTO job_card_sale_items(organization_id,job_card_id,product_id,quantity,product_name_snapshot,sort_order)
          VALUES ($1,$2,$3,$4,'New product',2)`, [f.organizationId, sale.jobCardId, product, quantity]))
          .rejects.toMatchObject({ code: '23514', constraint: 'job_card_sale_items_integer_quantity_check' });
      }
      for (const quantity of ['1', '2', '15', '100', '999999999']) {
        await pool.query('UPDATE job_card_sale_items SET quantity=$2 WHERE id=$1', [before[0].id, quantity]);
        expect((await pool.query('SELECT trim_scale(quantity)::text AS quantity FROM job_card_sale_items WHERE id=$1', [before[0].id])).rows[0].quantity).toBe(quantity);
      }
      expect(await runMigrations({ migrationsDirectory: directory, store })).toEqual({ appliedVersions: [] });
    });
  });
  it('fails closed on historical fractional rows without changing data or recording 058', async () => {
    await at057(async (pool, store) => {
      const f = await saleFixture(pool);
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      await pool.query('UPDATE job_card_sale_items SET quantity=0.5 WHERE job_card_id=$1', [sale.jobCardId]);
      const before = (await pool.query('SELECT *,xmin::text FROM job_card_sale_items ORDER BY id')).rows;
      const history = (await pool.query('SELECT *,xmin::text FROM schema_migrations ORDER BY version')).rows;
      await expect(runMigrations({ migrationsDirectory: directory, store }))
        .rejects.toMatchObject({ code: '23514', message: expect.stringContaining('SALE-QTY-001') });
      expect((await pool.query('SELECT *,xmin::text FROM job_card_sale_items ORDER BY id')).rows).toEqual(before);
      expect((await pool.query('SELECT *,xmin::text FROM schema_migrations ORDER BY version')).rows).toEqual(history);
      expect((await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='job_card_sale_items'::regclass AND conname='job_card_sale_items_integer_quantity_check'")).rows[0].n).toBe(0);
    });
  });
});
