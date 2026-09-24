import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr4_${randomUUID().replaceAll('-', '')}`;
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
 * WEEKLY_REPORT must never be proposed (or built) as a follow-up child while
 * its public creation path stays closed. The proposal validator rejects the
 * type before any follow-up row is written.
 */
describe.skipIf(!databaseUrl)('weekly report follow-up proposal stays closed (PostgreSQL)', () => {
  it('rejects a WEEKLY_REPORT follow-up proposal at submit time', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
        [`WR4 ${randomUUID()}`],
      )).rows[0]!.id;
      const managerId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
         VALUES ($1, 'WR4 Manager', $2, 'test-hash', 'MANAGER', TRUE) RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const staffId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
         VALUES ($1, 'WR4 Staff', $2, 'test-hash', 'STAFF', TRUE) RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const service = new JobCardService(
        new PostgresJobCardRepository(pool),
        () => new Date('2026-08-05T09:00:00.000Z'),
        { publish: () => undefined },
        { enabled: false },
        { enabled: false },
        { enabled: false, reminderLeadMinutes: 30 },
      );
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };
      let job = await service.create(manager, {
        clientActionId: randomUUID(), type: 'GENERAL_TASK', title: 'WR4 görev',
        description: null, customerId: null, contactId: null, assignedTo: staffId,
        priority: 'normal', dueDate: null, scheduledAt: null,
      });
      job = await service.acceptAssignment(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.start(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      const proposal = {
        // Monday 2027-01-04: far-future explicit slot, no scheduling objection.
        scheduledAt: '2027-01-04T07:00:00.000Z',
        type: 'WEEKLY_REPORT',
        assignedTo: staffId,
        followUpInstructions: 'Haftalık rapor takibi.',
      } as const;
      await expect(service.submitForApproval(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Tamamlandı.', followUpProposal: proposal,
      })).rejects.toMatchObject({ code: 'FOLLOW_UP_PROPOSAL_INVALID' });
      // The rejected submit wrote neither a proposal nor a status change.
      const detail = await service.detail(staff, job.id);
      expect(detail.status).toBe('IN_PROGRESS');
      expect(detail.followUpProposal).toBeNull();
    });
  });
});
