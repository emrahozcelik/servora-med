import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresDemoDatasetRepository } from '../src/modules/demo-data/repository.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { assertDemoDestructiveTestDatabaseSafe } from './support/demo-destructive-guard.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) assertDemoDestructiveTestDatabaseSafe(databaseUrl);
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 4 }) : null;
const temporaryDirectories: string[] = [];
const schemas: string[] = [];

type Fixture = {
  organizationId: string;
  admin: SafeUser;
  createService: DemoDatasetService;
  service: DemoDatasetService;
  pool: Pool;
};

async function runAllMigrations(store: PostgresMigrationStore) {
  const result = await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store });
  const expectedCount = 37;
  if (result.appliedVersions.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} migrations, got ${result.appliedVersions.length}`);
  }
}

async function withIsolatedDatabase(
  run: (fixture: Fixture) => Promise<void>,
) {
  const schema = `d1c_${randomUUID().replaceAll('-', '')}`;
  await adminPool!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${schema},public`,
  });

  try {
    await runAllMigrations(new PostgresMigrationStore(pool));
    const organizationName = 'D1C create ' + randomUUID();

    const orgRow = await pool.query<{ id: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      [organizationName],
    );
    const organizationId = orgRow.rows[0]!.id;

    const adminId = randomUUID();
    const adminEmail = 'admin-' + randomUUID() + '@d1c.local';
    const adminRow = await pool.query<{ id: string }>(
      "INSERT INTO users (id, organization_id, name, email, password_hash, role) "
      + "VALUES ($1, $2, $3, $4, $5, 'ADMIN') RETURNING id",
      [adminId, organizationId, 'D1C Admin', adminEmail, 'synthetic-hash'],
    );
    await pool.query(
      "INSERT INTO customers (organization_id, name, customer_type, status) "
      + "VALUES ($1, 'Business Musteri', 'clinic', 'active')",
      [organizationId],
    );
    await pool.query(
      "INSERT INTO products (organization_id, sku, name, unit) "
      + "VALUES ($1, 'BUS-SKU-1', 'Business Urun', 'adet')",
      [organizationId],
    );

    const admin: SafeUser = {
      id: adminRow.rows[0]!.id, organizationId, name: 'D1C Admin', email: adminEmail,
      role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
    };
    const base = () => new PostgresDemoDatasetRepository(pool);
    const service = new DemoDatasetService(base());
    const createService = new DemoDatasetService(base(), () => true);
    await run({ organizationId, admin, service, createService, pool });
  } finally {
    await pool.end();
  }
}

async function demoCounts(pool: Pool, organizationId: string) {
  const counts = await pool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM users WHERE organization_id = $1 AND data_class = 'DEMO'",
    [organizationId],
  );
  const customers = await pool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM customers WHERE organization_id = $1 AND data_class = 'DEMO'",
    [organizationId],
  );
  const products = await pool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM products WHERE organization_id = $1 AND data_class = 'DEMO'",
    [organizationId],
  );
  const jobs = await pool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM job_cards WHERE organization_id = $1 AND data_class = 'DEMO'",
    [organizationId],
  );
  return {
    users: counts.rows[0]!.n,
    customers: customers.rows[0]!.n,
    products: products.rows[0]!.n,
    jobCards: jobs.rows[0]!.n,
  };
}

afterAll(async () => {
  for (const schema of schemas.splice(0)) {
    await adminPool!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
  }
  await adminPool?.end();
});

describe.skipIf(!databaseUrl)('D1 demo dataset -- managed backend creation', () => {
  it('creates a full managed dataset as one ACTIVE set with the documented mix', async () => {
    await withIsolatedDatabase(async (fixture) => {
      const response = await fixture.createService.create(fixture.admin, { clientActionId: randomUUID() });

      expect(response.replayed).toBe(false);
      expect(response.dataset.status).toBe('ACTIVE');
      expect(response.dataset.seedVersion).toBe('demo-standard-v1');
      expect(response.dataset.datasetKey).toMatch(/^standard-v1-/);
      expect(response.counts).toEqual({ users: 3, customers: 5, products: 5, jobCards: 8 });
      expect(await demoCounts(fixture.pool, fixture.organizationId)).toEqual({ users: 3, customers: 5, products: 5, jobCards: 8 });

      const roles = await fixture.pool.query<{ role: string; n: number }>(
        "SELECT role, COUNT(*)::int AS n FROM users "
        + "WHERE organization_id = $1 AND data_class = 'DEMO' GROUP BY role",
        [fixture.organizationId],
      );
      expect(Object.fromEntries(roles.rows.map((row) => [row.role, row.n]))).toEqual({
        MANAGER: 1,
        STAFF: 2,
      });

      const active = await fixture.pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM demo_datasets WHERE organization_id = $1 AND status = 'ACTIVE'",
        [fixture.organizationId],
      );
      expect(active.rows[0]!.n).toBe(1);
    });
  });

  it('replays the same clientActionId idempotently without creating duplicates', async () => {
    await withIsolatedDatabase(async (fixture) => {
      const actionId = randomUUID();
      const firstResult = await fixture.createService.create(fixture.admin, { clientActionId: actionId });
      const replay = await fixture.createService.create(fixture.admin, { clientActionId: actionId });

      expect(firstResult.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(replay.dataset.id).toBe(firstResult.dataset.id);
      expect(await demoCounts(fixture.pool, fixture.organizationId)).toEqual({ users: 3, customers: 5, products: 5, jobCards: 8 });

      const datasets = await fixture.pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM demo_datasets WHERE organization_id = $1",
        [fixture.organizationId],
      );
      expect(datasets.rows[0]!.n).toBe(1);
    });
  });

  it('enforces at most one ACTIVE dataset per organization', async () => {
    await withIsolatedDatabase(async (fixture) => {
      await fixture.createService.create(fixture.admin, { clientActionId: randomUUID() });

      await expect(
        fixture.createService.create(fixture.admin, { clientActionId: randomUUID() }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'DEMO_DATASET_ALREADY_EXISTS' });

      const active = await fixture.pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM demo_datasets WHERE organization_id = $1 AND status = 'ACTIVE'",
        [fixture.organizationId],
      );
      expect(active.rows[0]!.n).toBe(1);
    });
  });
});

