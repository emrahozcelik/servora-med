import { describe, expect, it } from 'vitest';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { ReportsService } from '../src/modules/reports/service.js';
import { withIntentSchema, insertProofOrg, insertProofUser } from './support/lifecycle-intent-harness.js';
import { passThroughReportReadSnapshot } from './support/report-read-snapshot.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { ACTIVE_JOB_CARD_STATUSES } from '../src/modules/job-cards/types.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Staff report weekly workload reconciliation', () => {
  it.each(ACTIVE_JOB_CARD_STATUSES)('reconciles a %s weekly obligation without treating it as productive activity', async status => {
    await withIntentSchema(process.env.TEST_DATABASE_URL, async pool => {
      const organizationId = await insertProofOrg(pool, 'Synthetic weekly workload');
      const managerId = await insertProofUser(pool, organizationId, 'MANAGER');
      const staffId = await insertProofUser(pool, organizationId, 'STAFF');
      await pool.query('INSERT INTO staff_profiles (organization_id,user_id) VALUES ($1,$2)', [organizationId, staffId]);
      await pool.query(`INSERT INTO job_cards (organization_id,type,title,created_by,assigned_to)
        VALUES ($1,'WEEKLY_REPORT','Requested weekly report',$2,$3),
          ($1,'GENERAL_TASK','Clinic training materials',$2,$3)`, [organizationId, managerId, staffId]);
      await pool.query(`UPDATE job_cards SET status=$2::text,
        accepted_at=CASE WHEN $2 <> 'NEW' THEN '2026-11-04T09:00:00Z'::timestamptz END,
        accepted_by=CASE WHEN $2 <> 'NEW' THEN $3::uuid END,
        started_at=CASE WHEN $2 IN ('IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED') THEN '2026-11-04T09:00:00Z'::timestamptz END,
        staff_completed_at=CASE WHEN $2 IN ('WAITING_APPROVAL','REVISION_REQUESTED') THEN '2026-11-04T10:00:00Z'::timestamptz END,
        staff_completed_by=CASE WHEN $2 IN ('WAITING_APPROVAL','REVISION_REQUESTED') THEN $3::uuid END,
        revision_requested_at=CASE WHEN $2='REVISION_REQUESTED' THEN '2026-11-04T11:00:00Z'::timestamptz END,
        revision_requested_by=CASE WHEN $2='REVISION_REQUESTED' THEN $4::uuid END,
        revision_reason=CASE WHEN $2='REVISION_REQUESTED' THEN 'Synthetic revision' END
        WHERE organization_id=$1 AND type='WEEKLY_REPORT'`, [organizationId, status, staffId, managerId]);
      const otherOrg = await insertProofOrg(pool, 'Other synthetic organization');
      const otherStaff = await insertProofUser(pool, otherOrg, 'STAFF');
      await pool.query('INSERT INTO staff_profiles (organization_id,user_id) VALUES ($1,$2)', [otherOrg, otherStaff]);
      const actor: SafeUser = { id: managerId, organizationId, role: 'MANAGER', name: 'Synthetic manager',
        email: 'manager@example.test', isActive: true, mustChangePassword: false, version: 1 };
      const reports = new PostgresReportsRepository(pool);
      const service = new ReportsService(reports, passThroughReportReadSnapshot(reports, null), () => new Date('2026-11-06T10:00:00Z'));
      const result = await service.getStaffPerformance(actor, { requestedRange: null, includeSaleCapability: true });
      expect(result.items).toHaveLength(1);
      const workload = result.items[0].currentWorkload;
      expect(workload.openJobCards + workload.waitingApproval + workload.revisionRequested).toBe(2);
      expect(result.items[0].currentWorkloadByType).toEqual([
        { type: 'PRODUCT_DELIVERY', count: 0 }, { type: 'GENERAL_TASK', count: 1 },
        { type: 'SALES_MEETING', count: 0 }, { type: 'SALE', count: 0 },
      ]);
      expect(result.items[0].performance.completedJobs).toBe(0);
      const individual = await service.getStaffReport(actor, staffId, { requestedRange: null, includeSaleCapability: true });
      expect(individual.currentWorkloadByType).toEqual(result.items[0].currentWorkloadByType);
      await pool.query('UPDATE users SET is_active=FALSE WHERE id=$1', [staffId]);
      const inactive = await service.getStaffPerformance(actor, { requestedRange: null, includeSaleCapability: false });
      expect(inactive.items).toHaveLength(1);
      expect(inactive.items[0].staff.isActive).toBe(false);
      expect(inactive.items[0].currentWorkloadByType).not.toContainEqual(expect.objectContaining({ type: 'WEEKLY_REPORT' }));
    });
  });
});
