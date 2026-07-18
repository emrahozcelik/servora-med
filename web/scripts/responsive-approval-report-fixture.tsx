import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { ApprovalReportView } from '../src/reports/ApprovalReport';

const root = document.getElementById('responsive-approval-report-root');
if (root) {
  createRoot(root).render(
    <MemoryRouter>
      <ApprovalReportView report={{
        summary: {
          pendingCount: 1,
          oldestWaitingMinutes: 1500,
          averageWaitingMinutes: 1500,
          under2Hours: 0,
          between2And8Hours: 0,
          between8And24Hours: 0,
          over24Hours: 1,
        },
        items: [{
          id: 'smoke-approval-job',
          type: 'GENERAL_TASK',
          status: 'WAITING_APPROVAL',
          version: 4,
          title: 'Klinik kontrolü',
          priority: 'normal',
          dueDate: '2026-07-20',
          createdAt: '2026-07-17T08:00:00.000Z',
          updatedAt: '2026-07-18T09:00:00.000Z',
          staffCompletedAt: '2026-07-17T10:00:00.000Z',
          customer: { id: 'smoke-customer', name: 'DentArt Ağız ve Diş Sağlığı' },
          contact: null,
          assignee: { id: 'smoke-staff', name: 'Ayşe Personel' },
          deliveryItemCount: 0,
          waitingMinutes: 1500,
        }],
        total: 1,
        limit: 50,
        offset: 0,
      }} />
    </MemoryRouter>,
  );
}
