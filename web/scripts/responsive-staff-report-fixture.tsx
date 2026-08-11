import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { StaffOperationalReport } from '../src/reports/StaffOperationalReport';
import { ServoraAntProvider, StaffPerformanceTable } from '../src/ui/antd';

const root = document.getElementById('responsive-staff-report-root');
if (root) {
  createRoot(root).render(
    <StaffOperationalReport report={{
      staff: {
        userId: 'smoke-staff',
        name: 'Ayşe Çok Uzun Personel Soyadı',
        isActive: true,
      },
      range: {
        from: '2026-07-01',
        to: '2026-07-31',
        timezone: 'Europe/Istanbul',
      },
      priorRange: {
        from: '2026-05-31',
        to: '2026-06-30',
        timezone: 'Europe/Istanbul',
      },
      performance: {
        completedJobs: 14,
        completionDays: 8,
        jobsPerCompletionDay: 1.75,
        correctionRequestEvents: 2,
        authoredOperationalNotes: 11,
      },
      priorPerformance: {
        available: true,
        performance: {
          completedJobs: 10,
          completionDays: 7,
          jobsPerCompletionDay: 10 / 7,
          correctionRequestEvents: 3,
          authoredOperationalNotes: 8,
        },
      },
      staffExecution: {
        approvedJobsWithStaffCompletionTimestamp: 12,
        staffCompletionDays: 7,
        jobsPerStaffCompletionDay: 12 / 7,
        missingStaffCompletionTimestamp: 2,
      },
      onTime: {
        scheduledCompletedJobs: 9,
        onTimeCompletedJobs: 6,
        lateCompletedJobs: 3,
        unscheduledCompletedJobs: 5,
        onTimeRate: 6 / 9,
      },
      completionWorkTypes: [
        { type: 'SALES_MEETING', count: 8 },
        { type: 'PRODUCT_DELIVERY', count: 4 },
        { type: 'GENERAL_TASK', count: 2 },
      ],
      completedTrend: Array.from({ length: 31 }, (_, index) => ({
        date: `2026-07-${String(index + 1).padStart(2, '0')}`,
        count: index % 5 === 0 ? 2 : 0,
      })),
      deliveriesByPurpose: [{
        purpose: 'CONSIGNMENT',
        unit: 'SterilizasyonPaketleriİçinÇokUzunBirimTanımı',
        quantity: '123456789.500',
      }],
      meetingsByOutcome: [
        { outcome: 'POSITIVE', count: 4 },
        { outcome: 'FOLLOW_UP_REQUIRED', count: 7 },
        { outcome: 'NO_DECISION', count: 2 },
        { outcome: 'NOT_INTERESTED', count: 1 },
      ],
      currentWorkload: {
        openJobCards: 8,
        overdueJobCards: 2,
        waitingApproval: 3,
        revisionRequested: 1,
      },
    }} />,
  );
}

const performanceRoot = document.getElementById('responsive-staff-performance-root');
if (performanceRoot) {
  createRoot(performanceRoot).render(
    <MemoryRouter>
      <ServoraAntProvider>
        <StaffPerformanceTable records={[{
          key: 'smoke-staff',
          name: 'Ayşe Çok Uzun Personel Soyadı',
          isActive: true,
          completedJobs: 14,
          completionDays: 8,
          jobsPerCompletionDay: 1.75,
          correctionRequestEvents: 2,
          authoredOperationalNotes: 11,
          priorRangeLabel: '31 Mayıs 2026 – 30 Haziran 2026',
          priorPerformance: {
            available: true,
            performance: {
              completedJobs: 10,
              completionDays: 7,
              jobsPerCompletionDay: 10 / 7,
              correctionRequestEvents: 3,
              authoredOperationalNotes: 8,
            },
          },
          staffExecution: {
            approvedJobsWithStaffCompletionTimestamp: 12,
            staffCompletionDays: 7,
            jobsPerStaffCompletionDay: 12 / 7,
            missingStaffCompletionTimestamp: 2,
          },
          onTime: {
            scheduledCompletedJobs: 9,
            onTimeCompletedJobs: 6,
            lateCompletedJobs: 3,
            unscheduledCompletedJobs: 5,
            onTimeRate: 6 / 9,
          },
          workTypes: [
            { label: 'Satış görüşmesi', count: 8 },
            { label: 'Ürün teslimi', count: 4 },
            { label: 'Genel görev', count: 2 },
          ],
          currentWorkload: {
            openJobCards: 8,
            overdueJobCards: 2,
            waitingApproval: 3,
            revisionRequested: 1,
          },
          reportHref: '/staff/smoke-staff/reports?from=2026-07-01&to=2026-07-31',
        }]} />
      </ServoraAntProvider>
    </MemoryRouter>,
  );
}
