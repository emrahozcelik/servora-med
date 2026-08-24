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
  '025_messaging_context_ready.sql',
  '026_messaging_participant_lifecycle.sql',
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

async function insertManager(pool: Pool, organizationId: string, name: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'unused-test-hash', 'MANAGER')
     RETURNING id`,
    [organizationId, name, `${randomUUID()}@r2c.test`],
  )).rows[0]!.id;
}

async function insertCustomer(input: {
  pool: Pool;
  organizationId: string;
  name: string;
  customerType: 'clinic' | 'hospital' | 'dealer' | 'company' | 'other';
  status: 'prospect' | 'active' | 'inactive';
}) {
  return (await input.pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.organizationId, input.name, input.customerType, input.status],
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
  customerId?: string;
  dueDate?: string;
  managerApprovedAt?: string;
  sourceJobCardId?: string;
  followUpProposal?: {
    at: string;
    type: JobType;
    assignee: string;
    instructions: string;
    origin: 'SYSTEM' | 'STAFF_ADJUSTED';
    by: string;
  };
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
  const proposal = input.followUpProposal;

  return (await input.pool.query<{ id: string }>(
    `INSERT INTO job_cards (
       organization_id, type, status, title,
       assigned_to, created_by, created_at, engagement_kind,
       customer_id, due_date,
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
       $9, $10,
       $11, $12, $13,
       $14, $15,
       $16, $17,
       $18, $19, $20,
       $21, $22, $23,
       $24, $25,
       $26, $27,
       $28, $29,
       $30, $31
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
      acceptedAt,
      acceptedAt ? input.assignedTo : null,
      startedAt,
      staffCompletedAt,
      staffCompletedAt ? input.assignedTo : null,
      managerApprovedAt,
      managerApprovedAt ? input.createdBy : null,
      revisionRequestedAt,
      revisionRequestedAt ? input.createdBy : null,
      revisionRequestedAt ? 'R2C test revision' : null,
      cancelledAt,
      cancelledAt ? input.createdBy : null,
      cancelledAt ? 'R2C test cancellation' : null,
      input.sourceJobCardId ?? null,
      input.sourceJobCardId ? 'R2C follow-up instructions' : null,
      proposal?.at ?? null,
      proposal?.type ?? null,
      proposal?.assignee ?? null,
      proposal?.instructions ?? null,
      proposal?.origin ?? null,
      proposal?.by ?? null,
    ],
  )).rows[0]!.id;
}

