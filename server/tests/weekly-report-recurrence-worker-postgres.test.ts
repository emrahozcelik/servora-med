import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { parseWeeklyReportCreateInput } from '../src/modules/weekly-reports/create-input.js';
import { PostgresWeeklyReportRecurrenceRepository } from '../src/modules/weekly-reports/recurrence-repository.js';
import { WeeklyReportRecurrenceService } from '../src/modules/weekly-reports/recurrence-service.js';
import { createWeeklyReportRecurrenceWorker } from '../src/modules/weekly-reports/recurrence-worker.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const WEEK_A = '2026-10-05';
const WEEK_B = '2026-10-12';
const WEEK_C = '2026-10-19';
const WEEK_D = '2026-10-26';
/** Monday 12:00 Europe/Istanbul — the rule's week is the current week. */
const NOW = '2026-10-05T09:00:00.000Z';
/** Tuesday 12:00 Europe/Istanbul — three weeks of downtime to catch up. */
const NOW_CATCHUP = '2026-10-20T09:00:00.000Z';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr5w_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, timezone = 'Europe/Istanbul'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id`,
    [`WR5W ${randomUUID()}`, timezone],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
  active = true,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, $5) RETURNING id`,
    [organizationId, `WR5W ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role, active],
  )).rows[0]!.id;
}

/** Rule inserted directly so tests control `next_period_start` (downtime). */
async function insertRule(
  pool: Pool,
  input: {
    organizationId: string;
    staffUserId: string;
    requestedByUserId: string;
    nextPeriodStart: string;
    questions?: unknown;
    instructions?: string | null;
  },
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO weekly_report_recurrences
       (organization_id, staff_user_id, requested_by_user_id, next_period_start,
        manager_questions, instructions)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.organizationId,
      input.staffUserId,
      input.requestedByUserId,
      input.nextPeriodStart,
      JSON.stringify(input.questions ?? []),
      input.instructions ?? null,
    ],
  )).rows[0]!.id;
}

function buildHarness(pool: Pool, published: unknown[] = [], nowIso = NOW) {
  const jobCardService = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => new Date(nowIso),
    { publish: (event) => { published.push(event); } },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
  const repository = new PostgresWeeklyReportRecurrenceRepository(pool);
  const service = new WeeklyReportRecurrenceService(
    repository, pool, jobCardService, () => new Date(nowIso),
  );
  return { service, repository, jobCardService, published };
}

type Harness = ReturnType<typeof buildHarness>;

function buildWorker(harness: Harness, nowIso: string) {
  return createWeeklyReportRecurrenceWorker(
    harness.repository,
    harness.service.createOccurrence,
    {
      now: () => new Date(nowIso),
      publisher: { publish: (event) => { harness.published.push(event); } },
      batchSize: 50,
    },
  );
}

async function ruleRow(pool: Pool, id: string) {
  return (await pool.query<{
    enabled: boolean; disabled_reason: string | null; next_period_start: string;
    last_outcome: string | null; last_processed_period_start: string | null;
    failure_count: number; last_error_code: string | null; lease_token: string | null;
    next_attempt_at: Date; manager_questions: unknown; instructions: string | null;
    version: number;
  }>(
    `SELECT enabled, disabled_reason, next_period_start::text AS next_period_start,
            last_outcome, last_processed_period_start::text AS last_processed_period_start,
            failure_count, last_error_code, lease_token, next_attempt_at,
            manager_questions, instructions, version
       FROM weekly_report_recurrences WHERE id = $1`,
    [id],
  )).rows[0]!;
}

async function reportRows(pool: Pool) {
  return (await pool.query<{
    id: string; job_card_id: string; staff_user_id: string; period_start: string;
    period_end: string; manager_questions: unknown;
  }>(
    `SELECT id, job_card_id, staff_user_id, period_start::text AS period_start,
            period_end::text AS period_end, manager_questions
       FROM weekly_reports ORDER BY period_start`,
  )).rows;
}

async function jobRows(pool: Pool) {
  return (await pool.query<{
    id: string; status: string; title: string; description: string | null;
    assigned_to: string; created_by: string; due_date: string | null; customer_id: string | null;
    type: string;
  }>(
    `SELECT id, status, title, description, assigned_to, created_by,
            due_date::text AS due_date, customer_id, type
       FROM job_cards WHERE type = 'WEEKLY_REPORT' ORDER BY due_date, id`,
  )).rows;
}

async function countRows(pool: Pool, table: string): Promise<number> {
  return (await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0]!.n;
}

describe.skipIf(!databaseUrl)('weekly report recurrence worker (PostgreSQL)', () => {
  describe('due discovery', () => {
    it('leaves a rule whose week has not arrived untouched', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_B,
        });
        const harness = buildHarness(pool);
        const worker = buildWorker(harness, NOW);
        expect(await worker.runOnce()).toBe(0);
        expect(await countRows(pool, 'weekly_reports')).toBe(0);
        const row = await ruleRow(pool, ruleId);
        expect(row.next_period_start).toBe(WEEK_B);
        expect(row.last_processed_period_start).toBeNull();
      });
    });

    it('creates the report for a due current week with canonical semantics', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const questions = [{ key: 'q1', prompt: 'Bu hafta ne yaptın?' }];
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A, questions, instructions: 'Lütfen detaylandır.',
        });
        const harness = buildHarness(pool);
        const worker = buildWorker(harness, NOW);
        expect(await worker.runOnce()).toBe(1);

        const jobs = await jobRows(pool);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          status: 'NEW',
          title: `Haftalık Rapor (${WEEK_A} – 2026-10-11)`,
          description: 'Lütfen detaylandır.',
          assigned_to: staffId,
          created_by: managerId,
          due_date: WEEK_B,
          customer_id: null,
        });
        const reports = await reportRows(pool);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          staff_user_id: staffId, period_start: WEEK_A, manager_questions: questions,
        });
        expect(reports[0]!.job_card_id).toBe(jobs[0]!.id);

        const row = await ruleRow(pool, ruleId);
        expect(row.next_period_start).toBe(WEEK_B);
        expect(row.last_processed_period_start).toBe(WEEK_A);
        expect(row.last_outcome).toBe('created');
        expect(row.lease_token).toBeNull();
        expect(row.failure_count).toBe(0);
        expect(row.last_error_code).toBeNull();

        // Realtime JOB_CREATED was published exactly once.
        expect(harness.published).toHaveLength(1);
        expect(harness.published[0]).toMatchObject({ type: 'job.created' });
      });
    });

    it('converges to an already canonical report without creating a second one', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        const harness = buildHarness(pool);
        // A manager manually requested the same week before the worker ran.
        await harness.jobCardService.createWeeklyReport(
          { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
          parseWeeklyReportCreateInput({
            clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffId,
          }),
        );
        expect(await countRows(pool, 'weekly_reports')).toBe(1);
        const before = await jobRows(pool);
        const activityBefore = await countRows(pool, 'job_card_activity_logs');
        harness.published.length = 0;

        const worker = buildWorker(harness, NOW);
        expect(await worker.runOnce()).toBe(1);

        expect(await countRows(pool, 'weekly_reports')).toBe(1);
        const after = await jobRows(pool);
        expect(after).toHaveLength(1);
        expect(after[0]!.id).toBe(before[0]!.id);
        // No fake creation activity and no realtime for the converged occurrence.
        expect(await countRows(pool, 'job_card_activity_logs')).toBe(activityBefore);
        expect(harness.published).toHaveLength(0);

        const row = await ruleRow(pool, ruleId);
        expect(row.last_outcome).toBe('existing');
        expect(row.next_period_start).toBe(WEEK_B);
      });
    });
  });

  describe('target eligibility at execution', () => {
    it('auto-pauses and creates no report when the target is inactive', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        await pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [staffId]);
        const harness = buildHarness(pool);
        const worker = buildWorker(harness, NOW);
        expect(await worker.runOnce()).toBe(1);
        expect(await countRows(pool, 'weekly_reports')).toBe(0);
        expect(await countRows(pool, 'job_cards')).toBe(0);
        const row = await ruleRow(pool, ruleId);
        expect(row.enabled).toBe(false);
        expect(row.disabled_reason).toBe('STAFF_INELIGIBLE');
        expect(row.last_error_code).toBe('STAFF_INELIGIBLE');
        expect(row.next_period_start).toBe(WEEK_A);
        expect(row.lease_token).toBeNull();
        // Not retried forever: the rule is disabled, so it is never due again.
        expect(await worker.runOnce()).toBe(0);
      });
    });

    it('auto-pauses when the target is no longer a STAFF member', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        await pool.query(`UPDATE users SET role = 'MANAGER' WHERE id = $1`, [staffId]);
        const harness = buildHarness(pool);
        expect(await buildWorker(harness, NOW).runOnce()).toBe(1);
        expect(await countRows(pool, 'weekly_reports')).toBe(0);
        expect((await ruleRow(pool, ruleId)).disabled_reason).toBe('STAFF_INELIGIBLE');
      });
    });

    it('keeps generating reports after the authorizing manager loses the role', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        // The durable authorization is retained, so a role change must not
        // corrupt the rule: no HTTP authorization is re-run per tick.
        await pool.query(`UPDATE users SET role = 'STAFF' WHERE id = $1`, [managerId]);
        const harness = buildHarness(pool);
        expect(await buildWorker(harness, NOW).runOnce()).toBe(1);
        const jobs = await jobRows(pool);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.created_by).toBe(managerId);
      });
    });
  });

  describe('downtime and catch-up', () => {
    it('processes three missed enabled weeks sequentially without skipping', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        const harness = buildHarness(pool);
        const worker = buildWorker(harness, NOW_CATCHUP);
        // One period per iteration, in order.
        expect(await worker.runOnce()).toBe(1);
        expect((await ruleRow(pool, ruleId)).next_period_start).toBe(WEEK_B);
        expect(await worker.runOnce()).toBe(1);
        expect((await ruleRow(pool, ruleId)).next_period_start).toBe(WEEK_C);
        expect(await worker.runOnce()).toBe(1);
        expect((await ruleRow(pool, ruleId)).next_period_start).toBe(WEEK_D);
        // WEEK_D (10-26) is beyond the organization-local date (10-20).
        expect(await worker.runOnce()).toBe(0);
        const reports = await reportRows(pool);
        expect(reports.map((row) => row.period_start)).toEqual([WEEK_A, WEEK_B, WEEK_C]);
        expect((await ruleRow(pool, ruleId)).last_processed_period_start).toBe(WEEK_C);
      });
    });

    it('does not process a week that was deliberately paused', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        // Paused before the worker ever ran; the worker is three weeks late.
        await pool.query(
          `UPDATE weekly_report_recurrences SET enabled = FALSE, disabled_reason = 'MANUAL'
            WHERE id = $1`, [ruleId],
        );
        const harness = buildHarness(pool);
        const worker = buildWorker(harness, NOW_CATCHUP);
        expect(await worker.runOnce()).toBe(0);
        expect(await countRows(pool, 'weekly_reports')).toBe(0);
        // Resuming defaults to the CURRENT organization-local week, so the
        // paused weeks are never backfilled.
        await pool.query(
          `UPDATE weekly_report_recurrences SET enabled = TRUE, disabled_reason = NULL,
             next_period_start = GREATEST(next_period_start, $2::date)
            WHERE id = $1`, [ruleId, WEEK_C],
        );
        expect(await worker.runOnce()).toBe(1);
        expect(await reportRows(pool)).toHaveLength(1);
        expect((await reportRows(pool))[0]!.period_start).toBe(WEEK_C);
      });
    });
  });

  describe('organization-local timezone authority', () => {
    it('treats the same instant as Sunday in one organization and Monday in another', async () => {
      await withSchema(async (pool) => {
        // 2026-10-05T02:00Z → Monday 05:00 in Istanbul, Sunday 22:00 in New York.
        const instant = '2026-10-05T02:00:00.000Z';
        const orgMonday = await insertOrg(pool, 'Europe/Istanbul');
        const orgSunday = await insertOrg(pool, 'America/New_York');
        const managerMonday = await insertUser(pool, orgMonday, 'MANAGER');
        const managerSunday = await insertUser(pool, orgSunday, 'MANAGER');
        const staffMonday = await insertUser(pool, orgMonday, 'STAFF');
        const staffSunday = await insertUser(pool, orgSunday, 'STAFF');
        const ruleMonday = await insertRule(pool, {
          organizationId: orgMonday, staffUserId: staffMonday,
          requestedByUserId: managerMonday, nextPeriodStart: WEEK_A,
        });
        const ruleSunday = await insertRule(pool, {
          organizationId: orgSunday, staffUserId: staffSunday,
          requestedByUserId: managerSunday, nextPeriodStart: WEEK_A,
        });
        const harness = buildHarness(pool);
        const worker = buildWorker(harness, instant);
        expect(await worker.runOnce()).toBe(1);

        const reports = await reportRows(pool);
        expect(reports).toHaveLength(1);
        expect(reports[0]!.staff_user_id).toBe(staffMonday);
        expect((await ruleRow(pool, ruleMonday)).last_outcome).toBe('created');
        const sunday = await ruleRow(pool, ruleSunday);
        expect(sunday.next_period_start).toBe(WEEK_A);
        expect(sunday.last_outcome).toBeNull();
      });
    });
  });

  describe('failure handling', () => {
    it('does not advance the period on a transient failure and retries the same week', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        const harness = buildHarness(pool);
        let failNext = true;
        // Explicit delegation: a spread of a class instance would copy no
        // prototype methods and silently drop claimDue/retry/release.
        const flaky = {
          claimDue: (...args: Parameters<typeof harness.repository.claimDue>) =>
            harness.repository.claimDue(...args),
          retry: (...args: Parameters<typeof harness.repository.retry>) =>
            harness.repository.retry(...args),
          release: (...args: Parameters<typeof harness.repository.release>) =>
            harness.repository.release(...args),
          processOccurrence: async (
            ...args: Parameters<typeof harness.repository.processOccurrence>
          ) => {
            if (failNext) {
              failNext = false;
              throw new Error('simulated transient failure');
            }
            return harness.repository.processOccurrence(...args);
          },
        };
        const worker = createWeeklyReportRecurrenceWorker(
          flaky,
          harness.service.createOccurrence,
          { now: () => new Date(NOW), batchSize: 50 },
        );
        expect(await worker.runOnce()).toBe(1);
        const failed = await ruleRow(pool, ruleId);
        expect(failed.next_period_start).toBe(WEEK_A);
        expect(failed.failure_count).toBe(1);
        expect(failed.last_error_code).toBe('OCCURRENCE_FAILED');
        expect(failed.lease_token).toBeNull();
        expect(failed.next_attempt_at.valueOf()).toBeGreaterThan(new Date(NOW).valueOf());
        expect(await countRows(pool, 'weekly_reports')).toBe(0);

        // Same week is retried and succeeds once the transient cause clears.
        await pool.query(
          `UPDATE weekly_report_recurrences SET next_attempt_at = $2 WHERE id = $1`,
          [ruleId, new Date(new Date(NOW).valueOf() - 1000)],
        );
        expect(await worker.runOnce()).toBe(1);
        expect(await reportRows(pool)).toHaveLength(1);
        const recovered = await ruleRow(pool, ruleId);
        expect(recovered.next_period_start).toBe(WEEK_B);
        expect(recovered.failure_count).toBe(0);
        expect(recovered.last_error_code).toBeNull();
      });
    });

    it('reclaims a period whose lease expired without creating a duplicate', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        // Simulate a crash after claiming: an expired lease, nothing written.
        await pool.query(
          `UPDATE weekly_report_recurrences
              SET lease_token = $2, lease_until = $3 WHERE id = $1`,
          [ruleId, randomUUID(), new Date(new Date(NOW).valueOf() - 60_000)],
        );
        const harness = buildHarness(pool);
        const worker = buildWorker(harness, NOW);
        expect(await worker.runOnce()).toBe(1);
        expect(await reportRows(pool)).toHaveLength(1);
        const row = await ruleRow(pool, ruleId);
        expect(row.next_period_start).toBe(WEEK_B);
        expect(row.lease_token).toBeNull();
      });
    });

    it('does not reclaim a period whose lease is still live', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        await pool.query(
          `UPDATE weekly_report_recurrences
              SET lease_token = $2, lease_until = $3 WHERE id = $1`,
          [ruleId, randomUUID(), new Date(new Date(NOW).valueOf() + 120_000)],
        );
        const harness = buildHarness(pool);
        expect(await buildWorker(harness, NOW).runOnce()).toBe(0);
        expect(await countRows(pool, 'weekly_reports')).toBe(0);
      });
    });
  });

  describe('multi-instance safety', () => {
    it('lets exactly one of two workers claim and produce the report', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        const harnessA = buildHarness(pool);
        const harnessB = buildHarness(pool);
        const workerA = buildWorker(harnessA, NOW);
        const workerB = buildWorker(harnessB, NOW);
        const [claimsA, claimsB] = await Promise.all([workerA.runOnce(), workerB.runOnce()]);
        expect(claimsA + claimsB).toBe(1);
        expect(await reportRows(pool)).toHaveLength(1);
        expect((await ruleRow(pool, ruleId)).next_period_start).toBe(WEEK_B);
      });
    });
  });

  describe('pause race', () => {
    it('never creates a report for a claim that a manager paused mid-flight', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        const harness = buildHarness(pool);
        // Claim, then pause, then process: the occurrence transaction must
        // re-read the rule and refuse to create anything.
        const claimedAt = new Date(NOW);
        const claims = await harness.repository.claimDue(
          claimedAt, randomUUID(), new Date(claimedAt.valueOf() + 120_000), 10,
        );
        expect(claims).toHaveLength(1);
        await harness.service.pause(
          { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
          ruleId,
          { clientActionId: randomUUID(), expectedVersion: 1 },
        );
        const outcome = await harness.repository.processOccurrence(
          claims[0]!, claimedAt, harness.service.createOccurrence,
        );
        expect(outcome.result.outcome).toBe('skipped');
        expect(await countRows(pool, 'weekly_reports')).toBe(0);
        const row = await ruleRow(pool, ruleId);
        expect(row.enabled).toBe(false);
        expect(row.disabled_reason).toBe('MANUAL');
        expect(row.next_period_start).toBe(WEEK_A);
      });
    });
  });

  describe('pause/resume scheduling epoch', () => {
    it('T1 voids a pre-pause claim: stale process is skipped with paused state preserved', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        const harness = buildHarness(pool);
        const claimedAt = new Date(NOW);
        const claims = await harness.repository.claimDue(
          claimedAt, randomUUID(), new Date(claimedAt.valueOf() + 120_000), 10,
        );
        expect(claims).toHaveLength(1);
        const paused = await harness.service.pause(
          { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
          ruleId,
          { clientActionId: randomUUID(), expectedVersion: 1 },
        );
        expect(paused.version).toBe(2);
        // The committed pause must have invalidated the in-flight lease.
        expect((await ruleRow(pool, ruleId)).lease_token).toBeNull();
        const outcome = await harness.repository.processOccurrence(
          claims[0]!, claimedAt, harness.service.createOccurrence,
        );
        expect(outcome.result.outcome).toBe('skipped');
        expect(outcome.result.processedPeriodStart).toBeNull();
        expect(await countRows(pool, 'weekly_reports')).toBe(0);
        const row = await ruleRow(pool, ruleId);
        expect(row.enabled).toBe(false);
        expect(row.disabled_reason).toBe('MANUAL');
        expect(row.next_period_start).toBe(WEEK_A);
        expect(row.lease_token).toBeNull();
        expect(row.last_processed_period_start).toBeNull();
        expect(row.last_outcome).toBeNull();
        expect(row.version).toBe(2);
      });
    });

    it('T2 never executes a future resumed week early for a stale pre-pause claim', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        // Current week is 2026-10-26; the rule is three weeks overdue.
        const weekNow = '2026-10-26T09:00:00.000Z';
        const futureWeek = '2026-11-02';
        const harness = buildHarness(pool, [], weekNow);
        const claimedAt = new Date(weekNow);
        const claims = await harness.repository.claimDue(
          claimedAt, randomUUID(), new Date(claimedAt.valueOf() + 120_000), 10,
        );
        expect(claims).toHaveLength(1);
        await harness.service.pause(
          { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
          ruleId,
          { clientActionId: randomUUID(), expectedVersion: 1 },
        );
        const resumed = await harness.service.resume(
          { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
          ruleId,
          { clientActionId: randomUUID(), expectedVersion: 2, periodStart: futureWeek },
        );
        expect(resumed).toMatchObject({ enabled: true, nextPeriodStart: futureWeek, version: 3 });
        // The committed resume must not inherit the pre-pause lease.
        expect((await ruleRow(pool, ruleId)).lease_token).toBeNull();

        // The stale pre-pause claim now processes: it must skip.
        const outcome = await harness.repository.processOccurrence(
          claims[0]!, claimedAt, harness.service.createOccurrence,
        );
        expect(outcome.result.outcome).toBe('skipped');
        expect(await countRows(pool, 'weekly_reports')).toBe(0);
        const row = await ruleRow(pool, ruleId);
        expect(row.enabled).toBe(true);
        expect(row.next_period_start).toBe(futureWeek);
        expect(row.lease_token).toBeNull();
        expect(row.last_processed_period_start).toBeNull();
        expect(row.last_outcome).toBeNull();
        expect(row.version).toBe(3);

        // When the resumed week actually arrives, exactly one report is made.
        const dueHarness = buildHarness(pool, [], `${futureWeek}T09:00:00.000Z`);
        expect(await buildWorker(dueHarness, `${futureWeek}T09:00:00.000Z`).runOnce()).toBe(1);
        const reports = await reportRows(pool);
        expect(reports).toHaveLength(1);
        expect(reports[0]!.period_start).toBe(futureWeek);
        const advanced = await ruleRow(pool, ruleId);
        expect(advanced.next_period_start).toBe('2026-11-09');
        expect(advanced.last_processed_period_start).toBe(futureWeek);
      });
    });

    it('T3 invalidates the old claim on current-week resume but lets a new claim proceed', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        const weekNow = '2026-10-26T09:00:00.000Z';
        const currentWeek = '2026-10-26';
        const harness = buildHarness(pool, [], weekNow);
        const claimedAt = new Date(weekNow);
        const claims = await harness.repository.claimDue(
          claimedAt, randomUUID(), new Date(claimedAt.valueOf() + 120_000), 10,
        );
        expect(claims).toHaveLength(1);
        await harness.service.pause(
          { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
          ruleId,
          { clientActionId: randomUUID(), expectedVersion: 1 },
        );
        const resumed = await harness.service.resume(
          { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
          ruleId,
          { clientActionId: randomUUID(), expectedVersion: 2, periodStart: currentWeek },
        );
        expect(resumed).toMatchObject({ enabled: true, nextPeriodStart: currentWeek });

        // Old claim: skipped, creates nothing.
        const stale = await harness.repository.processOccurrence(
          claims[0]!, claimedAt, harness.service.createOccurrence,
        );
        expect(stale.result.outcome).toBe('skipped');
        expect(await countRows(pool, 'weekly_reports')).toBe(0);

        // New claim for the resumed current week: processes exactly once.
        const fresh = await harness.repository.claimDue(
          claimedAt, randomUUID(), new Date(claimedAt.valueOf() + 120_000), 10,
        );
        expect(fresh).toHaveLength(1);
        const created = await harness.repository.processOccurrence(
          fresh[0]!, claimedAt, harness.service.createOccurrence,
        );
        expect(created.result.outcome).toBe('created');
        expect(created.result.processedPeriodStart).toBe(currentWeek);
        const reports = await reportRows(pool);
        expect(reports).toHaveLength(1);
        expect(reports[0]!.period_start).toBe(currentWeek);
        expect((await ruleRow(pool, ruleId)).next_period_start).toBe('2026-11-02');
      });
    });

    it('T4 refuses a leased claim on a future period by revalidating due-ness', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const futureWeek = '2026-11-02';
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: futureWeek,
        });
        const weekNow = '2026-10-26T09:00:00.000Z';
        const harness = buildHarness(pool, [], weekNow);
        // Artificially establish a valid-looking lease on the future period.
        // This proves safety does not depend solely on pause clearing leases.
        const leaseToken = randomUUID();
        await pool.query(
          `UPDATE weekly_report_recurrences
              SET lease_token = $2, lease_until = $3 WHERE id = $1`,
          [ruleId, leaseToken, new Date(new Date(weekNow).valueOf() + 600_000)],
        );
        const outcome = await harness.repository.processOccurrence(
          {
            id: ruleId, organizationId, staffUserId: staffId,
            requestedByUserId: managerId, nextPeriodStart: futureWeek,
            managerQuestions: [], instructions: null, failureCount: 0,
            leaseToken,
          },
          new Date(weekNow),
          harness.service.createOccurrence,
        );
        expect(outcome.result.outcome).toBe('skipped');
        expect(await countRows(pool, 'weekly_reports')).toBe(0);
        const row = await ruleRow(pool, ruleId);
        expect(row.enabled).toBe(true);
        expect(row.next_period_start).toBe(futureWeek);
        expect(row.lease_token).toBeNull();
        expect(row.failure_count).toBe(0);
        expect(row.last_outcome).toBeNull();
      });
    });
    it('resume starts a new epoch: a post-pause lease is cleared and cannot execute', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        const weekNow = '2026-10-26T09:00:00.000Z';
        const currentWeek = '2026-10-26';
        const harness = buildHarness(pool, [], weekNow);
        const claimedAt = new Date(weekNow);
        const claims = await harness.repository.claimDue(
          claimedAt, randomUUID(), new Date(claimedAt.valueOf() + 120_000), 10,
        );
        expect(claims).toHaveLength(1);
        await harness.service.pause(
          { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
          ruleId,
          { clientActionId: randomUUID(), expectedVersion: 1 },
        );
        expect((await ruleRow(pool, ruleId)).lease_token).toBeNull();
        // A lease established after the pause under the old scheduling state
        // (crashed worker, manual intervention, future bug) must not survive
        // the resume: the resumed schedule is a new epoch.
        await pool.query(
          `UPDATE weekly_report_recurrences
              SET lease_token = $2, lease_until = $3 WHERE id = $1`,
          [ruleId, claims[0]!.leaseToken, new Date(claimedAt.valueOf() + 600_000)],
        );
        const resumed = await harness.service.resume(
          { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
          ruleId,
          { clientActionId: randomUUID(), expectedVersion: 2, periodStart: currentWeek },
        );
        expect(resumed).toMatchObject({ enabled: true, nextPeriodStart: currentWeek });
        expect((await ruleRow(pool, ruleId)).lease_token).toBeNull();

        const stale = await harness.repository.processOccurrence(
          claims[0]!, claimedAt, harness.service.createOccurrence,
        );
        expect(stale.result.outcome).toBe('skipped');
        expect(await countRows(pool, 'weekly_reports')).toBe(0);
        expect((await ruleRow(pool, ruleId)).next_period_start).toBe(currentWeek);
      });
    });
  });

  describe('question and instruction freezing', () => {
    it('never rewrites an already-created report when the template changes', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const original = [{ key: 'q1', prompt: 'İlk soru' }];
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A, questions: original, instructions: 'İlk talimat',
        });
        const harness = buildHarness(pool);
        expect(await buildWorker(harness, NOW).runOnce()).toBe(1);
        const firstReport = (await reportRows(pool))[0]!;
        const firstJob = (await jobRows(pool))[0]!;
        expect(firstReport.manager_questions).toEqual(original);
        expect(firstJob.description).toBe('İlk talimat');

        await harness.service.updateTemplate(
          { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
          ruleId,
          {
            clientActionId: randomUUID(), expectedVersion: 1,
            questions: [{ key: 'q9', prompt: 'Yeni soru' }], instructions: 'Yeni talimat',
          },
        );
        // The already-created report and JobCard are untouched.
        const after = (await reportRows(pool))[0]!;
        expect(after.id).toBe(firstReport.id);
        expect(after.manager_questions).toEqual(original);
        expect((await jobRows(pool))[0]!.description).toBe('İlk talimat');

        // The NEXT week uses the new template.
        await pool.query(
          `UPDATE weekly_report_recurrences SET next_attempt_at = $2 WHERE id = $1`,
          [ruleId, new Date(new Date(NOW).valueOf() - 1000)],
        );
        expect(await buildWorker(harness, `${WEEK_B}T09:00:00.000Z`).runOnce()).toBe(1);
        const reports = await reportRows(pool);
        expect(reports).toHaveLength(2);
        expect(reports[1]!.manager_questions).toEqual([{ key: 'q9', prompt: 'Yeni soru' }]);
        expect((await jobRows(pool))[1]!.description).toBe('Yeni talimat');
      });
    });
  });

  describe('deadline immutability', () => {
    it('P5: rejects manager/admin due-date patches on a recurrence-created report', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const adminId = await insertUser(pool, organizationId, 'ADMIN');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const ruleId = await insertRule(pool, {
          organizationId, staffUserId: staffId, requestedByUserId: managerId,
          nextPeriodStart: WEEK_A,
        });
        const harness = buildHarness(pool);
        // The report exists ONLY through the recurrence worker path.
        expect(await buildWorker(harness, NOW).runOnce()).toBe(1);
        const job = (await jobRows(pool))[0]!;
        expect(job.due_date).toBe(WEEK_B);
        const detail = await harness.jobCardService.detail(
          { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
          job.id,
        );
        // No alternate authority path: same rejection as a manually
        // requested report, for both MANAGER and ADMIN.
        for (const actor of [
          { id: managerId, organizationId, role: 'MANAGER' },
          { id: adminId, organizationId, role: 'ADMIN' },
        ] as JobCardActor[]) {
          await expect(harness.jobCardService.patch(actor, job.id, {
            expectedVersion: detail.version, dueDate: '2026-10-13',
          })).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            statusCode: 400,
            details: { fieldErrors: { dueDate: 'Haftalık raporun teslim son tarihi değiştirilemez.' } },
          });
        }
        const after = (await pool.query<{ due_date: string; version: number }>(
          `SELECT due_date::text AS due_date, version FROM job_cards WHERE id = $1`,
          [job.id],
        )).rows[0];
        expect(after.due_date).toBe(WEEK_B);
        expect(after.version).toBe(detail.version);
      });
    });
  });
});
