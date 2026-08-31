import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresDemoDatasetRepository } from '../src/modules/demo-data/repository.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { FollowUpCreateInput, JobCardActor } from '../src/modules/job-cards/types.js';
import { assertDemoDestructiveTestDatabaseSafe } from './support/demo-destructive-guard.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) assertDemoDestructiveTestDatabaseSafe(databaseUrl);
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

type DemoFixture = {
  pool: Pool;
  organizationId: string;
  datasetId: string;
  admin: SafeUser;
  manager: JobCardActor;
  demoStaffId: string;
  demoManagerId: string;
  businessStaffId: string;
  demoCustomerId: string;
  service: DemoDatasetService;
};

async function withSchema(run: (pool: Pool) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `demo_followup_f1_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      store: new PostgresMigrationStore(pool),
    });
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function createDemoFixture(pool: Pool, title: string): Promise<DemoFixture> {
  const organizationId = (await pool.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [`Demo follow-up ${title} ${randomUUID()}`],
  )).rows[0]!.id;

  const ids = {
    adminId: randomUUID(),
    managerId: randomUUID(),
    demoManagerId: randomUUID(),
    demoStaffId: randomUUID(),
    businessStaffId: randomUUID(),
  };
  await pool.query(
    `INSERT INTO users (id, organization_id, name, email, password_hash, role)
     VALUES
       ($1, $6, 'F1 Admin', $7, 'test-hash', 'ADMIN'),
       ($2, $6, 'F1 Manager', $8, 'test-hash', 'MANAGER'),
       ($3, $6, 'Demo Manager', $9, 'test-hash', 'MANAGER'),
       ($4, $6, 'Demo Staff', $10, 'test-hash', 'STAFF'),
       ($5, $6, 'Business Staff', $11, 'test-hash', 'STAFF')`,
    [
      ids.adminId, ids.managerId, ids.demoManagerId, ids.demoStaffId, ids.businessStaffId,
      organizationId,
      `${ids.adminId}@followup.local`, `${ids.managerId}@followup.local`,
      `${ids.demoManagerId}@followup.local`, `${ids.demoStaffId}@followup.local`,
      `${ids.businessStaffId}@followup.local`,
    ],
  );

  const datasetId = (await pool.query<{ id: string }>(
    `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
     VALUES ($1, $2, 'followup-f1', $3) RETURNING id`,
    [organizationId, `dataset-${randomUUID()}`, ids.demoStaffId],
  )).rows[0]!.id;
  await pool.query(
    `UPDATE users SET data_class = 'DEMO', demo_dataset_id = $2
     WHERE organization_id = $1 AND id IN ($3::uuid, $4::uuid)`,
    [organizationId, datasetId, ids.demoManagerId, ids.demoStaffId],
  );

  const demoCustomerId = (await pool.query<{ id: string }>(
    `INSERT INTO customers
       (organization_id, name, customer_type, assigned_staff_user_id, status, data_class, demo_dataset_id)
     VALUES ($1, 'Demo Clinic', 'clinic', $2, 'active', 'DEMO', $3) RETURNING id`,
    [organizationId, ids.demoStaffId, datasetId],
  )).rows[0]!.id;

  const admin: SafeUser = {
    id: ids.adminId,
    organizationId,
    name: 'F1 Admin',
    email: `${ids.adminId}@followup.local`,
    role: 'ADMIN',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
  return {
    pool,
    organizationId,
    datasetId,
    admin,
    manager: { id: ids.managerId, organizationId, role: 'MANAGER' },
    demoStaffId: ids.demoStaffId,
    demoManagerId: ids.demoManagerId,
    businessStaffId: ids.businessStaffId,
    demoCustomerId,
    service: new DemoDatasetService(new PostgresDemoDatasetRepository(pool)),
  };
}

async function insertJob(pool: Pool, fixture: Pick<DemoFixture, 'organizationId'>, spec: {
  title: string;
  status: string;
  dataClass: 'BUSINESS' | 'DEMO';
  demoDatasetId: string | null;
  customerId: string | null;
  assignedTo: string;
  createdBy: string;
  sourceJobCardId?: string | null;
  type?: string;
}) {
  const completed = spec.status === 'COMPLETED';
  const inProgress = spec.status === 'IN_PROGRESS';
  const startedAt = completed || inProgress ? new Date('2026-07-30T09:00:00.000Z') : null;
  const staffCompletedAt = completed ? new Date('2026-07-30T10:00:00.000Z') : null;
  const managerApprovedAt = completed ? new Date('2026-07-30T11:00:00.000Z') : null;
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, assigned_to, created_by,
        priority, started_at, staff_completed_at, staff_completed_by,
        manager_approved_at, manager_approved_by,
        source_job_card_id, follow_up_instructions, data_class, demo_dataset_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'normal', $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [
      fixture.organizationId,
      spec.type ?? 'GENERAL_TASK',
      spec.status,
      spec.title,
      spec.customerId,
      spec.assignedTo,
      spec.createdBy,
      startedAt,
      staffCompletedAt,
      completed ? spec.assignedTo : null,
      managerApprovedAt,
      completed ? spec.createdBy : null,
      spec.sourceJobCardId ?? null,
      spec.sourceJobCardId ? `Follow-up of ${spec.sourceJobCardId}` : null,
      spec.dataClass,
      spec.demoDatasetId,
    ],
  )).rows[0]!.id;
}

async function insertJobActivity(pool: Pool, orgId: string, jobId: string, actorId: string, eventType = 'JOB_CREATED') {
  await pool.query(
    `INSERT INTO job_card_activity_logs
       (organization_id, job_card_id, actor_id, event_type, new_value, client_action_id)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
    [orgId, jobId, actorId, eventType, randomUUID()],
  );
}

