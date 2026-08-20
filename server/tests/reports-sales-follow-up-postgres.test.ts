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
  '027_follow_up_proposals.sql',
] as const;

const range = { from: '2026-08-01', to: '2026-08-04' } as const;
const requestTime = new Date('2026-08-04T12:00:00.000Z');

type JobStatus =
  | 'NEW'
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'WAITING_APPROVAL'
  | 'REVISION_REQUESTED'
  | 'COMPLETED'
  | 'CANCELLED';

type JobType = 'PRODUCT_DELIVERY' | 'GENERAL_TASK' | 'SALES_MEETING';

type ProposalFixture = {
  at: string;
  type: JobType;
  assignee: string;
  instructions: string;
  origin: 'SYSTEM' | 'STAFF_ADJUSTED';
  by: string;
};

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

async function insertUser(pool: Pool, organizationId: string, name: string, role: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'unused-test-hash', $4)
     RETURNING id`,
    [organizationId, name, `${randomUUID()}@r2d.test`, role],
  )).rows[0]!.id;
}

async function insertCustomer(
  pool: Pool,
  organizationId: string,
  name: string,
  customerType = 'clinic',
  status = 'active',
) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [organizationId, name, customerType, status],
  )).rows[0]!.id;
}

async function insertJob(input: {
  pool: Pool;
  organizationId: string;
  type: JobType;
  status: JobStatus;
  title: string;
  createdAt: string;
  assignedTo: string;
  createdBy: string;
  customerId?: string | null;
  scheduledAt?: string | null;
  dueDate?: string | null;
  managerApprovedAt?: string | null;
  staffCompletedAt?: string | null;
  sourceJobCardId?: string | null;
  proposal?: ProposalFixture | null;
}) {
  const startedAt = [
    'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED',
  ].includes(input.status) ? input.createdAt : null;
  const staffCompletedAt = input.status === 'WAITING_APPROVAL'
    ? input.staffCompletedAt ?? input.createdAt
    : ['REVISION_REQUESTED', 'COMPLETED'].includes(input.status)
      ? input.staffCompletedAt ?? input.createdAt
      : null;
  const acceptedAt = input.status === 'ACCEPTED' ? input.createdAt : null;
  const managerApprovedAt = input.status === 'COMPLETED'
    ? input.managerApprovedAt ?? input.createdAt
    : null;
  const revisionRequestedAt = input.status === 'REVISION_REQUESTED' ? input.createdAt : null;
  const cancelledAt = input.status === 'CANCELLED' ? input.createdAt : null;
  const proposal = input.proposal;

  return (await input.pool.query<{ id: string }>(
    `INSERT INTO job_cards (
       organization_id, type, status, title,
       assigned_to, created_by, created_at, engagement_kind,
       customer_id, due_date, scheduled_at,
       accepted_at, accepted_by, started_at,
       staff_completed_at, staff_completed_by,
       manager_approved_at, manager_approved_by,
       revision_requested_at, revision_requested_by, revision_reason,
       cancelled_at, cancelled_by, cancel_reason,
       source_job_card_id, follow_up_instructions,
       follow_up_proposed_at, follow_up_proposed_type,
       follow_up_proposed_assignee, follow_up_proposal_instructions,
       follow_up_proposal_origin, follow_up_proposed_by
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11,
       $12, $13, $14,
       $15, $16,
       $17, $18,
       $19, $20, $21,
       $22, $23, $24,
       $25, $26,
       $27, $28,
       $29, $30,
       $31, $32
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
      input.customerId ?? null,
      input.dueDate ?? null,
      input.scheduledAt ?? null,
      acceptedAt,
      acceptedAt ? input.assignedTo : null,
      startedAt,
      staffCompletedAt,
      staffCompletedAt ? input.assignedTo : null,
      managerApprovedAt,
      managerApprovedAt ? input.createdBy : null,
      revisionRequestedAt,
      revisionRequestedAt ? input.createdBy : null,
      revisionRequestedAt ? 'R2D test revision' : null,
      cancelledAt,
      cancelledAt ? input.createdBy : null,
      cancelledAt ? 'R2D test cancellation' : null,
      input.sourceJobCardId ?? null,
      input.sourceJobCardId ? 'R2D follow-up instructions' : null,
      proposal?.at ?? null,
      proposal?.type ?? null,
      proposal?.assignee ?? null,
      proposal?.instructions ?? null,
      proposal?.origin ?? null,
      proposal?.by ?? null,
    ],
  )).rows[0]!.id;
}

