import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { saleFixture } from './support/sale-harness.js';

/**
 * SALE-002 slice S1 acceptance — PostgreSQL schema and migration 071.
 * Owning contract: docs/features/visit-to-sale/sale-002-contract.md §3, §9.1.
 *
 * These assertions are written against the accepted contract, not against an
 * implementation. The migration file is named by the contract
 * (`071_sale_standalone_and_delivery_link.sql`) and every constraint name used
 * below appears verbatim in §3.1.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const distSchemaCheck = fileURLToPath(new URL('../dist/db/schema-check.js', import.meta.url));
const distMigrationsDirectory = fileURLToPath(new URL('../dist/db/migrations', import.meta.url));

const MIGRATION_071 = '071_sale_standalone_and_delivery_link';
const MIGRATION_070 = '070_overdue_incident_invalidation_closure';

async function withSchema(run: (pool: Pool, schema: string) => Promise<void>): Promise<void> {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `sale002s1_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await run(pool, schema);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

/** A throwaway catalog copy that stops at the given migration number. */
async function migrationsUpTo(number: number): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'sale002-s1-head-'));
  const filenames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{3}_.+\.sql$/.test(name) && Number(name.slice(0, 3)) <= number);
  for (const filename of filenames) {
    await copyFile(path.join(migrationsDirectory, filename), path.join(directory, filename));
  }
  return directory;
}

/** The quoted literals of an applied CHECK constraint, read from the catalog. */
async function readCheckValues(pool: Pool, constraintName: string): Promise<string[]> {
  const result = await pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conname = $1
        AND connamespace = current_schema()::regnamespace`,
    [constraintName],
  );
  expect(result.rows).toHaveLength(1);
  return [...result.rows[0]!.definition.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

function runDistSchemaCheck(databaseUrlForSchema: string, healthVersion: string) {
  const { HEALTH_SCHEMA_VERSION: _ignored, ...rest } = process.env;
  void _ignored;
  const env: NodeJS.ProcessEnv = {
    ...rest,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrlForSchema,
    HEALTH_SCHEMA_VERSION: healthVersion,
  };
  try {
    const stdout = execFileSync(process.execPath, [distSchemaCheck], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { exitCode: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? String(failure.message ?? '')}`,
    };
  }
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'test-hash', $4) RETURNING id`,
    [organizationId, `S1 ${role}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function insertCustomer(pool: Pool, organizationId: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, 'S1 Klinik', 'clinic', 'active') RETURNING id`,
    [organizationId],
  )).rows[0]!.id;
}

async function insertSaleRow(
  pool: Pool,
  organizationId: string,
  userId: string,
  customerId: string,
  options: { status?: string; sourceVisitId?: string | null } = {},
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        customer_id, data_class, sale_source_visit_id)
     VALUES ($1, 'SALE', $2, 'Standalone agreement', $3, $3, $4, 'BUSINESS', $5)
     RETURNING id`,
    [organizationId, options.status ?? 'NEW', userId, customerId, options.sourceVisitId ?? null],
  )).rows[0]!.id;
}

function deliveryInput(fixture: Awaited<ReturnType<typeof saleFixture>>, clientActionId: string) {
  return {
    clientActionId,
    type: 'PRODUCT_DELIVERY' as const,
    title: 'Planlanmış ürün teslimi',
    description: null,
    customerId: fixture.customerId,
    contactId: null,
    assignedTo: fixture.staff.id,
    priority: 'normal' as const,
    dueDate: null,
    scheduledAt: '2026-10-14T11:00:00.000Z',
    scheduledEndsAt: '2026-10-14T11:30:00.000Z',
    overrideReason: null,
    deliveryPurpose: 'SALE' as const,
    deliveryNote: null,
    items: [{ productId: fixture.products[0]!, quantity: 2 }],
  };
}

type Row = Record<string, unknown>;

