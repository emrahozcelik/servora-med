import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { parseWeeklyReportRecurrenceBulkCreateInput } from '../src/modules/weekly-reports/recurrence-input.js';
import { PostgresWeeklyReportRecurrenceRepository } from '../src/modules/weekly-reports/recurrence-repository.js';
import { WeeklyReportRecurrenceService } from '../src/modules/weekly-reports/recurrence-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

/** Monday 12:00 Europe/Istanbul — the controllable clock for these tests. */
const NOW = '2026-10-05T09:00:00.000Z';
const WEEK_CURRENT = '2026-10-05';

/**
 * Schema-isolated pool with an explicit size. F-2 proved that recurrence
 * config commands self-deadlocked the pool when an inner timezone lookup used
 * `pool.query()` while the critical-action transaction owned the only client;
 * these tests pin the structural fix with real pool contention.
 */
async function withSizedSchema(max: number, run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr5p_${randomUUID().replaceAll('-', '')}`;
  let migrationPool: Pool | null = null;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    // Migrations run on an unconstrained pool: the migration runner itself is
    // out of scope for this test — only the test body below is constrained.
    migrationPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      store: new PostgresMigrationStore(migrationPool),
    });
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
      max,
    });
    await run(pool);
  } finally {
    await pool?.end();
    await migrationPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function insertOrg(pool: Pool): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id`,
    [`WR5P ${randomUUID()}`, 'Europe/Istanbul'],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, `WR5P ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

function buildHarness(pool: Pool) {
  const jobCardService = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => new Date(NOW),
    { publish: () => undefined },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
  const repository = new PostgresWeeklyReportRecurrenceRepository(pool);
  const service = new WeeklyReportRecurrenceService(
    repository, pool, jobCardService, () => new Date(NOW),
  );
  return { service };
}

const actor = (
  organizationId: string,
  id: string,
  role: JobCardActor['role'],
): JobCardActor => ({ id, organizationId, role });

/** Bounded wait: a pool self-deadlock would hang forever, so fail loudly. */
async function completesWithin<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(!databaseUrl)('weekly report recurrence pool safety (PostgreSQL)', () => {
  it('T5 completes a bulkCreate on a pool with max=1', async () => {
    await withSizedSchema(1, async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const { service } = buildHarness(pool);
      const created = await completesWithin(
        service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput({
            clientActionId: randomUUID(),
            staffUserIds: [staffId],
            startPeriodStart: WEEK_CURRENT,
          }),
        ),
        20_000,
        'max=1 bulkCreate',
      );
      expect(created.items).toHaveLength(1);
      expect(created.items[0]).toMatchObject({ staffUserId: staffId, outcome: 'created' });
      const count = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM weekly_report_recurrences`,
      );
      expect(count.rows[0]!.n).toBe(1);
      expect(pool.waitingCount).toBe(0);
    });
  });

  it('T6 completes pause and resume on a pool with max=1', async () => {
    await withSizedSchema(1, async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const { service } = buildHarness(pool);
      const manager = actor(organizationId, managerId, 'MANAGER');
      const created = await completesWithin(
        service.bulkCreate(
          manager,
          parseWeeklyReportRecurrenceBulkCreateInput({
            clientActionId: randomUUID(),
            staffUserIds: [staffId],
            startPeriodStart: WEEK_CURRENT,
          }),
        ),
        20_000,
        'max=1 bulkCreate',
      );
      const id = created.items[0]!.recurrenceId;
      const paused = await completesWithin(
        service.pause(manager, id, { clientActionId: randomUUID(), expectedVersion: 1 }),
        20_000,
        'max=1 pause',
      );
      expect(paused).toMatchObject({ enabled: false, version: 2 });
      const resumed = await completesWithin(
        service.resume(
          manager,
          id,
          { clientActionId: randomUUID(), expectedVersion: 2, periodStart: null },
        ),
        20_000,
        'max=1 resume',
      );
      expect(resumed).toMatchObject({ enabled: true, nextPeriodStart: WEEK_CURRENT, version: 3 });
      expect(pool.waitingCount).toBe(0);
    });
  });

  it('T7 completes three concurrent config commands on a saturated max=3 pool', async () => {
    await withSizedSchema(3, async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffIds = [
        await insertUser(pool, organizationId, 'STAFF'),
        await insertUser(pool, organizationId, 'STAFF'),
        await insertUser(pool, organizationId, 'STAFF'),
      ];
      const { service } = buildHarness(pool);
      const manager = actor(organizationId, managerId, 'MANAGER');
      const results = await completesWithin(
        Promise.all(staffIds.map((staffUserId) => service.bulkCreate(
          manager,
          parseWeeklyReportRecurrenceBulkCreateInput({
            clientActionId: randomUUID(),
            staffUserIds: [staffUserId],
            startPeriodStart: WEEK_CURRENT,
          }),
        ))),
        30_000,
        'saturated max=3 bulkCreates',
      );
      expect(results).toHaveLength(3);
      for (const [index, result] of results.entries()) {
        expect(result.items[0]).toMatchObject({
          staffUserId: staffIds[index],
          outcome: 'created',
        });
      }
      const count = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM weekly_report_recurrences`,
      );
      expect(count.rows[0]!.n).toBe(3);
      // No leaked waiters and every connection is reusable afterwards.
      expect(pool.waitingCount).toBe(0);
      expect(pool.totalCount).toBeLessThanOrEqual(3);
    });
  });
});