async function insertMeetingDetails(input: {
  pool: Pool;
  organizationId: string;
  jobCardId: string;
  meetingAt: string;
  outcome: string | null;
}) {
  await input.pool.query(
    `INSERT INTO job_card_meeting_details (
       organization_id, job_card_id, meeting_at, outcome
     ) VALUES ($1, $2, $3, $4)`,
    [input.organizationId, input.jobCardId, input.meetingAt, input.outcome],
  );
}

async function updateMeetingOutcome(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
  outcome: string,
) {
  await pool.query(
    `UPDATE job_card_meeting_details
     SET outcome = $3, updated_at = $4
     WHERE organization_id = $1 AND job_card_id = $2`,
    [organizationId, jobCardId, outcome, new Date('2026-08-03T10:00:00.000Z')],
  );
}

async function readSalesFollowUp(
  pool: Pool,
  organizationId: string,
  limit = 50,
  offset = 0,
) {
  const repository = new PostgresReportsRepository(pool);
  return repository.getSalesFollowUpReport({
    organizationId,
    requestedRange: range,
    requestTime,
    limit,
    offset,
  });
}

describe.skipIf(!databaseUrl)('Reports R2D-1 sales and follow-up operational aggregation contract', () => {
  it('exposes current Sales Meeting workload, deterministic queue ordering, independent pagination, and cross-org isolation', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_r2d_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationId = await insertOrganization(pool, 'R2D Berlin', 'Europe/Berlin');
      const otherOrganizationId = await insertOrganization(pool, 'R2D Other', 'Europe/Berlin');
      const managerId = await insertUser(pool, organizationId, 'R2D Manager', 'MANAGER');
      const staffOne = await insertUser(pool, organizationId, 'Staff One', 'STAFF');
      const staffTwo = await insertUser(pool, organizationId, 'Staff Two', 'STAFF');
      const otherStaff = await insertUser(pool, otherOrganizationId, 'Other Staff', 'STAFF');
      const customerA = await insertCustomer(pool, organizationId, 'Clinic Alpha');

      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'NEW', title: 'Queue NEW',
        createdAt: '2026-08-01T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, scheduledAt: '2026-08-05T09:00:00.000Z',
      });
      const accepted = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'ACCEPTED', title: 'Queue ACCEPTED',
        createdAt: '2026-08-01T08:00:00.000Z', assignedTo: staffTwo, createdBy: managerId,
        customerId: customerA, scheduledAt: null,
      });
      await insertMeetingDetails({
        pool, organizationId, jobCardId: accepted, meetingAt: '2026-08-02T09:00:00.000Z',
        outcome: null,
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'IN_PROGRESS', title: 'Queue IN_PROGRESS',
        createdAt: '2026-08-01T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, scheduledAt: '2026-08-01T10:00:00.000Z',
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'WAITING_APPROVAL', title: 'Queue WAITING',
        createdAt: '2026-08-01T08:00:00.000Z', assignedTo: staffTwo, createdBy: managerId,
        customerId: customerA, scheduledAt: '2026-08-02T10:00:00.000Z',
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'REVISION_REQUESTED', title: 'Queue REVISION',
        createdAt: '2026-08-01T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, scheduledAt: '2026-08-03T10:00:00.000Z',
      });
      const completed = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED', title: 'Queue COMPLETED',
        createdAt: '2026-08-01T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, scheduledAt: '2026-08-01T09:00:00.000Z',
        managerApprovedAt: '2026-08-02T09:00:00.000Z',
      });
      await insertMeetingDetails({
        pool, organizationId, jobCardId: completed, meetingAt: '2026-08-01T09:00:00.000Z',
        outcome: 'POSITIVE',
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'CANCELLED', title: 'Queue CANCELLED',
        createdAt: '2026-08-01T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, scheduledAt: '2026-08-01T11:00:00.000Z',
      });
      await insertJob({
        pool, organizationId: otherOrganizationId, type: 'SALES_MEETING', status: 'NEW',
        title: 'Other org queue job', createdAt: '2026-08-01T08:00:00.000Z',
        assignedTo: otherStaff, createdBy: otherStaff, customerId: null,
        scheduledAt: '2026-08-01T09:00:00.000Z',
      });

      const report = await readSalesFollowUp(pool, organizationId);

      expect(report.current.salesMeetings.total).toBe(5);
      expect(report.current.salesMeetings.statusDistribution).toEqual([
        { status: 'NEW', count: 1 },
        { status: 'ACCEPTED', count: 1 },
        { status: 'IN_PROGRESS', count: 1 },
        { status: 'WAITING_APPROVAL', count: 1 },
        { status: 'REVISION_REQUESTED', count: 1 },
      ]);
      const ids = new Set<string>();
      for (const item of report.current.salesMeetings.items) {
        ids.add(item.id);
        expect(typeof item.id).toBe('string');
        expect(['NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'])
          .toContain(item.status);
        expect(item.assignee).toEqual(expect.objectContaining({ userId: expect.any(String) }));
        expect(item.customer).toEqual(expect.objectContaining({ id: customerA, name: 'Clinic Alpha' }));
      }
      expect(ids.size).toBe(5);

      const titles = new Map<string, string>();
      for (const item of report.current.salesMeetings.items) {
        const row = (await pool.query<{ title: string }>(
          'SELECT title FROM job_cards WHERE id = $1', [item.id],
        )).rows[0]!;
        titles.set(item.id, row.title);
      }
      expect([...titles.values()]).toEqual([
        'Queue IN_PROGRESS', 'Queue WAITING', 'Queue REVISION', 'Queue NEW', 'Queue ACCEPTED',
      ]);

      const firstPage = await readSalesFollowUp(pool, organizationId, 2, 0);
      expect(firstPage.current.salesMeetings.items).toHaveLength(2);
      expect(firstPage.current.salesMeetings.total).toBe(5);

      const emptyPage = await readSalesFollowUp(pool, organizationId, 2, 6);
      expect(emptyPage.current.salesMeetings.items).toEqual([]);
      expect(emptyPage.current.salesMeetings.total).toBe(5);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('classifies completed meeting outcomes by current mutable state and meeting_at, preserving canonical null exclusion', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_r2d_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationId = await insertOrganization(pool, 'R2D Berlin', 'Europe/Berlin');
      const managerId = await insertUser(pool, organizationId, 'R2D Manager', 'MANAGER');
      const staffOne = await insertUser(pool, organizationId, 'Staff One', 'STAFF');
      const customerA = await insertCustomer(pool, organizationId, 'Clinic Alpha');

      const changed = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED',
        title: 'Outcome later changed', createdAt: '2026-08-01T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        scheduledAt: '2026-08-02T09:00:00.000Z', managerApprovedAt: '2026-08-03T09:00:00.000Z',
      });
      await insertMeetingDetails({
        pool, organizationId, jobCardId: changed, meetingAt: '2026-08-02T09:00:00.000Z',
        outcome: 'FOLLOW_UP_REQUIRED',
      });
      await updateMeetingOutcome(pool, organizationId, changed, 'POSITIVE');

      const scheduledInsideMeetingOutside = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED',
        title: 'Scheduled inside meeting outside', createdAt: '2026-08-01T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        scheduledAt: '2026-08-02T09:00:00.000Z', managerApprovedAt: '2026-08-03T09:00:00.000Z',
      });
      await insertMeetingDetails({
        pool, organizationId, jobCardId: scheduledInsideMeetingOutside,
        meetingAt: '2026-07-31T09:00:00.000Z', outcome: 'POSITIVE',
      });

      const scheduledOutsideMeetingInside = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED',
        title: 'Scheduled outside meeting inside', createdAt: '2026-08-01T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        scheduledAt: '2026-07-30T09:00:00.000Z', managerApprovedAt: '2026-08-03T09:00:00.000Z',
      });
      await insertMeetingDetails({
        pool, organizationId, jobCardId: scheduledOutsideMeetingInside,
        meetingAt: '2026-08-03T09:00:00.000Z', outcome: 'POSITIVE',
      });

      const nullOutcome = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED',
        title: 'Null outcome meeting', createdAt: '2026-08-01T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        scheduledAt: '2026-08-02T09:00:00.000Z', managerApprovedAt: '2026-08-03T09:00:00.000Z',
      });
      await insertMeetingDetails({
        pool, organizationId, jobCardId: nullOutcome, meetingAt: '2026-08-02T09:00:00.000Z',
        outcome: null,
      });

      const report = await readSalesFollowUp(pool, organizationId);

      expect(report.period.meetingOutcomeDistribution).toEqual([
        { outcome: 'POSITIVE', count: 2 },
        { outcome: 'FOLLOW_UP_REQUIRED', count: 0 },
        { outcome: 'NO_DECISION', count: 0 },
        { outcome: 'NOT_INTERESTED', count: 0 },
      ]);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('counts selected-period Sales Meeting creation and manager-approved completion with canonical completion semantics', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_r2d_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationId = await insertOrganization(pool, 'R2D Berlin', 'Europe/Berlin');
      const managerId = await insertUser(pool, organizationId, 'R2D Manager', 'MANAGER');
      const staffOne = await insertUser(pool, organizationId, 'Staff One', 'STAFF');
      const customerA = await insertCustomer(pool, organizationId, 'Clinic Alpha');

      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED', title: 'Created inside',
        createdAt: '2026-08-02T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, managerApprovedAt: '2026-08-05T09:00:00.000Z',
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'NEW', title: 'Created inside NEW',
        createdAt: '2026-08-02T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA,
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'NEW', title: 'Created before range',
        createdAt: '2026-07-31T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA,
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'NEW', title: 'Created after range',
        createdAt: '2026-08-05T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA,
      });
      await insertJob({
        pool, organizationId, type: 'PRODUCT_DELIVERY', status: 'COMPLETED', title: 'Delivery created inside',
        createdAt: '2026-08-02T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, managerApprovedAt: '2026-08-03T09:00:00.000Z',
      });

      const approvedInside = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED',
        title: 'Manager approved inside', createdAt: '2026-07-20T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        staffCompletedAt: '2026-07-30T08:00:00.000Z',
        managerApprovedAt: '2026-08-02T09:00:00.000Z',
      });
      await insertMeetingDetails({
        pool, organizationId, jobCardId: approvedInside, meetingAt: '2026-07-25T09:00:00.000Z',
        outcome: 'POSITIVE',
      });

      const staffCompletedOnly = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED',
        title: 'Staff completed inside, manager approved outside',
        createdAt: '2026-07-20T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, staffCompletedAt: '2026-08-02T08:00:00.000Z',
        managerApprovedAt: '2026-07-30T09:00:00.000Z',
      });
      await insertMeetingDetails({
        pool, organizationId, jobCardId: staffCompletedOnly, meetingAt: '2026-07-25T09:00:00.000Z',
        outcome: 'POSITIVE',
      });

      const report = await readSalesFollowUp(pool, organizationId);

      expect(report.period.salesMeetingsCreated).toBe(2);
      expect(report.period.salesMeetingsManagerApproved).toBe(1);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('exposes the proposal-bearing approval/revision queue with proposedFollowUpAt as the proposed date', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_r2d_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationId = await insertOrganization(pool, 'R2D Berlin', 'Europe/Berlin');
      const managerId = await insertUser(pool, organizationId, 'R2D Manager', 'MANAGER');
      const staffOne = await insertUser(pool, organizationId, 'Staff One', 'STAFF');
      const staffTwo = await insertUser(pool, organizationId, 'Staff Two', 'STAFF');
      const customerA = await insertCustomer(pool, organizationId, 'Clinic Alpha');

      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'WAITING_APPROVAL',
        title: 'Waiting with proposal', createdAt: '2026-07-01T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        proposal: {
          at: '2026-08-10T09:00:00.000Z',
          type: 'SALES_MEETING',
          assignee: staffTwo,
          instructions: 'Yeni takip görüşmesi planla',
          origin: 'SYSTEM',
          by: staffOne,
        },
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'REVISION_REQUESTED',
        title: 'Revision with proposal', createdAt: '2026-07-02T08:00:00.000Z',
        assignedTo: staffTwo, createdBy: managerId, customerId: customerA,
        proposal: {
          at: '2026-08-11T09:00:00.000Z',
          type: 'PRODUCT_DELIVERY',
          assignee: staffOne,
          instructions: 'Numune teslimi planla',
          origin: 'STAFF_ADJUSTED',
          by: managerId,
        },
      });
      const completedWithProposal = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED',
        title: 'Completed with proposal no child', createdAt: '2026-07-03T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        managerApprovedAt: '2026-07-05T09:00:00.000Z',
        proposal: {
          at: '2026-08-12T09:00:00.000Z',
          type: 'SALES_MEETING',
          assignee: staffTwo,
          instructions: 'Yeni takip görüşmesi planla',
          origin: 'SYSTEM',
          by: staffOne,
        },
      });
      await insertMeetingDetails({
        pool, organizationId, jobCardId: completedWithProposal,
        meetingAt: '2026-07-04T09:00:00.000Z', outcome: 'FOLLOW_UP_REQUIRED',
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'WAITING_APPROVAL',
        title: 'Waiting without proposal', createdAt: '2026-07-04T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'IN_PROGRESS',
        title: 'In progress with proposal', createdAt: '2026-07-05T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        proposal: {
          at: '2026-08-13T09:00:00.000Z',
          type: 'SALES_MEETING',
          assignee: staffTwo,
          instructions: 'Yeni takip görüşmesi planla',
          origin: 'SYSTEM',
          by: staffOne,
        },
      });

      const report = await readSalesFollowUp(pool, organizationId);

      expect(report.current.proposalQueue.total).toBe(2);
      expect(report.current.proposalQueue.items).toEqual([
        {
          id: expect.any(String),
          status: 'WAITING_APPROVAL',
          customer: { id: customerA, name: 'Clinic Alpha' },
          assignee: { userId: staffOne, name: 'Staff One' },
          followUpProposedType: 'SALES_MEETING',
          followUpProposedAssignee: { userId: staffTwo, name: 'Staff Two' },
          followUpProposalInstructions: 'Yeni takip görüşmesi planla',
          proposedFollowUpAt: '2026-08-10T09:00:00.000Z',
          followUpProposalOrigin: 'SYSTEM',
        },
        {
          id: expect.any(String),
          status: 'REVISION_REQUESTED',
          customer: { id: customerA, name: 'Clinic Alpha' },
          assignee: { userId: staffTwo, name: 'Staff Two' },
          followUpProposedType: 'PRODUCT_DELIVERY',
          followUpProposedAssignee: { userId: staffOne, name: 'Staff One' },
          followUpProposalInstructions: 'Numune teslimi planla',
          proposedFollowUpAt: '2026-08-11T09:00:00.000Z',
          followUpProposalOrigin: 'STAFF_ADJUSTED',
        },
      ]);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('distinguishes actual follow-up children from proposals and counts child type distribution exactly once', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_r2d_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationId = await insertOrganization(pool, 'R2D Berlin', 'Europe/Berlin');
      const managerId = await insertUser(pool, organizationId, 'R2D Manager', 'MANAGER');
      const staffOne = await insertUser(pool, organizationId, 'Staff One', 'STAFF');
      const customerA = await insertCustomer(pool, organizationId, 'Clinic Alpha');

      const parentA = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED', title: 'Parent A',
        createdAt: '2026-07-01T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, managerApprovedAt: '2026-07-02T09:00:00.000Z',
        proposal: {
          at: '2026-08-10T09:00:00.000Z',
          type: 'SALES_MEETING',
          assignee: staffOne,
          instructions: 'Yeni takip görüşmesi planla',
          origin: 'SYSTEM',
          by: staffOne,
        },
      });
      await insertMeetingDetails({
        pool, organizationId, jobCardId: parentA, meetingAt: '2026-07-01T09:00:00.000Z',
        outcome: 'FOLLOW_UP_REQUIRED',
      });
      const parentB = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED', title: 'Parent B',
        createdAt: '2026-07-03T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, managerApprovedAt: '2026-07-04T09:00:00.000Z',
      });

      const reportBeforeChildren = await readSalesFollowUp(pool, organizationId);
      expect(reportBeforeChildren.period.followUpChildrenCreated).toBe(0);
      expect(reportBeforeChildren.period.followUpChildrenCreatedByType).toEqual([
        { type: 'PRODUCT_DELIVERY', count: 0 },
        { type: 'GENERAL_TASK', count: 0 },
        { type: 'SALES_MEETING', count: 0 },
      ]);

      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'IN_PROGRESS',
        title: 'Child meeting', createdAt: '2026-08-02T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        sourceJobCardId: parentA,
      });
      await insertJob({
        pool, organizationId, type: 'PRODUCT_DELIVERY', status: 'NEW',
        title: 'Manual delivery child', createdAt: '2026-08-03T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        sourceJobCardId: parentA,
      });
      await insertJob({
        pool, organizationId, type: 'GENERAL_TASK', status: 'COMPLETED',
        title: 'Completed task child', createdAt: '2026-08-04T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        sourceJobCardId: parentB, managerApprovedAt: '2026-08-05T09:00:00.000Z',
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'NEW',
        title: 'Child outside period', createdAt: '2026-08-05T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        sourceJobCardId: parentB,
      });

      const report = await readSalesFollowUp(pool, organizationId);

      expect(report.period.followUpChildrenCreated).toBe(3);
      expect(report.period.followUpChildrenCreatedByType).toEqual([
        { type: 'PRODUCT_DELIVERY', count: 1 },
        { type: 'GENERAL_TASK', count: 1 },
        { type: 'SALES_MEETING', count: 1 },
      ]);
      expect(report.current.followUpChildren.total).toBe(3);
      expect(report.current.followUpChildren.statusDistribution).toEqual([
        { status: 'NEW', count: 2 },
        { status: 'ACCEPTED', count: 0 },
        { status: 'IN_PROGRESS', count: 1 },
        { status: 'WAITING_APPROVAL', count: 0 },
        { status: 'REVISION_REQUESTED', count: 0 },
      ]);
      expect(report.current.followUpChildren.typeDistribution).toEqual([
        { type: 'PRODUCT_DELIVERY', count: 1 },
        { type: 'GENERAL_TASK', count: 0 },
        { type: 'SALES_MEETING', count: 2 },
      ]);
      expect(report.relationships.directFollowUpLinks).toBe(4);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('reports only due-dated active follow-up children as overdue and never interprets a proposal date as a due obligation', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_r2d_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationId = await insertOrganization(pool, 'R2D Berlin', 'Europe/Berlin');
      const managerId = await insertUser(pool, organizationId, 'R2D Manager', 'MANAGER');
      const staffOne = await insertUser(pool, organizationId, 'Staff One', 'STAFF');
      const customerA = await insertCustomer(pool, organizationId, 'Clinic Alpha');

      const parentA = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED', title: 'Parent A',
        createdAt: '2026-07-01T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, managerApprovedAt: '2026-07-02T09:00:00.000Z',
      });

      await insertJob({
        pool, organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        title: 'Automatic child no due date', createdAt: '2026-08-02T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        sourceJobCardId: parentA, dueDate: null,
      });
      await insertJob({
        pool, organizationId, type: 'GENERAL_TASK', status: 'NEW',
        title: 'Overdue manual child', createdAt: '2026-08-02T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        sourceJobCardId: parentA, dueDate: '2026-08-01',
      });
      await insertJob({
        pool, organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        title: 'Due today not overdue', createdAt: '2026-08-02T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        sourceJobCardId: parentA, dueDate: '2026-08-04',
      });
      await insertJob({
        pool, organizationId, type: 'GENERAL_TASK', status: 'COMPLETED',
        title: 'Completed with past due date', createdAt: '2026-08-02T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        sourceJobCardId: parentA, dueDate: '2026-07-01', managerApprovedAt: '2026-08-03T09:00:00.000Z',
      });
      await insertJob({
        pool, organizationId, type: 'GENERAL_TASK', status: 'CANCELLED',
        title: 'Cancelled with past due date', createdAt: '2026-08-02T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        sourceJobCardId: parentA, dueDate: '2026-07-01',
      });

      const waitingParent = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'WAITING_APPROVAL',
        title: 'Parent with past proposal date', createdAt: '2026-07-01T08:00:00.000Z',
        assignedTo: staffOne, createdBy: managerId, customerId: customerA,
        proposal: {
          at: '2026-07-10T09:00:00.000Z',
          type: 'SALES_MEETING',
          assignee: staffOne,
          instructions: 'Yeni takip görüşmesi planla',
          origin: 'SYSTEM',
          by: staffOne,
        },
      });

      const report = await readSalesFollowUp(pool, organizationId);

      expect(report.current.followUpChildren.overdueDueDatedFollowUpChildren).toBe(1);
      expect(report.current.proposalQueue.total).toBe(1);
      expect(report.current.proposalQueue.items[0]!.id).toBe(waitingParent);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('counts current parent/child customer divergence without mutating the immutable child customer', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_r2d_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationId = await insertOrganization(pool, 'R2D Berlin', 'Europe/Berlin');
      const managerId = await insertUser(pool, organizationId, 'R2D Manager', 'MANAGER');
      const staffOne = await insertUser(pool, organizationId, 'Staff One', 'STAFF');
      const customerA = await insertCustomer(pool, organizationId, 'Clinic Alpha');
      const customerB = await insertCustomer(pool, organizationId, 'Hospital Beta');

      const parentOne = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED', title: 'Parent One',
        createdAt: '2026-07-01T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, managerApprovedAt: '2026-07-02T09:00:00.000Z',
      });
      const childOne = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'IN_PROGRESS', title: 'Child One',
        createdAt: '2026-07-03T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, sourceJobCardId: parentOne,
      });
      const parentTwo = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED', title: 'Parent Two',
        createdAt: '2026-07-01T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, managerApprovedAt: '2026-07-02T09:00:00.000Z',
      });
      await insertJob({
        pool, organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS', title: 'Child Two',
        createdAt: '2026-07-03T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, sourceJobCardId: parentTwo,
      });
      const parentThree = await insertJob({
        pool, organizationId, type: 'GENERAL_TASK', status: 'COMPLETED', title: 'Parent Three',
        createdAt: '2026-07-01T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: null, managerApprovedAt: '2026-07-02T09:00:00.000Z',
      });
      await insertJob({
        pool, organizationId, type: 'GENERAL_TASK', status: 'IN_PROGRESS', title: 'Child Three',
        createdAt: '2026-07-03T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: null, sourceJobCardId: parentThree,
      });

      await pool.query(
        'UPDATE job_cards SET customer_id = $2 WHERE id = $1',
        [parentOne, customerB],
      );
      await pool.query(
        'UPDATE job_cards SET customer_id = $2 WHERE id = $1',
        [parentTwo, customerB],
      );

      const childRow = (await pool.query<{ customer_id: string | null }>(
        'SELECT customer_id FROM job_cards WHERE id = $1', [childOne],
      )).rows[0]!;
      expect(childRow.customer_id).toBe(customerA);

      const report = await readSalesFollowUp(pool, organizationId);

      expect(report.relationships.currentCustomerDivergence).toBe(2);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('counts only direct parent/child links without recursive chain analytics', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_r2d_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationId = await insertOrganization(pool, 'R2D Berlin', 'Europe/Berlin');
      const managerId = await insertUser(pool, organizationId, 'R2D Manager', 'MANAGER');
      const staffOne = await insertUser(pool, organizationId, 'Staff One', 'STAFF');
      const customerA = await insertCustomer(pool, organizationId, 'Clinic Alpha');

      const a = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED', title: 'A',
        createdAt: '2026-07-01T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, managerApprovedAt: '2026-07-02T09:00:00.000Z',
      });
      const b = await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'COMPLETED', title: 'B',
        createdAt: '2026-08-02T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, sourceJobCardId: a, managerApprovedAt: '2026-08-03T09:00:00.000Z',
      });
      await insertJob({
        pool, organizationId, type: 'SALES_MEETING', status: 'IN_PROGRESS', title: 'C',
        createdAt: '2026-08-03T08:00:00.000Z', assignedTo: staffOne, createdBy: managerId,
        customerId: customerA, sourceJobCardId: b,
      });

      const report = await readSalesFollowUp(pool, organizationId);

      expect(report.relationships.directFollowUpLinks).toBe(2);
      expect(report.period.followUpChildrenCreated).toBe(2);
      expect(report.current.followUpChildren.total).toBe(1);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});