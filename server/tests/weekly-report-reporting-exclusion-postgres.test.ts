import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

// August 2026 range; completions land on 2026-08-05 (Europe/Istanbul).
const RANGE = { from: '2026-08-01', to: '2026-08-31' };
const REQUEST_TIME = new Date('2026-08-20T09:00:00.000Z');
const COMPLETED_AT = '2026-08-05T09:00:00.000Z';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr3_${randomUUID().replaceAll('-', '')}`;
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

/**
 * Weekly Reports are administrative artifacts, not productive work: they must
 * not inflate completion/performance/type-bucket measures. Status counters
 * (open/waiting/revision) intentionally still count them as outstanding
 * assigned work and are covered by the unchanged existing suites.
 */
describe.skipIf(!databaseUrl)('weekly reports excluded from productive-work aggregates (PostgreSQL)', () => {
  it('keeps completed weekly reports out of completions, buckets, execution and on-time measures', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
        [`WR3 ${randomUUID()}`],
      )).rows[0]!.id;
      const managerId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
         VALUES ($1, 'WR3 Manager', $2, 'test-hash', 'MANAGER', TRUE) RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const staffId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
         VALUES ($1, 'WR3 Staff', $2, 'test-hash', 'STAFF', TRUE) RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO staff_profiles (organization_id, user_id, title, manager_user_id)
         VALUES ($1, $2, 'Saha Personeli', $3)`,
        [organizationId, staffId, managerId],
      );
      for (const type of ['GENERAL_TASK', 'WEEKLY_REPORT']) {
        await pool.query(
          `INSERT INTO job_cards
             (organization_id, type, status, title, assigned_to, created_by,
              started_at, staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by)
           VALUES ($1, $2, 'COMPLETED', 'WR3 fixture', $3, $4, $5, $5, $3, $5, $4)`,
          [organizationId, type, staffId, managerId, COMPLETED_AT],
        );
      }
      // Active rows for the workload-by-type buckets.
      for (const type of ['GENERAL_TASK', 'WEEKLY_REPORT']) {
        await pool.query(
          `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
           VALUES ($1, $2, 'NEW', 'WR3 open fixture', $3, $4)`,
          [organizationId, type, staffId, managerId],
        );
      }
      const repository = new PostgresReportsRepository(pool);
      const input = {
        organizationId,
        staffUserIds: [staffId],
        requestedRange: RANGE,
        requestTime: REQUEST_TIME,
      };
      const summary = (await repository.getMany(input)).get(staffId)!;
      expect(summary.counters.completedInPeriod).toBe(1);
      expect(summary.currentWorkloadByType).toEqual([
        { type: 'PRODUCT_DELIVERY', count: 0 },
        { type: 'GENERAL_TASK', count: 1 },
        { type: 'SALES_MEETING', count: 0 },
      ]);

      const completion = (await repository.getStaffCompletionPerformanceMany(input)).get(staffId)!;
      expect(completion.completionDays).toBe(1);
      expect(completion.completionWorkTypes).toEqual([
        { type: 'PRODUCT_DELIVERY', count: 0 },
        { type: 'GENERAL_TASK', count: 1 },
        { type: 'SALES_MEETING', count: 0 },
      ]);

      const execution = (await repository.getStaffExecutionMany(input)).get(staffId)!;
      expect(execution.staffCompletedJobs).toBe(1);

      const onTime = (await repository.getStaffOnTimeMany(input)).get(staffId)!;
      expect(onTime.ineligibleOrNoDeadlineCompletedJobs).toBe(1);
      expect(onTime.eligibleScheduledCompletedJobs).toBe(0);

      const dashboard = await repository.getDashboard({
        organizationId,
        requestedRange: RANGE,
        requestTime: REQUEST_TIME,
      });
      expect(dashboard.counters.completedInPeriod).toBe(1);
      const trendTotal = dashboard.completedTrend.reduce((sum, point) => sum + point.count, 0);
      expect(trendTotal).toBe(1);
    });
  });
});
