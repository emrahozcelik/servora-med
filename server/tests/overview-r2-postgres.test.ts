import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

import { PostgresOverviewRepository } from '../src/modules/overview/repository.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { getAllowedJobActions } from '../src/modules/job-cards/policy.js';
import type { JobPermissionSubject } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS = [
  '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
  '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
  '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql', '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql', '012_create_in_app_notifications.sql',
  '013_create_job_action_locations.sql', '014_create_web_push.sql',
  '015_job_card_engagement_kind.sql', '016_google_reverse_geocoding.sql',
  '017_calendar.sql', '018_messaging.sql',
  '019_job_card_operational_note_context.sql',
  '020_job_card_transition_note_contexts.sql',
  '021_job_card_note_added_notification_kind.sql',
  '022_job_card_follow_up_links.sql',
  '023_staff_confidential_notes.sql',
  '024_job_card_notes_invoice_number.sql',
  '025_messaging_context_ready.sql',
  '026_messaging_participant_lifecycle.sql',
] as const;

const requestTime = new Date('2026-07-26T08:00:00.000Z');

type Fixture = {
  pool: Pool;
  orgA: string;
  orgB: string;
  managerEmpty: SafeUser;
  managerTeam: SafeUser;
  adminA: SafeUser;
  staffA1: SafeUser;
  staffA2: SafeUser;
  managerB: SafeUser;
  staffB: SafeUser;
  staffA1JobIds: string[];
  staffA2JobIds: string[];
  manualA2Id: string;
  staffBJobId: string;
  manualBId: string;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `ovw_r2_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    for (const migration of MIGRATIONS) {
      const path = fileURLToPath(
        new URL(`../src/db/migrations/${migration}`, import.meta.url),
      );
      await pool.query(await readFile(path, 'utf8'));
    }

    const orgA = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Overview Org A') RETURNING id`,
    )).rows[0]!.id;
    const orgB = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Overview Org B') RETURNING id`,
    )).rows[0]!.id;

    async function user(org: string, name: string, role: string): Promise<SafeUser> {
      const row = (await pool!.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, 'unused-test-hash', $4) RETURNING id`,
        [org, name, `${randomUUID()}@test.local`, role],
      )).rows[0]!;
      return {
        id: row.id,
        organizationId: org,
        name,
        email: `${randomUUID()}@test.local`,
        role: role as SafeUser['role'],
        mustChangePassword: false,
        isActive: true,
        version: 1,
      };
    }

    const managerEmpty = await user(orgA, 'Boş Ekipli Yönetici', 'MANAGER');
    const managerTeam = await user(orgA, 'Ekipli Yönetici', 'MANAGER');
    const adminA = await user(orgA, 'Org A Admin', 'ADMIN');
    const staffA1 = await user(orgA, 'Org A Personel 1', 'STAFF');
    const staffA2 = await user(orgA, 'Org A Personel 2', 'STAFF');
    const managerB = await user(orgB, 'Org B Yönetici', 'MANAGER');
    const staffB = await user(orgB, 'Org B Personel', 'STAFF');

    // Only staffA1 belongs to managerTeam's legacy team. managerEmpty has no
    // direct reports at all. staffA2/staffB have no manager relationship.
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
       VALUES ($1, $2, $3), ($1, $4, NULL), ($5, $6, NULL)`,
      [orgA, staffA1.id, managerTeam.id, staffA2.id, orgB, staffB.id],
    );

    async function job(org: string, staff: SafeUser, title: string, scheduledAt: string) {
      const endsAt = new Date(Date.parse(scheduledAt) + 60 * 60 * 1_000).toISOString();
      const row = (await pool!.query<{ id: string }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by,
            scheduled_at, scheduled_ends_at)
         VALUES ($1, 'GENERAL_TASK', 'NEW', $2, $3, $3, $4, $5)
         RETURNING id`,
        [org, title, staff.id, scheduledAt, endsAt],
      )).rows[0]!;
      return row.id;
    }

    async function manual(org: string, staff: SafeUser, title: string, startsAt: string) {
      const endsAt = new Date(Date.parse(startsAt) + 60 * 60 * 1_000).toISOString();
      const row = (await pool!.query<{ id: string }>(
        `INSERT INTO calendar_events
           (organization_id, assigned_user_id, title, starts_at, ends_at,
            timezone, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, 'Europe/Istanbul', $6, $6)
         RETURNING id`,
        [org, staff.id, title, startsAt, endsAt, staff.id],
      )).rows[0]!;
      return row.id;
    }

    // staffA1: 6 upcoming jobs (Staff limit 5 proof), staffA2: 11 upcoming jobs
    // (management limit 10 + ordering proof), plus one MANUAL event per org.
    const staffA1JobIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      staffA1JobIds.push(await job(
        orgA, staffA1, `A1 İş ${i}`,
        new Date(requestTime.valueOf() + (1 + 2 * i) * 60 * 60 * 1_000).toISOString(),
      ));
    }
    const staffA2JobIds: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      staffA2JobIds.push(await job(
        orgA, staffA2, `A2 İş ${i}`,
        new Date(requestTime.valueOf() + (25 + 2 * i) * 60 * 60 * 1_000).toISOString(),
      ));
    }
    const manualA2Id = await manual(
      orgA, staffA2, 'A2 Manuel Plan', new Date(requestTime.valueOf() + 30 * 60 * 1_000).toISOString(),
    );
    const staffBJobId = await job(
      orgB, staffB, 'B İş', new Date(requestTime.valueOf() + 60 * 60 * 1_000).toISOString(),
    );
    const manualBId = await manual(
      orgB, staffB, 'B Manuel Plan', new Date(requestTime.valueOf() + 90 * 60 * 1_000).toISOString(),
    );

    await run({
      pool, orgA, orgB, managerEmpty, managerTeam, adminA, staffA1, staffA2,
      managerB, staffB, staffA1JobIds, staffA2JobIds, manualA2Id, staffBJobId, manualBId,
    });
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function repository(pool: Pool): PostgresOverviewRepository {
  const reports = {
    getOne: vi.fn(),
    getDashboard: vi.fn(),
    getApprovalSummary: vi.fn(),
  };
  return new PostgresOverviewRepository(pool, reports as never);
}

function isSorted(items: { startsAt: string; source: string; id: string }[]): boolean {
  for (let i = 1; i < items.length; i += 1) {
    const prev = items[i - 1]!;
    const current = items[i]!;
    if (prev.startsAt > current.startsAt) return false;
    if (prev.startsAt === current.startsAt && prev.source > current.source) return false;
    if (prev.startsAt === current.startsAt && prev.source === current.source
      && prev.id > current.id) return false;
  }
  return true;
}

describe.skipIf(!databaseUrl)('Overview R2 organization-wide Manager RBAC (PostgreSQL)', () => {
  it('O-R2-1: Manager sees upcoming JOB and MANUAL work for Staff outside the former team', async () => {
    await withFixture(async ({ pool, managerTeam, staffA2JobIds, manualA2Id }) => {
      const result = await repository(pool).getUpcomingWork(managerTeam, requestTime);
      const ids = result.items.map((item) => item.id);
      expect(ids).toContain(staffA2JobIds[0]);
      expect(ids).toContain(manualA2Id);
    });
  });

  it('O-R2-2: Manager with zero direct reports still sees organization-wide Upcoming Work', async () => {
    await withFixture(async ({ pool, managerEmpty, staffA1JobIds, staffA2JobIds, manualA2Id }) => {
      const result = await repository(pool).getUpcomingWork(managerEmpty, requestTime);
      const ids = result.items.map((item) => item.id);
      expect(ids).toContain(staffA1JobIds[0]);
      expect(ids).toContain(staffA2JobIds[0]);
      expect(ids).toContain(manualA2Id);
    });
  });

  it('O-R2-3: Staff remains self-scoped with the Staff limit preserved', async () => {
    await withFixture(async ({ pool, staffA1, staffA2, staffA1JobIds, staffA2JobIds, manualA2Id }) => {
      const a1 = await repository(pool).getUpcomingWork(staffA1, requestTime);
      expect(a1.items).toHaveLength(5);
      expect(a1.items.every((item) => staffA1JobIds.includes(item.id))).toBe(true);

      const a2 = await repository(pool).getUpcomingWork(staffA2, requestTime);
      expect(a2.items).toHaveLength(5);
      expect(a2.items.every((item) => staffA2JobIds.includes(item.id) || item.id === manualA2Id)).toBe(true);
      expect(a2.items.map((item) => item.id)).toContain(manualA2Id);
    });
  });

  it('O-R2-4: Admin remains organization-wide', async () => {
    await withFixture(async ({ pool, adminA, staffA1JobIds, staffA2JobIds, manualA2Id }) => {
      const result = await repository(pool).getUpcomingWork(adminA, requestTime);
      const ids = result.items.map((item) => item.id);
      expect(ids).toContain(staffA1JobIds[0]);
      expect(ids).toContain(staffA2JobIds[0]);
      expect(ids).toContain(manualA2Id);
    });
  });

  it('O-R2-5: cross-org isolation — Org B Manager never sees Org A upcoming data', async () => {
    await withFixture(async ({ pool, managerB, orgA, staffBJobId, manualBId }) => {
      const result = await repository(pool).getUpcomingWork(managerB, requestTime);
      const ids = result.items.map((item) => item.id);
      expect(ids).toContain(staffBJobId);
      expect(ids).toContain(manualBId);
      expect(ids.length).toBeGreaterThanOrEqual(2);
      // Aggregate isolation: no Org A identifiers anywhere in the result.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(orgA);
    });
  });

  it('O-R2-7: every newly visible Upcoming JOB is reachable under existing JobCard policy', async () => {
    await withFixture(async ({ pool, managerEmpty, orgA }) => {
      const result = await repository(pool).getUpcomingWork(managerEmpty, requestTime);
      const jobItems = result.items.filter((item) => item.source === 'JOB');
      expect(jobItems.length).toBeGreaterThan(0);
      for (const item of jobItems) {
        const row = (await pool.query<{ assigned_to: string }>(
          `SELECT assigned_to FROM job_cards WHERE organization_id = $1 AND id = $2`,
          [orgA, item.id],
        )).rows[0]!;
        const subject: JobPermissionSubject = {
          organizationId: orgA,
          type: 'GENERAL_TASK',
          status: 'NEW',
          assignedTo: row.assigned_to,
        };
        expect(getAllowedJobActions(managerEmpty, subject).length).toBeGreaterThan(0);
      }
    });
  });

  it('O-R2-8: management limit 10 and deterministic ordering remain intact after widening', async () => {
    await withFixture(async ({ pool, managerEmpty }) => {
      const result = await repository(pool).getUpcomingWork(managerEmpty, requestTime);
      expect(result.items).toHaveLength(10);
      expect(isSorted(result.items)).toBe(true);
    });
  });
});
