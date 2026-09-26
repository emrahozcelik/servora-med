import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresSessionRevocationPort } from '../src/modules/auth/admin-ports.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { PeopleService } from '../src/modules/people/service.js';
import { PostgresPeopleRepository } from '../src/modules/people/repository.js';
import { PostgresStaffOffboardingService } from '../src/modules/people/offboarding.js';
import { PostgresWeeklyReportRecurrenceRepository } from '../src/modules/weekly-reports/recurrence-repository.js';
import { WeeklyReportRecurrenceService } from '../src/modules/weekly-reports/recurrence-service.js';
import { createWeeklyReportRecurrenceWorker } from '../src/modules/weekly-reports/recurrence-worker.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const WEEK_A = '2026-10-05';
/** Monday 12:00 Europe/Istanbul — WEEK_A is the current organization week. */
const NOW = '2026-10-05T09:00:00.000Z';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr5l_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [`WR5L ${randomUUID()}`],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: SafeUser['role'],
): Promise<SafeUser> {
  const row = (await pool.query<SafeUser>(
    `INSERT INTO users (
       organization_id, name, email, password_hash, role, is_active, data_class
     ) VALUES ($1, $2, $3, 'test-hash', $4, TRUE, 'BUSINESS')
     RETURNING id, organization_id AS "organizationId", name, email, role,
       must_change_password AS "mustChangePassword", is_active AS "isActive", version`,
    [organizationId, `WR5L ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!;
  if (role === 'STAFF') {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'WR5L test staff')`,
      [organizationId, row.id],
    );
  }
  return row;
}

async function userVersion(pool: Pool, userId: string): Promise<number> {
  return (await pool.query<{ version: number }>(
    `SELECT version FROM users WHERE id = $1`, [userId],
  )).rows[0]!.version;
}

async function insertRule(
  pool: Pool,
  input: { organizationId: string; staffUserId: string; requestedByUserId: string; nextPeriodStart: string },
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO weekly_report_recurrences
       (organization_id, staff_user_id, requested_by_user_id, next_period_start,
        manager_questions, instructions)
     VALUES ($1, $2, $3, $4, '[]', NULL) RETURNING id`,
    [input.organizationId, input.staffUserId, input.requestedByUserId, input.nextPeriodStart],
  )).rows[0]!.id;
}

function peopleService(pool: Pool): PeopleService {
  const repository = new PostgresPeopleRepository(
    pool,
    { validatePassword() {}, hashPassword: async () => 'unused' },
    new PostgresSessionRevocationPort(),
  );
  return new PeopleService(
    repository,
    { validatePassword() {}, hashPassword: async () => 'unused' },
    {} as never,
    () => new Date(NOW),
  );
}

function recurrenceHarness(pool: Pool) {
  const published: unknown[] = [];
  const jobCardService = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => new Date(NOW),
    { publish: (event) => { published.push(event); } },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
  const repository = new PostgresWeeklyReportRecurrenceRepository(pool);
  const service = new WeeklyReportRecurrenceService(
    repository, pool, jobCardService, () => new Date(NOW),
  );
  const worker = createWeeklyReportRecurrenceWorker(
    repository,
    service.createOccurrence,
    {
      now: () => new Date(NOW),
      publisher: { publish: (event) => { published.push(event); } },
      batchSize: 50,
    },
  );
  return { worker, published };
}

async function ruleState(pool: Pool, id: string) {
  return (await pool.query<{
    enabled: boolean; disabled_reason: string | null; next_period_start: string;
  }>(
    `SELECT enabled, disabled_reason,
            next_period_start::text AS next_period_start
       FROM weekly_report_recurrences WHERE id = $1`,
    [id],
  )).rows[0]!;
}

describe.skipIf(!databaseUrl)('weekly report recurrence staff lifecycle (PostgreSQL)', () => {
  it('offboards a staff member with an active rule and the worker auto-pauses with no report', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const admin = await insertUser(pool, organizationId, 'ADMIN');
      const manager = await insertUser(pool, organizationId, 'MANAGER');
      const staff = await insertUser(pool, organizationId, 'STAFF');
      const ruleId = await insertRule(pool, {
        organizationId, staffUserId: staff.id, requestedByUserId: manager.id, nextPeriodStart: WEEK_A,
      });

      // Offboarding must NOT fail merely because a recurrence exists, and it
      // must NOT resolve the rule itself: the worker converges to auto-pause
      // on its next run. No cross-module coupling was added.
      const offboarding = new PostgresStaffOffboardingService(
        pool, { disconnectUser: () => {} }, () => new Date(NOW),
      );
      const plan = await offboarding.preview(admin, staff.id);
      expect(plan.jobs).toHaveLength(0);
      const response = await offboarding.execute(admin, staff.id, {
        clientActionId: randomUUID(),
        planHash: plan.planHash,
        reasonCode: 'ACCESS_ENDED',
        jobDecisions: [],
        calendarDecisions: [],
        followUpDecisions: [],
        customerDecisions: [],
        reminderDecisions: [],
      });
      expect(response.status).toBe('OFFBOARDED');
      await expect(ruleState(pool, ruleId)).resolves.toMatchObject({
        enabled: true, disabled_reason: null, next_period_start: WEEK_A,
      });

      const { worker, published } = recurrenceHarness(pool);
      expect(await worker.runOnce()).toBe(1);
      expect(published).toHaveLength(0);
      await expect(pool.query(`SELECT id FROM weekly_reports WHERE staff_user_id = $1`, [staff.id]))
        .resolves.toMatchObject({ rows: [] });
      await expect(ruleState(pool, ruleId)).resolves.toMatchObject({
        enabled: false, disabled_reason: 'STAFF_INELIGIBLE', next_period_start: WEEK_A,
      });
    });
  });

  it('blocks permanent delete while an enabled rule targets the staff member', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const admin = await insertUser(pool, organizationId, 'ADMIN');
      const manager = await insertUser(pool, organizationId, 'MANAGER');
      const staff = await insertUser(pool, organizationId, 'STAFF');
      await insertRule(pool, {
        organizationId, staffUserId: staff.id, requestedByUserId: manager.id, nextPeriodStart: WEEK_A,
      });

      const service = peopleService(pool);
      await expect(service.getUser(admin, staff.id)).resolves.toMatchObject({
        canPermanentlyDelete: false,
        permanentDeleteBlockers: ['HAS_ACTIVE_RESPONSIBILITIES'],
      });
      await expect(service.deleteUser(admin, staff.id, staff.version)).rejects.toMatchObject({
        code: 'USER_PERMANENT_DELETE_BLOCKED',
        details: { blockers: ['HAS_ACTIVE_RESPONSIBILITIES'] },
      });
      await expect(pool.query(`SELECT id FROM users WHERE id = $1`, [staff.id]))
        .resolves.toMatchObject({ rows: [{ id: staff.id }] });
    });
  });

  it('pausing the rule unblocks delete and cleans the orphaned rule', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const admin = await insertUser(pool, organizationId, 'ADMIN');
      const manager = await insertUser(pool, organizationId, 'MANAGER');
      const staff = await insertUser(pool, organizationId, 'STAFF');
      const ruleId = await insertRule(pool, {
        organizationId, staffUserId: staff.id, requestedByUserId: manager.id, nextPeriodStart: WEEK_A,
      });
      await pool.query(
        `UPDATE weekly_report_recurrences
            SET enabled = FALSE, disabled_reason = 'MANUAL', version = version + 1
          WHERE id = $1`,
        [ruleId],
      );

      const service = peopleService(pool);
      await service.deleteUser(admin, staff.id, await userVersion(pool, staff.id));
      await expect(pool.query(`SELECT id FROM users WHERE id = $1`, [staff.id]))
        .resolves.toMatchObject({ rows: [] });
      // The paused rule's target no longer exists, so the configuration row is
      // removed with the user instead of orphaning a rule that can never run.
      await expect(pool.query(`SELECT id FROM weekly_report_recurrences WHERE id = $1`, [ruleId]))
        .resolves.toMatchObject({ rows: [] });
    });
  });

  it('retains the authorizing manager as business history while the rule exists', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const admin = await insertUser(pool, organizationId, 'ADMIN');
      const manager = await insertUser(pool, organizationId, 'MANAGER');
      const staff = await insertUser(pool, organizationId, 'STAFF');
      await insertRule(pool, {
        organizationId, staffUserId: staff.id, requestedByUserId: manager.id, nextPeriodStart: WEEK_A,
      });

      // The manager authorized nothing else: no JobCard, no audit event, no
      // assignment. The recurrence requester identity alone is history, exactly
      // like a JobCard creator.
      const service = peopleService(pool);
      await expect(service.getUser(admin, manager.id)).resolves.toMatchObject({
        canPermanentlyDelete: false,
        permanentDeleteBlockers: ['HAS_BUSINESS_HISTORY'],
      });
      await expect(service.deleteUser(admin, manager.id, manager.version)).rejects.toMatchObject({
        code: 'USER_PERMANENT_DELETE_BLOCKED',
        details: { blockers: ['HAS_BUSINESS_HISTORY'] },
      });
    });
  });
});
