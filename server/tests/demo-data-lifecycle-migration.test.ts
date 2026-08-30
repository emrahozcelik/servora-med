import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { assertDemoDestructiveTestDatabaseSafe } from './support/demo-destructive-guard.js';

const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const migration040Path = path.join(migrationsDirectory, '040_demo_lifecycle_simplification.sql');
const migration040 = await readFile(migration040Path, 'utf8');
const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl) assertDemoDestructiveTestDatabaseSafe(databaseUrl);

const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 4 }) : null;
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await adminPool?.end();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createMigrationSubset(lastNumber: number) {
  const directory = await mkdtemp(path.join(tmpdir(), 'servora-med-d4-migrations-'));
  temporaryDirectories.push(directory);

  const names = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith('.sql'))
    .filter((name) => Number.parseInt(name.slice(0, 3), 10) <= lastNumber)
    .sort();

  for (const name of names) {
    await writeFile(
      path.join(directory, name),
      await readFile(path.join(migrationsDirectory, name), 'utf8'),
      'utf8',
    );
  }

  return directory;
}

async function withIsolatedDatabase(run: (pool: Pool) => Promise<void>) {
  const schema = `d4_migration_${randomUUID().replaceAll('-', '')}`;
  await adminPool!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  });

  try {
    await run(pool);
  } finally {
    await pool.end();
    await adminPool!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

async function applyThrough(pool: Pool, lastNumber: number) {
  const directory = await createMigrationSubset(lastNumber);
  return runMigrations({
    migrationsDirectory: directory,
    store: new PostgresMigrationStore(pool),
  });
}

async function createLegacyFixture(pool: Pool, withDemoRoot = false) {
  const organization = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ('D4 migration organization') RETURNING id`,
  );
  const organizationId = organization.rows[0]!.id;
  const businessAdmin = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'D4 Business Admin', $2, 'test-hash', 'ADMIN')
     RETURNING id`,
    [organizationId, `${randomUUID()}@d4.test`],
  );
  const businessAdminId = businessAdmin.rows[0]!.id;
  const sentinel = await pool.query<{ id: string; name: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, 'D4 Business Sentinel', 'clinic', 'active')
     RETURNING id, name`,
    [organizationId],
  );

  const datasetId = randomUUID();
  const creatorSnapshot = randomUUID();
  await pool.query(
    `INSERT INTO demo_datasets
       (id, organization_id, dataset_key, seed_version, status,
        created_by, created_by_user_id_snapshot, purged_at)
     VALUES ($1, $2, 'legacy-d4', 'demo-standard-v1', 'PURGED', NULL, $3, NOW())`,
    [datasetId, organizationId, creatorSnapshot],
  );

  if (withDemoRoot) {
    await pool.query(
      `INSERT INTO customers
         (organization_id, name, customer_type, status, data_class, demo_dataset_id)
       VALUES ($1, 'Legacy D4 Demo Root', 'clinic', 'active', 'DEMO', $2)`,
      [organizationId, datasetId],
    );
  }

  const operationId = randomUUID();
  const clientActionId = randomUUID();
  const planHash = 'a'.repeat(64);
  const completedAt = '2026-08-30T08:00:00.000Z';
  await pool.query(
    `INSERT INTO demo_dataset_purge_operations
       (id, organization_id, dataset_id, client_action_id, plan_hash,
        requested_by_user_id_snapshot, dataset_key, seed_version, status,
        response_body, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'legacy-d4', 'demo-standard-v1', 'COMPLETED', $7, $8)`,
    [
      operationId,
      organizationId,
      datasetId,
      clientActionId,
      planHash,
      creatorSnapshot,
      JSON.stringify({
        operationId,
        status: 'COMPLETED',
        dataset: {
          id: datasetId,
          organizationId,
          datasetKey: 'legacy-d4',
          seedVersion: 'demo-standard-v1',
          status: 'PURGED',
          createdAt: completedAt,
          createdBy: creatorSnapshot,
          purgedAt: completedAt,
        },
        datasetKey: 'legacy-d4',
        seedVersion: 'demo-standard-v1',
        planHash,
        affectedCounts: {
          users: 0,
          staffProfiles: 0,
          customers: 0,
          contacts: 0,
          products: 0,
          jobCards: 0,
          deliveryItems: 0,
          notes: 0,
          confidentialNotes: 0,
          activities: 0,
          followUps: 0,
          calendarEvents: 0,
          conversations: 0,
          messages: 0,
          notifications: 0,
          reminders: 0,
          realtimeEvents: 0,
        },
        retained: { auditActorDetaches: 2 },
        completedAt,
      }),
      completedAt,
    ],
  );

  return {
    organizationId,
    businessAdminId,
    sentinelId: sentinel.rows[0]!.id,
    sentinelName: sentinel.rows[0]!.name,
    datasetId,
    operationId,
    clientActionId,
    planHash,
  };
}

async function createActiveFixture(pool: Pool) {
  const organization = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ('D4 active migration organization') RETURNING id`,
  );
  const organizationId = organization.rows[0]!.id;
  const businessAdmin = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'D4 Active Business Admin', $2, 'test-hash', 'ADMIN')
     RETURNING id`,
    [organizationId, `${randomUUID()}@d4.test`],
  );
  const businessSentinel = await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, 'D4 Active Business Sentinel', 'clinic', 'active')
     RETURNING id`,
    [organizationId],
  );

  const datasetId = randomUUID();
  await pool.query(
    `INSERT INTO demo_datasets
       (id, organization_id, dataset_key, seed_version, status,
        created_by, created_by_user_id_snapshot, purged_at)
     VALUES ($1, $2, 'active-d4', 'demo-standard-v1', 'ACTIVE', $3, NULL, NULL)`,
    [datasetId, organizationId, businessAdmin.rows[0]!.id],
  );
  const demoUser = await pool.query<{ id: string }>(
    `INSERT INTO users
       (organization_id, name, email, password_hash, role, data_class, demo_dataset_id)
     VALUES ($1, 'D4 Active Demo Staff', $2, 'test-hash', 'STAFF', 'DEMO', $3)
     RETURNING id`,
    [organizationId, `${randomUUID()}@demo.d4.test`, datasetId],
  );
  const demoCustomer = await pool.query<{ id: string }>(
    `INSERT INTO customers
       (organization_id, name, customer_type, assigned_staff_user_id, status,
        data_class, demo_dataset_id)
     VALUES ($1, 'D4 Active Demo Clinic', 'clinic', $2, 'active', 'DEMO', $3)
     RETURNING id`,
    [organizationId, demoUser.rows[0]!.id, datasetId],
  );
  const demoContact = await pool.query<{ id: string }>(
    `INSERT INTO contacts (organization_id, customer_id, name, title, is_primary)
     VALUES ($1, $2, 'D4 Active Demo Contact', 'Purchasing', TRUE)
     RETURNING id`,
    [organizationId, demoCustomer.rows[0]!.id],
  );

  return {
    organizationId,
    businessAdminId: businessAdmin.rows[0]!.id,
    businessSentinelId: businessSentinel.rows[0]!.id,
    datasetId,
    demoUserId: demoUser.rows[0]!.id,
    demoCustomerId: demoCustomer.rows[0]!.id,
    demoContactId: demoContact.rows[0]!.id,
  };
}

