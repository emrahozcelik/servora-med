import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import {
  parseWeeklyReportBulkRequestInput,
  parseWeeklyReportCreateInput,
} from '../src/modules/weekly-reports/create-input.js';
import { parseWeeklyReportRecurrenceBulkCreateInput } from '../src/modules/weekly-reports/recurrence-input.js';
import { PostgresWeeklyReportRecurrenceRepository } from '../src/modules/weekly-reports/recurrence-repository.js';
import { WeeklyReportRecurrenceService } from '../src/modules/weekly-reports/recurrence-service.js';
import { createWeeklyReportRecurrenceWorker } from '../src/modules/weekly-reports/recurrence-worker.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const WEEK_A = '2026-10-05';
const WEEK_B = '2026-10-12';
const NOW = '2026-10-05T09:00:00.000Z';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr5r_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
      max: 10,
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

async function insertOrg(pool: Pool): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [`WR5R ${randomUUID()}`],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'test-hash', $4) RETURNING id`,
    [organizationId, `WR5R ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function insertRule(
  pool: Pool,
  input: { organizationId: string; staffUserId: string; requestedByUserId: string },
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO weekly_report_recurrences
       (organization_id, staff_user_id, requested_by_user_id, next_period_start)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.organizationId, input.staffUserId, input.requestedByUserId, WEEK_A],
  )).rows[0]!.id;
}

function buildHarness(pool: Pool, nowIso = NOW) {
  const jobCardService = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => new Date(nowIso),
    { publish: () => {} },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
  const repository = new PostgresWeeklyReportRecurrenceRepository(pool);
  const service = new WeeklyReportRecurrenceService(
    repository, pool, jobCardService, () => new Date(nowIso),
  );
  return { service, repository, jobCardService };
}

async function counts(pool: Pool) {
  const rules = (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM weekly_report_recurrences`)).rows[0]!.n;
  const jobs = (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM job_cards WHERE type = 'WEEKLY_REPORT'`)).rows[0]!.n;
  const reports = (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM weekly_reports`)).rows[0]!.n;
  return { rules, jobs, reports };
}

const actor = (organizationId: string, id: string, role: JobCardActor['role']): JobCardActor =>
  ({ id, organizationId, role });

describe.skipIf(!databaseUrl)('weekly report recurrence concurrency (PostgreSQL)', () => {
  it('creates exactly one rule when two bulk creates race for the same staff', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const harness = buildHarness(pool);
      const manager = actor(organizationId, managerId, 'MANAGER');
      const body = () => parseWeeklyReportRecurrenceBulkCreateInput({
        clientActionId: randomUUID(), staffUserIds: [staffId], startPeriodStart: WEEK_A,
      });
      const [a, b] = await Promise.all([
        harness.service.bulkCreate(manager, body()),
        harness.service.bulkCreate(manager, body()),
      ]);
      expect([...a.items, ...b.items].map((item) => item.outcome).sort())
        .toEqual(['created', 'existing']);
      expect(await counts(pool)).toMatchObject({ rules: 1 });
      const [ruleIdA] = [a.items[0]!.recurrenceId];
      expect(b.items[0]!.recurrenceId).toBe(ruleIdA);
    });
  });

  it('creates exactly one report when the worker races a manager single create', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const harness = buildHarness(pool);
      await insertRule(pool, {
        organizationId, staffUserId: staffId, requestedByUserId: managerId,
      });
      const worker = createWeeklyReportRecurrenceWorker(
        harness.repository, harness.service.createOccurrence, { now: () => new Date(NOW) },
      );
      const manager = actor(organizationId, managerId, 'MANAGER');
      const results = await Promise.allSettled([
        worker.runOnce(),
        harness.jobCardService.createWeeklyReport(manager, parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffId,
        })),
      ]);
      expect(await counts(pool)).toMatchObject({ reports: 1, jobs: 1 });
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected.length).toBeLessThanOrEqual(1);
      if (rejected.length === 1) {
        expect(rejected[0]).toMatchObject({
          reason: expect.objectContaining({ code: 'WEEKLY_REPORT_ALREADY_EXISTS' }),
        });
      }
    });
  });

  it('creates exactly one report when the worker races a manager bulk request', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffA = await insertUser(pool, organizationId, 'STAFF');
      const staffB = await insertUser(pool, organizationId, 'STAFF');
      const harness = buildHarness(pool);
      await insertRule(pool, {
        organizationId, staffUserId: staffA, requestedByUserId: managerId,
      });
      const worker = createWeeklyReportRecurrenceWorker(
        harness.repository, harness.service.createOccurrence, { now: () => new Date(NOW) },
      );
      const manager = actor(organizationId, managerId, 'MANAGER');
      await Promise.all([
        worker.runOnce(),
        harness.jobCardService.bulkRequestWeeklyReports(manager, parseWeeklyReportBulkRequestInput({
          clientActionId: randomUUID(), staffUserIds: [staffA, staffB], periodStart: WEEK_A,
        })),
      ]);
      // staffA: exactly one report (converged); staffB: exactly one report.
      const perStaff = await pool.query<{ staff_user_id: string; n: number }>(
        `SELECT staff_user_id, COUNT(*)::int AS n FROM weekly_reports GROUP BY staff_user_id`,
      );
      expect(perStaff.rows.every((row) => row.n === 1)).toBe(true);
      expect(await counts(pool)).toMatchObject({ reports: 2, jobs: 2 });
    });
  });

  it('creates exactly one report when the worker races a STAFF self-create', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const harness = buildHarness(pool);
      await insertRule(pool, {
        organizationId, staffUserId: staffId, requestedByUserId: managerId,
      });
      const worker = createWeeklyReportRecurrenceWorker(
        harness.repository, harness.service.createOccurrence, { now: () => new Date(NOW) },
      );
      const staff = actor(organizationId, staffId, 'STAFF');
      await Promise.allSettled([
        worker.runOnce(),
        harness.jobCardService.createWeeklyReport(staff, parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffId,
        })),
      ]);
      expect(await counts(pool)).toMatchObject({ reports: 1, jobs: 1 });
      // The rule advanced exactly once regardless of who won.
      const rule = await pool.query<{ next_period_start: string }>(
        `SELECT next_period_start::text AS next_period_start FROM weekly_report_recurrences`,
      );
      expect(rule.rows[0]!.next_period_start).toBe(WEEK_B);
    });
  });

  it('never advances a rule twice when two workers race the same period', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const harnessA = buildHarness(pool);
      const harnessB = buildHarness(pool);
      const ruleId = await insertRule(pool, {
        organizationId, staffUserId: staffId, requestedByUserId: managerId,
      });
      const workerA = createWeeklyReportRecurrenceWorker(
        harnessA.repository, harnessA.service.createOccurrence, { now: () => new Date(NOW) },
      );
      const workerB = createWeeklyReportRecurrenceWorker(
        harnessB.repository, harnessB.service.createOccurrence, { now: () => new Date(NOW) },
      );
      await Promise.all([workerA.runOnce(), workerB.runOnce()]);
      expect(await counts(pool)).toMatchObject({ reports: 1, jobs: 1 });
      const rule = await pool.query<{
        next_period_start: string; last_processed_period_start: string; version: number;
      }>(
        `SELECT next_period_start::text AS next_period_start,
                last_processed_period_start::text AS last_processed_period_start, version
           FROM weekly_report_recurrences WHERE id = $1`,
        [ruleId],
      );
      expect(rule.rows[0]!.next_period_start).toBe(WEEK_B);
      expect(rule.rows[0]!.last_processed_period_start).toBe(WEEK_A);
    });
  });
});