describe.skipIf(!databaseUrl)('Reports R2C-1 customer operational aggregation contract', () => {
  it('attributes created, snapshot, completed, and follow-up events to the current customer', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_r2c_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationId = await insertOrganization(pool, 'R2C Berlin', 'Europe/Berlin');
      const otherOrganizationId = await insertOrganization(pool, 'R2C Other', 'Europe/Berlin');
      const managerId = await insertManager(pool, organizationId, 'R2C Manager');
      const otherManagerId = await insertManager(pool, otherOrganizationId, 'Other Manager');

      const clinicA = await insertCustomer({
        pool,
        organizationId,
        name: 'Clinic Alpha',
        customerType: 'clinic',
        status: 'active',
      });
      const hospitalB = await insertCustomer({
        pool,
        organizationId,
        name: 'Hospital Beta',
        customerType: 'hospital',
        status: 'inactive',
      });
      const dealerC = await insertCustomer({
        pool,
        organizationId,
        name: 'Dealer Gamma',
        customerType: 'dealer',
        status: 'prospect',
      });
      await insertCustomer({
        pool,
        organizationId,
        name: 'Zero Activity',
        customerType: 'other',
        status: 'inactive',
      });
      const otherCustomer = await insertCustomer({
        pool,
        organizationId: otherOrganizationId,
        name: 'Other Org Customer',
        customerType: 'company',
        status: 'active',
      });

      // Created inside the range, NEW: created + active + actionable.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'PRODUCT_DELIVERY',
        status: 'NEW',
        title: 'A new delivery in range',
        createdAt: '2026-07-31T22:30:00.000Z',
        customerId: clinicA,
      });
      // Created inside the range, ACCEPTED, overdue: created + active + actionable + overdue.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'GENERAL_TASK',
        status: 'ACCEPTED',
        title: 'A overdue accepted task',
        createdAt: '2026-08-01T10:00:00.000Z',
        customerId: clinicA,
        dueDate: '2026-08-03',
      });
      // Created inside the range, ACCEPTED, due today: active but NOT overdue (strict <).
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'SALES_MEETING',
        status: 'ACCEPTED',
        title: 'A due-today accepted meeting',
        createdAt: '2026-08-02T10:00:00.000Z',
        customerId: clinicA,
        dueDate: '2026-08-04',
      });
      // Created outside the range, currently WAITING_APPROVAL: snapshot only.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'GENERAL_TASK',
        status: 'WAITING_APPROVAL',
        title: 'A waiting approval snapshot',
        createdAt: '2026-07-20T10:00:00.000Z',
        customerId: clinicA,
      });
      // Created outside the range, currently REVISION_REQUESTED: snapshot only.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'PRODUCT_DELIVERY',
        status: 'REVISION_REQUESTED',
        title: 'A revision snapshot',
        createdAt: '2026-07-21T10:00:00.000Z',
        customerId: clinicA,
      });
      // Created outside the range, COMPLETED approved inside: manager-approved counts,
      // created does not.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'GENERAL_TASK',
        status: 'COMPLETED',
        title: 'A approved in range',
        createdAt: '2026-07-31T20:00:00.000Z',
        customerId: clinicA,
        managerApprovedAt: '2026-08-01T08:00:00.000Z',
      });
      // COMPLETED approved outside the range: no period metric, no snapshot metric.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'PRODUCT_DELIVERY',
        status: 'COMPLETED',
        title: 'A approved outside range',
        createdAt: '2026-07-15T10:00:00.000Z',
        customerId: clinicA,
        managerApprovedAt: '2026-07-16T08:00:00.000Z',
      });
      // A completed source (parent) JobCard outside the range: contributes
      // nothing to the period metrics on its own.
      const sourceId = await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'SALES_MEETING',
        status: 'COMPLETED',
        title: 'A completed source outside range',
        createdAt: '2026-07-01T10:00:00.000Z',
        customerId: clinicA,
        managerApprovedAt: '2026-07-02T08:00:00.000Z',
      });
      // Follow-up child persisted as a real JobCard, created inside the range:
      // counts as created AND as follow-up child, attributed to current customer.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'SALES_MEETING',
        status: 'NEW',
        title: 'A persisted follow-up child',
        createdAt: '2026-08-03T08:00:00.000Z',
        customerId: clinicA,
        sourceJobCardId: sourceId,
      });
      // A parent carrying a persisted follow-up proposal is NOT a child.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'SALES_MEETING',
        status: 'WAITING_APPROVAL',
        title: 'A parent with proposal only',
        createdAt: '2026-08-01T12:00:00.000Z',
        customerId: clinicA,
        followUpProposal: {
          at: '2026-08-10T09:00:00.000Z',
          type: 'GENERAL_TASK',
          assignee: managerId,
          instructions: 'R2C proposed follow-up',
          origin: 'SYSTEM',
          by: managerId,
        },
      });
      // Created inside the range, CANCELLED: created counts, snapshot does not.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'PRODUCT_DELIVERY',
        status: 'CANCELLED',
        title: 'B cancelled in range',
        createdAt: '2026-08-03T10:00:00.000Z',
        customerId: hospitalB,
      });
      // Reassigned after creation: the current customer owns the created event.
      const reassigned = await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'GENERAL_TASK',
        status: 'NEW',
        title: 'Reassigned to B',
        createdAt: '2026-08-02T09:00:00.000Z',
        customerId: clinicA,
      });
      await pool.query(
        `UPDATE job_cards SET customer_id = $1 WHERE id = $2 AND organization_id = $3`,
        [hospitalB, reassigned, organizationId],
      );
      // Dealer prospect with a non-overdue NEW meeting in range.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'SALES_MEETING',
        status: 'NEW',
        title: 'C new meeting in range',
        createdAt: '2026-08-01T22:30:00.000Z',
        customerId: dealerC,
        dueDate: '2026-08-10',
      });
      // Unassigned reconciliation: customer_id IS NULL GENERAL_TASK, overdue.
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'GENERAL_TASK',
        status: 'ACCEPTED',
        title: 'Unassigned overdue task',
        createdAt: '2026-08-01T11:00:00.000Z',
        dueDate: '2026-08-02',
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
        customerId: otherCustomer,
      });

      const repository = new PostgresReportsRepository(pool);
      const report = await repository.getCustomerReport({
        organizationId,
        requestedRange: range,
        requestTime,
        search: null,
        status: null,
        customerType: null,
        limit: 50,
        offset: 0,
      });

      expect(report.range).toEqual({ ...range, timezone: 'Europe/Berlin' });
      expect(report.total).toBe(4);
      expect(report.items.map((item) => item.customer.name)).toEqual([
        'Clinic Alpha',
        'Dealer Gamma',
        'Hospital Beta',
        'Zero Activity',
      ]);

      const alpha = report.items[0]!.activity;
      expect(alpha.snapshot).toEqual({
        active: 7,
        actionable: 4,
        waitingApproval: 2,
        revisionRequested: 1,
        overdue: 1,
      });
      expect(alpha.period.created).toBe(5);
      expect(alpha.period.createdWorkTypes).toEqual({
        PRODUCT_DELIVERY: 1,
        GENERAL_TASK: 1,
        SALES_MEETING: 3,
      });
      expect(alpha.period.managerApproved).toBe(1);
      expect(alpha.period.followUpChildren).toBe(1);

      const beta = report.items.find((item) => item.customer.name === 'Hospital Beta')!;
      expect(beta.customer.customerType).toBe('hospital');
      expect(beta.customer.status).toBe('inactive');
      expect(beta.activity.snapshot).toEqual({
        active: 1,
        actionable: 1,
        waitingApproval: 0,
        revisionRequested: 0,
        overdue: 0,
      });
      expect(beta.activity.period.created).toBe(2);
      expect(beta.activity.period.managerApproved).toBe(0);
      expect(beta.activity.period.followUpChildren).toBe(0);

      const gamma = report.items.find((item) => item.customer.name === 'Dealer Gamma')!;
      expect(gamma.activity.snapshot).toEqual({
        active: 1,
        actionable: 1,
        waitingApproval: 0,
        revisionRequested: 0,
        overdue: 0,
      });
      expect(gamma.activity.period.created).toBe(1);
      expect(gamma.activity.period.createdWorkTypes).toEqual({
        PRODUCT_DELIVERY: 0,
        GENERAL_TASK: 0,
        SALES_MEETING: 1,
      });

      const zero = report.items.find((item) => item.customer.name === 'Zero Activity')!;
      expect(zero.activity.snapshot).toEqual({
        active: 0,
        actionable: 0,
        waitingApproval: 0,
        revisionRequested: 0,
        overdue: 0,
      });
      expect(zero.activity.period.created).toBe(0);
      expect(zero.activity.period.managerApproved).toBe(0);
      expect(zero.activity.period.followUpChildren).toBe(0);

      expect(report.unassigned.snapshot).toEqual({
        active: 1,
        actionable: 1,
        waitingApproval: 0,
        revisionRequested: 0,
        overdue: 1,
      });
      expect(report.unassigned.period.created).toBe(1);
      expect(report.unassigned.period.createdWorkTypes).toEqual({
        PRODUCT_DELIVERY: 0,
        GENERAL_TASK: 1,
        SALES_MEETING: 0,
      });
      expect(report.unassigned.period.managerApproved).toBe(0);
      expect(report.unassigned.period.followUpChildren).toBe(0);

      const createdSum = report.items
        .reduce((sum, item) => sum + item.activity.period.created, 0)
        + report.unassigned.period.created;
      const createdTypeSum = report.items
        .reduce((sum, item) => sum + Object.values(item.activity.period.createdWorkTypes)
          .reduce((typeSum, count) => typeSum + count, 0), 0)
        + Object.values(report.unassigned.period.createdWorkTypes)
          .reduce((typeSum, count) => typeSum + count, 0);
      expect(createdTypeSum).toBe(createdSum);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('filters and paginates customer rows without touching the unassigned reconciliation', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_r2c_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationId = await insertOrganization(pool, 'R2C Filter', 'Europe/Berlin');
      const managerId = await insertManager(pool, organizationId, 'R2C Manager');
      const clinic = await insertCustomer({
        pool,
        organizationId,
        name: 'Filter Clinic',
        customerType: 'clinic',
        status: 'active',
      });
      const hospital = await insertCustomer({
        pool,
        organizationId,
        name: 'Filter Hospital',
        customerType: 'hospital',
        status: 'inactive',
      });
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'GENERAL_TASK',
        status: 'NEW',
        title: 'Clinic job in range',
        createdAt: '2026-08-01T10:00:00.000Z',
        customerId: clinic,
      });
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'GENERAL_TASK',
        status: 'NEW',
        title: 'Hospital job in range',
        createdAt: '2026-08-01T10:00:00.000Z',
        customerId: hospital,
      });
      await insertJob({
        pool,
        organizationId,
        assignedTo: managerId,
        createdBy: managerId,
        type: 'GENERAL_TASK',
        status: 'NEW',
        title: 'Unassigned job in range',
        createdAt: '2026-08-01T10:00:00.000Z',
      });

      const repository = new PostgresReportsRepository(pool);

      const statusFiltered = await repository.getCustomerReport({
        organizationId,
        requestedRange: range,
        requestTime,
        search: null,
        status: 'active',
        customerType: null,
        limit: 50,
        offset: 0,
      });
      expect(statusFiltered.total).toBe(1);
      expect(statusFiltered.items.map((item) => item.customer.name)).toEqual(['Filter Clinic']);
      expect(statusFiltered.unassigned.snapshot.active).toBe(1);

      const typeFiltered = await repository.getCustomerReport({
        organizationId,
        requestedRange: range,
        requestTime,
        search: null,
        status: null,
        customerType: 'hospital',
        limit: 50,
        offset: 0,
      });
      expect(typeFiltered.total).toBe(1);
      expect(typeFiltered.items.map((item) => item.customer.name)).toEqual(['Filter Hospital']);
      expect(typeFiltered.unassigned.period.created).toBe(1);

      const searched = await repository.getCustomerReport({
        organizationId,
        requestedRange: range,
        requestTime,
        search: 'FILTER H',
        status: null,
        customerType: null,
        limit: 50,
        offset: 0,
      });
      expect(searched.total).toBe(1);
      expect(searched.items.map((item) => item.customer.name)).toEqual(['Filter Hospital']);
      expect(searched.unassigned.period.created).toBe(1);

      const firstPage = await repository.getCustomerReport({
        organizationId,
        requestedRange: range,
        requestTime,
        search: null,
        status: null,
        customerType: null,
        limit: 1,
        offset: 0,
      });
      expect(firstPage.total).toBe(2);
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.items[0]!.customer.name).toBe('Filter Clinic');

      const secondPage = await repository.getCustomerReport({
        organizationId,
        requestedRange: range,
        requestTime,
        search: null,
        status: null,
        customerType: null,
        limit: 1,
        offset: 1,
      });
      expect(secondPage.total).toBe(2);
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.items[0]!.customer.name).toBe('Filter Hospital');

      // Offset beyond the last matching row: the page is empty but total must
      // still report the count of all matching customers.
      const beyondPage = await repository.getCustomerReport({
        organizationId,
        requestedRange: range,
        requestTime,
        search: null,
        status: null,
        customerType: null,
        limit: 1,
        offset: 2,
      });
      expect(beyondPage.total).toBe(2);
      expect(beyondPage.items).toEqual([]);
      expect(beyondPage.unassigned.snapshot.active).toBe(1);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