describe('040 Demo lifecycle simplification migration contract', () => {
  it('adds the narrow D4 receipt/audit vocabulary and active-only registry boundary', () => {
    expect(migration040).toContain("'DEMO_DATASET_PURGED'");
    expect(migration040).toContain('DROP CONSTRAINT demo_dataset_purge_operations_dataset_fk');
    expect(migration040).toContain("WHERE status = 'PURGED'");
    expect(migration040).toContain("data_class = 'DEMO' AND demo_dataset_id = legacy.id");
    expect(migration040).toContain('demo_datasets_active_status_check');
    expect(migration040).toContain('demo_datasets_active_creator_attribution_check');
    expect(migration040).not.toContain('DEMO_DATASET_ALREADY_PURGED');
    expect(migration040).not.toMatch(/DROP\s+(TABLE|SCHEMA|DATABASE|COLUMN)/i);
  });
});

describe.skipIf(!databaseUrl)('040 Demo lifecycle simplification PostgreSQL migration', () => {
  it('reconciles empty legacy PURGED rows, preserves the receipt, and leaves BUSINESS data intact', async () => {
    await withIsolatedDatabase(async (pool) => {
      const baseline = await applyThrough(pool, 39);
      expect(baseline.appliedVersions).toHaveLength(39);
      const fixture = await createLegacyFixture(pool);

      const upgrade = await applyThrough(pool, 40);
      expect(upgrade.appliedVersions).toEqual(['040_demo_lifecycle_simplification']);

      const dataset = await pool.query(
        'SELECT id FROM demo_datasets WHERE organization_id = $1 AND id = $2',
        [fixture.organizationId, fixture.datasetId],
      );
      expect(dataset.rows).toHaveLength(0);

      const receipt = await pool.query<{
        status: string;
        dataset_id: string;
        response_body: Record<string, unknown>;
      }>(
        `SELECT status, dataset_id, response_body
           FROM demo_dataset_purge_operations
          WHERE id = $1`,
        [fixture.operationId],
      );
      expect(receipt.rows[0]).toEqual({
        status: 'COMPLETED',
        dataset_id: fixture.datasetId,
        response_body: {
          operationId: fixture.operationId,
          status: 'COMPLETED',
          datasetId: fixture.datasetId,
          datasetKey: 'legacy-d4',
          seedVersion: 'demo-standard-v1',
          planHash: fixture.planHash,
          affectedCounts: {
            users: 0,
            staffProfiles: 0,
            customers: 0,
            contacts: 0,
            products: 0,
            jobCards: 0,
            deliveryItems: 0,
            notes: 0,
            confidentialNotes: 0,
            activities: 0,
            followUps: 0,
            calendarEvents: 0,
            conversations: 0,
            messages: 0,
            notifications: 0,
            reminders: 0,
            realtimeEvents: 0,
          },
          retained: { auditActorDetaches: 2 },
          completedAt: '2026-08-30T08:00:00.000Z',
        },
      });

      const sentinel = await pool.query<{ id: string; name: string; data_class: string }>(
        'SELECT id, name, data_class FROM customers WHERE id = $1',
        [fixture.sentinelId],
      );
      expect(sentinel.rows).toEqual([{
        id: fixture.sentinelId,
        name: fixture.sentinelName,
        data_class: 'BUSINESS',
      }]);

      const receiptForeignKey = await pool.query(
        `SELECT 1
           FROM pg_constraint
          WHERE conname = 'demo_dataset_purge_operations_dataset_fk'
            AND connamespace = current_schema()::regnamespace`,
      );
      expect(receiptForeignKey.rows).toHaveLength(0);

      const eventTypes = await pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = 'audit_events_event_type_check'
            AND connamespace = current_schema()::regnamespace`,
      );
      expect(eventTypes.rows[0]?.definition).toContain("'DEMO_DATASET_PURGED'");

      await expect(pool.query(
        `INSERT INTO demo_datasets
           (organization_id, dataset_key, seed_version, status,
            created_by, created_by_user_id_snapshot, purged_at)
         VALUES ($1, 'new-purged', 'demo-standard-v1', 'PURGED', NULL, $2, NOW())`,
        [fixture.organizationId, randomUUID()],
      )).rejects.toMatchObject({ code: '23514' });

      await expect(pool.query(
        `INSERT INTO audit_events
           (organization_id, actor_user_id, subject_type, subject_id, event_type)
         VALUES ($1, $2, 'DEMO_DATASET', $3, 'DEMO_DATASET_PURGED')`,
        [fixture.organizationId, fixture.businessAdminId, fixture.datasetId],
      )).resolves.toBeDefined();
    });
  });

  it('preserves an existing ACTIVE dataset and its Demo child graph while applying 040', async () => {
    await withIsolatedDatabase(async (pool) => {
      const baseline = await applyThrough(pool, 39);
      expect(baseline.appliedVersions).toHaveLength(39);
      const fixture = await createActiveFixture(pool);

      const snapshot = async () => ({
        dataset: (await pool.query(
          `SELECT id::text AS id, dataset_key, seed_version, status,
                  created_by::text AS created_by,
                  created_by_user_id_snapshot::text AS created_by_user_id_snapshot,
                  purged_at IS NULL AS purged_at_is_null
             FROM demo_datasets
            WHERE organization_id = $1 AND id = $2`,
          [fixture.organizationId, fixture.datasetId],
        )).rows,
        users: (await pool.query(
          `SELECT id::text AS id, data_class, demo_dataset_id::text AS demo_dataset_id
             FROM users
            WHERE organization_id = $1 AND id = $2`,
          [fixture.organizationId, fixture.demoUserId],
        )).rows,
        customers: (await pool.query(
          `SELECT id::text AS id, data_class, demo_dataset_id::text AS demo_dataset_id,
                  assigned_staff_user_id::text AS assigned_staff_user_id
             FROM customers
            WHERE organization_id = $1 AND id = $2`,
          [fixture.organizationId, fixture.demoCustomerId],
        )).rows,
        contacts: (await pool.query(
          `SELECT id::text AS id, customer_id::text AS customer_id, name, title, is_primary
             FROM contacts
            WHERE organization_id = $1 AND id = $2`,
          [fixture.organizationId, fixture.demoContactId],
        )).rows,
        businessSentinel: (await pool.query(
          `SELECT id::text AS id, data_class, demo_dataset_id::text AS demo_dataset_id
             FROM customers
            WHERE organization_id = $1 AND id = $2`,
          [fixture.organizationId, fixture.businessSentinelId],
        )).rows,
      });
      const before = await snapshot();

      const upgrade = await applyThrough(pool, 40);
      expect(upgrade.appliedVersions).toEqual(['040_demo_lifecycle_simplification']);
      expect(await snapshot()).toEqual(before);
    });
  });

  it('fails closed when a legacy PURGED row still owns a Demo root and rolls back 040', async () => {
    await withIsolatedDatabase(async (pool) => {
      const baseline = await applyThrough(pool, 39);
      expect(baseline.appliedVersions).toHaveLength(39);
      const fixture = await createLegacyFixture(pool, true);

      await expect(applyThrough(pool, 40)).rejects.toThrow(
        'D4 cannot reconcile PURGED Demo dataset with remaining Demo roots',
      );

      const history = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1',
      );
      expect(history.rows[0]?.version).toBe('039_contact_deleted_audit');

      const legacyRow = await pool.query(
        'SELECT status, purged_at FROM demo_datasets WHERE organization_id = $1 AND id = $2',
        [fixture.organizationId, fixture.datasetId],
      );
      expect(legacyRow.rows).toHaveLength(1);
      expect(legacyRow.rows[0]?.status).toBe('PURGED');
      expect(legacyRow.rows[0]?.purged_at).not.toBeNull();
    });
  });
});
