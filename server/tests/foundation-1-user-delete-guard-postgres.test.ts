import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresCustomerAssignmentCleanup } from '../src/modules/crm/people-adapter.js';
import { PostgresPeopleRepository } from '../src/modules/people/repository.js';
import { PeopleService } from '../src/modules/people/service.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

describe.skipIf(!databaseUrl)('FOUNDATION-1 user deletion history guard', () => {
  it('blocks permanent deletion of a user referenced only by history rows (HAS_BUSINESS_HISTORY)', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const schema = `f1ud_${randomUUID().replaceAll('-', '')}`;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema},public` });
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
    try {
      const organizationId = randomUUID();
      await pool.query(
        `INSERT INTO organizations (id, name, timezone) VALUES ($1, $2, 'Europe/Istanbul')`,
        [organizationId, `F1UD ${randomUUID()}`],
      );
      const adminRow = await pool.query<{ id: string; version: number }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'UD Admin', $2, 'test-hash', 'ADMIN') RETURNING id, version`,
        [organizationId, `${randomUUID()}@f1ud.test`],
      );
      const targetRow = await pool.query<{ id: string; version: number }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'UD Target', $2, 'test-hash', 'STAFF') RETURNING id, version`,
        [organizationId, `${randomUUID()}@f1ud.test`],
      );
      const otherRow = await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'UD Other', $2, 'test-hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@f1ud.test`],
      );

      const jobId = randomUUID();
      await pool.query(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by, id)
         VALUES ($1, 'GENERAL_TASK', 'NEW', 'History-backed job', $2, $3, $4)`,
        [organizationId, targetRow.rows[0]!.id, adminRow.rows[0]!.id, jobId],
      );
      // Ownership moved away: the target now has only historical references.
      await pool.query(
        `UPDATE job_cards SET assigned_to = $1 WHERE id = $2`,
        [otherRow.rows[0]!.id, jobId],
      );
      // Schedule revision created_by = target; assignment history to_user_id = target.
      await pool.query(
        `INSERT INTO job_card_schedule_revisions
           (organization_id, job_card_id, revision_no, organization_timezone, source, created_by)
         VALUES ($1, $2, 1, 'Europe/Istanbul', 'CREATE', $3)`,
        [organizationId, jobId, targetRow.rows[0]!.id],
      );
      await pool.query(
        `INSERT INTO job_card_assignment_history
           (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
         VALUES ($1, $2, NULL, $3, $4, 'CREATE', NOW())`,
        [organizationId, jobId, targetRow.rows[0]!.id, adminRow.rows[0]!.id],
      );

      const repository = new PostgresPeopleRepository(
        pool,
        { validatePassword: () => undefined, hashPassword: async () => 'synthetic-hash' },
        { revokeAllSessions: async () => undefined },
        new PostgresCustomerAssignmentCleanup(),
      );
      const people = new PeopleService(
        repository,
        { validatePassword: () => undefined, hashPassword: async () => 'synthetic-hash' },
        new PostgresReportsRepository(pool),
        () => new Date('2026-09-10T08:00:00.000Z'),
      );

      const admin = {
        id: adminRow.rows[0]!.id, organizationId, name: 'UD Admin',
        email: `a-${randomUUID()}@f1ud.test`, role: 'ADMIN' as const,
        mustChangePassword: false, isActive: true, version: adminRow.rows[0]!.version,
      };
      await expect(
        people.deleteUser(admin, targetRow.rows[0]!.id, targetRow.rows[0]!.version),
      ).rejects.toMatchObject({
        code: 'USER_PERMANENT_DELETE_BLOCKED',
        statusCode: 409,
      });
      const stillThere = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE id = $1`,
        [targetRow.rows[0]!.id],
      );
      expect(stillThere.rows[0]!.count).toBe('1');
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
