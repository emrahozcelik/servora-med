import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import {
  mapSourceWorkRow,
  weekInstants,
} from '../src/modules/weekly-reports/source-work.js';
import { validateSourceWorkSnapshot } from '../src/modules/weekly-reports/validation.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

// Reporting week Monday 2026-08-03 (Europe/Istanbul, permanent +03:00).
const PERIOD_START = '2026-08-03';
const WEEK_START_ISO = '2026-08-02T21:00:00.000Z';
const WEEK_END_ISO = '2026-08-09T21:00:00.000Z';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr2sw_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, timezone: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id`,
    [`WR2SW ${randomUUID()}`, timezone],
  )).rows[0]!.id;
}

async function insertUser(pool: Pool, organizationId: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', 'STAFF', TRUE) RETURNING id`,
    [organizationId, `WR2SW ${randomUUID()}`, `${randomUUID()}@test.local`],
  )).rows[0]!.id;
}

async function insertCustomer(pool: Pool, organizationId: string, name: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, name],
  )).rows[0]!.id;
}

async function insertJob(
  pool: Pool,
  input: {
    organizationId: string;
    type: string;
    status: string;
    staffId: string;
    completedAt: string | null;
    customerId?: string | null;
    managerApprovedAt?: string | null;
  },
): Promise<string> {
  // COMPLETED rows additionally require manager approval evidence.
  const approvedAt = input.status === 'COMPLETED'
    ? (input.managerApprovedAt ?? input.completedAt)
    : input.managerApprovedAt ?? null;
  // Lifecycle timestamp CHECKs require a coherent trail: every fixture was
  // accepted, and progressed rows were additionally started.
  const acceptedAt = input.status === 'NEW'
    ? null
    : input.completedAt
      ? new Date(new Date(input.completedAt).getTime() - 7_200_000).toISOString()
      : '2026-08-01T09:00:00.000Z';
  // Active statuses require started_at; derive it just before completion.
  const startedAt = input.completedAt
    ? new Date(new Date(input.completedAt).getTime() - 3_600_000).toISOString()
    : null;
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by, customer_id,
        engagement_kind, accepted_at, accepted_by, started_at,
        staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by,
        revision_requested_at, revision_requested_by, revision_reason,
        cancelled_at, cancelled_by, cancel_reason,
        invalidated_at, invalidated_by, invalidation_reason_code)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING id`,
    [
      input.organizationId, input.type, input.status, `WR2SW ${input.type} ${randomUUID()}`,
      input.staffId, input.customerId ?? null,
      input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null,
      acceptedAt, acceptedAt ? input.staffId : null, startedAt, input.completedAt,
      input.completedAt ? input.staffId : null,
      approvedAt, approvedAt ? input.staffId : null,
      input.status === 'REVISION_REQUESTED' ? input.completedAt : null,
      input.status === 'REVISION_REQUESTED' ? input.staffId : null,
      input.status === 'REVISION_REQUESTED' ? 'Revizyon gerekli.' : null,
      input.status === 'CANCELLED' ? input.completedAt ?? '2026-08-05T09:00:00.000Z' : null,
      input.status === 'CANCELLED' ? input.staffId : null,
      input.status === 'CANCELLED' ? 'İptal edildi.' : null,
      input.status === 'INVALIDATED' ? '2026-08-05T09:00:00.000Z' : null,
      input.status === 'INVALIDATED' ? input.staffId : null,
      input.status === 'INVALIDATED' ? 'DUPLICATE' : null,
    ],
  )).rows[0]!.id;
}

describe.skipIf(!databaseUrl)('weekly source-work query (PostgreSQL)', () => {
  it('derives org-local Monday boundaries without session timezone assumptions', () => {
    const { weekStart, weekEnd } = weekInstants(PERIOD_START, 'Europe/Istanbul');
    expect(weekStart.toISOString()).toBe(WEEK_START_ISO);
    expect(weekEnd.toISOString()).toBe(WEEK_END_ISO);
  });

  it('includes exactly the qualifying week slice with deterministic order', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const staffId = await insertUser(pool, organizationId);
      const otherStaffId = await insertUser(pool, organizationId);
      const otherOrgId = await insertOrg(pool, 'Europe/Istanbul');
      const otherOrgStaffId = await insertUser(pool, otherOrgId);
      const customerId = await insertCustomer(pool, organizationId, 'Örnek Klinik');
      const { weekStart, weekEnd } = weekInstants(PERIOD_START, 'Europe/Istanbul');
      const repo = new PostgresJobCardRepository(pool);
      const query = () => repo.listWeeklySourceWorkSnapshot({
        organizationId, staffUserId: staffId, weekStart, weekEnd,
      });

      // 1: COMPLETED this week → included.
      const completedId = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'COMPLETED', staffId,
        completedAt: '2026-08-05T09:00:00.000Z', customerId,
      });
      // 2: WAITING_APPROVAL this week → included.
      const waitingId = await insertJob(pool, {
        organizationId, type: 'PRODUCT_DELIVERY', status: 'WAITING_APPROVAL', staffId,
        completedAt: '2026-08-06T09:00:00.000Z',
      });
      // 3: manager approval next week does NOT move it (staff clock rules).
      await insertJob(pool, {
        organizationId, type: 'SALES_MEETING', status: 'COMPLETED', staffId,
        completedAt: '2026-08-07T09:00:00.000Z', managerApprovedAt: '2026-08-12T09:00:00.000Z',
      });
      // 9: exactly Monday 00:00 org-local (inclusive) → included.
      const boundaryInId = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'COMPLETED', staffId,
        completedAt: WEEK_START_ISO,
      });
      // 4: previous week → excluded.
      await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'COMPLETED', staffId,
        completedAt: '2026-08-02T20:59:59.000Z',
      });
      // 10: exactly next Monday 00:00 org-local (exclusive) → excluded.
      await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'COMPLETED', staffId,
        completedAt: WEEK_END_ISO,
      });
      // 5: CANCELLED / INVALIDATED with in-week completion → excluded.
      for (const status of ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED', 'CANCELLED', 'INVALIDATED']) {
        await insertJob(pool, {
          organizationId, type: 'GENERAL_TASK', status, staffId,
          completedAt: status === 'NEW' || status === 'ACCEPTED' ? null : '2026-08-05T09:00:00.000Z',
        });
      }
      // 6: WEEKLY_REPORT → excluded even when completed in week.
      await insertJob(pool, {
        organizationId, type: 'WEEKLY_REPORT', status: 'COMPLETED', staffId,
        completedAt: '2026-08-05T09:00:00.000Z',
      });
      // 7/8: another staff / another org → excluded.
      await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'COMPLETED', staffId: otherStaffId,
        completedAt: '2026-08-05T09:00:00.000Z',
      });
      await insertJob(pool, {
        organizationId: otherOrgId, type: 'GENERAL_TASK', status: 'COMPLETED', staffId: otherOrgStaffId,
        completedAt: '2026-08-05T09:00:00.000Z',
      });

      const rows = await query();
      expect(rows.map((row) => row.jobCardId)).toEqual([
        boundaryInId, completedId, waitingId,
        // 2026-08-07 sales meeting sorts after 2026-08-06 waiting row.
        rows.find((row) => row.type === 'SALES_MEETING')!.jobCardId,
      ]);
      expect(rows).toHaveLength(4);
      const completed = rows.find((row) => row.jobCardId === completedId)!;
      expect(completed.customerName).toBe('Örnek Klinik');
      expect(completed.status).toBe('COMPLETED');
      const waiting = rows.find((row) => row.jobCardId === waitingId)!;
      // 12: nullable customer source job stays included with null display name.
      expect(waiting.customerName).toBeNull();

      // Snapshot mapping is total and shape-valid for every returned row.
      const items = rows.map(mapSourceWorkRow);
      expect(() => validateSourceWorkSnapshot(items)).not.toThrow();
      expect(items[0]!.staffCompletedAt).toBe(WEEK_START_ISO);
    });
  });

  it('honours DST when converting the org-local week window', async () => {
    await withSchema(async (pool) => {
      // America/New_York springs forward 2026-03-08; Monday 2026-03-09 00:00 EDT = 04:00Z.
      const organizationId = await insertOrg(pool, 'America/New_York');
      const staffId = await insertUser(pool, organizationId);
      const { weekStart, weekEnd } = weekInstants('2026-03-09', 'America/New_York');
      expect(weekStart.toISOString()).toBe('2026-03-09T04:00:00.000Z');
      expect(weekEnd.toISOString()).toBe('2026-03-16T04:00:00.000Z');
      await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'COMPLETED', staffId,
        completedAt: '2026-03-09T03:59:59.000Z',
      });
      const insideId = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'COMPLETED', staffId,
        completedAt: '2026-03-09T04:00:00.000Z',
      });
      const repo = new PostgresJobCardRepository(pool);
      const rows = await repo.listWeeklySourceWorkSnapshot({
        organizationId, staffUserId: staffId, weekStart, weekEnd,
      });
      expect(rows.map((row) => row.jobCardId)).toEqual([insideId]);
    });
  });

  it('breaks staff_completed_at ties by stable job id', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const staffId = await insertUser(pool, organizationId);
      const { weekStart, weekEnd } = weekInstants(PERIOD_START, 'Europe/Istanbul');
      const first = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'COMPLETED', staffId,
        completedAt: '2026-08-05T09:00:00.000Z',
      });
      const second = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'COMPLETED', staffId,
        completedAt: '2026-08-05T09:00:00.000Z',
      });
      const repo = new PostgresJobCardRepository(pool);
      const rows = await repo.listWeeklySourceWorkSnapshot({
        organizationId, staffUserId: staffId, weekStart, weekEnd,
      });
      const ids = rows.map((row) => row.jobCardId).sort();
      expect(rows.map((row) => row.jobCardId)).toEqual(ids);
      expect(new Set([first, second])).toEqual(new Set(ids));
    });
  });
});
