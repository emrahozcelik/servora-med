import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const MIGRATIONS_001_TO_008 = [
  '001_auth_foundation.sql',
  '002_delivery_tracer.sql',
  '003_people.sql',
  '004_crm_contacts.sql',
  '005_product_catalog.sql',
  '006_jobcard_workspace.sql',
  '007_sales_meeting.sql',
  '008_meeting_approval_withdrawal.sql',
] as const;

const UPGRADE_FIXTURES = [
  { status: 'NEW', expectedStatus: 'NEW', plannedAt: null as Date | null },
  {
    status: 'PLANNED',
    expectedStatus: 'NEW',
    plannedAt: new Date('2026-07-10T09:00:00.000Z'),
  },
  {
    status: 'IN_PROGRESS',
    expectedStatus: 'IN_PROGRESS',
    plannedAt: new Date('2026-07-11T09:00:00.000Z'),
  },
] as const;

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await adminPool?.end();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createMigrationSubset(files: readonly string[]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'servora-med-job-acceptance-'));
  temporaryDirectories.push(directory);
  for (const file of files) {
    await writeFile(
      path.join(directory, file),
      await readFile(path.join(MIGRATIONS_DIRECTORY, file), 'utf8'),
      'utf8',
    );
  }
  return directory;
}

async function withIsolatedDatabase(
  run: (pool: Pool, store: PostgresMigrationStore) => Promise<void>,
) {
  const schema = `job_acceptance_${randomUUID().replaceAll('-', '')}`;
  await adminPool!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  });

  try {
    await run(pool, new PostgresMigrationStore(pool));
  } finally {
    await pool.end();
    await adminPool!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

function extractQuotedValues(definition: string) {
  return [...definition.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

async function readCheckValues(pool: Pool, constraintName: string) {
  const result = await pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conname = $1
        AND connamespace = current_schema()::regnamespace`,
    [constraintName],
  );
  expect(result.rows).toHaveLength(1);
  return extractQuotedValues(result.rows[0]!.definition);
}

async function createOrganizationAndStaff(pool: Pool, label: string) {
  const organization = await pool.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [label],
  );
  const organizationId = organization.rows[0]!.id;
  const staff = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'test-hash', 'STAFF') RETURNING id`,
    [organizationId, `${label} Staff`, `${randomUUID()}@test.local`],
  );
  return { organizationId, staffUserId: staff.rows[0]!.id };
}

describe.skipIf(!databaseUrl)('Job acceptance PostgreSQL migration 009', () => {
  it('upgrades 001-008 data: PLANNED becomes NEW, acceptance columns are null, history kept', async () => {
    await withIsolatedDatabase(async (pool, store) => {
      const baselineDirectory = await createMigrationSubset(MIGRATIONS_001_TO_008);
      const baseline = await runMigrations({ migrationsDirectory: baselineDirectory, store });
      expect(baseline.appliedVersions).toHaveLength(8);

      const { organizationId, staffUserId } = await createOrganizationAndStaff(pool, 'Acceptance');
      const plannedAtByTitle = new Map<string, Date | null>();

      for (const fixture of UPGRADE_FIXTURES) {
        const title = `job-${fixture.status}`;
        plannedAtByTitle.set(title, fixture.plannedAt);
        const startedAt = fixture.status === 'IN_PROGRESS' ? fixture.plannedAt : null;
        await pool.query(
          `INSERT INTO job_cards (
             organization_id, type, status, title, assigned_to, created_by,
             planned_at, started_at
           ) VALUES ($1, 'GENERAL_TASK', $2, $3, $4, $4, $5, $6)`,
          [organizationId, fixture.status, title, staffUserId, fixture.plannedAt, startedAt],
        );
      }

      const plannedJob = await pool.query<{ id: string }>(
        `SELECT id FROM job_cards WHERE organization_id = $1 AND title = 'job-PLANNED'`,
        [organizationId],
      );
      const plannedJobId = plannedJob.rows[0]!.id;
      await pool.query(
        `INSERT INTO job_card_activity_logs (
           organization_id, job_card_id, actor_id, event_type, old_value, new_value
         ) VALUES (
           $1, $2, $3, 'JOB_PLANNED',
           '{"status":"NEW"}'::jsonb, '{"status":"PLANNED"}'::jsonb
         )`,
        [organizationId, plannedJobId, staffUserId],
      );

      const upgrade = await runMigrations({
        migrationsDirectory: MIGRATIONS_DIRECTORY,
        store,
      });
      expect(upgrade).toEqual({
        appliedVersions: [
          '009_job_acceptance_and_scheduling',
          '010_entity_delete_audit',
          '011_create_realtime_events',
          '012_create_in_app_notifications',
        ],
      });

      const rows = await pool.query<{
        title: string;
        status: string;
        planned_at: Date | null;
        accepted_at: Date | null;
        accepted_by: string | null;
        scheduled_at: Date | null;
      }>(
        `SELECT title, status, planned_at, accepted_at, accepted_by, scheduled_at
           FROM job_cards
          WHERE organization_id = $1
          ORDER BY title`,
        [organizationId],
      );

      expect(rows.rows).toHaveLength(UPGRADE_FIXTURES.length);
      for (const fixture of UPGRADE_FIXTURES) {
        const row = rows.rows.find((candidate) => candidate.title === `job-${fixture.status}`);
        expect(row).toBeDefined();
        expect(row!.status).toBe(fixture.expectedStatus);
        expect(row!.accepted_at).toBeNull();
        expect(row!.accepted_by).toBeNull();
        expect(row!.scheduled_at).toBeNull();
        if (fixture.plannedAt === null) {
          expect(row!.planned_at).toBeNull();
        } else {
          expect(row!.planned_at?.toISOString()).toBe(fixture.plannedAt.toISOString());
        }
      }

      const history = await pool.query<{ event_type: string; planned_at: Date | null }>(
        `SELECT a.event_type, j.planned_at
           FROM job_card_activity_logs a
           JOIN job_cards j
             ON j.organization_id = a.organization_id AND j.id = a.job_card_id
          WHERE a.organization_id = $1 AND a.job_card_id = $2`,
        [organizationId, plannedJobId],
      );
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0]!.event_type).toBe('JOB_PLANNED');
      expect(history.rows[0]!.planned_at?.toISOString()).toBe(
        plannedAtByTitle.get('job-PLANNED')!.toISOString(),
      );

      const statuses = await readCheckValues(pool, 'job_cards_status_check');
      expect(new Set(statuses)).toEqual(new Set([
        'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
        'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED',
      ]));
      expect(statuses).not.toContain('PLANNED');

      const activityEvents = await readCheckValues(
        pool,
        'job_card_activity_logs_event_type_check',
      );
      expect(activityEvents).toContain('JOB_ACCEPTED');
      expect(activityEvents).toContain('JOB_PLANNED');

      const plannedConstraint = await pool.query(
        `SELECT 1 FROM pg_constraint
          WHERE conname = 'job_cards_planned_status_timestamp_check'
            AND connamespace = current_schema()::regnamespace`,
      );
      expect(plannedConstraint.rows).toHaveLength(0);

      await expect(pool.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by
         ) VALUES ($1, 'GENERAL_TASK', 'ACCEPTED', 'Missing acceptance facts', $2, $2)`,
        [organizationId, staffUserId],
      )).rejects.toMatchObject({ code: '23514' });

      await expect(pool.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           accepted_at, accepted_by, scheduled_at
         ) VALUES (
           $1, 'GENERAL_TASK', 'ACCEPTED', 'Accepted with schedule', $2, $2,
           NOW(), $2, '2026-07-18T10:00:00.000Z'
         )`,
        [organizationId, staffUserId],
      )).resolves.toMatchObject({ rowCount: 1 });

      await expect(pool.query(
        `INSERT INTO job_card_activity_logs (
           organization_id, job_card_id, actor_id, event_type
         )
         SELECT organization_id, id, $2, 'JOB_ACCEPTED'
           FROM job_cards
          WHERE organization_id = $1 AND title = 'Accepted with schedule'`,
        [organizationId, staffUserId],
      )).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it('makes delivered_at nullable without backfilling from scheduled_at', async () => {
    await withIsolatedDatabase(async (pool, store) => {
      const upgrade = await runMigrations({
        migrationsDirectory: MIGRATIONS_DIRECTORY,
        store,
      });
      expect(upgrade.appliedVersions).toContain('009_job_acceptance_and_scheduling');

      const nullable = await pool.query<{ is_nullable: string }>(
        `SELECT is_nullable
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'job_card_delivery_items'
            AND column_name = 'delivered_at'`,
      );
      expect(nullable.rows).toEqual([{ is_nullable: 'YES' }]);

      const { organizationId, staffUserId } = await createOrganizationAndStaff(
        pool,
        'Delivery Time Split',
      );
      const customer = await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type)
         VALUES ($1, 'Planned Clinic', 'clinic') RETURNING id`,
        [organizationId],
      );
      const product = await pool.query<{ id: string }>(
        `INSERT INTO products (organization_id, name, unit)
         VALUES ($1, 'Implant Kit', 'adet') RETURNING id`,
        [organizationId],
      );
      const scheduledAt = new Date('2026-07-20T10:00:00.000Z');
      const startedAt = new Date('2026-07-21T08:00:00.000Z');
      const job = await pool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at, started_at
         ) VALUES (
           $1, 'PRODUCT_DELIVERY', 'IN_PROGRESS', 'Planned delivery line', $2, $3, $3, $4, $5
         ) RETURNING id`,
        [organizationId, customer.rows[0]!.id, staffUserId, scheduledAt, startedAt],
      );

      const plannedItem = await pool.query<{
        delivered_at: Date | null;
      }>(
        `INSERT INTO job_card_delivery_items (
           organization_id, job_card_id, product_id, delivery_purpose,
           delivered_at, quantity, unit, product_name_snapshot
         ) VALUES ($1, $2, $3, 'SALE', NULL, 1, 'adet', 'Implant Kit')
         RETURNING delivered_at`,
        [organizationId, job.rows[0]!.id, product.rows[0]!.id],
      );
      expect(plannedItem.rows[0]!.delivered_at).toBeNull();

      const jobRow = await pool.query<{ scheduled_at: Date | null }>(
        'SELECT scheduled_at FROM job_cards WHERE id = $1',
        [job.rows[0]!.id],
      );
      expect(jobRow.rows[0]!.scheduled_at?.toISOString()).toBe(scheduledAt.toISOString());

      const actualDeliveredAt = new Date('2026-07-21T14:30:00.000Z');
      const actualItem = await pool.query<{ delivered_at: Date | null }>(
        `UPDATE job_card_delivery_items
            SET delivered_at = $2
          WHERE organization_id = $1 AND job_card_id = $3
          RETURNING delivered_at`,
        [organizationId, actualDeliveredAt, job.rows[0]!.id],
      );
      expect(actualItem.rows[0]!.delivered_at?.toISOString()).toBe(
        actualDeliveredAt.toISOString(),
      );
      expect(actualItem.rows[0]!.delivered_at?.toISOString()).not.toBe(
        scheduledAt.toISOString(),
      );
    });
  });
});
