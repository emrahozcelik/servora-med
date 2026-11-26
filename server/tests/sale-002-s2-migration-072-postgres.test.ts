import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { getHealthSchemaVersionMismatchError } from '../src/db/schema-compatibility.js';

/**
 * SALE-002 S2 / R9 (accepted Q1) — migration `072_sale_submit_without_start`.
 * Owning contract: docs/features/visit-to-sale/sale-002-contract.md §2.2 R9,
 * §4.3, §11 Q1.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const MIGRATION_071 = '071_sale_standalone_and_delivery_link';
const MIGRATION_072 = '072_sale_submit_without_start';
const MIGRATION_073 = '073_assignment_offer_time_proposal';
const MIGRATION_074 = '074_installation_operator_and_module_state';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `s2migration_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function insertOrg(pool: Pool): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ('S2 R9', 'Europe/Istanbul') RETURNING id`,
  )).rows[0]!.id;
}

async function insertStaff(pool: Pool, organizationId: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'S2 staff', $2, 'test-hash', 'STAFF') RETURNING id`,
    [organizationId, `${randomUUID()}@test.local`],
  )).rows[0]!.id;
}

async function insertCustomer(pool: Pool, organizationId: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, 'R9 clinic', 'clinic', 'active') RETURNING id`,
    [organizationId],
  )).rows[0]!.id;
}

async function insertCard(
  pool: Pool,
  input: {
    organizationId: string;
    userId: string;
    customerId: string;
    type: 'SALE' | 'SALES_MEETING' | 'PRODUCT_DELIVERY' | 'GENERAL_TASK';
    status: string;
    startedAt: string | null;
  },
): Promise<string> {
  // Minimal rows that satisfy the type/status CHECK set for this assertion.
  // A SALE needs a customer and no schedule/due date (057 sale fields).
  const submitted = input.status === 'WAITING_APPROVAL' || input.status === 'REVISION_REQUESTED'
    || input.status === 'COMPLETED';
  const card = (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by,
       customer_id, engagement_kind, started_at, staff_completed_at, staff_completed_by,
       data_class)
     VALUES ($1::uuid,$2::varchar,$3::varchar,'R9 proof',$4::uuid,$4::uuid,
       $5::uuid,$9::varchar,$6::timestamptz,$7::timestamptz,$8::uuid,'BUSINESS')
     RETURNING id`,
    [input.organizationId, input.type, input.status, input.userId,
      input.type === 'SALE' ? input.customerId : null,
      input.startedAt, submitted ? new Date() : null, submitted ? input.userId : null,
      input.type === 'SALES_MEETING' ? 'CUSTOMER_VISIT' : null],
  )).rows[0]!.id;
  return card;
}

describe.skipIf(!databaseUrl)('SALE-002 S2 migration 072 (R9)', () => {
  it('lets a SALE reach a post-start status without started_at and keeps the guard for every other type', async () => {
    await withSchema(async (pool) => {
      await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
      const organizationId = await insertOrg(pool);
      const userId = await insertStaff(pool, organizationId);
      const customerId = await insertCustomer(pool, organizationId);

      // R9: exactly the reviewed gap. No fabricated `started_at`.
      const saleId = await insertCard(pool, {
        organizationId, userId, customerId,
        type: 'SALE', status: 'WAITING_APPROVAL', startedAt: null,
      });
      expect(saleId).toBeTruthy();
      await pool.query(
        `UPDATE job_cards SET status='REVISION_REQUESTED',
           revision_requested_at=NOW(), revision_requested_by=$2, revision_reason='R9'
         WHERE id=$1`,
        [saleId, userId],
      );
      await pool.query(
        `UPDATE job_cards SET status='COMPLETED', manager_approved_at=NOW(), manager_approved_by=$2
         WHERE id=$1`,
        [saleId, userId],
      );
      await pool.query(
        `UPDATE job_cards SET status='IN_PROGRESS' WHERE id=$1`, [saleId],
      );

      for (const type of ['SALES_MEETING', 'PRODUCT_DELIVERY', 'GENERAL_TASK'] as const) {
        await expect(insertCard(pool, {
          organizationId, userId, customerId, type, status: 'WAITING_APPROVAL', startedAt: null,
        })).rejects.toMatchObject({
          code: '23514',
          constraint: 'job_cards_started_status_timestamp_check',
        });
      }
      // A started card of any type is still accepted.
      await expect(insertCard(pool, {
        organizationId, userId, customerId, type: 'SALES_MEETING', status: 'WAITING_APPROVAL',
        startedAt: '2026-11-23T08:00:00.000Z',
      })).resolves.toBeTruthy();
    });
  });

  it('upgrades an applied 071 database with existing started sales exactly once', async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const schema = `s2migration_${randomUUID().replaceAll('-', '')}`;
    const previous = await mkdtemp(path.join(tmpdir(), 's2-072-head071-'));
    let pool: Pool | null = null;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
      for (const filename of (await readdir(migrationsDirectory)).filter(
        (name) => /^\d{3}_.+\.sql$/.test(name) && Number(name.slice(0, 3)) <= 71,
      )) {
        await copyFile(path.join(migrationsDirectory, filename), path.join(previous, filename));
      }
      const store = new PostgresMigrationStore(pool);
      const baseline = await runMigrations({ migrationsDirectory: previous, store });
      expect(baseline.appliedVersions.at(-1)).toBe(MIGRATION_071);

      const organizationId = await insertOrg(pool);
      const userId = await insertStaff(pool, organizationId);
      const customerId = await insertCustomer(pool, organizationId);
      // A pre-072 sale that had started keeps its bytes.
      const startedSale = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by,
           customer_id, started_at, staff_completed_at, staff_completed_by, data_class)
         VALUES ($1::uuid,'SALE','WAITING_APPROVAL','Legacy started sale',$2::uuid,$2::uuid,
           $3::uuid,'2026-11-01T08:00:00.000Z', NOW(), $2::uuid, 'BUSINESS') RETURNING id`,
        [organizationId, userId, customerId],
      )).rows[0]!.id;
      const before = (await pool.query('SELECT *, xmin::text AS xmin FROM job_cards WHERE id=$1',
        [startedSale])).rows[0];

      const upgrade = await runMigrations({ migrationsDirectory, store });
      expect(upgrade).toEqual({ appliedVersions: [MIGRATION_072, MIGRATION_073, MIGRATION_074] });
      expect((await pool.query('SELECT *, xmin::text AS xmin FROM job_cards WHERE id=$1',
        [startedSale])).rows[0]).toEqual(before);
      expect(await runMigrations({ migrationsDirectory, store })).toEqual({ appliedVersions: [] });

      const history = (await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      )).rows;
      expect(history.at(-1)!.version).toBe(MIGRATION_074);
    } finally {
      await pool?.end();
      await rm(previous, { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('moves the health schema version to 074', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    expect(catalog.head?.version).toBe(MIGRATION_074);
    expect(getHealthSchemaVersionMismatchError(catalog, MIGRATION_074)).toBeNull();
    expect(getHealthSchemaVersionMismatchError(catalog, MIGRATION_073)).not.toBeNull();
    expect(getHealthSchemaVersionMismatchError(catalog, MIGRATION_072)).not.toBeNull();
  });
});
