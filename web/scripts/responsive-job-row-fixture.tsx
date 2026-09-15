import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';

import { JobRow } from '../src/jobs/JobRow';
import type { JobCardListItem } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';

const manager: CurrentUser = {
  id: '22222222-2222-4222-8222-222222222222',
  organizationId: 'org-1',
  name: 'Murat Yönetici',
  email: 'murat@example.com',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 1,
};

/**
 * The longest lateness the OVR-1 row signal can render ("12 gün 23 saat
 * gecikti"), on a row with a long title, so the geometry probe covers the
 * worst case at every supported width.
 */
const job: JobCardListItem = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'PRODUCT_DELIVERY',
  status: 'IN_PROGRESS',
  version: 4,
  engagementKind: null,
  title: 'Gecikmiş klinik teslimi — çok uzun bir operasyon başlığı',
  priority: 'urgent',
  dueDate: '2026-07-13',
  scheduledAt: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-07-14T11:00:00.000Z',
  staffCompletedAt: null,
  customer: { id: 'customer-1', name: 'ABC Klinik' },
  contact: { id: 'contact-1', name: 'Dr. Deniz' },
  assignee: { id: '11111111-1111-4111-8111-111111111111', name: 'Ayşe Personel' },
  deliveryItemCount: 2,
  allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
  overdueSince: '2026-07-13T21:00:00.000Z',
  latenessSeconds: 1_119_600,
};

const root = document.getElementById('responsive-job-row-root');
if (root) {
  flushSync(() => createRoot(root).render(
    <MemoryRouter>
      <div data-smoke-job-row="true">
        <JobRow job={job} user={manager} onCommand={() => {}} />
      </div>
    </MemoryRouter>,
  ));
}
