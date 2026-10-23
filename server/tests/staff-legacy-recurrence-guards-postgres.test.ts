import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresSessionRevocationPort } from '../src/modules/auth/admin-ports.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresPeopleRepository } from '../src/modules/people/repository.js';
import { PostgresStaffOffboardingService } from '../src/modules/people/offboarding.js';
import { PeopleService } from '../src/modules/people/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const WEEK_A = '2026-10-05';
const NOW = '2026-10-05T09:00:00.000Z';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wrlegacy_${randomUUID().replaceAll('-', '')}`;
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
    [`WR-LEGACY ${randomUUID()}`],
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
    [organizationId, `WR-LEGACY ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!;
  if (role === 'STAFF') {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'WR legacy test staff')`,
      [organizationId, row.id],
    );
  }
  return row;
}

/** The rule is deliberately due in the past: any surviving writer would fire. */
async function insertRule(
  pool: Pool,
  input: { organizationId: string; staffUserId: string; requestedByUserId: string },
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO weekly_report_recurrences
       (organization_id, staff_user_id, requested_by_user_id, next_period_start,
        manager_questions, instructions, next_attempt_at)
     VALUES ($1, $2, $3, $4, '[]', NULL, NOW() - INTERVAL '1 second') RETURNING id`,
    [input.organizationId, input.staffUserId, input.requestedByUserId, WEEK_A],
  )).rows[0]!.id;
}

async function userVersion(pool: Pool, userId: string): Promise<number> {
  return (await pool.query<{ version: number }>(
    `SELECT version FROM users WHERE id = $1`, [userId],
  )).rows[0]!.version;
}

function peopleService(pool: Pool): PeopleService {
  const repository = new PostgresPeopleRepository(
    pool,
    { validateNewPassword() {}, hashPassword: async () => 'unused' },
    new PostgresSessionRevocationPort(),
  );
  return new PeopleService(
    repository,
    { validateNewPassword() {}, hashPassword: async () => 'unused' },
    {} as never,
    () => new Date(NOW),
  );
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

describe.skipIf(!databaseUrl)('legacy recurrence rows and staff lifecycle (PostgreSQL)', () => {
  it('offboarding a staff member with an enabled legacy rule neither fails nor mutates the rule', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const admin = await insertUser(pool, organizationId, 'ADMIN');
      const manager = await insertUser(pool, organizationId, 'MANAGER');
      const staff = await insertUser(pool, organizationId, 'STAFF');
      const ruleId = await insertRule(pool, {
        organizationId, staffUserId: staff.id, requestedByUserId: manager.id,
      });

      // Retirement removed the worker. Offboarding must stay usable and must
      // not invent a second resolver for the dormant rule.
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
      await expect(pool.query(`SELECT id FROM weekly_reports WHERE staff_user_id = $1`, [staff.id]))
        .resolves.toMatchObject({ rows: [] });
    });
  });

  it('blocks permanent delete while an enabled legacy rule targets the staff member', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const admin = await insertUser(pool, organizationId, 'ADMIN');
      const manager = await insertUser(pool, organizationId, 'MANAGER');
      const staff = await insertUser(pool, organizationId, 'STAFF');
      await insertRule(pool, {
        organizationId, staffUserId: staff.id, requestedByUserId: manager.id,
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

  it('a paused legacy rule does not block delete and its orphan row is cleaned with the user', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const admin = await insertUser(pool, organizationId, 'ADMIN');
      const manager = await insertUser(pool, organizationId, 'MANAGER');
      const staff = await insertUser(pool, organizationId, 'STAFF');
      const ruleId = await insertRule(pool, {
        organizationId, staffUserId: staff.id, requestedByUserId: manager.id,
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
      // Existing hard-delete cleanup for a paused rule whose target is gone.
      await expect(pool.query(`SELECT id FROM weekly_report_recurrences WHERE id = $1`, [ruleId]))
        .resolves.toMatchObject({ rows: [] });
    });
  });

  it('retains the authorizing manager as business history while the legacy rule exists', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const admin = await insertUser(pool, organizationId, 'ADMIN');
      const manager = await insertUser(pool, organizationId, 'MANAGER');
      const staff = await insertUser(pool, organizationId, 'STAFF');
      await insertRule(pool, {
        organizationId, staffUserId: staff.id, requestedByUserId: manager.id,
      });

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
