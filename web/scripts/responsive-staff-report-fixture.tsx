import { createRoot } from 'react-dom/client';

import { StaffOperationalReport } from '../src/reports/StaffOperationalReport';

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
      counters: {
        openJobCards: 8,
        waitingApproval: 3,
        revisionRequested: 1,
        overdueJobCards: 2,
        completedInPeriod: 14,
      },
      deliveriesByPurpose: [{
        purpose: 'CONSIGNMENT',
        unit: 'SterilizasyonPaketleriİçinÇokUzunBirimTanımı',
        quantity: '123456789.500',
      }],
      meetingsByOutcome: [
        { outcome: 'FOLLOW_UP_REQUIRED', count: 7 },
        { outcome: 'POSITIVE', count: 4 },
        { outcome: 'NO_DECISION', count: 2 },
        { outcome: 'NOT_INTERESTED', count: 1 },
      ],
    }} />,
  );
}
