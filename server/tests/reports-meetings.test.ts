import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const requestTime = new Date('2026-03-29T12:00:00.000Z');
const input = {
  organizationId: ORG_ID,
  staffUserId: STAFF_ID,
  requestedRange: { from: '2026-03-29', to: '2026-03-29' },
  requestTime,
} as const;

describe('PostgresReportsRepository Staff meeting outcomes', () => {
  it('maps exactly four canonical zero-filled outcomes without application aggregation', async () => {
    const query = vi.fn(async () => ({ rows: [
      { outcome: 'POSITIVE', count: 0 },
      { outcome: 'FOLLOW_UP_REQUIRED', count: 2 },
      { outcome: 'NO_DECISION', count: 0 },
      { outcome: 'NOT_INTERESTED', count: 1 },
    ] }));
    const repository = new PostgresReportsRepository({ query } as never);

    await expect(repository.getStaffMeetingsByOutcome(input)).resolves.toEqual([
      { outcome: 'POSITIVE', count: 0 },
      { outcome: 'FOLLOW_UP_REQUIRED', count: 2 },
      { outcome: 'NO_DECISION', count: 0 },
      { outcome: 'NOT_INTERESTED', count: 1 },
    ]);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([
      ORG_ID, STAFF_ID, '2026-03-29', '2026-03-29', requestTime,
    ]);
    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain("('POSITIVE', 1)");
    expect(sql).toContain("('FOLLOW_UP_REQUIRED', 2)");
    expect(sql).toContain("('NO_DECISION', 3)");
    expect(sql).toContain("('NOT_INTERESTED', 4)");
    expect(sql).toContain("jc.type = 'SALES_MEETING'");
    expect(sql).toContain("jc.status = 'COMPLETED'");
    expect(sql).toContain('jc.assigned_to = $2');
    expect(sql).toContain('md.meeting_at >=');
    expect(sql).toContain('md.meeting_at <');
    expect(sql).toContain('AT TIME ZONE organization_range.timezone');
    expect(sql).not.toMatch(/due_date|created_at|manager_approved_at|activity/i);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Staff meeting outcome PostgreSQL boundaries', () => {
  it('uses actual meeting time, completed ownership, organization and the Berlin DST range', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_meetings_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      for (const migration of [
        '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
        '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
        '007_sales_meeting.sql',
      ]) {
        const migrationPath = fileURLToPath(
          new URL(`../src/db/migrations/${migration}`, import.meta.url),
        );
        await pool.query(await readFile(migrationPath, 'utf8'));
      }

      async function organization(name: string) {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO organizations (name, timezone)
           VALUES ($1, 'Europe/Berlin') RETURNING id`,
          [name],
        )).rows[0]!.id;
      }
      async function staff(organizationId: string, name: string, isActive: boolean) {
        const userId = (await pool!.query<{ id: string }>(
          `INSERT INTO users
             (organization_id, name, email, password_hash, role, is_active)
           VALUES ($1, $2, $3, 'test-hash', 'STAFF', $4) RETURNING id`,
          [organizationId, name, `${randomUUID()}@test.local`, isActive],
        )).rows[0]!.id;
        await pool!.query(
          `INSERT INTO staff_profiles (organization_id, user_id) VALUES ($1, $2)`,
          [organizationId, userId],
        );
        return userId;
      }
      async function customer(organizationId: string) {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO customers (organization_id, name, customer_type, status)
           VALUES ($1, 'Klinik', 'clinic', 'active') RETURNING id`,
          [organizationId],
        )).rows[0]!.id;
      }
      async function meeting(params: {
        organizationId: string;
        staffUserId: string;
        customerId: string;
        status: 'COMPLETED' | 'WAITING_APPROVAL';
        outcome: 'POSITIVE' | 'FOLLOW_UP_REQUIRED' | 'NO_DECISION' | 'NOT_INTERESTED';
        meetingAt: string;
      }) {
        const completed = params.status === 'COMPLETED';
        const jobCardId = (await pool!.query<{ id: string }>(
          `INSERT INTO job_cards (
             organization_id, type, status, title, customer_id, assigned_to, created_by,
             started_at, staff_completed_at, staff_completed_by,
             manager_approved_at, manager_approved_by
           ) VALUES (
             $1, 'SALES_MEETING', $2, 'Görüşme', $3, $4, $4,
             '2026-03-28T10:00:00Z', '2026-03-28T11:00:00Z', $4,
             $5, $6
           ) RETURNING id`,
          [params.organizationId, params.status, params.customerId, params.staffUserId,
            completed ? new Date('2026-03-29T12:00:00Z') : null,
            completed ? params.staffUserId : null],
        )).rows[0]!.id;
        await pool!.query(
          `INSERT INTO job_card_meeting_details (
             organization_id, job_card_id, meeting_at, outcome, meeting_summary
           ) VALUES ($1, $2, $3, $4, 'Görüşme tamamlandı')`,
          [params.organizationId, jobCardId, params.meetingAt, params.outcome],
        );
      }

      const firstOrganizationId = await organization('Berlin One');
      const secondOrganizationId = await organization('Berlin Two');
      const targetStaffId = await staff(firstOrganizationId, 'Eski Personel', false);
      const otherStaffId = await staff(firstOrganizationId, 'Diğer Personel', true);
      const crossOrganizationStaffId = await staff(secondOrganizationId, 'Başka Firma', true);
      const firstCustomerId = await customer(firstOrganizationId);
      const secondCustomerId = await customer(secondOrganizationId);

      await meeting({
        organizationId: firstOrganizationId, staffUserId: targetStaffId,
        customerId: firstCustomerId, status: 'COMPLETED', outcome: 'POSITIVE',
        meetingAt: '2026-03-28T23:00:00.000Z',
      });
      await meeting({
        organizationId: firstOrganizationId, staffUserId: targetStaffId,
        customerId: firstCustomerId, status: 'COMPLETED', outcome: 'FOLLOW_UP_REQUIRED',
        meetingAt: '2026-03-29T21:59:59.999Z',
      });
      await meeting({
        organizationId: firstOrganizationId, staffUserId: targetStaffId,
        customerId: firstCustomerId, status: 'COMPLETED', outcome: 'NOT_INTERESTED',
        meetingAt: '2026-03-29T22:00:00.000Z',
      });
      await meeting({
        organizationId: firstOrganizationId, staffUserId: targetStaffId,
        customerId: firstCustomerId, status: 'WAITING_APPROVAL', outcome: 'NO_DECISION',
        meetingAt: '2026-03-29T10:00:00.000Z',
      });
      await meeting({
        organizationId: firstOrganizationId, staffUserId: otherStaffId,
        customerId: firstCustomerId, status: 'COMPLETED', outcome: 'NO_DECISION',
        meetingAt: '2026-03-29T10:00:00.000Z',
      });
      await meeting({
        organizationId: secondOrganizationId, staffUserId: crossOrganizationStaffId,
        customerId: secondCustomerId, status: 'COMPLETED', outcome: 'NOT_INTERESTED',
        meetingAt: '2026-03-29T10:00:00.000Z',
      });

      const result = await new PostgresReportsRepository(pool).getStaffMeetingsByOutcome({
        organizationId: firstOrganizationId,
        staffUserId: targetStaffId,
        requestedRange: { from: '2026-03-29', to: '2026-03-29' },
        requestTime,
      });
      expect(result).toEqual([
        { outcome: 'POSITIVE', count: 1 },
        { outcome: 'FOLLOW_UP_REQUIRED', count: 1 },
        { outcome: 'NO_DECISION', count: 0 },
        { outcome: 'NOT_INTERESTED', count: 0 },
      ]);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
