import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { insertProofUser, withIntentSchema } from './support/lifecycle-intent-harness.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

// August 2026 range; every recorded instant lands on 2026-08-05..06 in
// Europe/Istanbul.
const RANGE = { from: '2026-08-01', to: '2026-08-31' };
const REQUEST_TIME = new Date('2026-08-20T09:00:00.000Z');

async function insertOrganization(pool: Pool, name: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [name],
  )).rows[0]!.id;
}

async function insertStaffProfile(
  pool: Pool,
  organizationId: string,
  userId: string,
  managerId: string,
) {
  await pool.query(
    `INSERT INTO staff_profiles (organization_id, user_id, title, manager_user_id)
     VALUES ($1, $2, 'Saha Personeli', $3)`,
    [organizationId, userId, managerId],
  );
}

/**
 * DOM-006 and REPORT-002: every Staff operational and delivery measure
 * attributes work through `job_cards.assigned_to`, the assignee at completion.
 * A MANAGER/ADMIN submission on behalf of the assigned Staff member must not
 * move that work out of the Staff report. The recorded submission actor stays
 * separate evidence and is never reinterpreted as the work owner.
 */
describe.skipIf(!databaseUrl)('Staff report attribution follows assignee at completion (PostgreSQL)', () => {
  it('attributes management-submitted work to the assigned Staff in every metric', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertOrganization(pool, `Assign ${randomUUID()}`);
      const managerId = await insertProofUser(pool, organizationId, 'MANAGER');
      const staffA = await insertProofUser(pool, organizationId, 'STAFF');
      const staffB = await insertProofUser(pool, organizationId, 'STAFF');
      await insertStaffProfile(pool, organizationId, staffA, managerId);
      await insertStaffProfile(pool, organizationId, staffB, managerId);
      const productId = (await pool.query<{ id: string }>(
        `INSERT INTO products (organization_id, sku, name, unit)
         VALUES ($1, $2, 'Implant Classic', 'adet') RETURNING id`,
        [organizationId, `SKU-${randomUUID()}`],
      )).rows[0]!.id;

      // Management submits on behalf of the assigned staff member (allowed by
      // policy), then a manager approves it.
      const deliveredJobId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           started_at, scheduled_at, staff_completed_at, staff_completed_by,
           manager_approved_at, manager_approved_by
         ) VALUES ($1, 'PRODUCT_DELIVERY', 'COMPLETED', 'Yönetim adına teslim',
           $2, $3, $4, $5, $5, $3, $6, $3)
         RETURNING id`,
        [
          organizationId,
          staffA,
          managerId,
          '2026-08-05T07:00:00.000Z',
          '2026-08-05T08:00:00.000Z',
          '2026-08-05T09:00:00.000Z',
        ],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO job_card_delivery_items (
           organization_id, job_card_id, product_id, delivery_purpose,
           delivered_at, quantity, unit, product_name_snapshot
         ) VALUES ($1, $2, $3, 'SALE', '2026-08-06T09:00:00.000Z', 2.500, 'Kutu',
           'Implant Classic')`,
        [organizationId, deliveredJobId, productId],
      );
      await pool.query(
        `INSERT INTO job_card_activity_logs (
           organization_id, job_card_id, actor_id, event_type, created_at
         ) VALUES ($1, $2, $3, 'JOB_REVISION_REQUESTED', '2026-08-09T08:00:00.000Z')`,
        [organizationId, deliveredJobId, managerId],
      );

      // A management-submitted sales meeting is also the assignee's outcome.
      const meetingJobId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           engagement_kind, started_at, scheduled_at, staff_completed_at,
           staff_completed_by, manager_approved_at, manager_approved_by
         ) VALUES ($1, 'SALES_MEETING', 'COMPLETED', 'Yönetim adına görüşme',
           $2, $3, 'CUSTOMER_VISIT', $4, $5, $5, $3, $6, $3)
         RETURNING id`,
        [
          organizationId,
          staffA,
          managerId,
          '2026-08-06T07:00:00.000Z',
          '2026-08-06T08:00:00.000Z',
          '2026-08-06T09:00:00.000Z',
        ],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO job_card_meeting_details (
           organization_id, job_card_id, meeting_at, outcome, meeting_summary
         ) VALUES ($1, $2, '2026-08-06T08:30:00.000Z', 'POSITIVE', 'Olumlu görüşme')`,
        [organizationId, meetingJobId],
      );

      // Reassigned before start: the completed row belongs to the new assignee.
      const reassignedJobId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by
         ) VALUES ($1, 'GENERAL_TASK', 'NEW', 'Başlamadan devredilen görev',
           $2, $3) RETURNING id`,
        [organizationId, staffA, managerId],
      )).rows[0]!.id;
      await pool.query(
        `UPDATE job_cards
            SET assigned_to = $2, status = 'COMPLETED',
                started_at = '2026-08-07T07:00:00.000Z',
                staff_completed_at = '2026-08-07T08:00:00.000Z', staff_completed_by = $2,
                manager_approved_at = '2026-08-07T09:00:00.000Z', manager_approved_by = $3
          WHERE id = $1 AND organization_id = $4`,
        [reassignedJobId, staffB, managerId, organizationId],
      );

      // Staff A's own recorded submission stays a separate submission metric.
      await pool.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by
         ) VALUES ($1, 'GENERAL_TASK', 'WAITING_APPROVAL', 'Personelin gönderimi',
           $2, $3, '2026-08-08T07:00:00.000Z', '2026-08-08T08:00:00.000Z', $2)`,
        [organizationId, staffA, managerId],
      );

      const repository = new PostgresReportsRepository(pool);
      const input = {
        organizationId,
        staffUserIds: [staffA, staffB],
        requestedRange: RANGE,
        requestTime: REQUEST_TIME,
      };

      const summaries = await repository.getMany(input);
      const summary = summaries.get(staffA)!;
      expect(summary.counters.completedInPeriod).toBe(2);
      expect(summary.counters.waitingApproval).toBe(1);
      expect(summary.currentWorkloadByType).toEqual([
        { type: 'PRODUCT_DELIVERY', count: 0 },
        // The waiting-approval task is still active workload.
        { type: 'GENERAL_TASK', count: 1 },
        { type: 'SALES_MEETING', count: 0 },
        { type: 'SALE', count: 0 },
      ]);
      expect(summaries.get(staffB)!.counters.completedInPeriod).toBe(1);

      const completion = (await repository.getStaffCompletionPerformanceMany(input)).get(staffA)!;
      expect(completion.completionDays).toBe(2);
      expect(completion.completionWorkTypes).toEqual([
        { type: 'PRODUCT_DELIVERY', count: 1 },
        { type: 'GENERAL_TASK', count: 0 },
        { type: 'SALES_MEETING', count: 1 },
        { type: 'SALE', count: 0 },
      ]);

      const byStaffExecution = await repository.getStaffExecutionMany(input);
      expect(byStaffExecution.get(staffA)).toMatchObject({
        staffCompletedJobs: 2,
        staffCompletionDays: 2,
        missingStaffCompletionTimestamp: 0,
        // Submission actor evidence is unchanged: Staff A submitted only the
        // waiting-approval task, never the management-submitted delivery.
        recordedSubmissionCount: 1,
        recordedSubmissionDays: 1,
      });
      expect(byStaffExecution.get(staffB))
        .toMatchObject({ staffCompletedJobs: 1, recordedSubmissionCount: 1 });

      expect((await repository.getStaffOnTimeMany(input)).get(staffA)).toMatchObject({
        eligibleScheduledCompletedJobs: 1,
        onTimeCompletedJobs: 1,
        lateCompletedJobs: 0,
        ineligibleOrNoDeadlineCompletedJobs: 1,
      });
      expect((await repository.getStaffOnTimeMany(input)).get(staffB)).toMatchObject({
        eligibleScheduledCompletedJobs: 0,
        ineligibleOrNoDeadlineCompletedJobs: 1,
      });

      expect(await repository.getStaffCorrectionRequestEventsMany(input))
        .toEqual(new Map([[staffA, 1]]));

      const trend = await repository.getStaffDailyCompletionTrend({
        organizationId,
        staffUserId: staffA,
        requestedRange: RANGE,
        requestTime: REQUEST_TIME,
      });
      expect(trend.filter((point) => point.count > 0))
        .toEqual([
          { date: '2026-08-05', count: 1 },
          { date: '2026-08-06', count: 1 },
        ]);

      expect(await repository.getStaffDeliveriesByPurpose({
        organizationId,
        staffUserId: staffA,
        requestedRange: RANGE,
        requestTime: REQUEST_TIME,
      })).toEqual([{ purpose: 'SALE', unit: 'Kutu', quantity: '2.500' }]);

      expect(await repository.getStaffMeetingsByOutcome({
        organizationId,
        staffUserId: staffA,
        requestedRange: RANGE,
        requestTime: REQUEST_TIME,
      })).toEqual([
        { outcome: 'POSITIVE', count: 1 },
        { outcome: 'FOLLOW_UP_REQUIRED', count: 0 },
        { outcome: 'NO_DECISION', count: 0 },
        { outcome: 'NOT_INTERESTED', count: 0 },
      ]);
      expect(await repository.getStaffMeetingsByOutcome({
        organizationId,
        staffUserId: staffB,
        requestedRange: RANGE,
        requestTime: REQUEST_TIME,
      })).toEqual([
        { outcome: 'POSITIVE', count: 0 },
        { outcome: 'FOLLOW_UP_REQUIRED', count: 0 },
        { outcome: 'NO_DECISION', count: 0 },
        { outcome: 'NOT_INTERESTED', count: 0 },
      ]);

      const byStaff = await repository.getDeliveryReport({
        organizationId,
        requestedRange: RANGE,
        requestTime: REQUEST_TIME,
        groupBy: 'staff',
        staffUserId: null,
        limit: 50,
        offset: 0,
      });
      expect(byStaff.items).toEqual([{
        staff: { userId: staffA, name: expect.any(String), isActive: true },
        unit: 'Kutu',
        quantity: '2.500',
      }]);
      const filtered = await repository.getDeliveryReport({
        organizationId,
        requestedRange: RANGE,
        requestTime: REQUEST_TIME,
        groupBy: 'staff',
        staffUserId: staffA,
        limit: 50,
        offset: 0,
      });
      expect(filtered.items.map((item) => item.quantity)).toEqual(['2.500']);
      const otherStaffFiltered = await repository.getDeliveryReport({
        organizationId,
        requestedRange: RANGE,
        requestTime: REQUEST_TIME,
        groupBy: 'staff',
        staffUserId: staffB,
        limit: 50,
        offset: 0,
      });
      expect(otherStaffFiltered.items).toEqual([]);
    });
  });
});
