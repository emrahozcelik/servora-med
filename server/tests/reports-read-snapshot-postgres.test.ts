import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { PostgresReportReadSnapshot } from '../src/modules/reports/read-snapshot.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { ReportsService } from '../src/modules/reports/service.js';
import { passThroughReportReadSnapshot } from './support/report-read-snapshot.js';
import {
  applyMigrations,
  insertCustomer,
  insertDeliveryItem,
  insertJobCard,
  interleavingPool,
  seedReportOrganization,
  type InterleavingHarness,
} from './support/report-snapshot-harness.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const REQUEST_TIME = new Date('2026-07-14T12:00:00.000Z');
const JULY_RANGE = { from: '2026-07-01', to: '2026-07-31' };
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i;

function actor(organizationId: string, userId: string): SafeUser {
  return {
    id: userId,
    organizationId,
    name: 'Snapshot Manager',
    email: 'manager@test.local',
    role: 'MANAGER',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

function snapshotService(harness: InterleavingHarness) {
  return new ReportsService(
    new PostgresReportsRepository(harness.pool),
    new PostgresReportReadSnapshot(
      harness.pool,
      new PostgresJobCardRepository(harness.pool),
    ),
    () => REQUEST_TIME,
  );
}

function unSnapshottedService(harness: InterleavingHarness) {
  const reports = new PostgresReportsRepository(harness.pool);
  // The composition that existed before this fix: the same reads, issued
  // straight on the pool with no shared transaction.
  return new ReportsService(
    reports,
    passThroughReportReadSnapshot(
      reports,
      new PostgresJobCardRepository(harness.pool),
    ),
    () => REQUEST_TIME,
  );
}

describe.skipIf(!databaseUrl)('Report read snapshots in PostgreSQL', () => {
  let adminPool: Pool;
  let pool: Pool;
  let schema: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl });
    schema = `report_snapshot_${randomUUID().replaceAll('-', '')}`;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await applyMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  it('SNAPSHOT-1: keeps the customer total and page on one snapshot', async () => {
    const { organizationId, managerId } = await seedReportOrganization(pool);
    await insertCustomer(pool, organizationId, 'Alpha Clinic');
    await insertCustomer(pool, organizationId, 'Beta Clinic');

    const harness = interleavingPool(pool, {
      beforeStatement: 3, // the page read, after the count read
      action: () => insertCustomer(pool, organizationId, 'Gamma Clinic').then(),
    });

    const report = await snapshotService(harness).getCustomers(
      actor(organizationId, managerId),
      {
        requestedRange: JULY_RANGE,
        search: null,
        status: null,
        customerType: null,
        limit: 50,
        offset: 0,
      },
    );

    expect(report.total).toBe(2);
    expect(report.items).toHaveLength(report.total);
  });

  it('SNAPSHOT-1 control: the same write splits the response without a snapshot', async () => {
    const { organizationId, managerId } = await seedReportOrganization(pool);
    await insertCustomer(pool, organizationId, 'Alpha Clinic');
    await insertCustomer(pool, organizationId, 'Beta Clinic');

    const harness = interleavingPool(pool, {
      beforeStatement: 3,
      action: () => insertCustomer(pool, organizationId, 'Gamma Clinic').then(),
    });

    const report = await unSnapshottedService(harness).getCustomers(
      actor(organizationId, managerId),
      {
        requestedRange: JULY_RANGE,
        search: null,
        status: null,
        customerType: null,
        limit: 50,
        offset: 0,
      },
    );

    // Hybrid response: the total was counted before the insert, the page after.
    expect(report.total).toBe(2);
    expect(report.items).toHaveLength(3);
  });

  it('SNAPSHOT-2: keeps the sales meeting queue total and page on one snapshot', async () => {
    const { organizationId, managerId, staffId }
      = await seedReportOrganization(pool);
    await insertJobCard(pool, {
      organizationId,
      assignedTo: staffId,
      createdBy: managerId,
      title: 'Meeting one',
      type: 'SALES_MEETING',
      status: 'NEW',
      scheduledAt: '2026-07-15T09:00:00.000Z',
    });

    const harness = interleavingPool(pool, {
      beforeStatement: 4, // the queue page, after the queue count
      action: () => insertJobCard(pool, {
        organizationId,
        assignedTo: staffId,
        createdBy: managerId,
        title: 'Meeting two',
        type: 'SALES_MEETING',
        status: 'NEW',
        scheduledAt: '2026-07-16T09:00:00.000Z',
      }).then(),
    });

    const report = await snapshotService(harness).getSalesFollowUp(
      actor(organizationId, managerId),
      {
        requestedRange: JULY_RANGE,
        limit: 50,
        offset: 0,
        proposalLimit: 50,
        proposalOffset: 0,
      },
    );

    expect(report.current.salesMeetings.total).toBe(1);
    expect(report.current.salesMeetings.items)
      .toHaveLength(report.current.salesMeetings.total);
  });

  it('SNAPSHOT-3: keeps the approval summary and the job-card queue on one snapshot', async () => {
    const { organizationId, managerId, staffId }
      = await seedReportOrganization(pool);
    await insertJobCard(pool, {
      organizationId,
      assignedTo: staffId,
      createdBy: managerId,
      title: 'Waiting one',
      type: 'GENERAL_TASK',
      status: 'WAITING_APPROVAL',
      staffCompletedAt: '2026-07-14T08:00:00.000Z',
      staffCompletedBy: staffId,
    });
    const pendingId = await insertJobCard(pool, {
      organizationId,
      assignedTo: staffId,
      createdBy: managerId,
      title: 'In progress one',
      type: 'GENERAL_TASK',
      status: 'IN_PROGRESS',
    });

    const harness = interleavingPool(pool, {
      beforeStatement: 2, // the job-card queue read, after the summary read
      action: async () => {
        await pool.query(
          `UPDATE job_cards
             SET status = 'WAITING_APPROVAL',
                 staff_completed_at = '2026-07-14T09:00:00.000Z',
                 staff_completed_by = $2
           WHERE id = $1`,
          [pendingId, staffId],
        );
      },
    });

    const report = await snapshotService(harness).getApprovals(
      actor(organizationId, managerId),
      { limit: 50, offset: 0 },
    );

    expect(report.summary.pendingCount).toBe(1);
    expect(report.total).toBe(report.summary.pendingCount);
    expect(report.items).toHaveLength(report.summary.pendingCount);
  });

  it('SNAPSHOT-4: keeps staff summary and completion aggregates on one snapshot', async () => {
    const { organizationId, managerId, staffId }
      = await seedReportOrganization(pool);
    const jobCardId = await insertJobCard(pool, {
      organizationId,
      assignedTo: staffId,
      createdBy: managerId,
      title: 'Open job',
      type: 'GENERAL_TASK',
      status: 'IN_PROGRESS',
    });

    const harness = interleavingPool(pool, {
      beforeStatement: 3, // completion aggregates, after the summary
      action: async () => {
        await pool.query(
          `UPDATE job_cards
             SET status = 'COMPLETED',
                 staff_completed_at = '2026-07-10T08:00:00.000Z',
                 staff_completed_by = $3,
                 manager_approved_at = '2026-07-10T12:00:00.000Z',
                 manager_approved_by = $2
           WHERE id = $1`,
          [jobCardId, managerId, staffId],
        );
      },
    });

    const report = await snapshotService(harness).getStaffPerformance(
      actor(organizationId, managerId),
      { requestedRange: JULY_RANGE },
    );

    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.performance.completedJobs).toBe(0);
    expect(report.items[0]?.completionWorkTypes.every(({ count }) => count === 0))
      .toBe(true);
  });

  it('SNAPSHOT-4 control: the same completion breaks the cross-aggregate invariant without a snapshot', async () => {
    const { organizationId, managerId, staffId }
      = await seedReportOrganization(pool);
    const jobCardId = await insertJobCard(pool, {
      organizationId,
      assignedTo: staffId,
      createdBy: managerId,
      title: 'Open job',
      type: 'GENERAL_TASK',
      status: 'IN_PROGRESS',
    });

    const harness = interleavingPool(pool, {
      beforeStatement: 3,
      action: async () => {
        await pool.query(
          `UPDATE job_cards
             SET status = 'COMPLETED',
                 staff_completed_at = '2026-07-10T08:00:00.000Z',
                 staff_completed_by = $3,
                 manager_approved_at = '2026-07-10T12:00:00.000Z',
                 manager_approved_by = $2
           WHERE id = $1`,
          [jobCardId, managerId, staffId],
        );
      },
    });

    // The summary and the completion aggregates disagree, so the composition
    // fails on an invariant that cannot fail inside one snapshot.
    await expect(
      unSnapshottedService(harness).getStaffPerformance(
        actor(organizationId, managerId),
        { requestedRange: JULY_RANGE },
      ),
    ).rejects.toThrow('Staff completion work type aggregate invariant could not be resolved.');
  });

  it('SNAPSHOT-5: keeps the delivery total and page on one snapshot', async () => {
    const { organizationId, managerId, staffId, productId }
      = await seedReportOrganization(pool);
    const jobCardId = await insertJobCard(pool, {
      organizationId,
      assignedTo: staffId,
      createdBy: managerId,
      title: 'Delivered job',
      type: 'PRODUCT_DELIVERY',
      status: 'COMPLETED',
      staffCompletedAt: '2026-07-10T08:00:00.000Z',
      staffCompletedBy: staffId,
      managerApprovedAt: '2026-07-10T12:00:00.000Z',
      managerApprovedBy: managerId,
    });
    await insertDeliveryItem(pool, {
      organizationId,
      jobCardId,
      productId,
      deliveredAt: '2026-07-10T09:00:00.000Z',
    });

    const harness = interleavingPool(pool, {
      beforeStatement: 3, // the page read, after the count read
      action: () => insertDeliveryItem(pool, {
        organizationId,
        jobCardId,
        productId,
        deliveredAt: '2026-07-12T09:00:00.000Z',
      }),
    });

    const report = await snapshotService(harness).getDeliveries(
      actor(organizationId, managerId),
      {
        requestedRange: JULY_RANGE,
        groupBy: 'day',
        staffUserId: null,
        limit: 50,
        offset: 0,
      },
    );

    expect(report.total).toBe(1);
    expect(report.items).toHaveLength(report.total);
  });

  it('SNAPSHOT-6: leaves the single-statement dashboard on its own atomic read', async () => {
    const { organizationId, managerId } = await seedReportOrganization(pool);

    const harness = interleavingPool(pool, {
      beforeStatement: Number.MAX_SAFE_INTEGER,
      action: async () => {},
    });

    await snapshotService(harness).dashboard(
      actor(organizationId, managerId),
      { requestedRange: null },
    );

    expect(harness.dataStatementCount()).toBe(1);
    expect(harness.statements.some((text) => TRANSACTION_CONTROL.test(text)))
      .toBe(false);
  });

  it('SNAPSHOT-7: runs the composition in a read-only repeatable-read transaction that is always released', async () => {
    const singleConnection = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
      max: 1,
      connectionTimeoutMillis: 1_000,
    });
    const harness = interleavingPool(singleConnection, {
      beforeStatement: Number.MAX_SAFE_INTEGER,
      action: async () => {},
    });
    const snapshot = new PostgresReportReadSnapshot(
      harness.pool,
      new PostgresJobCardRepository(harness.pool),
    );
    try {
      await expect(
        snapshot.run(async () => {
          throw new Error('composition failed');
        }),
      ).rejects.toThrow('composition failed');

      expect(harness.statements[0]?.trim())
        .toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      expect(harness.statements.some((text) => /^ROLLBACK$/i.test(text.trim())))
        .toBe(true);

      // The one pooled connection was released: the next request still runs
      // instead of waiting forever for a connection that was never returned.
      await expect(snapshot.run(async () => 'committed')).resolves.toBe('committed');
      expect(harness.statements.some((text) => /^COMMIT$/i.test(text.trim())))
        .toBe(true);
    } finally {
      await singleConnection.end();
    }
  });
});