function followUpInput(assignedTo: string): FollowUpCreateInput {
  return {
    clientActionId: randomUUID(),
    type: 'GENERAL_TASK',
    title: 'Takip: demo kaynak',
    followUpInstructions: 'Demo kaynak takibi.',
    scheduledAt: null,
    assignedTo,
    priority: 'normal',
    dueDate: null,
    contactId: null,
    engagementKind: null,
  };
}

describe.skipIf(!databaseUrl)('Demo follow-up provenance F1 PostgreSQL contract', () => {
  it('forward: a follow-up of a DEMO source inherits DEMO provenance; BUSINESS sources stay BUSINESS', async () => {
    await withSchema(async (pool) => {
      const fixture = await createDemoFixture(pool, 'forward');

      const businessCustomerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Business Clinic', 'clinic', 'active') RETURNING id`,
        [fixture.organizationId],
      )).rows[0]!.id;
      const demoSourceId = await insertJob(pool, fixture, {
        title: 'Demo source completed',
        status: 'COMPLETED',
        dataClass: 'DEMO',
        demoDatasetId: fixture.datasetId,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.demoStaffId,
        createdBy: fixture.demoManagerId,
      });
      const businessSourceId = await insertJob(pool, fixture, {
        title: 'Business source completed',
        status: 'COMPLETED',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: businessCustomerId,
        assignedTo: fixture.businessStaffId,
        createdBy: fixture.manager.id,
      });

      const jobService = new JobCardService(
        new PostgresJobCardRepository(pool),
        () => new Date('2026-08-01T10:00:00.000Z'),
        { publish: () => undefined },
        undefined,
        undefined,
        { enabled: false, reminderLeadMinutes: 30 },
      );

      const demoChild = await jobService.createFollowUp(
        fixture.manager,
        demoSourceId,
        followUpInput(fixture.demoStaffId),
      );
      const demoChildRow = (await pool.query<{
        id: string;
        data_class: 'BUSINESS' | 'DEMO';
        demo_dataset_id: string | null;
      }>(
        'SELECT id, data_class, demo_dataset_id FROM job_cards WHERE id = $1',
        [demoChild.id],
      )).rows[0]!;
      expect(demoChildRow.data_class).toBe('DEMO');
      expect(demoChildRow.demo_dataset_id).toBe(fixture.datasetId);

      const businessChild = await jobService.createFollowUp(
        fixture.manager,
        businessSourceId,
        followUpInput(fixture.businessStaffId),
      );
      const businessChildRow = (await pool.query<{
        id: string;
        data_class: 'BUSINESS' | 'DEMO';
        demo_dataset_id: string | null;
      }>(
        'SELECT id, data_class, demo_dataset_id FROM job_cards WHERE id = $1',
        [businessChild.id],
      )).rows[0]!;
      expect(businessChildRow.data_class).toBe('BUSINESS');
      expect(businessChildRow.demo_dataset_id).toBeNull();
    });
  });

  it('legacy: misclassified DEMO-derived follow-up no longer blocks purge and is purged with its data', async () => {
    await withSchema(async (pool) => {
      const fixture = await createDemoFixture(pool, 'legacy');

      const parentId = await insertJob(pool, fixture, {
        title: 'Demo Onay Bekliyor',
        status: 'COMPLETED',
        dataClass: 'DEMO',
        demoDatasetId: fixture.datasetId,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.demoStaffId,
        createdBy: fixture.demoManagerId,
      });
      const legacyFollowUpId = await insertJob(pool, fixture, {
        title: 'Takip: Demo Onay Bekliyor',
        status: 'NEW',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.demoStaffId,
        createdBy: fixture.demoManagerId,
        sourceJobCardId: parentId,
      });
      await insertJobActivity(pool, fixture.organizationId, legacyFollowUpId, fixture.demoStaffId, 'JOB_STARTED');

      // Sentinels: independent BUSINESS job and real BUSINESS staff must survive.
      const sentinelJobId = await insertJob(pool, fixture, {
        title: 'Gerçek iş sentineli',
        status: 'IN_PROGRESS',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: null,
        assignedTo: fixture.businessStaffId,
        createdBy: fixture.manager.id,
      });

      const preview = await fixture.service.preview(fixture.admin, fixture.datasetId);
      expect(preview.safeToPurge).toBe(true);
      const codes = preview.blockers.map((blocker) => blocker.code);
      expect(codes).not.toContain('BUSINESS_JOB_TO_DEMO_FOLLOW_UP');
      expect(codes).not.toContain('DEMO_CUSTOMER_TO_BUSINESS_JOB');
      expect(codes).not.toContain('DEMO_USER_TO_BUSINESS_JOB');

      const response = await fixture.service.purge(fixture.admin, fixture.datasetId, {
        clientActionId: randomUUID(),
        planHash: preview.planHash,
      });
      expect(response.status).toBe('COMPLETED');

      expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [legacyFollowUpId])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [parentId])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM job_card_activity_logs WHERE job_card_id = $1', [legacyFollowUpId])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM customers WHERE id = $1', [fixture.demoCustomerId])).rows.length).toBe(0);
      // Sentinels preserved.
      expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [sentinelJobId])).rows.length).toBe(1);
      expect((await pool.query('SELECT id FROM users WHERE id = $1', [fixture.businessStaffId])).rows.length).toBe(1);
    });
  });

  it('legacy: transitive DEMO-derived chain purges safely even when assigned to real BUSINESS staff', async () => {
    await withSchema(async (pool) => {
      const fixture = await createDemoFixture(pool, 'transitive');

      const parentId = await insertJob(pool, fixture, {
        title: 'Demo kök',
        status: 'COMPLETED',
        dataClass: 'DEMO',
        demoDatasetId: fixture.datasetId,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.demoStaffId,
        createdBy: fixture.demoManagerId,
      });
      const legacyB = await insertJob(pool, fixture, {
        title: 'Takip B (Business staff)',
        status: 'NEW',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.businessStaffId,
        createdBy: fixture.demoManagerId,
        sourceJobCardId: parentId,
      });
      const legacyC = await insertJob(pool, fixture, {
        title: 'Takip C',
        status: 'NEW',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.businessStaffId,
        createdBy: fixture.demoManagerId,
        sourceJobCardId: legacyB,
      });

      const preview = await fixture.service.preview(fixture.admin, fixture.datasetId);
      expect(preview.safeToPurge).toBe(true);

      const response = await fixture.service.purge(fixture.admin, fixture.datasetId, {
        clientActionId: randomUUID(),
        planHash: preview.planHash,
      });
      expect(response.status).toBe('COMPLETED');

      for (const id of [parentId, legacyB, legacyC]) {
        expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [id])).rows.length).toBe(0);
      }
      expect((await pool.query('SELECT id FROM users WHERE id = $1', [fixture.businessStaffId])).rows.length).toBe(1);
    });
  });

  it('independent BUSINESS job referencing Demo roots without source lineage still blocks', async () => {
    await withSchema(async (pool) => {
      const fixture = await createDemoFixture(pool, 'business-block');

      await insertJob(pool, fixture, {
        title: 'Gerçek BUSINESS iş, demo kök referanslı',
        status: 'NEW',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.demoStaffId,
        createdBy: fixture.demoManagerId,
      });

      const preview = await fixture.service.preview(fixture.admin, fixture.datasetId);
      expect(preview.safeToPurge).toBe(false);
      const codes = preview.blockers.map((blocker) => blocker.code);
      expect(codes).toContain('DEMO_USER_TO_BUSINESS_JOB');
      expect(codes).toContain('DEMO_CUSTOMER_TO_BUSINESS_JOB');
    });
  });
});