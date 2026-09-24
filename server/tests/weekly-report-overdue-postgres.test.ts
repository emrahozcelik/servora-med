import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  createOverdueBreachScanner,
  PostgresOverdueBreachScannerRepository,
} from '../src/modules/job-cards/overdue-breach-scanner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, JobCardStatus } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

// Request clock: 2026-08-05 12:00 UTC (15:00 Europe/Istanbul). Due 2026-08-01
// is past-due; due 2026-08-10 is not.
const REQUEST_TIME = new Date('2026-08-05T12:00:00.000Z');
const PAST_DUE = '2026-08-01';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr2_${randomUUID().replaceAll('-', '')}`;
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

async function seedOrg(pool: Pool): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [`WR2 ${randomUUID()}`],
  )).rows[0]!.id;
}

async function seedUser(pool: Pool, organizationId: string, role: 'MANAGER' | 'STAFF'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, `WR2 ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function seedJob(
  pool: Pool,
  input: {
    organizationId: string;
    type: string;
    status: JobCardStatus;
    staffId: string;
    managerId: string;
    submittedAt?: Date;
  },
): Promise<string> {
  const submitted = input.submittedAt ?? null;
  const startedAt = submitted
    ? new Date(submitted.getTime() - 86_400_000)
    : new Date('2026-08-04T09:00:00.000Z');
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        started_at, staff_completed_at, staff_completed_by, due_date)
     VALUES ($1, $2, $3, 'WR2 fixture', $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      input.organizationId, input.type, input.status, input.staffId, input.managerId,
      startedAt, submitted, submitted ? input.staffId : null, PAST_DUE,
    ],
  )).rows[0]!.id;
}

function buildService(pool: Pool) {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => REQUEST_TIME,
    { publish: () => undefined },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
}

describe.skipIf(!databaseUrl)('weekly report overdue behavior (PostgreSQL)', () => {
  it('excludes submitted weekly reports from the employee overdue view only', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const managerId = await seedUser(pool, organizationId, 'MANAGER');
      const staffId = await seedUser(pool, organizationId, 'STAFF');
      const submittedAt = new Date('2026-08-04T09:00:00.000Z');
      const generalReview = await seedJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        staffId, managerId, submittedAt,
      });
      const weeklyReview = await seedJob(pool, {
        organizationId, type: 'WEEKLY_REPORT', status: 'WAITING_APPROVAL',
        staffId, managerId, submittedAt,
      });
      const weeklyOpen = await seedJob(pool, {
        organizationId, type: 'WEEKLY_REPORT', status: 'IN_PROGRESS',
        staffId, managerId,
      });
      const generalNew = await seedJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'NEW',
        staffId, managerId,
      });
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const page = await buildService(pool).list(manager, {
        q: null, type: null, assignedTo: null, customerId: null, priority: null,
        dueBefore: null, dueAfter: null, followUp: null,
        status: 'active', limit: 20, offset: 0, overdue: true,
      });
      const ids = new Set(page.items.map((item) => item.id));
      // Productive review work stays overdue-eligible; unsubmitted work of any
      // type stays eligible; only the submitted weekly report is exempt.
      expect(ids.has(generalReview)).toBe(true);
      expect(ids.has(generalNew)).toBe(true);
      expect(ids.has(weeklyOpen)).toBe(true);
      expect(ids.has(weeklyReview)).toBe(false);
      expect(page.total).toBe(3);
    });
  });

  it('keeps APPROVAL_WAIT breach eligibility for submitted weekly reports', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const managerId = await seedUser(pool, organizationId, 'MANAGER');
      const staffId = await seedUser(pool, organizationId, 'STAFF');
      const submittedAt = new Date('2026-08-03T06:00:00.000Z');
      const jobId = await seedJob(pool, {
        organizationId, type: 'WEEKLY_REPORT', status: 'WAITING_APPROVAL',
        staffId, managerId, submittedAt,
      });
      await pool.query(
        `INSERT INTO job_card_schedule_revisions
           (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
            due_date, organization_timezone, source, created_by, created_at)
         VALUES ($1, $2, 1, NULL, NULL, $3, 'Europe/Istanbul', 'BASELINE', $4, $5)`,
        [organizationId, jobId, PAST_DUE, staffId, submittedAt],
      );
      const activityId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type)
         VALUES ($1, $2, $3, 'JOB_SUBMITTED_FOR_APPROVAL') RETURNING id`,
        [organizationId, jobId, staffId],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO job_card_accountability_facts
           (organization_id, job_card_id, fact_type, seq_no, occurred_at,
            schedule_revision_no, responsible_user_id, actor_user_id, source_activity_id)
         VALUES ($1, $2, 'SUBMITTED', 1, $3, 1, $4, $4, $5)`,
        [organizationId, jobId, submittedAt, staffId, activityId],
      );
      const scanner = createOverdueBreachScanner(
        new PostgresOverdueBreachScannerRepository(new PostgresJobCardRepository(pool)),
        {},
      );
      const early = await scanner.runOnce(new Date(submittedAt.getTime() + 86_400_000 - 1));
      expect(early.inserted).toBe(0);
      const at = await scanner.runOnce(new Date(submittedAt.getTime() + 86_400_000));
      expect(at.inserted).toBe(1);
      const rows = await pool.query(
        `SELECT delay_type, source, accountable_role, accountable_source
           FROM job_card_overdue_incidents
          WHERE organization_id = $1 AND job_card_id = $2`,
        [organizationId, jobId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        delay_type: 'APPROVAL_WAIT',
        source: 'SCANNER',
        accountable_role: 'MANAGEMENT',
        accountable_source: 'ROLE_POLICY',
      });
    });
  });
});
