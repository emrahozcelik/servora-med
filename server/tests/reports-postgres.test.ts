import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { ReportsService } from '../src/modules/reports/service.js';
import type {
  ApprovalSummary,
  DeliveryPurposeItem,
} from '../src/modules/reports/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS = [
  '001_auth_foundation.sql',
  '002_delivery_tracer.sql',
  '003_people.sql',
  '004_crm_contacts.sql',
  '005_product_catalog.sql',
  '006_jobcard_workspace.sql',
  '007_sales_meeting.sql',
] as const;

type ReportFixture = {
  organizationOne: string;
  organizationTwo: string;
  admin: SafeUser;
  manager: SafeUser;
  activeStaff: SafeUser;
  inactiveStaff: SafeUser;
  otherOrganizationStaff: SafeUser;
  requestTime: Date;
  futureJobId: string;
  reassignedJobId: string;
  productId: string;
  expected: {
    activeAllTypes: number;
    purposeRows: DeliveryPurposeItem[];
    groupedRows: number;
  };
};

function bucketTotal(summary: ApprovalSummary) {
  return summary.under2Hours + summary.between2And8Hours
    + summary.between8And24Hours + summary.over24Hours;
}

function toSafeUser(row: {
  id: string;
  organization_id: string;
  name: string;
  email: string;
  role: SafeUser['role'];
  is_active: boolean;
  version: number;
}): SafeUser {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    email: row.email,
    role: row.role,
    mustChangePassword: false,
    isActive: row.is_active,
    version: row.version,
  };
}

async function applyMigrations001Through007(pool: Pool) {
  for (const migration of MIGRATIONS) {
    const path = fileURLToPath(
      new URL(`../src/db/migrations/${migration}`, import.meta.url),
    );
    await pool.query(await readFile(path, 'utf8'));
  }
}