describe.skipIf(!databaseUrl)('D1 demo dataset -- lifecycle (round-trip, preservation, rollback)', () => {
  it('supports create A -> purge A -> create B and replays old A without a new ACTIVE', async () => {
    await withIsolatedDatabase(async (fixture) => {
      const actionA = randomUUID();
      const createA = await fixture.createService.create(fixture.admin, { clientActionId: actionA });

      const preview = await fixture.service.preview(fixture.admin, createA.dataset.id);
      expect(preview.safeToPurge).toBe(true);
      const purge = await fixture.service.purge(fixture.admin, createA.dataset.id, {
        clientActionId: randomUUID(),
        planHash: preview.planHash,
      });
      expect(purge.status).toBe('COMPLETED');

      const createB = await fixture.createService.create(fixture.admin, { clientActionId: randomUUID() });
      expect(createB.dataset.id).not.toBe(createA.dataset.id);
      expect(createB.replayed).toBe(false);
      expect(createB.counts).toEqual({ users: 3, customers: 5, products: 5, jobCards: 8 });
      expect(await demoCounts(fixture.pool, fixture.organizationId)).toEqual({ users: 3, customers: 5, products: 5, jobCards: 8 });

      const replayA = await fixture.createService.create(fixture.admin, { clientActionId: actionA });
      expect(replayA.replayed).toBe(true);
      expect(replayA.dataset.status).toBe('PURGED');

      const active = await fixture.pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM demo_datasets WHERE organization_id = $1 AND status = 'ACTIVE'",
        [fixture.organizationId],
      );
      expect(active.rows[0]!.n).toBe(1);
    });
  });

  it('preserves the BUSINESS baseline untouched while creating DEMO data', async () => {
    await withIsolatedDatabase(async (fixture) => {
      const business = async () => {
        const customers = await fixture.pool.query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM customers WHERE organization_id = $1 AND data_class = 'BUSINESS'",
          [fixture.organizationId],
        );
        const products = await fixture.pool.query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM products WHERE organization_id = $1 AND data_class = 'BUSINESS'",
          [fixture.organizationId],
        );
        const users = await fixture.pool.query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM users WHERE organization_id = $1 AND data_class = 'BUSINESS'",
          [fixture.organizationId],
        );
        return { customers: customers.rows[0]!.n, products: products.rows[0]!.n, users: users.rows[0]!.n };
      };
      const before = await business();
      await fixture.createService.create(fixture.admin, { clientActionId: randomUUID() });
      const after = await business();
      expect(after).toEqual(before);
      expect(before.customers).toBe(1);
      expect(before.products).toBe(1);
      expect(before.users).toBe(1);
    });
  });

  it('rejects invalid clientActionId before any mutation', async () => {
    await withIsolatedDatabase(async (fixture) => {
      await expect(
        fixture.createService.create(fixture.admin, { clientActionId: 'not-a-uuid' }),
      ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });

      const datasets = await fixture.pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM demo_datasets WHERE organization_id = $1",
        [fixture.organizationId],
      );
      expect(datasets.rows[0]!.n).toBe(0);
      expect((await demoCounts(fixture.pool, fixture.organizationId)).users).toBe(0);
    });
  });

  it('concurrency: exactly one ACTIVE dataset survives parallel creates', async () => {
    await withIsolatedDatabase(async (fixture) => {
      const results = await Promise.allSettled([
        fixture.createService.create(fixture.admin, { clientActionId: randomUUID() }),
        fixture.createService.create(fixture.admin, { clientActionId: randomUUID() }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

      const active = await fixture.pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM demo_datasets WHERE organization_id = $1 AND status = 'ACTIVE'",
        [fixture.organizationId],
      );
      expect(active.rows[0]!.n).toBe(1);
    });
  });

  it('rolls back every DEMO row when a mid-transaction write fails', async () => {
    await withIsolatedDatabase(async (fixture) => {
      await fixture.pool.query(`
        CREATE OR REPLACE FUNCTION d1c_injected_rollback() RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.data_class = 'DEMO' AND (SELECT COUNT(*) FROM users WHERE organization_id = NEW.organization_id AND demo_dataset_id = NEW.demo_dataset_id) >= 2 THEN
            RAISE EXCEPTION 'injected demo creation failure' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER d1c_injected_rollback_trigger BEFORE INSERT ON users
          FOR EACH ROW EXECUTE FUNCTION d1c_injected_rollback();
      `);

      await expect(
        fixture.createService.create(fixture.admin, { clientActionId: randomUUID() }),
      ).rejects.toThrow();

      const datasets = await fixture.pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM demo_datasets WHERE organization_id = $1",
        [fixture.organizationId],
      );
      expect(datasets.rows[0]!.n).toBe(0);
      expect((await demoCounts(fixture.pool, fixture.organizationId)).users).toBe(0);
    });
  });
});