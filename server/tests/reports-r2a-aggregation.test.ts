import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS = [
  '001_auth_foundation.sql',
  '002_delivery_tracer.sql',
  '003_people.sql',
  '004_crm_contacts.sql',
  '005_product_catalog.sql',
  '006_jobcard_workspace.sql',
  '007_sales_meeting.sql',
  '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql',
  '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql',
  '012_create_in_app_notifications.sql',
  '013_create_job_action_locations.sql',
  '014_create_web_push.sql',
  '015_job_card_engagement_kind.sql',
  '016_google_reverse_geocoding.sql',
  '017_calendar.sql',
  '018_messaging.sql',
  '019_job_card_operational_note_context.sql',
  '020_job_card_transition_note_contexts.sql',
  '021_job_card_note_added_notification_kind.sql',
  '022_job_card_follow_up_links.sql',
  '023_staff_confidential_notes.sql',
  '024_job_card_notes_invoice_number.sql',
  '025_messaging_context_ready.sql',
  '026_messaging_participant_lifecycle.sql',
  '027_follow_up_proposals.sql',
  '028_notification_center_dismissal.sql',
  '029_messaging_conversation_archive.sql',
  '030_backup_domain_foundation.sql',
  '031_backup_engine_failure_taxonomy_and_dump_version.sql',
  '032_backup_r2_failure_taxonomy.sql',
  '033_backup_worker_runtime.sql',
  '034_demo_data_foundation.sql',
  '035_demo_data_purge_foundation.sql',
  '036_job_card_invalidated.sql',
] as const;

const range = { from: '2026-08-01', to: '2026-08-04' } as const;
const requestTime = new Date('2026-08-04T12:00:00.000Z');

async function applyMigrations(pool: Pool) {
  for (const migration of MIGRATIONS) {
    const path = fileURLToPath(
      new URL(`../src/db/migrations/${migration}`, import.meta.url),
    );
    await pool.query(await readFile(path, 'utf8'));
  }
}

async function insertOrganization(pool: Pool, name: string, timezone: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone)
     VALUES ($1, $2)
     RETURNING id`,
    [name, timezone],
  )).rows[0]!.id;
}

async function insertUser(pool: Pool, organizationId: string, name: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'unused-test-hash', 'MANAGER')
     RETURNING id`,
    [organizationId, name, `${randomUUID()}@reports-r2a.test`],
  )).rows[0]!.id;
}

type JobStatus =
  | 'NEW'
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'WAITING_APPROVAL'
  | 'REVISION_REQUESTED'
  | 'COMPLETED'
  | 'CANCELLED';

type JobType = 'PRODUCT_DELIVERY' | 'GENERAL_TASK' | 'SALES_MEETING';

async function insertJob(input: {
  pool: Pool;
  organizationId: string;
  assignedTo: string;
  createdBy: string;
  type: JobType;
  status: JobStatus;
  title: string;
  createdAt: string;
  managerApprovedAt?: string;
}) {
  const startedAt = [
    'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED',
  ].includes(input.status) ? input.createdAt : null;
  const staffCompletedAt = [
    'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED',
  ].includes(input.status) ? input.createdAt : null;
  const acceptedAt = input.status === 'ACCEPTED' ? input.createdAt : null;
  const managerApprovedAt = input.status === 'COMPLETED'
    ? input.managerApprovedAt ?? input.createdAt
    : null;
  const revisionRequestedAt = input.status === 'REVISION_REQUESTED' ? input.createdAt : null;
  const cancelledAt = input.status === 'CANCELLED' ? input.createdAt : null;

  return (await input.pool.query<{ id: string }>(
    `INSERT INTO job_cards (
       organization_id, type, status, title,
       assigned_to, created_by, created_at, engagement_kind,
       accepted_at, accepted_by, started_at,
       staff_completed_at, staff_completed_by,
       manager_approved_at, manager_approved_by,
       revision_requested_at, revision_requested_by, revision_reason,
       cancelled_at, cancelled_by, cancel_reason
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11,
       $12, $13,
       $14, $15,
       $16, $17, $18,
       $19, $20, $21
     )
     RETURNING id`,
    [
      input.organizationId,
      input.type,
      input.status,
      input.title,
      input.assignedTo,
      input.createdBy,
      input.createdAt,
      input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null,
      acceptedAt,
      acceptedAt ? input.assignedTo : null,
      startedAt,
      staffCompletedAt,
      staffCompletedAt ? input.assignedTo : null,
      managerApprovedAt,
      managerApprovedAt ? input.createdBy : null,
      revisionRequestedAt,
      revisionRequestedAt ? input.createdBy : null,
      revisionRequestedAt ? 'R2A test revision' : null,
      cancelledAt,
      cancelledAt ? input.createdBy : null,
      cancelledAt ? 'R2A test cancellation' : null,
    ],
  )).rows[0]!.id;
}

