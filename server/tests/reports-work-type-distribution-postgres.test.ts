import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe('Work-type distribution manager-scope regression', () => {
  it('keeps the repository aggregate independent of manager hierarchy while preserving staff filtering', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => ({
        rows: [
          { type: 'GENERAL_TASK', count: '1' },
          { type: 'PRODUCT_DELIVERY', count: '1' },
          { type: 'SALES_MEETING', count: '1' },
        ],
      })),
    };
    const reports = new PostgresReportsRepository(pool as never);
    const input = {
      organizationId: 'org-1',
      from: '2026-07-01',
      to: '2026-07-31',
      staffUserId: null,
    };

    const organizationWide = await reports.getWorkTypeDistribution(input);
    expect(organizationWide).toEqual([
      { type: 'GENERAL_TASK', count: 1 },
      { type: 'PRODUCT_DELIVERY', count: 1 },
      { type: 'SALES_MEETING', count: 1 },
    ]);
    expect(organizationWide.every((row) => Object.keys(row).sort().join(',') === 'count,type'))
      .toBe(true);
    const organizationSql = pool.query.mock.calls[0]![0];
    expect(organizationSql).toContain('j.organization_id = $1');
    expect(organizationSql).toContain("j.status <> 'INVALIDATED'");
    expect(organizationSql).not.toContain('staff_profiles');
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [
      input.organizationId,
      input.from,
      input.to,
    ]);

    await reports.getWorkTypeDistribution({
      ...input,
      staffUserId: 'staff-1',
    });
    const staffSql = pool.query.mock.calls[1]![0];
    expect(staffSql).toContain('j.assigned_to = $4');
    expect(pool.query.mock.calls[1]![1]).toEqual([
      input.organizationId,
      input.from,
      input.to,
      'staff-1',
    ]);
  });
});

async function applyCurrentMigrations(pool: Pool) {
  const migrationsDirectory = fileURLToPath(
    new URL('../src/db/migrations/', import.meta.url),
  );
  const migrations = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const migration of migrations) {
    await pool.query(await readFile(`${migrationsDirectory}/${migration}`, 'utf8'));
  }
}

describe.skipIf(!databaseUrl)('Work-type distribution PostgreSQL RBAC contract', () => {
  it('includes same-org direct, other-manager, and unassigned Staff while excluding another organization', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `work_type_distribution_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyCurrentMigrations(pool);

      async function insertOrganization(name: string) {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO organizations (name, timezone)
           VALUES ($1, 'Europe/Istanbul')
           RETURNING id`,
          [name],
        )).rows[0]!.id;
      }

      async function insertUser(
        organizationId: string,
        name: string,
        role: 'ADMIN' | 'MANAGER' | 'STAFF',
      ) {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO users (organization_id, name, email, password_hash, role)
           VALUES ($1, $2, $3, 'unused-test-hash', $4)
           RETURNING id`,
          [organizationId, name, `${randomUUID()}@test.local`, role],
        )).rows[0]!.id;
      }

      async function insertStaffProfile(
        organizationId: string,
        userId: string,
        managerId: string | null,
      ) {
        await pool!.query(
          `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id, title)
           VALUES ($1, $2, $3, 'Field Staff')`,
          [organizationId, userId, managerId],
        );
      }

      async function insertJob(
        organizationId: string,
        type: 'GENERAL_TASK' | 'PRODUCT_DELIVERY' | 'SALES_MEETING',
        assignedTo: string,
        createdAt: string,
      ) {
        const engagementKind = type === 'SALES_MEETING' ? 'SALES_MEETING' : null;
        await pool!.query(
          `INSERT INTO job_cards (
             organization_id, type, status, title, assigned_to, created_by, created_at,
             engagement_kind
           ) VALUES ($1, $2, 'NEW', $3, $4, $4, $5, $6)`,
          [organizationId, type, `${type} ${assignedTo}`, assignedTo, createdAt, engagementKind],
        );
      }

      const organizationOne = await insertOrganization('R2 Organization One');
      const organizationTwo = await insertOrganization('R2 Organization Two');
      const managerOne = await insertUser(organizationOne, 'Manager One', 'MANAGER');
      const managerTwo = await insertUser(organizationOne, 'Manager Two', 'MANAGER');
      await insertUser(organizationOne, 'Admin One', 'ADMIN');
      const directStaff = await insertUser(organizationOne, 'Direct Staff', 'STAFF');
      const otherManagerStaff = await insertUser(organizationOne, 'Other Manager Staff', 'STAFF');
      const unassignedStaff = await insertUser(organizationOne, 'Unassigned Staff', 'STAFF');
      const outsideOrganizationStaff = await insertUser(
        organizationTwo,
        'Outside Organization Staff',
        'STAFF',
      );

      await insertStaffProfile(organizationOne, directStaff, managerOne);
      await insertStaffProfile(organizationOne, otherManagerStaff, managerTwo);
      await insertStaffProfile(organizationOne, unassignedStaff, null);
      await insertStaffProfile(organizationTwo, outsideOrganizationStaff, null);

      const inRange = '2026-07-10T10:00:00.000Z';
      await insertJob(organizationOne, 'SALES_MEETING', directStaff, inRange);
      await insertJob(organizationOne, 'GENERAL_TASK', otherManagerStaff, inRange);
      await insertJob(organizationOne, 'PRODUCT_DELIVERY', unassignedStaff, inRange);
      await insertJob(organizationTwo, 'PRODUCT_DELIVERY', outsideOrganizationStaff, inRange);
      // Europe/Istanbul July 1 starts at June 30 21:00Z. Keep this row
      // genuinely outside the organization-local reporting range.
      await insertJob(organizationOne, 'GENERAL_TASK', directStaff, '2026-06-30T20:59:59.000Z');

      const reports = new PostgresReportsRepository(pool);
      const input = {
        organizationId: organizationOne,
        from: '2026-07-01',
        to: '2026-07-31',
        staffUserId: null,
      };
      const organizationWide = await reports.getWorkTypeDistribution(input);
      expect(organizationWide).toEqual([
        { type: 'GENERAL_TASK', count: 1 },
        { type: 'PRODUCT_DELIVERY', count: 1 },
        { type: 'SALES_MEETING', count: 1 },
      ]);
      expect(organizationWide.every((row) => Object.keys(row).sort().join(',') === 'count,type'))
        .toBe(true);

      const otherManagerRows = await reports.getWorkTypeDistribution({
        ...input,
        staffUserId: otherManagerStaff,
      });
      expect(otherManagerRows).toEqual([{ type: 'GENERAL_TASK', count: 1 }]);

      const unassignedRows = await reports.getWorkTypeDistribution({
        ...input,
        staffUserId: unassignedStaff,
      });
      expect(unassignedRows).toEqual([{ type: 'PRODUCT_DELIVERY', count: 1 }]);

      const outsideOrganizationRows = await reports.getWorkTypeDistribution({
        organizationId: organizationTwo,
        from: input.from,
        to: input.to,
        staffUserId: null,
      });
      expect(outsideOrganizationRows).toEqual([{ type: 'PRODUCT_DELIVERY', count: 1 }]);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