async function seedReportFixture(pool: Pool): Promise<ReportFixture> {
  const requestTime = new Date('2026-07-14T12:00:00.000Z');

  const organizationOne = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone)
     VALUES ('Berlin Clinic Group', 'Europe/Berlin')
     RETURNING id`,
  )).rows[0]!.id;
  const organizationTwo = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone)
     VALUES ('Tokyo Clinic Group', 'Asia/Tokyo')
     RETURNING id`,
  )).rows[0]!.id;

  async function insertUser(
    organizationId: string,
    name: string,
    role: SafeUser['role'],
    isActive = true,
  ) {
    const row = (await pool.query<{
      id: string;
      organization_id: string;
      name: string;
      email: string;
      role: SafeUser['role'];
      is_active: boolean;
      version: number;
    }>(
      `INSERT INTO users (
         organization_id, name, email, password_hash, role, is_active
       ) VALUES ($1, $2, $3, 'unused-test-hash', $4, $5)
       RETURNING id, organization_id, name, email, role, is_active, version`,
      [organizationId, name, `${randomUUID()}@test.local`, role, isActive],
    )).rows[0]!;
    if (role === 'STAFF') {
      await pool.query(
        `INSERT INTO staff_profiles (organization_id, user_id, title)
         VALUES ($1, $2, 'Field Staff')`,
        [organizationId, row.id],
      );
    }
    return toSafeUser(row);
  }

  const admin = await insertUser(organizationOne, 'Admin User', 'ADMIN');
  const manager = await insertUser(organizationOne, 'Manager User', 'MANAGER');
  const activeStaff = await insertUser(organizationOne, 'Active Staff', 'STAFF');
  const inactiveStaff = await insertUser(
    organizationOne,
    'Inactive Staff',
    'STAFF',
    false,
  );
  const otherOrganizationStaff = await insertUser(
    organizationTwo,
    'Tokyo Staff',
    'STAFF',
  );

  const productId = (await pool.query<{ id: string }>(
    `INSERT INTO products (
       organization_id, sku, name, unit, is_active
     ) VALUES ($1, 'IMP-001', 'Implant Classic', 'adet', TRUE)
     RETURNING id`,
    [organizationOne],
  )).rows[0]!.id;
  const otherProductId = (await pool.query<{ id: string }>(
    `INSERT INTO products (
       organization_id, sku, name, unit, is_active
     ) VALUES ($1, 'TOK-001', 'Tokyo Product', 'adet', TRUE)
     RETURNING id`,
    [organizationTwo],
  )).rows[0]!.id;

  type JobInsert = {
    organizationId: string;
    type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK';
    status: string;
    title: string;
    assignedTo: string;
    createdBy: string;
    plannedAt?: Date | null;
    startedAt?: Date | null;
    staffCompletedAt?: Date | null;
    staffCompletedBy?: string | null;
    managerApprovedAt?: Date | null;
    managerApprovedBy?: string | null;
    revisionRequestedAt?: Date | null;
    revisionRequestedBy?: string | null;
    revisionReason?: string | null;
    cancelledAt?: Date | null;
    cancelledBy?: string | null;
    cancelReason?: string | null;
    dueDate?: string | null;
  };

  async function insertJob(input: JobInsert) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO job_cards (
         organization_id, type, status, title,
         assigned_to, created_by,
         planned_at, started_at,
         staff_completed_at, staff_completed_by,
         manager_approved_at, manager_approved_by,
         revision_requested_at, revision_requested_by, revision_reason,
         cancelled_at, cancelled_by, cancel_reason,
         due_date
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8,
         $9, $10,
         $11, $12,
         $13, $14, $15,
         $16, $17, $18,
         $19
       ) RETURNING id`,
      [
        input.organizationId,
        input.type,
        input.status,
        input.title,
        input.assignedTo,
        input.createdBy,
        input.plannedAt ?? null,
        input.startedAt ?? null,
        input.staffCompletedAt ?? null,
        input.staffCompletedBy ?? null,
        input.managerApprovedAt ?? null,
        input.managerApprovedBy ?? null,
        input.revisionRequestedAt ?? null,
        input.revisionRequestedBy ?? null,
        input.revisionReason ?? null,
        input.cancelledAt ?? null,
        input.cancelledBy ?? null,
        input.cancelReason ?? null,
        input.dueDate ?? null,
      ],
    )).rows[0]!.id;
  }

  async function insertDelivery(input: {
    organizationId: string;
    jobCardId: string;
    productId: string;
    purpose: string;
    deliveredAt: Date | string;
    quantity: string;
    unit: string | null;
    productNameSnapshot: string;
    productSkuSnapshot?: string | null;
    productModelSnapshot?: string | null;
    sortOrder?: number;
  }) {
    await pool.query(
      `INSERT INTO job_card_delivery_items (
         organization_id, job_card_id, product_id, delivery_purpose,
         delivered_at, quantity, unit,
         product_name_snapshot, product_sku_snapshot, product_model_snapshot,
         sort_order
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6::numeric, $7,
         $8, $9, $10,
         $11
       )`,
      [
        input.organizationId,
        input.jobCardId,
        input.productId,
        input.purpose,
        input.deliveredAt,
        input.quantity,
        input.unit,
        input.productNameSnapshot,
        input.productSkuSnapshot ?? null,
        input.productModelSnapshot ?? null,
        input.sortOrder ?? 0,
      ],
    );
  }

  // --- Active pipeline (all JobCard types count for dashboard/staff/approvals) ---
  await insertJob({
    organizationId: organizationOne,
    type: 'PRODUCT_DELIVERY',
    status: 'NEW',
    title: 'New delivery',
    assignedTo: activeStaff.id,
    createdBy: manager.id,
  });
  await insertJob({
    organizationId: organizationOne,
    type: 'GENERAL_TASK',
    status: 'PLANNED',
    title: 'Planned visit',
    assignedTo: activeStaff.id,
    createdBy: manager.id,
    plannedAt: new Date('2026-07-10T08:00:00.000Z'),
  });
  const unapprovedJobId = await insertJob({
    organizationId: organizationOne,
    type: 'PRODUCT_DELIVERY',
    status: 'IN_PROGRESS',
    title: 'Unapproved delivery in progress',
    assignedTo: activeStaff.id,
    createdBy: manager.id,
    startedAt: new Date('2026-07-12T08:00:00.000Z'),
  });
  await insertDelivery({
    organizationId: organizationOne,
    jobCardId: unapprovedJobId,
    productId,
    purpose: 'SALE',
    deliveredAt: '2026-07-12T09:00:00.000Z',
    quantity: '99.000',
    unit: 'Kutu',
    productNameSnapshot: 'Implant Classic',
  });
  await insertJob({
    organizationId: organizationOne,
    type: 'GENERAL_TASK',
    status: 'REVISION_REQUESTED',
    title: 'Revision task',
    assignedTo: activeStaff.id,
    createdBy: manager.id,
    startedAt: new Date('2026-07-08T08:00:00.000Z'),
    staffCompletedAt: new Date('2026-07-09T08:00:00.000Z'),
    staffCompletedBy: activeStaff.id,
    revisionRequestedAt: new Date('2026-07-09T10:00:00.000Z'),
    revisionRequestedBy: manager.id,
    revisionReason: 'Eksik not',
  });

  // --- Waiting approval ages relative to requestTime ---
  const waitingAges: Array<{ hours: number; type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK'; title: string }> = [
    { hours: 1, type: 'PRODUCT_DELIVERY', title: 'Waiting under 2h' },
    { hours: 2, type: 'GENERAL_TASK', title: 'Waiting exact 2h' },
    { hours: 4, type: 'PRODUCT_DELIVERY', title: 'Waiting mid 2-8h' },
    { hours: 8, type: 'GENERAL_TASK', title: 'Waiting exact 8h' },
    { hours: 12, type: 'PRODUCT_DELIVERY', title: 'Waiting mid 8-24h' },
    { hours: 24, type: 'GENERAL_TASK', title: 'Waiting exact 24h' },
    { hours: 48, type: 'PRODUCT_DELIVERY', title: 'Waiting over 24h' },
  ];
  for (const age of waitingAges) {
    const staffCompletedAt = new Date(
      requestTime.getTime() - age.hours * 60 * 60 * 1000,
    );
    await insertJob({
      organizationId: organizationOne,
      type: age.type,
      status: 'WAITING_APPROVAL',
      title: age.title,
      assignedTo: activeStaff.id,
      createdBy: manager.id,
      startedAt: new Date(staffCompletedAt.getTime() - 60 * 60 * 1000),
      staffCompletedAt,
      staffCompletedBy: activeStaff.id,
    });
  }
  const futureJobId = await insertJob({
    organizationId: organizationOne,
    type: 'PRODUCT_DELIVERY',
    status: 'WAITING_APPROVAL',
    title: 'Future staff submission',
    assignedTo: activeStaff.id,
    createdBy: manager.id,
    startedAt: new Date(requestTime.getTime() - 30 * 60 * 1000),
    staffCompletedAt: new Date(requestTime.getTime() + 60 * 60 * 1000),
    staffCompletedBy: activeStaff.id,
  });

  // NEW + PLANNED + IN_PROGRESS + REVISION + 7 aged waiting + 1 future = 12 active
  const activeAllTypes = 12;

  // --- DST transition deliveries (Europe/Berlin spring 2026) ---
  const dstJobId = await insertJob({
    organizationId: organizationOne,
    type: 'PRODUCT_DELIVERY',
    status: 'COMPLETED',
    title: 'DST window deliveries',
    assignedTo: activeStaff.id,
    createdBy: manager.id,
    startedAt: new Date('2026-03-28T20:00:00.000Z'),
    staffCompletedAt: new Date('2026-03-29T23:00:00.000Z'),
    staffCompletedBy: activeStaff.id,
    managerApprovedAt: new Date('2026-03-30T08:00:00.000Z'),
    managerApprovedBy: manager.id,
  });
  await insertDelivery({
    organizationId: organizationOne,
    jobCardId: dstJobId,
    productId,
    purpose: 'SALE',
    deliveredAt: '2026-03-28T23:30:00.000Z',
    quantity: '1.000',
    unit: 'Kutu',
    productNameSnapshot: 'Implant Classic',
    sortOrder: 1,
  });
  await insertDelivery({
    organizationId: organizationOne,
    jobCardId: dstJobId,
    productId,
    purpose: 'SALE',
    deliveredAt: '2026-03-29T21:30:00.000Z',
    quantity: '2.000',
    unit: 'Kutu',
    productNameSnapshot: 'Implant Classic',
    sortOrder: 2,
  });
  await insertDelivery({
    organizationId: organizationOne,
    jobCardId: dstJobId,
    productId,
    purpose: 'SALE',
    deliveredAt: '2026-03-29T22:30:00.000Z',
    quantity: '4.000',
    unit: 'Kutu',
    productNameSnapshot: 'Implant Classic',
    sortOrder: 3,
  });

  // --- Reassigned completed job: attribution follows current assigned_to ---
  const reassignedJobId = await insertJob({
    organizationId: organizationOne,
    type: 'PRODUCT_DELIVERY',
    status: 'COMPLETED',
    title: 'Reassigned completed delivery',
    assignedTo: activeStaff.id,
    createdBy: manager.id,
    startedAt: new Date('2026-07-04T08:00:00.000Z'),
    staffCompletedAt: new Date('2026-07-05T08:00:00.000Z'),
    staffCompletedBy: inactiveStaff.id,
    managerApprovedAt: new Date('2026-07-05T10:00:00.000Z'),
    managerApprovedBy: manager.id,
  });
  await insertDelivery({
    organizationId: organizationOne,
    jobCardId: reassignedJobId,
    productId,
    purpose: 'SALE',
    deliveredAt: '2026-07-05T09:00:00.000Z',
    quantity: '3.000',
    unit: 'Kutu',
    productNameSnapshot: 'Implant Classic',
  });
  await pool.query(
    `INSERT INTO job_card_activity_logs (
       organization_id, job_card_id, actor_id, event_type
     ) VALUES ($1, $2, $3, 'JOB_ASSIGNED')`,
    [organizationOne, reassignedJobId, manager.id],
  );

  // --- July completed deliveries: units null / kutu / Kutu ---
  const julyJobId = await insertJob({
    organizationId: organizationOne,
    type: 'PRODUCT_DELIVERY',
    status: 'COMPLETED',
    title: 'July unit variety',
    assignedTo: activeStaff.id,
    createdBy: manager.id,
    startedAt: new Date('2026-07-09T08:00:00.000Z'),
    staffCompletedAt: new Date('2026-07-10T08:00:00.000Z'),
    staffCompletedBy: activeStaff.id,
    managerApprovedAt: new Date('2026-07-10T12:00:00.000Z'),
    managerApprovedBy: manager.id,
  });
  await insertDelivery({
    organizationId: organizationOne,
    jobCardId: julyJobId,
    productId,
    purpose: 'SALE',
    deliveredAt: '2026-07-10T09:00:00.000Z',
    quantity: '5.000',
    unit: 'Kutu',
    productNameSnapshot: 'Implant Classic',
    sortOrder: 1,
  });
  await insertDelivery({
    organizationId: organizationOne,
    jobCardId: julyJobId,
    productId,
    purpose: 'SAMPLE',
    deliveredAt: '2026-07-11T09:00:00.000Z',
    quantity: '1.500',
    unit: 'kutu',
    productNameSnapshot: 'Implant Classic',
    sortOrder: 2,
  });
  await insertDelivery({
    organizationId: organizationOne,
    jobCardId: julyJobId,
    productId,
    purpose: 'CONSIGNMENT',
    deliveredAt: '2026-07-12T09:00:00.000Z',
    quantity: '0.250',
    unit: null,
    productNameSnapshot: 'Implant Classic',
    sortOrder: 3,
  });

  // --- Historical product snapshots around rename + deactivation ---
  const renameJobId = await insertJob({
    organizationId: organizationOne,
    type: 'PRODUCT_DELIVERY',
    status: 'COMPLETED',
    title: 'Snapshot rename delivery',
    assignedTo: activeStaff.id,
    createdBy: manager.id,
    startedAt: new Date('2026-07-06T08:00:00.000Z'),
    staffCompletedAt: new Date('2026-07-07T08:00:00.000Z'),
    staffCompletedBy: activeStaff.id,
    managerApprovedAt: new Date('2026-07-07T12:00:00.000Z'),
    managerApprovedBy: manager.id,
  });
  await insertDelivery({
    organizationId: organizationOne,
    jobCardId: renameJobId,
    productId,
    purpose: 'SALE',
    deliveredAt: '2026-07-06T10:00:00.000Z',
    quantity: '1.000',
    unit: 'adet',
    productNameSnapshot: 'Implant Classic',
    productSkuSnapshot: 'IMP-001',
    sortOrder: 1,
  });
  await insertDelivery({
    organizationId: organizationOne,
    jobCardId: renameJobId,
    productId,
    purpose: 'SALE',
    deliveredAt: '2026-07-07T10:00:00.000Z',
    quantity: '2.000',
    unit: 'adet',
    productNameSnapshot: 'Implant Renamed',
    productSkuSnapshot: 'IMP-001',
    sortOrder: 2,
  });
  await pool.query(
    `UPDATE products
     SET name = 'Implant Renamed', is_active = FALSE, version = version + 1
     WHERE id = $1`,
    [productId],
  );

  // --- Leap-day delivery ---
  const leapJobId = await insertJob({
    organizationId: organizationOne,
    type: 'PRODUCT_DELIVERY',
    status: 'COMPLETED',
    title: 'Leap day delivery',
    assignedTo: activeStaff.id,
    createdBy: manager.id,
    startedAt: new Date('2024-02-28T10:00:00.000Z'),
    staffCompletedAt: new Date('2024-02-29T12:00:00.000Z'),
    staffCompletedBy: activeStaff.id,
    managerApprovedAt: new Date('2024-02-29T15:00:00.000Z'),
    managerApprovedBy: manager.id,
  });
  await insertDelivery({
    organizationId: organizationOne,
    jobCardId: leapJobId,
    productId,
    purpose: 'SALE',
    deliveredAt: '2024-02-29T10:00:00.000Z',
    quantity: '1.000',
    unit: 'adet',
    productNameSnapshot: 'Implant Classic',
  });

  // --- Cancelled in period (counts cancelled_in_period, not delivery) ---
  await insertJob({
    organizationId: organizationOne,
    type: 'GENERAL_TASK',
    status: 'CANCELLED',
    title: 'Cancelled task',
    assignedTo: activeStaff.id,
    createdBy: manager.id,
    cancelledAt: new Date('2026-07-03T12:00:00.000Z'),
    cancelledBy: manager.id,
    cancelReason: 'Müşteri erteledi',
  });

  // --- Cross-organization noise ---
  const otherOrgJobId = await insertJob({
    organizationId: organizationTwo,
    type: 'PRODUCT_DELIVERY',
    status: 'COMPLETED',
    title: 'Tokyo completed delivery',
    assignedTo: otherOrganizationStaff.id,
    createdBy: otherOrganizationStaff.id,
    startedAt: new Date('2026-07-10T01:00:00.000Z'),
    staffCompletedAt: new Date('2026-07-10T02:00:00.000Z'),
    staffCompletedBy: otherOrganizationStaff.id,
    managerApprovedAt: new Date('2026-07-10T03:00:00.000Z'),
    managerApprovedBy: otherOrganizationStaff.id,
  });
  await insertDelivery({
    organizationId: organizationTwo,
    jobCardId: otherOrgJobId,
    productId: otherProductId,
    purpose: 'SALE',
    deliveredAt: '2026-07-10T01:30:00.000Z',
    quantity: '50.000',
    unit: 'Kutu',
    productNameSnapshot: 'Tokyo Product',
  });
  await insertJob({
    organizationId: organizationTwo,
    type: 'PRODUCT_DELIVERY',
    status: 'WAITING_APPROVAL',
    title: 'Tokyo waiting',
    assignedTo: otherOrganizationStaff.id,
    createdBy: otherOrganizationStaff.id,
    startedAt: new Date(requestTime.getTime() - 3 * 60 * 60 * 1000),
    staffCompletedAt: new Date(requestTime.getTime() - 2 * 60 * 60 * 1000),
    staffCompletedBy: otherOrganizationStaff.id,
  });

  // July staff purpose rows for activeStaff (default month at requestTime):
  // SALE Kutu 5.000 + 3.000 reassigned = 8.000
  // SALE adet 1.000 + 2.000 snapshots = 3.000
  // SAMPLE kutu 1.500
  // CONSIGNMENT null 0.250
  // Order: purpose SALE/SAMPLE/CONSIGNMENT..., unit COLLATE "C" (K before a)
  const purposeRows: DeliveryPurposeItem[] = [
    { purpose: 'SALE', unit: 'Kutu', quantity: '8.000' },
    { purpose: 'SALE', unit: 'adet', quantity: '3.000' },
    { purpose: 'SAMPLE', unit: 'kutu', quantity: '1.500' },
    { purpose: 'CONSIGNMENT', unit: null, quantity: '0.250' },
  ];

  // Wide-range day groups for approved org1 deliveries:
  // 2024-02-29 adet 1.000
  // 2026-03-29 Kutu 3.000 (1+2)
  // 2026-03-30 Kutu 4.000
  // 2026-07-05 Kutu 3.000
  // 2026-07-06 adet 1.000
  // 2026-07-07 adet 2.000
  // 2026-07-10 Kutu 5.000
  // 2026-07-11 kutu 1.500
  // 2026-07-12 null 0.250
  const groupedRows = 9;

  return {
    organizationOne,
    organizationTwo,
    admin,
    manager,
    activeStaff,
    inactiveStaff,
    otherOrganizationStaff,
    requestTime,
    futureJobId,
    reassignedJobId,
    productId,
    expected: {
      activeAllTypes,
      purposeRows,
      groupedRows,
    },
  };
}

async function exerciseEveryReportQuery(
  reports: PostgresReportsRepository,
  jobCards: PostgresJobCardRepository,
  fixture: ReportFixture,
) {
  const scope = {
    organizationId: fixture.organizationOne,
    requestedRange: null as { from: string; to: string } | null,
    requestTime: fixture.requestTime,
  };
  const wideRange = { from: '2024-01-01', to: '2026-12-31' };

  await reports.getMany({
    ...scope,
    staffUserIds: [fixture.activeStaff.id, fixture.inactiveStaff.id],
  });
  await reports.getDashboard(scope);
  await reports.getStaffDeliveriesByPurpose({
    ...scope,
    staffUserId: fixture.activeStaff.id,
  });
  for (const groupBy of ['day', 'purpose', 'product', 'staff'] as const) {
    await reports.getDeliveryReport({
      organizationId: fixture.organizationOne,
      requestedRange: wideRange,
      requestTime: fixture.requestTime,
      groupBy,
      staffUserId: null,
      limit: 50,
      offset: 0,
    });
  }
  await reports.getApprovalSummary({
    organizationId: fixture.organizationOne,
    requestTime: fixture.requestTime,
  });
  await jobCards.getApprovalItems({
    organizationId: fixture.organizationOne,
    requestTime: fixture.requestTime,
    limit: 50,
    offset: 0,
  });
}

async function verifyReports(pool: Pool, fixture: ReportFixture) {
  const reports = new PostgresReportsRepository(pool);
  const jobCards = new PostgresJobCardRepository(pool);
  const service = new ReportsService(
    reports,
    jobCards,
    () => fixture.requestTime,
  );

  const julyRange = { from: '2026-07-01', to: '2026-07-31' };
  const wideRange = { from: '2024-01-01', to: '2026-12-31' };

  const dashboard = await reports.getDashboard({
    organizationId: fixture.organizationOne,
    requestedRange: julyRange,
    requestTime: fixture.requestTime,
  });
  expect(dashboard.counters.activeJobCards).toBe(fixture.expected.activeAllTypes);
  expect(dashboard.range.timezone).toBe('Europe/Berlin');
  expect(dashboard.counters.waitingApproval).toBe(8);
  expect(dashboard.counters.revisionRequested).toBe(1);
  expect(dashboard.counters.cancelledInPeriod).toBe(1);
  // July completed approvals: reassigned, july variety, rename (DST/leap outside July)
  expect(dashboard.counters.completedInPeriod).toBe(3);

  const staffReport = await service.getStaffReport(
    fixture.manager,
    fixture.activeStaff.id,
    { requestedRange: julyRange },
  );
  expect(staffReport.staff.userId).toBe(fixture.activeStaff.id);
  expect(staffReport.staff.isActive).toBe(true);
  expect(staffReport.deliveriesByPurpose).toEqual(fixture.expected.purposeRows);
  // GENERAL_TASK revision + open pipeline contribute to Staff counters
  expect(staffReport.counters.revisionRequested).toBe(1);
  expect(staffReport.counters.waitingApproval).toBe(8);
  expect(staffReport.counters.openJobCards).toBe(3); // NEW + PLANNED + IN_PROGRESS

  const inactiveReport = await service.getStaffReport(
    fixture.manager,
    fixture.inactiveStaff.id,
    { requestedRange: julyRange },
  );
  expect(inactiveReport.staff.userId).toBe(fixture.inactiveStaff.id);
  expect(inactiveReport.staff.isActive).toBe(false);
  // Reassigned job is no longer on inactiveStaff despite staff_completed_by
  expect(inactiveReport.counters.completedInPeriod).toBe(0);
  expect(inactiveReport.deliveriesByPurpose).toEqual([]);

  await expect(service.getStaffReport(
    fixture.manager,
    fixture.otherOrganizationStaff.id,
    { requestedRange: julyRange },
  )).rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });

  await expect(service.dashboard(fixture.activeStaff, {
    requestedRange: julyRange,
  })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

  const ownReport = await service.getOwnStaffReport(fixture.activeStaff, {
    requestedRange: julyRange,
  });
  expect(ownReport.staff.userId).toBe(fixture.activeStaff.id);
  expect(ownReport.deliveriesByPurpose).toEqual(fixture.expected.purposeRows);

  const deliveries = await reports.getDeliveryReport({
    organizationId: fixture.organizationOne,
    requestedRange: wideRange,
    requestTime: fixture.requestTime,
    groupBy: 'day',
    staffUserId: null,
    limit: 50,
    offset: 0,
  });
  expect(deliveries.total).toBe(fixture.expected.groupedRows);
  expect(deliveries.items.every((item) => /^\d+\.\d{3}$/.test(item.quantity))).toBe(true);
  expect(deliveries.items.map((item) => 'date' in item ? item.date : null))
    .not.toContain('2026-03-28'); // UTC edge that is local March 29 only
  // Unapproved 99.000 and Tokyo 50.000 must never appear
  expect(JSON.stringify(deliveries)).not.toMatch(/99\.000|50\.000/);

  const purposeDeliveries = await reports.getDeliveryReport({
    organizationId: fixture.organizationOne,
    requestedRange: wideRange,
    requestTime: fixture.requestTime,
    groupBy: 'purpose',
    staffUserId: null,
    limit: 50,
    offset: 0,
  });
  expect(purposeDeliveries.items.every((item) => /^\d+\.\d{3}$/.test(item.quantity)))
    .toBe(true);
  // GENERAL_TASK never contributes delivery quantities
  expect(purposeDeliveries.items.some((item) => item.quantity === '99.000')).toBe(false);

  const productDeliveries = await reports.getDeliveryReport({
    organizationId: fixture.organizationOne,
    requestedRange: julyRange,
    requestTime: fixture.requestTime,
    groupBy: 'product',
    staffUserId: null,
    limit: 50,
    offset: 0,
  });
  const snapshots = productDeliveries.items.map((item) => item.productNameSnapshot).sort();
  expect(snapshots).toEqual(
    expect.arrayContaining(['Implant Classic', 'Implant Renamed']),
  );
  expect(productDeliveries.items.every((item) => item.productId === fixture.productId))
    .toBe(true);

  const staffDeliveries = await reports.getDeliveryReport({
    organizationId: fixture.organizationOne,
    requestedRange: julyRange,
    requestTime: fixture.requestTime,
    groupBy: 'staff',
    staffUserId: null,
    limit: 50,
    offset: 0,
  });
  expect(staffDeliveries.items.every((item) => item.staff.userId === fixture.activeStaff.id))
    .toBe(true);
  expect(staffDeliveries.items.some((item) => item.staff.userId === fixture.inactiveStaff.id))
    .toBe(false);

  const reassignedStaffDeliveries = await reports.getDeliveryReport({
    organizationId: fixture.organizationOne,
    requestedRange: julyRange,
    requestTime: fixture.requestTime,
    groupBy: 'staff',
    staffUserId: fixture.activeStaff.id,
    limit: 50,
    offset: 0,
  });
  const reassignedQty = reassignedStaffDeliveries.items
    .filter((item) => item.unit === 'Kutu')
    .map((item) => item.quantity);
  expect(reassignedQty).toContain('8.000'); // 5 July + 3 reassigned

  const approvals = await service.getApprovals(fixture.admin, {
    limit: 50,
    offset: 0,
  });
  expect(approvals.summary.pendingCount).toBe(approvals.total);
  expect(bucketTotal(approvals.summary)).toBe(approvals.total);
  expect(approvals.total).toBe(8);
  expect(approvals.summary).toMatchObject({
    under2Hours: 2, // 1h + future (clamped)
    between2And8Hours: 2, // exact 2h + 4h
    between8And24Hours: 2, // exact 8h + 12h
    over24Hours: 2, // exact 24h + 48h
  });
  expect(approvals.items.find((item) => item.id === fixture.futureJobId)?.waitingMinutes)
    .toBe(0);
  expect(approvals.items.map((item) => item.id))
    .not.toContain(fixture.reassignedJobId);
  // Queue mixes PRODUCT_DELIVERY and GENERAL_TASK
  expect(new Set(approvals.items.map((item) => item.type)).size).toBe(2);
  // Sorted oldest staff_completed_at first ⇒ waiting minutes non-increasing
  for (let index = 1; index < approvals.items.length; index += 1) {
    expect(approvals.items[index]!.waitingMinutes)
      .toBeLessThanOrEqual(approvals.items[index - 1]!.waitingMinutes);
  }

  const dstDayReport = await reports.getDeliveryReport({
    organizationId: fixture.organizationOne,
    requestedRange: { from: '2026-03-29', to: '2026-03-29' },
    requestTime: fixture.requestTime,
    groupBy: 'day',
    staffUserId: null,
    limit: 50,
    offset: 0,
  });
  expect(dstDayReport).toMatchObject({
    groupBy: 'day',
    range: { from: '2026-03-29', to: '2026-03-29', timezone: 'Europe/Berlin' },
    total: 1,
    items: [{ date: '2026-03-29', unit: 'Kutu', quantity: '3.000' }],
  });

  const leapDayReport = await reports.getDeliveryReport({
    organizationId: fixture.organizationOne,
    requestedRange: { from: '2024-02-29', to: '2024-02-29' },
    requestTime: fixture.requestTime,
    groupBy: 'day',
    staffUserId: null,
    limit: 50,
    offset: 0,
  });
  expect(leapDayReport.total).toBe(1);
  expect(leapDayReport.items).toEqual([
    { date: '2024-02-29', unit: 'adet', quantity: '1.000' },
  ]);

  // Tokyo organization isolation: Berlin-facing queries never see Tokyo rows
  const tokyoDashboard = await reports.getDashboard({
    organizationId: fixture.organizationTwo,
    requestedRange: julyRange,
    requestTime: fixture.requestTime,
  });
  expect(tokyoDashboard.range.timezone).toBe('Asia/Tokyo');
  expect(tokyoDashboard.counters.activeJobCards).toBe(1);
  expect(tokyoDashboard.counters.completedInPeriod).toBe(1);

  const tokyoDeliveries = await reports.getDeliveryReport({
    organizationId: fixture.organizationTwo,
    requestedRange: julyRange,
    requestTime: fixture.requestTime,
    groupBy: 'day',
    staffUserId: null,
    limit: 50,
    offset: 0,
  });
  expect(tokyoDeliveries.total).toBe(1);
  expect(tokyoDeliveries.items[0]).toMatchObject({ quantity: '50.000' });

  // Query-plan evidence from production SQL paths
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const recordingPool = {
    query: async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return pool.query(text, [...values]);
    },
  };
  const recordedReports = new PostgresReportsRepository(recordingPool as never);
  const recordedJobCards = new PostgresJobCardRepository(recordingPool as never);
  await exerciseEveryReportQuery(recordedReports, recordedJobCards, fixture);

  const selectCalls = calls.filter(({ text }) => /^\s*(WITH|SELECT)/i.test(text));
  expect(selectCalls.length).toBeGreaterThan(5);

  for (const call of selectCalls) {
    const explain = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${call.text}`,
      [...call.values],
    );
    expect(explain.rows[0]?.['QUERY PLAN']).toBeDefined();
    if (process.env.REPORT_EXPLAIN === '1') {
      process.stdout.write(`${JSON.stringify(explain.rows[0]?.['QUERY PLAN'], null, 2)}\n`);
    }
  }
}

describe.skipIf(!databaseUrl)('Operational reports PostgreSQL contract', () => {
  it('derives trusted reports from migrations 001 through 007', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations001Through007(pool);
      const fixture = await seedReportFixture(pool);
      await verifyReports(pool, fixture);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
