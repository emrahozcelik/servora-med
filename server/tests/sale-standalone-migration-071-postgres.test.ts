import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { loadMigrationCatalog, type MigrationCatalog } from '../src/db/migration-catalog.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { withIntentSchema } from './support/lifecycle-intent-harness.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const MIGRATION_071 = '071_sale_standalone_and_delivery_link';
// SALE-002 S2 adds 072 (R9) after this slice; the 071 bytes are unchanged.
const MIGRATION_072 = '072_sale_submit_without_start';
const MIGRATION_073 = '073_assignment_offer_time_proposal';
const MIGRATION_074 = '074_installation_operator_and_module_state';
const MIGRATION_075 = '075_installation_module_registry_widening';

async function insertUser(pool: Pool, organizationId: string, role = 'STAFF') {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id,name,email,password_hash,role)
     VALUES ($1,'SALE-002 user',$2,'test-hash',$3) RETURNING id`,
    [organizationId, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

type Base = {
  organizationId: string;
  userId: string;
  customerId: string;
  contactId: string;
  productId: string;
};

async function insertBase(pool: Pool): Promise<Base> {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name,timezone) VALUES ('SALE-002 migration','Europe/Istanbul') RETURNING id`,
  )).rows[0]!.id;
  const userId = await insertUser(pool, organizationId);
  const customerId = (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id,name,customer_type,status)
     VALUES ($1,'Migration clinic','clinic','active') RETURNING id`, [organizationId],
  )).rows[0]!.id;
  const contactId = (await pool.query<{ id: string }>(
    `INSERT INTO contacts (organization_id,customer_id,name,title)
     VALUES ($1,$2,'Migration doctor','Dr.') RETURNING id`, [organizationId, customerId],
  )).rows[0]!.id;
  const productId = (await pool.query<{ id: string }>(
    `INSERT INTO products (organization_id,name,sku) VALUES ($1,'Migration product','SKU-MIG') RETURNING id`,
    [organizationId],
  )).rows[0]!.id;
  return { organizationId, userId, customerId, contactId, productId };
}

async function insertJob(pool: Pool, base: Base, type: string, extra: {
  customerId?: string | null; engagementKind?: string | null;
} = {}) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (organization_id,type,status,title,customer_id,assigned_to,created_by,engagement_kind)
     VALUES ($1,$2,'NEW','SALE-002 row',$3,$4,$4,$5) RETURNING id`,
    [base.organizationId, type, extra.customerId === undefined ? base.customerId : extra.customerId,
      base.userId, extra.engagementKind ?? null],
  )).rows[0]!.id;
}