describe.skipIf(!databaseUrl)('Reports R2A-1 executive aggregation contract', () => {
  it('keeps created events, active snapshots, completed events, and tenants semantically separate', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_r2a_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationId = await insertOrganization(pool, 'R2A Berlin', 'Europe/Berlin');
      const otherOrganizationId = await insertOrganization(pool, 'R2A Other', 'Europe/Berlin');
      const emptyOrganizationId = await insertOrganization(pool, 'R2A Empty', 'Europe/Berlin');
      const managerId = await insertUser(pool, organizationId, 'R2A Manager');
      const otherManagerId = await insertUser(pool, otherOrganizationId, 'Other Manager');

      // Created inside the range: local Aug 1, status NEW.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'PRODUCT_DELIVERY',
        status: 'NEW',
        title: 'Created local Aug 1',
        createdAt: '2026-07-31T22:30:00.000Z',
      });
      // Created inside the range, but approved after the range: created counts, completed does not.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'GENERAL_TASK',
        status: 'COMPLETED',
        title: 'Created Aug 2 approved later',
        createdAt: '2026-08-01T22:30:00.000Z',
        managerApprovedAt: '2026-08-05T08:00:00.000Z',
      });
      // Created inside the range, terminal CANCELLED: created counts, active does not.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'SALES_MEETING',
        status: 'CANCELLED',
        title: 'Cancelled Aug 3',
        createdAt: '2026-08-03T10:00:00.000Z',
      });
      // Created at the local end of Aug 3: timezone bucketing must keep it in the range.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'PRODUCT_DELIVERY',
        status: 'IN_PROGRESS',
        title: 'Created local Aug 3 late',
        createdAt: '2026-08-03T21:59:00.000Z',
      });

      // Current active snapshot buckets, all outside the selected created cohort.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'GENERAL_TASK',
        status: 'ACCEPTED',
        title: 'Current accepted snapshot',
        createdAt: '2026-07-20T10:00:00.000Z',
      });
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'SALES_MEETING',
        status: 'WAITING_APPROVAL',
        title: 'Current waiting snapshot',
        createdAt: '2026-07-21T10:00:00.000Z',
      });
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'PRODUCT_DELIVERY',
        status: 'REVISION_REQUESTED',
        title: 'Current revision snapshot',
        createdAt: '2026-07-22T10:00:00.000Z',
      });

      // Created before the range, approved inside it: completed counts, created does not.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'GENERAL_TASK',
        status: 'COMPLETED',
        title: 'Older job approved in range',
        createdAt: '2026-07-31T20:00:00.000Z',
        managerApprovedAt: '2026-08-01T08:00:00.000Z',
      });

      // A same-range job in another organization must not leak into either aggregate.
      await insertJob({
        pool,
        organizationId: otherOrganizationId,
        assignedTo: otherManagerId,
        createdBy: otherManagerId,
        type: 'SALES_MEETING',
        status: 'NEW',
        title: 'Other organization job',
        createdAt: '2026-08-01T22:30:00.000Z',
      });

      const repository = new PostgresReportsRepository(pool);
      const dashboard = await repository.getDashboard({
        organizationId,
        requestedRange: range,
        requestTime,
      });

      expect(dashboard.range).toEqual({
        ...range,
        timezone: 'Europe/Berlin',
      });
      expect(dashboard.dailyCreatedTrend).toEqual([
        { date: '2026-08-01', count: 1 },
        { date: '2026-08-02', count: 1 },
        { date: '2026-08-03', count: 2 },
        { date: '2026-08-04', count: 0 },
      ]);
      expect(dashboard.createdWorkTypeDistribution).toEqual([
        { type: 'PRODUCT_DELIVERY', count: 2 },
        { type: 'GENERAL_TASK', count: 1 },
        { type: 'SALES_MEETING', count: 1 },
      ]);
      expect(dashboard.activeStatusDistribution).toEqual([
        { status: 'NEW', count: 1 },
        { status: 'ACCEPTED', count: 1 },
        { status: 'IN_PROGRESS', count: 1 },
        { status: 'WAITING_APPROVAL', count: 1 },
        { status: 'REVISION_REQUESTED', count: 1 },
      ]);
      expect(dashboard.counters.activeJobCards).toBe(
        dashboard.activeStatusDistribution.reduce((sum, bucket) => sum + bucket.count, 0),
      );
      expect(dashboard.counters.completedInPeriod).toBe(1);
      expect(dashboard.completedTrend).toEqual([
        { date: '2026-08-01', count: 1 },
        { date: '2026-08-02', count: 0 },
        { date: '2026-08-03', count: 0 },
        { date: '2026-08-04', count: 0 },
      ]);
      expect(dashboard.dailyCreatedTrend.reduce((sum, point) => sum + point.count, 0)).toBe(
        dashboard.createdWorkTypeDistribution.reduce((sum, bucket) => sum + bucket.count, 0),
      );

      const emptyDashboard = await repository.getDashboard({
        organizationId: emptyOrganizationId,
        requestedRange: range,
        requestTime,
      });
      expect(emptyDashboard.dailyCreatedTrend).toEqual([
        { date: '2026-08-01', count: 0 },
        { date: '2026-08-02', count: 0 },
        { date: '2026-08-03', count: 0 },
        { date: '2026-08-04', count: 0 },
      ]);
      expect(emptyDashboard.activeStatusDistribution).toEqual([
        { status: 'NEW', count: 0 },
        { status: 'ACCEPTED', count: 0 },
        { status: 'IN_PROGRESS', count: 0 },
        { status: 'WAITING_APPROVAL', count: 0 },
        { status: 'REVISION_REQUESTED', count: 0 },
      ]);
      expect(emptyDashboard.createdWorkTypeDistribution).toEqual([
        { type: 'PRODUCT_DELIVERY', count: 0 },
        { type: 'GENERAL_TASK', count: 0 },
        { type: 'SALES_MEETING', count: 0 },
      ]);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
