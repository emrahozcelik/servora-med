import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

describe.skipIf(!databaseUrl)('JobCard history PostgreSQL authorization and pagination', () => {
  it('uses identical filtered totals/items for Customer and Staff scopes', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `history_f3_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
      await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('F3 history org') RETURNING id`,
      )).rows[0]!.id;
      const managerId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role) VALUES ($1, 'Manager', $2, 'hash', 'MANAGER') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const staffAId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role) VALUES ($1, 'Staff A', $2, 'hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const staffBId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role) VALUES ($1, 'Staff B', $2, 'hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id) VALUES ($1, $2, $3), ($1, $4, $3)`,
        [organizationId, staffAId, managerId, staffBId],
      );
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status) VALUES ($1, 'F3 Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;

      const createJob = async (input: {
        title: string; assignedTo: string; status: 'NEW' | 'COMPLETED'; sourceJobCardId?: string | null;
        createdAt: string;
      }) => (await pool!.query<{ id: string }>(
        `INSERT INTO job_cards
          (organization_id, type, status, title, customer_id, assigned_to, created_by, priority,
           started_at, staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by,
           source_job_card_id, follow_up_instructions, created_at, updated_at)
         VALUES ($1, 'GENERAL_TASK', $2, $3, $4, $5, $6, 'normal',
           $7, $8, $9, $10, $11, $12, $13, $14, $14)
         RETURNING id`,
        [organizationId, input.status, input.title, customerId, input.assignedTo, managerId,
          input.status === 'COMPLETED' ? '2026-07-20T09:00:00Z' : null,
          input.status === 'COMPLETED' ? '2026-07-20T10:00:00Z' : null,
          input.status === 'COMPLETED' ? input.assignedTo : null,
          input.status === 'COMPLETED' ? '2026-07-20T11:00:00Z' : null,
          input.status === 'COMPLETED' ? managerId : null,
          input.sourceJobCardId ?? null,
          input.sourceJobCardId ? 'F3 instructions' : null,
          input.createdAt],
      )).rows[0]!.id;

      await createJob({ title: 'Açık A', assignedTo: staffAId, status: 'NEW', createdAt: '2026-07-21T08:00:00Z' });
      await createJob({ title: 'Açık B', assignedTo: staffBId, status: 'NEW', createdAt: '2026-07-22T08:00:00Z' });
      const sourceId = await createJob({ title: 'Tamamlanan kaynak', assignedTo: staffAId, status: 'COMPLETED', createdAt: '2026-07-23T08:00:00Z' });
      await createJob({ title: 'Takip B', assignedTo: staffBId, status: 'COMPLETED', sourceJobCardId: sourceId, createdAt: '2026-07-24T08:00:00Z' });

      const repository = new PostgresJobCardRepository(pool);
      const managerActor = { id: managerId, organizationId, role: 'MANAGER' as const };
      const staffA = { id: staffAId, organizationId, role: 'STAFF' as const };
      const staffB = { id: staffBId, organizationId, role: 'STAFF' as const };

      await expect(repository.listCustomerJobHistory({
        organizationId, customerId, actor: managerActor, status: 'all', limit: 2, offset: 2,
      })).resolves.toMatchObject({ total: 4, limit: 2, offset: 2, items: expect.any(Array) });
      await expect(repository.listCustomerJobHistory({
        organizationId, customerId, actor: staffA, status: 'all', limit: 20, offset: 0,
      })).resolves.toMatchObject({ total: 2, items: expect.arrayContaining([
        expect.objectContaining({ assignee: expect.objectContaining({ id: staffAId }), childCount: null }),
      ]) });
      await expect(repository.listStaffJobHistory({
        organizationId, targetUserId: staffBId, actor: staffA, status: 'all', limit: 20, offset: 0,
      })).resolves.toMatchObject({ total: 2, items: expect.arrayContaining([
        expect.objectContaining({ assignee: expect.objectContaining({ id: staffAId }) }),
      ]) });
      await expect(repository.listStaffJobHistory({
        organizationId, targetUserId: staffBId, actor: managerActor, status: 'completed', limit: 20, offset: 0,
      })).resolves.toMatchObject({ total: 1, items: expect.arrayContaining([
        expect.objectContaining({ assignee: expect.objectContaining({ id: staffBId }), followUp: { sourceJobCardId: sourceId }, childCount: 0 }),
      ]) });
      await expect(repository.listCustomerJobHistory({
        organizationId, customerId, actor: managerActor, status: 'open', limit: 20, offset: 0,
      })).resolves.toMatchObject({ total: 2 });
      await expect(repository.listCustomerJobHistory({
        organizationId, customerId, actor: managerActor, status: 'completed', limit: 20, offset: 0,
      })).resolves.toMatchObject({ total: 2 });
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
