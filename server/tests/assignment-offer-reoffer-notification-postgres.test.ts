import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { MINUTE_MS, readDbBaseline } from './support/db-clock-baseline.js';

/**
 * JOB-010 release 2b — re-offer supersedes an overdue offer (review finding 7).
 *
 * §3/§8: re-offer closes an overdue `OPEN` offer as `EXPIRED` in the same
 * transaction that opens the new one. The expiry is history: the acting
 * manager is already recovering the job, so the `JOB_ASSIGNMENT_OFFER_EXPIRED`
 * activity and its realtime event are written but the `job.acceptance_expired`
 * in-app notifications are not.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `job010reoffer_${randomUUID().replaceAll('-', '')}`;
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

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
  name: string,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, true) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

function actor(id: string, organizationId: string, role: 'MANAGER' | 'STAFF'): JobCardActor {
  return { id, organizationId, role };
}

describe.skipIf(!databaseUrl)(
  'JOB-010 release 2b — re-offer supersedes an overdue offer without the expiry notification',
  () => {
    it('keeps the expiry activity and realtime fact but sends no job.acceptance_expired', async () => {
      await withSchema(async (pool) => {
        const baseline = await readDbBaseline(pool);
        const organizationId = (await pool.query<{ id: string }>(
          `INSERT INTO organizations (name, timezone)
           VALUES ('JOB-010 Reoffer Klinik', 'Europe/Istanbul') RETURNING id`,
        )).rows[0]!.id;
        const actingManagerId = await insertUser(pool, organizationId, 'MANAGER', 'Aktör Müdür');
        // A second active manager would receive the expiry notification
        // whenever the service did not suppress it.
        await insertUser(pool, organizationId, 'MANAGER', 'Diğer Müdür');
        const staffId = await insertUser(pool, organizationId, 'STAFF', 'Saha Personeli');

        const job = (await pool.query<{ id: string; version: number }>(
          `INSERT INTO job_cards
             (organization_id, type, status, title, assigned_to, created_by,
              scheduled_at, scheduled_ends_at, engagement_kind)
           VALUES ($1, 'SALES_MEETING', 'NEW', 'Klinik ziyareti yeniden teklifi', $2, $3,
                   $4::timestamptz, $5::timestamptz, 'SALES_MEETING')
           RETURNING id, version`,
          [
            organizationId, staffId, actingManagerId,
            new Date(baseline.getTime() + 50 * MINUTE_MS),
            new Date(baseline.getTime() + 110 * MINUTE_MS),
          ],
        )).rows[0]!;
        const overdueOfferId = (await pool.query<{ id: string }>(
          `INSERT INTO job_card_assignment_offers
             (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason,
              opened_by, acceptance_due_at, state)
           VALUES ($1, $2, $3, $4::timestamptz, 'CREATE', $5, $6::timestamptz, 'OPEN')
           RETURNING id`,
          [
            organizationId, job.id, staffId,
            new Date(baseline.getTime() - 80 * MINUTE_MS), actingManagerId,
            new Date(baseline.getTime() - 10 * MINUTE_MS),
          ],
        )).rows[0]!.id;

        const service = new JobCardService(
          new PostgresJobCardRepository(pool),
          () => baseline,
          undefined,
          { enabled: false },
          { enabled: false },
          { enabled: false, reminderLeadMinutes: 30 },
          {},
          { enabled: true },
        );
        const receipt = await service.reofferAssignment(
          actor(actingManagerId, organizationId, 'MANAGER'),
          job.id,
          { clientActionId: randomUUID(), expectedVersion: Number(job.version) },
        );

        const offers = (await pool.query<{
          id: string; state: string; closed_by: string | null;
        }>(
          `SELECT id, state, closed_by FROM job_card_assignment_offers
            WHERE job_card_id = $1 ORDER BY opened_at ASC, id ASC`,
          [job.id],
        )).rows;
        expect(offers).toHaveLength(2);
        expect(offers[0]).toMatchObject({
          id: overdueOfferId, state: 'EXPIRED', closed_by: null,
        });
        expect(offers[1]).toMatchObject({ id: receipt.offerId, state: 'OPEN' });

        // The list and board projections carry the same offer fact, so the
        // Staff answers stay available there (§2/§5).
        const staff = actor(staffId, organizationId, 'STAFF');
        const listItem = (await service.list(staff, {
          status: 'active', q: null, type: null, assignedTo: null, customerId: null,
          priority: null, dueBefore: null, dueAfter: null, followUp: null,
          overdue: false, limit: 25, offset: 0,
        })).items.find((item) => item.id === job.id);
        expect(listItem?.allowedCommands).toEqual(['ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT']);
        const boardItem = (await service.board(staff, {
          q: null, type: null, assignedTo: null, customerId: null, priority: null,
          dueBefore: null, dueAfter: null, followUp: null, limit: 25,
        })).columns.NEW.items.find((item) => item.id === job.id);
        expect(boardItem?.allowedCommands).toEqual(['ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT']);

        // The activity and its realtime fact stay: the close is history.
        const activities = (await pool.query<{ id: string }>(
          `SELECT id FROM job_card_activity_logs
            WHERE job_card_id = $1 AND event_type = 'JOB_ASSIGNMENT_OFFER_EXPIRED'`,
          [job.id],
        )).rows;
        expect(activities).toHaveLength(1);
        const realtime = (await pool.query<{ resource_keys: string[] }>(
          `SELECT resource_keys FROM realtime_events WHERE source_activity_id = $1`,
          [activities[0]!.id],
        )).rows;
        expect(realtime).toHaveLength(1);
        expect(realtime[0]!.resource_keys).not.toContain('notifications');

        // Nobody is alarmed: the acting manager is handling the recovery.
        const notifications = (await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM in_app_notifications
            WHERE organization_id = $1 AND kind = 'job.acceptance_expired'`,
          [organizationId],
        )).rows[0]!;
        expect(notifications.count).toBe('0');

        // The tightened 065 closure CHECK: `closed_by` is NULL exactly for a
        // clock-only EXPIRED offer, so an actor-stamped expiry is unrepresentable.
        await expect(pool.query(
          `INSERT INTO job_card_assignment_offers
             (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason,
              opened_by, acceptance_due_at, state, closed_at, closed_by)
           VALUES ($1, $2, $3, $4::timestamptz, 'REOFFER', $5, $4::timestamptz,
                   'EXPIRED', $4::timestamptz, $5)`,
          [organizationId, job.id, staffId, baseline, actingManagerId],
        )).rejects.toMatchObject({ code: '23514' });
      });
    });
  },
);
