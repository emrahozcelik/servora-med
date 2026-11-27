import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

import { JobDetailPanel } from '../src/JobDetail';
import type {
  JobCard, JobLifecycleFacts, JobWorkflowContext, LifecycleCommand,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd';

/**
 * UI-FEEDBACK/B rendered fixture: the real JobDetailPanel after a manager
 * decision whose child section already closed. The page receipt is the only
 * success announcement, so the capture can prove it survives the unmount.
 *
 * `?case=proposal`   accepted Staff time proposal (offer section gone)
 * `?case=change-request` record-only change request closure (panel gone)
 *
 * Deterministic synthetic data only; no API request is made.
 */

const manager: CurrentUser = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: 'org-1',
  name: 'Mehmet Yönetici',
  email: 'mehmet@servora.local',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 1,
};

const lifecycle: JobLifecycleFacts = {
  createdAt: '2026-11-12T06:00:00.000Z',
  acceptedAt: '2026-11-12T06:20:00.000Z',
  acceptedBy: { id: manager.id, name: manager.name },
  startedAt: null,
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
  allowedCommands: ['CANCEL'] as LifecycleCommand[],
  allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
  startLocationCaptureEnabled: false,
  submitLocationCaptureEnabled: false,
  lifecycle,
  submissionReadiness: null,
};

function jobFor(type: JobCard['type'], title: string, scheduledAt: string | null): JobCard {
  return {
    id: 'job-child-receipt',
    organizationId: 'org-1',
    type,
    status: 'ACCEPTED',
    version: 5,
    engagementKind: null,
    title,
    description: null,
    customerId: 'customer-1',
    contactId: 'contact-1',
    assignedTo: 'staff-1',
    createdBy: manager.id,
    priority: 'normal',
    dueDate: null,
    scheduledAt,
    scheduledEndsAt: scheduledAt === null ? null : '2026-12-15T09:30:00.000Z',
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: { id: 'customer-1', name: 'DentArt Ağız ve Diş Sağlığı' },
    contact: { id: 'contact-1', name: 'Dr. Selin Aksoy' },
    followUpContext: null,
    followUpProposal: null,
    earlyStartAuthorization: null,
    submitLocationComparison: null,
    changeRequest: null,
    assignmentOffer: null,
    hasOpenOverdueIncident: false,
    correctionDueAt: null,
    workflowContext,
  };
}

const cases = {
  proposal: {
    receipt: 'Önerilen zaman onaylandı; iş Ayşe Personel için kabul edildi.',
    job: jobFor('PRODUCT_DELIVERY', 'DentArt kliniği ürün teslimi', '2026-12-15T09:00:00.000Z'),
  },
  'change-request': {
    receipt: 'Öneri kapatıldı: Düzeltildi. İş bilgileri değişmedi.',
    job: jobFor('GENERAL_TASK', 'DentArt kliniği ziyaretini yeniden planla', null),
  },
} as const;

type CaseKey = keyof typeof cases;

const requested = new URLSearchParams(window.location.search).get('case');
const caseKey: CaseKey = requested === 'change-request' ? 'change-request' : 'proposal';
const active = cases[caseKey];

const root = document.getElementById('job-detail-child-receipt-root');
if (!root) throw new Error('Job detail child-receipt fixture mount is missing');

function Fixture() {
  const feedbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Mirror the page-level focus request after a committed child decision.
    document.documentElement.dataset.childReceiptCase = caseKey;
    document.documentElement.dataset.childReceiptReady = 'true';
    feedbackRef.current?.focus();
  }, []);
  return (
    <JobDetailPanel
      job={active.job}
      items={[]}
      user={manager}
      pending={false}
      message={active.receipt}
      feedbackRef={feedbackRef}
      onCommand={() => undefined}
    />
  );
}

createRoot(root).render(
  <ServoraAntProvider>
    <Fixture />
  </ServoraAntProvider>,
);