async function snapshotExistingRows(pool: Pool) {
  const read = async (table: string, orderBy: string): Promise<Row[]> =>
    (await pool.query(`SELECT *, xmin::text AS xmin FROM ${table} ORDER BY ${orderBy}`)).rows as Row[];
  return {
    jobCards: await read('job_cards', 'id'),
    saleDetails: await read('job_card_sale_details', 'job_card_id'),
    saleItems: await read('job_card_sale_items', 'id'),
    deliveryItems: await read('job_card_delivery_items', 'id'),
    activities: await read('job_card_activity_logs', 'id'),
    receipts: await read('processed_actions', 'id'),
    assignmentOffers: await read('job_card_assignment_offers', 'id'),
  };
}

function withoutDeliveryLink(rows: Row[]): Row[] {
  return rows.map(({ delivery_source_sale_id: _added, ...rest }) => {
    void _added;
    return rest;
  });
}

describe.skipIf(!databaseUrl)('SALE-002 S1 migration 071', () => {
  it('installs 071 as the exact catalog head and moves HEALTH_SCHEMA_VERSION', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    expect(catalog.count).toBe(71);
    expect(catalog.head?.version).toBe(MIGRATION_071);

    if (existsSync(distMigrationsDirectory)) {
      const distCatalog = await loadMigrationCatalog(distMigrationsDirectory);
      expect(distCatalog.head?.version).toBe(MIGRATION_071);
    }

    await withSchema(async (pool, schema) => {
      const store = new PostgresMigrationStore(pool);
      const applied = await runMigrations({ migrationsDirectory, store });
      expect(applied.appliedVersions).toHaveLength(71);
      expect(applied.appliedVersions[70]).toBe(MIGRATION_071);

      const history = (await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      )).rows.map((row) => row.version);
      expect(history).toHaveLength(71);
      expect(history[70]).toBe(MIGRATION_071);

      expect(await runMigrations({ migrationsDirectory, store })).toEqual({ appliedVersions: [] });
      expect((await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      )).rows.map((row) => row.version)).toEqual(history);

      if (existsSync(distSchemaCheck)) {
        const url = new URL(databaseUrl as string);
        url.searchParams.set('options', `-c search_path=${schema},public`);
        const current = runDistSchemaCheck(url.toString(), MIGRATION_071);
        expect(current.exitCode).toBe(0);
        expect(current.output).toMatch(/COMPATIBLE/);

        const previous = runDistSchemaCheck(url.toString(), MIGRATION_070);
        expect(previous.exitCode).not.toBe(0);
        expect(previous.output).toMatch(/HEALTH_SCHEMA_VERSION mismatch/);
        expect(current.output + previous.output).not.toMatch(/postgresql:\/\//);
      }
    });
  });

  it('upgrades an applied 070 database with a live sale and delivery without rewriting existing bytes', async () => {
    const previousDirectory = await migrationsUpTo(70);
    try {
      await withSchema(async (pool) => {
        const store = new PostgresMigrationStore(pool);
        const baseline = await runMigrations({ migrationsDirectory: previousDirectory, store });
        expect(baseline.appliedVersions).toHaveLength(70);
        expect(baseline.appliedVersions[69]).toBe(MIGRATION_070);

        const previousActivityEvents = await readCheckValues(pool, 'job_card_activity_logs_event_type_check');
        const previousOpenedReasons = await readCheckValues(
          pool,
          'job_card_assignment_offers_opened_reason_check',
        );

        const fixture = await saleFixture(pool);
        const sale = await fixture.service.createSaleFromVisit(
          fixture.staff,
          fixture.visitId,
          fixture.input,
        );
        const delivery = await fixture.service.createProductDelivery(
          fixture.manager,
          deliveryInput(fixture, 's1-migration-delivery'),
        );

        const before = await snapshotExistingRows(pool);
        expect(before.jobCards).toHaveLength(3);

        const upgrade = await runMigrations({ migrationsDirectory, store });
        expect(upgrade).toEqual({ appliedVersions: [MIGRATION_071] });

        const after = await snapshotExistingRows(pool);
        for (const row of after.jobCards) {
          expect(row.delivery_source_sale_id).toBeNull();
        }
        expect(withoutDeliveryLink(after.jobCards)).toEqual(before.jobCards);
        expect(after.saleDetails).toEqual(before.saleDetails);
        expect(after.saleItems).toEqual(before.saleItems);
        expect(after.deliveryItems).toEqual(before.deliveryItems);
        expect(after.activities).toEqual(before.activities);
        expect(after.receipts).toEqual(before.receipts);
        expect(after.assignmentOffers).toEqual(before.assignmentOffers);

        // The widened CHECKs keep every previously accepted literal.
        const activityEvents = await readCheckValues(pool, 'job_card_activity_logs_event_type_check');
        expect(activityEvents).toEqual(expect.arrayContaining(previousActivityEvents));
        expect(activityEvents).toContain('SALE_DELIVERY_CREATED');
        const openedReasons = await readCheckValues(pool, 'job_card_assignment_offers_opened_reason_check');
        expect(openedReasons).toEqual(expect.arrayContaining(previousOpenedReasons));
        expect(openedReasons).toContain('SALE_APPROVAL');

        // Existing rows stay addressable by the new link, and no re-apply happens.
        const linkable = await pool.query<{ delivery_source_sale_id: string }>(
          'UPDATE job_cards SET delivery_source_sale_id = $2 WHERE id = $1 RETURNING delivery_source_sale_id',
          [delivery.jobCardId, sale.jobCardId],
        );
        expect(linkable.rows[0]!.delivery_source_sale_id).toBe(sale.jobCardId);
        await pool.query('UPDATE job_cards SET delivery_source_sale_id = NULL WHERE id = $1', [
          delivery.jobCardId,
        ]);

        expect(await runMigrations({ migrationsDirectory, store })).toEqual({ appliedVersions: [] });
      });
    } finally {
      await rm(previousDirectory, { recursive: true, force: true });
    }
  });

  it('allows a source-less SALE, rejects a source on any other type and keeps the visit slot index', async () => {
    await withSchema(async (pool) => {
      await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('S1 source rules', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const customerId = await insertCustomer(pool, organizationId);

      const visitId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by, engagement_kind, started_at)
         VALUES ($1, 'SALES_MEETING', 'IN_PROGRESS', 'Clinic visit', $2, $2, 'CUSTOMER_VISIT', now()) RETURNING id`,
        [organizationId, staffId],
      )).rows[0]!.id;

      // R1: a SALE without a source is representable, twice (NULL is distinct in the slot index).
      const firstStandalone = await insertSaleRow(pool, organizationId, staffId, customerId);
      const secondStandalone = await insertSaleRow(pool, organizationId, staffId, customerId);
      expect(firstStandalone).not.toBe(secondStandalone);
      expect((await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_cards WHERE type='SALE' AND sale_source_visit_id IS NULL`,
      )).rows[0]!.n).toBe(2);

      // Only a SALE may carry a source.
      await expect(pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by, sale_source_visit_id)
         VALUES ($1, 'GENERAL_TASK', 'NEW', 'Carrier task', $2, $2, $3)`,
        [organizationId, staffId, visitId],
      )).rejects.toMatchObject({ code: '23514', constraint: 'job_cards_sale_source_type_check' });
      await expect(pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by, engagement_kind, sale_source_visit_id)
         VALUES ($1, 'SALES_MEETING', 'NEW', 'Carrier visit', $2, $2, 'CUSTOMER_VISIT', $3)`,
        [organizationId, staffId, visitId],
      )).rejects.toMatchObject({ code: '23514', constraint: 'job_cards_sale_source_type_check' });

      // A SALE may still carry its source visit.
      const saleFromVisit = await insertSaleRow(pool, organizationId, staffId, customerId, {
        sourceVisitId: visitId,
      });
      expect((await pool.query<{ sale_source_visit_id: string }>(
        'SELECT sale_source_visit_id FROM job_cards WHERE id = $1',
        [saleFromVisit],
      )).rows[0]!.sale_source_visit_id).toBe(visitId);

      // R16: the 057 one-active-sale-per-visit slot rule is not weakened.
      await expect(insertSaleRow(pool, organizationId, staffId, customerId, {
        status: 'NEW',
        sourceVisitId: visitId,
      })).rejects.toMatchObject({
        code: '23505',
        constraint: 'job_cards_one_active_sale_per_visit_idx',
      });

      const index = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'job_cards_one_active_sale_per_visit_idx'`,
      );
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0]!.indexdef).toMatch(/CREATE UNIQUE INDEX/);
      expect(index.rows[0]!.indexdef).toMatch(/WHERE/);
    });
  });

  it('enforces an all-or-none sale details source shape', async () => {
    await withSchema(async (pool) => {
      await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
      const fixture = await saleFixture(pool);
      const sale = await fixture.service.createSaleFromVisit(
        fixture.staff,
        fixture.visitId,
        fixture.input,
      );

      const nullable = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'job_card_sale_details'
            AND column_name = ANY($1::text[])
          ORDER BY column_name`,
        [['source_customer_name_snapshot', 'source_visit_title_snapshot', 'source_visit_version']],
      );
      expect(nullable.rows).toEqual([
        { column_name: 'source_customer_name_snapshot', is_nullable: 'YES' },
        { column_name: 'source_visit_title_snapshot', is_nullable: 'YES' },
        { column_name: 'source_visit_version', is_nullable: 'YES' },
      ]);

      const visitShape = await pool.query<Row>(
        'SELECT * FROM job_card_sale_details WHERE job_card_id = $1',
        [sale.jobCardId],
      );
      expect(visitShape.rows[0]).toMatchObject({
        source_visit_version: fixture.input.expectedSourceVersion,
        source_visit_title_snapshot: 'Clinic visit',
        source_customer_name_snapshot: 'Dental Klinik',
        source_planned_contact_id: fixture.plannedContactId,
        source_met_contact_id: fixture.metContactId,
      });

      // Pre-existing details CHECKs already reject some fragments, so the
      // assertion is that no partial shape can be stored at all, plus the
      // exact name and semantics of the new all-or-none constraint.
      const shapeConstraint = await pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = 'job_card_sale_details_source_shape_check'
            AND connamespace = current_schema()::regnamespace`,
      );
      expect(shapeConstraint.rows).toHaveLength(1);
      expect(shapeConstraint.rows[0]!.definition).toMatch(/source_met_contact_title_snapshot IS NULL/);
      expect(shapeConstraint.rows[0]!.definition).toMatch(/source_visit_version > 0/);

      for (const statement of [
        'UPDATE job_card_sale_details SET source_visit_version = NULL WHERE job_card_id = $1',
        'UPDATE job_card_sale_details SET source_visit_title_snapshot = NULL WHERE job_card_id = $1',
        'UPDATE job_card_sale_details SET source_customer_name_snapshot = NULL WHERE job_card_id = $1',
        'UPDATE job_card_sale_details SET source_planned_contact_id = NULL WHERE job_card_id = $1',
      ]) {
        await expect(pool.query(statement, [sale.jobCardId])).rejects.toMatchObject({ code: '23514' });
      }

      // The source-free shape (a standalone sale) is representable.
      const cleared = await pool.query<Row>(
        `UPDATE job_card_sale_details
            SET source_visit_version = NULL,
                source_visit_title_snapshot = NULL,
                source_customer_name_snapshot = NULL,
                source_planned_contact_id = NULL,
                source_planned_contact_name_snapshot = NULL,
                source_planned_contact_title_snapshot = NULL,
                source_met_contact_id = NULL,
                source_met_contact_name_snapshot = NULL,
                source_met_contact_title_snapshot = NULL
          WHERE job_card_id = $1
          RETURNING *`,
        [sale.jobCardId],
      );
      expect(cleared.rows[0]).toMatchObject({
        source_visit_version: null,
        source_visit_title_snapshot: null,
        source_customer_name_snapshot: null,
        source_planned_contact_id: null,
        source_planned_contact_name_snapshot: null,
        source_planned_contact_title_snapshot: null,
        source_met_contact_id: null,
        source_met_contact_name_snapshot: null,
        source_met_contact_title_snapshot: null,
        sale_contact_id: fixture.metContactId,
      });

      // A contact-only source fragment is neither of the two accepted shapes.
      await expect(pool.query(
        'UPDATE job_card_sale_details SET source_planned_contact_id = $2 WHERE job_card_id = $1',
        [sale.jobCardId, fixture.plannedContactId],
      )).rejects.toMatchObject({ code: '23514' });

      // The visit-origin shape can be restored.
      await pool.query(
        `UPDATE job_card_sale_details
            SET source_visit_version = $2,
                source_visit_title_snapshot = 'Clinic visit',
                source_customer_name_snapshot = 'Dental Klinik'
          WHERE job_card_id = $1`,
        [sale.jobCardId, fixture.input.expectedSourceVersion],
      );
    });
  });

  it('enforces the sale → delivery link foreign key, type, self, follow-up and uniqueness rules', async () => {
    await withSchema(async (pool) => {
      await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
      const fixture = await saleFixture(pool);
      const sale = await fixture.service.createSaleFromVisit(
        fixture.staff,
        fixture.visitId,
        fixture.input,
      );
      const firstDelivery = await fixture.service.createProductDelivery(
        fixture.manager,
        deliveryInput(fixture, 's1-link-first'),
      );
      const secondDelivery = await fixture.service.createProductDelivery(
        fixture.manager,
        {
          ...deliveryInput(fixture, 's1-link-second'),
          items: [{ productId: fixture.products[1]!, quantity: 1 }],
        },
      );

      const linked = await pool.query<{ delivery_source_sale_id: string }>(
        'UPDATE job_cards SET delivery_source_sale_id = $2 WHERE id = $1 RETURNING delivery_source_sale_id',
        [firstDelivery.jobCardId, sale.jobCardId],
      );
      expect(linked.rows[0]!.delivery_source_sale_id).toBe(sale.jobCardId);

      // One delivery per sale, ever.
      await expect(pool.query(
        'UPDATE job_cards SET delivery_source_sale_id = $2 WHERE id = $1',
        [secondDelivery.jobCardId, sale.jobCardId],
      )).rejects.toMatchObject({
        code: '23505',
        constraint: 'job_cards_one_delivery_per_sale_idx',
      });

      // No self-link.
      await expect(pool.query(
        'UPDATE job_cards SET delivery_source_sale_id = id WHERE id = $1',
        [firstDelivery.jobCardId],
      )).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_cards_delivery_source_self_check',
      });

      // Only a PRODUCT_DELIVERY may carry the link.
      await expect(pool.query(
        'UPDATE job_cards SET delivery_source_sale_id = $2 WHERE id = $1',
        [sale.jobCardId, firstDelivery.jobCardId],
      )).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_cards_delivery_source_type_check',
      });

      // Same-organization composite foreign key.
      const foreignOrganizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('S1 foreign org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const foreignStaffId = await insertUser(pool, foreignOrganizationId, 'STAFF');
      const foreignCustomerId = await insertCustomer(pool, foreignOrganizationId);
      const foreignSale = await insertSaleRow(
        pool,
        foreignOrganizationId,
        foreignStaffId,
        foreignCustomerId,
      );
      await expect(pool.query(
        'UPDATE job_cards SET delivery_source_sale_id = $2 WHERE id = $1',
        [firstDelivery.jobCardId, foreignSale],
      )).rejects.toMatchObject({
        code: '23503',
        constraint: 'job_cards_delivery_source_sale_fk',
      });

      // A sale-linked delivery can never also be a follow-up child.
      await pool.query('UPDATE job_cards SET delivery_source_sale_id = NULL WHERE id = $1', [
        firstDelivery.jobCardId,
      ]);
      await pool.query(
        `UPDATE job_cards
            SET source_job_card_id = $2, follow_up_instructions = 'S1 takip ziyareti'
          WHERE id = $1`,
        [firstDelivery.jobCardId, fixture.visitId],
      );
      await expect(pool.query(
        'UPDATE job_cards SET delivery_source_sale_id = $2 WHERE id = $1',
        [firstDelivery.jobCardId, sale.jobCardId],
      )).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_cards_delivery_source_not_follow_up_check',
      });
    });
  });
});