async function insertVisit(pool: Pool, base: Base) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (organization_id,type,status,title,customer_id,assigned_to,created_by,engagement_kind,started_at)
     VALUES ($1,'SALES_MEETING','IN_PROGRESS','Migration visit',$2,$3,$3,'CUSTOMER_VISIT',NOW()) RETURNING id`,
    [base.organizationId, base.customerId, base.userId],
  )).rows[0]!.id;
}

async function insertStandaloneDetails(pool: Pool, base: Base, jobCardId: string, source: {
  version?: number | null; title?: string | null; customerName?: string | null; plannedContactId?: string | null;
} = {}) {
  await pool.query(
    `INSERT INTO job_card_sale_details
       (organization_id,job_card_id,sold_at,sale_contact_id,sale_contact_name_snapshot,sale_contact_title_snapshot,
        source_visit_version,source_visit_title_snapshot,source_customer_name_snapshot,
        source_planned_contact_id,source_planned_contact_name_snapshot,source_planned_contact_title_snapshot)
     VALUES ($1,$2,NOW(),$3,'Migration doctor','Dr.',$4,$5,$6,$7,$8,$9)`,
    [base.organizationId, jobCardId, base.contactId, source.version ?? null, source.title ?? null,
      source.customerName ?? null, source.plannedContactId ?? null,
      source.plannedContactId ? 'Migration doctor' : null, null],
  );
}

describe.skipIf(!databaseUrl)('SALE-002 migration 071', () => {
  it('installs the standalone/carried-source shape, the one-delivery link and both vocabularies', async () => {
    await withIntentSchema(databaseUrl, async (pool, schema) => {
      const base = await insertBase(pool);

      // R1: a SALE without a source is representable; multiple standalone sales coexist.
      const standalone = await insertJob(pool, base, 'SALE');
      await insertStandaloneDetails(pool, base, standalone);
      const standaloneSecond = await insertJob(pool, base, 'SALE');
      await insertStandaloneDetails(pool, base, standaloneSecond);

      // R2: a partially-null source shape and a source-only-planned shape are rejected.
      const partial = await insertJob(pool, base, 'SALE');
      await expect(insertStandaloneDetails(pool, base, partial, { version: 2, title: null, customerName: null }))
        .rejects.toMatchObject({ code: '23514', constraint: 'job_card_sale_details_source_shape_check' });
      await expect(insertStandaloneDetails(pool, base, partial, { plannedContactId: base.contactId }))
        .rejects.toMatchObject({ code: '23514', constraint: 'job_card_sale_details_source_shape_check' });

      // Visit-origin shape is still accepted and a non-SALE source is rejected.
      const visit = await insertVisit(pool, base);
      const visitSale = await insertJob(pool, base, 'SALE');
      await insertStandaloneDetails(pool, base, visitSale, {
        version: 1, title: 'Migration visit', customerName: 'Migration clinic',
      });
      await pool.query('UPDATE job_cards SET sale_source_visit_id=$2 WHERE id=$1', [visitSale, visit]);
      const task = await insertJob(pool, base, 'GENERAL_TASK', { customerId: null });
      await expect(pool.query('UPDATE job_cards SET sale_source_visit_id=$2 WHERE id=$1', [task, visit]))
        .rejects.toMatchObject({ code: '23514', constraint: 'job_cards_sale_source_type_check' });

      // R8: only a PRODUCT_DELIVERY may carry the link, once, and never as its own follow-up.
      const delivery = await insertJob(pool, base, 'PRODUCT_DELIVERY');
      await pool.query('UPDATE job_cards SET delivery_source_sale_id=$2 WHERE id=$1', [delivery, standalone]);
      const secondDelivery = await insertJob(pool, base, 'PRODUCT_DELIVERY');
      await expect(pool.query('UPDATE job_cards SET delivery_source_sale_id=$2 WHERE id=$1',
        [secondDelivery, standalone]))
        .rejects.toMatchObject({ code: '23505', constraint: 'job_cards_one_delivery_per_sale_idx' });
      await expect(pool.query('UPDATE job_cards SET delivery_source_sale_id=id WHERE id=$1', [secondDelivery]))
        .rejects.toMatchObject({ code: '23514', constraint: 'job_cards_delivery_source_self_check' });
      await expect(pool.query('UPDATE job_cards SET delivery_source_sale_id=$2 WHERE id=$1', [visitSale, standalone]))
        .rejects.toMatchObject({ code: '23514', constraint: 'job_cards_delivery_source_type_check' });
      const foreignOrg = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Foreign SALE-002') RETURNING id`,
      )).rows[0]!.id;
      const foreignUser = await insertUser(pool, foreignOrg);
      const foreignCustomer = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id,name,customer_type,status)
         VALUES ($1,'Foreign clinic','clinic','active') RETURNING id`, [foreignOrg],
      )).rows[0]!.id;
      const foreignSale = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id,type,status,title,customer_id,assigned_to,created_by)
         VALUES ($1,'SALE','NEW','Foreign sale',$2,$3,$3) RETURNING id`,
        [foreignOrg, foreignCustomer, foreignUser],
      )).rows[0]!.id;
      await expect(pool.query('UPDATE job_cards SET delivery_source_sale_id=$2 WHERE id=$1',
        [secondDelivery, foreignSale]))
        .rejects.toMatchObject({ code: '23503', constraint: 'job_cards_delivery_source_sale_fk' });
      await pool.query('UPDATE job_cards SET delivery_source_sale_id=$2 WHERE id=$1', [secondDelivery, visitSale]);
      const parent = await insertJob(pool, base, 'GENERAL_TASK', { customerId: null });
      await expect(pool.query(
        `INSERT INTO job_cards (organization_id,type,status,title,assigned_to,created_by,source_job_card_id,delivery_source_sale_id)
         VALUES ($1,'PRODUCT_DELIVERY','NEW','Linked follow-up child',$2,$2,$3,$4)`,
        [base.organizationId, base.userId, parent, standaloneSecond],
      )).rejects.toMatchObject({ code: '23514', constraint: 'job_cards_delivery_source_not_follow_up_check' });

      // R13/R14: the new values are accepted and the previous vocabulary stays valid.
      const manager = await insertUser(pool, base.organizationId, 'MANAGER');
      for (const reason of ['SALE_APPROVAL', 'REOFFER']) {
        await pool.query(
          `INSERT INTO job_card_assignment_offers
             (organization_id,job_card_id,assignee_user_id,opened_at,opened_reason,opened_by,acceptance_due_at,state)
           VALUES ($1,$2,$3,NOW(),$4,$5,NOW() + INTERVAL '10 minutes','OPEN')`,
          [base.organizationId, reason === 'SALE_APPROVAL' ? delivery : task, base.userId, reason, manager],
        );
      }
      for (const event of ['SALE_DELIVERY_CREATED', 'SALE_FROM_VISIT_CREATED']) {
        await pool.query(
          `INSERT INTO job_card_activity_logs (organization_id,job_card_id,event_type) VALUES ($1,$2,$3)`,
          [base.organizationId, standalone, event],
        );
      }

      const catalog: MigrationCatalog = await loadMigrationCatalog(migrationsDirectory);
      expect(catalog.head?.version).toBe(MIGRATION_075);
      expect(catalog.count).toBe(75);
      expect((await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      )).rows[0]!.version).toBe(MIGRATION_075);
      expect(schema).toMatch(/^lcproof_/);
    });
  });

  it('upgrades an applied 070 database with existing sales and deliveries and applies 071 once', async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const schema = `sale071_${randomUUID().replaceAll('-', '')}`.toLowerCase();
    const previous = await mkdtemp(path.join(tmpdir(), 'sale071-head070-'));
    let pool: Pool | null = null;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
      for (const filename of (await readdir(migrationsDirectory)).filter(
        (name) => /^\d{3}_.+\.sql$/.test(name) && Number(name.slice(0, 3)) <= 70,
      )) {
        await copyFile(path.join(migrationsDirectory, filename), path.join(previous, filename));
      }
      const store = new PostgresMigrationStore(pool);
      const baseRun = await runMigrations({ migrationsDirectory: previous, store });
      expect(baseRun.appliedVersions.at(-1)).toBe('070_overdue_incident_invalidation_closure');
      expect(baseRun.appliedVersions).toHaveLength(70);

      // The pre-upgrade rows are inserted with SQL. The application only runs at
      // the exact schema head (startup guard), so a service fixture cannot build
      // rows on an older schema; the upgrade's byte-preservation contract below
      // is unchanged.
      const base = await insertBase(pool);
      const visit = await insertVisit(pool, base);
      // At 070 the source-presence CHECK is immediate, so the visit-origin
      // SALE is inserted with its source in one statement.
      const sale = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, customer_id, assigned_to, created_by,
            sale_source_visit_id)
         VALUES ($1, 'SALE', 'NEW', 'SALE-002 row', $2, $3, $3, $4) RETURNING id`,
        [base.organizationId, base.customerId, base.userId, visit],
      )).rows[0]!.id;
      await insertStandaloneDetails(pool, base, sale, {
        version: 1, title: 'Migration visit', customerName: 'Migration clinic',
      });
      await pool.query(
        `INSERT INTO job_card_sale_items
           (organization_id,job_card_id,product_id,quantity,product_name_snapshot,sort_order)
         VALUES ($1,$2,$3,1,'Migration product',0)`,
        [base.organizationId, sale, base.productId],
      );
      const delivery = await insertJob(pool, base, 'PRODUCT_DELIVERY');
      await pool.query(
        `INSERT INTO job_card_delivery_items
           (organization_id,job_card_id,product_id,delivery_purpose,quantity,product_name_snapshot,sort_order)
         VALUES ($1,$2,$3,'SALE',1,'Migration product',0)`,
        [base.organizationId, delivery, base.productId],
      );
      const saleBefore = (await pool.query('SELECT *,xmin::text AS xmin FROM job_cards WHERE id=$1',
        [sale])).rows[0];
      const deliveryBefore = (await pool.query('SELECT *,xmin::text AS xmin FROM job_cards WHERE id=$1',
        [delivery])).rows[0];
      const detailsBefore = (await pool.query('SELECT *,xmin::text AS xmin FROM job_card_sale_details WHERE job_card_id=$1',
        [sale])).rows[0];
      const itemsBefore = (await pool.query('SELECT *,xmin::text AS xmin FROM job_card_sale_items WHERE job_card_id=$1 ORDER BY id',
        [sale])).rows;

      const upgrade = await runMigrations({ migrationsDirectory, store });
      expect(upgrade).toEqual({ appliedVersions: [MIGRATION_071, MIGRATION_072, MIGRATION_073, MIGRATION_074, MIGRATION_075] });

      const saleAfter = (await pool.query('SELECT *,xmin::text AS xmin FROM job_cards WHERE id=$1',
        [sale])).rows[0];
      expect(saleAfter.delivery_source_sale_id).toBeNull();
      const { delivery_source_sale_id: _link, ...saleAfterOld } = saleAfter;
      expect(saleAfterOld).toEqual(saleBefore);
      const deliveryAfter = (await pool.query('SELECT *,xmin::text AS xmin FROM job_cards WHERE id=$1',
        [delivery])).rows[0];
      expect(deliveryAfter.delivery_source_sale_id).toBeNull();
      const { delivery_source_sale_id: _deliveryLink, ...deliveryAfterOld } = deliveryAfter;
      expect(deliveryAfterOld).toEqual(deliveryBefore);
      expect((await pool.query('SELECT *,xmin::text AS xmin FROM job_card_sale_details WHERE job_card_id=$1',
        [sale])).rows[0]).toEqual(detailsBefore);
      expect((await pool.query('SELECT *,xmin::text AS xmin FROM job_card_sale_items WHERE job_card_id=$1 ORDER BY id',
        [sale])).rows).toEqual(itemsBefore);

      const history = (await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      )).rows;
      expect(history).toHaveLength(75);
      expect(history.at(-1)!.version).toBe(MIGRATION_075);
      expect(await runMigrations({ migrationsDirectory, store })).toEqual({ appliedVersions: [] });

      // Forward path: the new standalone create is reachable after the
      // schema-first upgrade, and it still writes no source.
      const service = new JobCardService(
        new PostgresJobCardRepository(pool), () => new Date('2026-10-16T09:00:00.000Z'),
      );
      const staff: JobCardActor = {
        id: base.userId, organizationId: base.organizationId, role: 'STAFF',
      };
      const standalone = await service.createStandaloneSale(staff, {
        clientActionId: 'post-upgrade-standalone', title: 'Yeni telefon siparişi', description: null,
        customerId: base.customerId, assignedTo: base.userId, soldAt: '2026-10-16T09:00:00.000Z',
        saleContactId: null, items: [{ productId: base.productId, quantity: 1 }],
      });
      expect((await pool.query(
        'SELECT sale_source_visit_id,delivery_source_sale_id FROM job_cards WHERE id=$1', [standalone.jobCardId],
      )).rows[0]).toEqual({ sale_source_visit_id: null, delivery_source_sale_id: null });
    } finally {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(previous, { recursive: true, force: true });
    }
  });
});
