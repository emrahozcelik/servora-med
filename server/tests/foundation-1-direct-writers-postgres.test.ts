import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresSetupRepository, seedDevelopment } from '../src/modules/auth/setup.js';
import { PostgresDemoDatasetRepository } from '../src/modules/demo-data/repository.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { assertDemoDestructiveTestDatabaseSafe } from './support/demo-destructive-guard.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) assertDemoDestructiveTestDatabaseSafe(databaseUrl);
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function createSchemaPool(): Promise<{ pool: Pool; cleanup: () => Promise<void> }> {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const schema = `f1w_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema},public` });
  await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
  const cleanup = async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  };
  return { pool, cleanup };
}

async function insertOrgAdmin(pool: Pool): Promise<{ organizationId: string; admin: SafeUser }> {
  const organizationId = randomUUID();
  await pool.query(
    `INSERT INTO organizations (id, name, timezone) VALUES ($1, $2, 'Europe/Istanbul')`,
    [organizationId, `F1W ${randomUUID()}`],
  );
  const row = await pool.query<SafeUser>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'W Admin', $2, 'test-hash', 'ADMIN')
     RETURNING id, organization_id AS "organizationId", name, email, role,
       must_change_password AS "mustChangePassword", is_active AS "isActive", version,
       data_class AS "dataClass"`,
    [organizationId, `${randomUUID()}@f1w.test`],
  );
  return { organizationId, admin: row.rows[0]! };
}

describe.skipIf(!databaseUrl)('FOUNDATION-1 direct writers', () => {
  it('auth/setup seedDevelopment-created JobCards carry revision #1 + assignment history', async () => {
    const fixture = await createSchemaPool();
    try {
      await seedDevelopment(new PostgresSetupRepository(fixture.pool), {
        organizationName: `F1 Setup ${randomUUID()}`,
        password: 'development-password',
      }, 'test');
      const jobs = await fixture.pool.query<{ id: string }>(
        `SELECT id FROM job_cards`,
      );
      expect(jobs.rows.length).toBeGreaterThan(0);
      for (const job of jobs.rows) {
        const revs = await fixture.pool.query<{ revision_no: number; source: string }>(
          `SELECT revision_no, source FROM job_card_schedule_revisions WHERE job_card_id = $1`,
          [job.id],
        );
        expect(revs.rows).toEqual([{ revision_no: 1, source: 'CREATE' }]);
        const assigns = await fixture.pool.query<{ from_user_id: string | null; to_user_id: string; source: string }>(
          `SELECT from_user_id, to_user_id, source FROM job_card_assignment_history WHERE job_card_id = $1`,
          [job.id],
        );
        expect(assigns.rows).toHaveLength(1);
        expect(assigns.rows[0]!).toMatchObject({ from_user_id: null, source: 'CREATE' });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('demo-data repository-created JobCards carry revision #1 + assignment history', async () => {
    const fixture = await createSchemaPool();
    try {
      const { organizationId, admin } = await insertOrgAdmin(fixture.pool);
      await new PostgresDemoDatasetRepository(fixture.pool).create(
        organizationId,
        admin.id,
        { clientActionId: randomUUID() },
      );
      const jobs = await fixture.pool.query<{ id: string }>(
        `SELECT id FROM job_cards WHERE organization_id = $1 ORDER BY id`,
        [organizationId],
      );
      expect(jobs.rows.length).toBeGreaterThan(0);
      for (const job of jobs.rows) {
        const revs = await fixture.pool.query<{ revision_no: number; source: string }>(
          `SELECT revision_no, source FROM job_card_schedule_revisions WHERE job_card_id = $1`,
          [job.id],
        );
        expect(revs.rows).toEqual([{ revision_no: 1, source: 'CREATE' }]);
        const assigns = await fixture.pool.query<{ source: string; to_user_id: string }>(
          `SELECT source, to_user_id FROM job_card_assignment_history WHERE job_card_id = $1`,
          [job.id],
        );
        expect(assigns.rows).toHaveLength(1);
        expect(assigns.rows[0]!.source).toBe('CREATE');
        expect(assigns.rows[0]!.to_user_id).toBeTruthy();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('demo purge removes history rows before JobCards and preserves unrelated history', async () => {
    const fixture = await createSchemaPool();
    try {
      const { organizationId, admin } = await insertOrgAdmin(fixture.pool);
      const pool = fixture.pool;
      const demoStaff = await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Demo Staff', $2, 'test-hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@f1w.test`],
      );
      const dataset = await pool.query<{ id: string }>(
        `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
         VALUES ($1, $2, 'f1-test', $3) RETURNING id`,
        [organizationId, `f1-${randomUUID()}`, demoStaff.rows[0]!.id],
      );
      const datasetId = dataset.rows[0]!.id;
      await pool.query(
        `UPDATE users SET data_class = 'DEMO', demo_dataset_id = $2
         WHERE organization_id = $1 AND id = $3`,
        [organizationId, datasetId, demoStaff.rows[0]!.id],
      );
      await pool.query(
        `INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, 'Demo')`,
        [organizationId, demoStaff.rows[0]!.id],
      );
      await pool.query(
        `INSERT INTO customers
           (organization_id, name, customer_type, assigned_staff_user_id, status, data_class, demo_dataset_id)
         VALUES ($1, 'Demo Clinic', 'clinic', $2, 'active', 'DEMO', $3)`,
        [organizationId, demoStaff.rows[0]!.id, datasetId],
      );

      const insertJobProfile = async (
        title: string,
        assignedTo: string,
        createdBy: string,
        dataClass: 'BUSINESS' | 'DEMO',
        demoDatasetId: string | null,
      ) => {
        const job = await pool.query<{ id: string }>(
          `INSERT INTO job_cards
             (organization_id, type, status, title, assigned_to, created_by, priority, data_class, demo_dataset_id)
           VALUES ($1, 'GENERAL_TASK', 'NEW', $2, $3, $4, 'normal', $5, $6) RETURNING id`,
          [organizationId, title, assignedTo, createdBy, dataClass, demoDatasetId],
        );
        const jobId = job.rows[0]!.id;
        await pool.query(
          `INSERT INTO job_card_schedule_revisions
             (organization_id, job_card_id, revision_no, organization_timezone, source, created_by)
           VALUES ($1, $2, 1, 'Europe/Istanbul', 'CREATE', $3)`,
          [organizationId, jobId, createdBy],
        );
        await pool.query(
          `INSERT INTO job_card_assignment_history
             (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
           VALUES ($1, $2, NULL, $3, $4, 'CREATE', NOW())`,
          [organizationId, jobId, assignedTo, createdBy],
        );
        await pool.query(
          `INSERT INTO job_card_activity_logs
             (organization_id, job_card_id, actor_id, event_type, new_value)
           VALUES ($1, $2, $3, 'JOB_CREATED', '{}'::jsonb)`,
          [organizationId, jobId, createdBy],
        );
        return jobId;
      };
      const demoJobId = await insertJobProfile(
        'Demo job', demoStaff.rows[0]!.id, admin.id, 'DEMO', datasetId,
      );
      const businessJobId = await insertJobProfile(
        'Business job', admin.id, admin.id, 'BUSINESS', null,
      );

      const service = new DemoDatasetService(new PostgresDemoDatasetRepository(pool));
      const preview = await service.preview(admin, datasetId);
      expect(preview.safeToPurge).toBe(true);
      const response = await service.purge(admin, datasetId, {
        clientActionId: randomUUID(), planHash: preview.planHash,
      });
      expect(response.status).toBe('COMPLETED');

      const demoJob = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_cards WHERE id = $1`, [demoJobId],
      );
      expect(demoJob.rows[0]!.count).toBe('0');
      const demoHistory = await pool.query<{ revs: string; assigns: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM job_card_schedule_revisions WHERE job_card_id = $1) AS revs,
           (SELECT COUNT(*)::text FROM job_card_assignment_history WHERE job_card_id = $1) AS assigns`,
        [demoJobId],
      );
      expect(demoHistory.rows[0]).toEqual({ revs: '0', assigns: '0' });

      const businessJob = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_cards WHERE id = $1`, [businessJobId],
      );
      expect(businessJob.rows[0]!.count).toBe('1');
      const businessHistory = await pool.query<{ revs: string; assigns: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM job_card_schedule_revisions WHERE job_card_id = $1) AS revs,
           (SELECT COUNT(*)::text FROM job_card_assignment_history WHERE job_card_id = $1) AS assigns`,
        [businessJobId],
      );
      expect(businessHistory.rows[0]).toEqual({ revs: '1', assigns: '1' });
    } finally {
      await fixture.cleanup();
    }
  });
});
