import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

import { CommittedStaleNotice, JobDetailPanel } from '../src/JobDetail';
import type {
  JobCard, JobLifecycleFacts, JobWorkflowContext, LifecycleCommand,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd';

/**
 * UI-FEEDBACK/A rendered fixture: the real JobDetailPanel plus the real
 * CommittedStaleNotice, production CSS and the owned Ant provider.
 *
 * The case is a deterministic synthetic GENERAL_TASK whose last mutation was
 * committed but whose canonical re-read failed. Copy is action-specific, as a
 * schedule save would show it. No API request is made: the notice is a prop.
 */

const staff: CurrentUser = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: 'org-1',
  name: 'Ayşe Personel',
  email: 'ayse@servora.local',
  role: 'STAFF',
  mustChangePassword: false,
  isActive: true,
  version: 1,
};

const lifecycle: JobLifecycleFacts = {
  createdAt: '2026-11-12T06:00:00.000Z',
  acceptedAt: '2026-11-12T06:20:00.000Z',
  acceptedBy: { id: staff.id, name: staff.name },
  startedAt: '2026-11-12T06:40:00.000Z',
  submittedAt: null,
  submittedBy: null,
  submissionNote: null,
  approvedAt: null,
  approvedBy: null,
  approvalNote: null,
  revisionRequestedAt: null,
  revisionRequestedBy: null,
  revisionReason: null,
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  cancelledFromStatus: null,
};

const workflowContext: JobWorkflowContext = {
  allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'] as LifecycleCommand[],
  allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
  startLocationCaptureEnabled: false,
  submitLocationCaptureEnabled: false,
  lifecycle,
  submissionReadiness: null,
};

const job: JobCard = {
  id: 'job-committed-refresh',
  organizationId: 'org-1',
  type: 'GENERAL_TASK',
  status: 'IN_PROGRESS',
  version: 4,
  engagementKind: null,
  title: 'DentArt kliniği teklif dönüşünü takip et',
  description: 'Doktorun kararını öğren ve sonucu karta yaz.',
  customerId: 'customer-1',
  contactId: 'contact-1',
  assignedTo: staff.id,
  createdBy: staff.id,
  priority: 'high',
  dueDate: '2026-11-21',
  scheduledAt: null,
  scheduledEndsAt: null,
  assignee: { id: staff.id, name: staff.name },
  customer: { id: 'customer-1', name: 'DentArt Ağız ve Diş Sağlığı' },
  contact: { id: 'contact-1', name: 'Dr. Selin Aksoy' },
  followUpContext: null,
  hasOpenOverdueIncident: false,
  correctionDueAt: null,
  workflowContext,
};

const root = document.getElementById('job-detail-committed-refresh-root');
if (!root) throw new Error('Job detail committed-refresh fixture mount is missing');

function Fixture() {
  const feedbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.dataset.committedRefreshReady = 'true';
  }, []);
  return (
    <JobDetailPanel
      job={job}
      items={[]}
      user={staff}
      pending={false}
      message=""
      feedbackRef={feedbackRef}
      committedStaleNotice={(
        <CommittedStaleNotice
          message="Planlanan zaman güncellendi."
          reloadPending={false}
          onReload={() => undefined}
          feedbackRef={feedbackRef}
        />
      )}
      onCommand={() => undefined}
    />
  );
}

createRoot(root).render(
  <ServoraAntProvider>
    <Fixture />
  </ServoraAntProvider>,
);
