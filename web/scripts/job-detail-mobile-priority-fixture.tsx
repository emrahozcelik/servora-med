import { createRoot } from 'react-dom/client';

import { JobDetailPanel } from '../src/JobDetail';
import type {
  DeliveryItem, JobCard, JobLifecycleFacts, JobWorkflowContext, LifecycleCommand,
} from '../src/jobs/jobs-api';
import { OverdueIncidentHistorySection, SubmissionLatenessSection } from '../src/jobs/SubmissionLateness';
import type { CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd';

/**
 * UI-005 rendered fixture: the real JobDetailPanel with the real lateness
 * components, synthetic medical/dental records and mocked API responses for the
 * two lateness endpoints only. Everything else is component props.
 *
 * Cases (query param `case`):
 *  - staff-in-progress, manager-waiting, revision, staff-late, manager-late-history
 */

const params = new URLSearchParams(window.location.search);
const fixtureCase = params.get('case') ?? 'staff-in-progress';

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
const manager: CurrentUser = {
  ...staff,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Murat Yönetici',
  email: 'murat@servora.local',
  role: 'MANAGER',
};

const baseLifecycle: JobLifecycleFacts = {
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

function workflowContext(
  commands: LifecycleCommand[],
  lifecycle: Partial<JobLifecycleFacts> = {},
  actions: JobWorkflowContext['allowedActions'] = ['VIEW_NOTES', 'ADD_NOTE'],
): JobWorkflowContext {
  return {
    allowedCommands: commands,
    allowedActions: actions,
    startLocationCaptureEnabled: false,
    submitLocationCaptureEnabled: true,
    lifecycle: { ...baseLifecycle, ...lifecycle },
    submissionReadiness: {
      evaluatedAt: '2026-11-18T09:15:00.000Z',
      ready: false,
      items: [
        { code: 'DELIVERY_ITEM_PRESENT', state: 'met', field: 'deliveryItems' },
        { code: 'DELIVERY_ITEMS_VALID', state: 'missing', field: 'deliveryItems' },
      ],
    },
  } as JobWorkflowContext;
}

function jobCard(
  status: JobCard['status'],
  commands: LifecycleCommand[],
  lifecycle: Partial<JobLifecycleFacts> = {},
): JobCard {
  return {
    id: 'job-fixture',
    organizationId: 'org-1',
    type: 'PRODUCT_DELIVERY',
    status,
    version: 4,
    engagementKind: null,
    title: 'DentArt Ağız ve Diş Sağlığı — Xenofill implant seti teslimi',
    description: 'Klinik stok kontrolü sonrası teslim edilecek; seri numaraları kayda geçirilecek.',
    customerId: 'customer-1',
    contactId: 'contact-1',
    assignedTo: staff.id,
    createdBy: manager.id,
    priority: 'high',
    dueDate: '2026-11-21',
    scheduledAt: '2026-11-20T09:00:00.000Z',
    scheduledEndsAt: '2026-11-20T09:30:00.000Z',
    assignee: { id: staff.id, name: staff.name },
    customer: { id: 'customer-1', name: 'DentArt Ağız ve Diş Sağlığı' },
    contact: { id: 'contact-1', name: 'Dr. Selin Aksoy' },
    followUpContext: null,
    workflowContext: workflowContext(commands, lifecycle),
  };
}

const deliveryItems: DeliveryItem[] = [
  {
    id: 'item-1', organizationId: 'org-1', jobCardId: 'job-fixture', productId: 'product-1',
    deliveryPurpose: 'SALE', deliveredAt: '2026-11-18T08:30:00.000Z', quantity: 2, unit: 'kutu',
    productNameSnapshot: 'Xenofill Implant Set', productSkuSnapshot: 'XF-220', productModelSnapshot: null,
    lotNo: 'LOT-4471', serialNo: null, expiryDate: null, deliveryNote: null,
  },
  {
    id: 'item-2', organizationId: 'org-1', jobCardId: 'job-fixture', productId: 'product-2',
    deliveryPurpose: 'SAMPLE', deliveredAt: '2026-11-18T08:35:00.000Z', quantity: 1, unit: 'adet',
    productNameSnapshot: 'Fissür Örtücü Uygulama Kiti', productSkuSnapshot: 'FO-110', productModelSnapshot: null,
    lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null,
  },
];

const cases: Record<string, { job: JobCard; user: CurrentUser }> = {
  'staff-in-progress': {
    job: jobCard('IN_PROGRESS', ['SUBMIT_FOR_APPROVAL', 'CANCEL'], {}),
    user: staff,
  },
  'manager-waiting': {
    job: jobCard('WAITING_APPROVAL', ['APPROVE', 'REQUEST_REVISION', 'CANCEL'], {
      submittedAt: '2026-11-18T09:10:00.000Z',
      submittedBy: { id: staff.id, name: staff.name },
      submissionNote: 'Klinik teslimi tamamlandı, seri numaraları eklendi.',
    }),
    user: manager,
  },
  revision: {
    job: jobCard('REVISION_REQUESTED', ['RESUME', 'CANCEL'], {
      submittedAt: '2026-11-18T09:10:00.000Z',
      submittedBy: { id: staff.id, name: staff.name },
      revisionRequestedAt: '2026-11-18T10:05:00.000Z',
      revisionRequestedBy: { id: manager.id, name: manager.name },
      revisionReason: 'İkinci kalemin lot numarası eksik; teslim miktarını doğrulayıp tekrar gönderin.',
    }),
    user: staff,
  },
  'staff-late': {
    job: jobCard('IN_PROGRESS', ['SUBMIT_FOR_APPROVAL', 'CANCEL'], {}),
    user: staff,
  },
  'manager-late-history': {
    job: jobCard('WAITING_APPROVAL', ['APPROVE', 'REQUEST_REVISION', 'CANCEL'], {
      submittedAt: '2026-11-18T09:10:00.000Z',
      submittedBy: { id: staff.id, name: staff.name },
    }),
    user: manager,
  },
};

const openLateness = {
  incidentId: 'incident-open',
  delayType: 'LATE_SUBMISSION',
  episodeNo: 2,
  scheduleRevisionNo: 1,
  deadlineAt: '2026-11-18T08:00:00.000Z',
  breachedAt: '2026-11-18T08:00:00.000Z',
  elapsedSeconds: 8100,
  accountableUser: { id: staff.id, name: staff.name },
  accountableRole: 'STAFF',
  staffReminderSentAt: '2026-11-18T08:20:00.000Z',
  escalationSentAt: null,
  manualReminderSentAt: null,
  manualReminderCount: 0,
};

function historyItem(index: number, delayType: 'LATE_START' | 'LATE_SUBMISSION' | 'APPROVAL_WAIT') {
  return {
    id: `incident-${index}`,
    delayType,
    episodeNo: index,
    scheduleRevisionNo: 1,
    deadlineAt: `2026-11-${String(10 + index).padStart(2, '0')}T08:00:00.000Z`,
    breachedAt: `2026-11-${String(10 + index).padStart(2, '0')}T09:30:00.000Z`,
    accountableRole: 'STAFF',
    accountableSource: 'ASSIGNMENT_AT_BREACH',
    accountableUser: { id: staff.id, name: staff.name },
    source: 'SCANNER',
    recordedAt: `2026-11-${String(10 + index).padStart(2, '0')}T09:30:00.000Z`,
    recoveredAt: `2026-11-${String(10 + index).padStart(2, '0')}T11:00:00.000Z`,
    recoveryActor: { id: staff.id, name: staff.name },
    totalDelaySeconds: 5400 + index * 600,
    manualReminderSentAt: null,
    manualReminderCount: 0,
    postReminderDelaySeconds: null,
  };
}

const hasLateness = fixtureCase === 'staff-late' || fixtureCase === 'manager-late-history';
const hasHistory = fixtureCase === 'manager-late-history';

// Mock only the two lateness endpoints; everything else is component props.
window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  if (url.includes('/submission-lateness')) {
    return json({ open: hasLateness ? openLateness : null });
  }
  if (url.includes('/overdue-incidents')) {
    // Offset-aware paging mock so the collapsible disclosure can be exercised
    // past the first page in Chromium.
    const all = hasHistory
      ? [
        historyItem(1, 'LATE_START'),
        historyItem(2, 'LATE_SUBMISSION'),
        historyItem(3, 'APPROVAL_WAIT'),
        historyItem(4, 'LATE_START'),
        historyItem(5, 'LATE_SUBMISSION'),
        historyItem(6, 'APPROVAL_WAIT'),
        historyItem(7, 'LATE_SUBMISSION'),
      ]
      : [];
    const limit = Number(new URL(url, window.location.origin).searchParams.get('limit') ?? 6);
    const offset = Number(new URL(url, window.location.origin).searchParams.get('offset') ?? 0);
    return json({ items: all.slice(offset, offset + limit), total: all.length, limit, offset });
  }
  return new Response(JSON.stringify({ message: 'Unexpected fixture request' }), { status: 404 });
}) as typeof window.fetch;

const current = cases[fixtureCase] ?? cases['staff-in-progress']!;

const root = document.getElementById('job-detail-mobile-priority-root');
if (!root) throw new Error('Job detail mobile-priority fixture mount is missing');

createRoot(root).render(
  <ServoraAntProvider>
    <JobDetailPanel
      job={current.job}
      items={deliveryItems}
      user={current.user}
      pending={false}
      message=""
      onCommand={() => undefined}
      submissionLateness={<SubmissionLatenessSection
        jobId={current.job.id}
        jobVersion={current.job.version}
        user={current.user}
        onReminded={() => undefined}
      />}
      overdueHistory={current.user.role === 'STAFF'
        ? undefined
        : <OverdueIncidentHistorySection
          jobId={current.job.id}
          collapsible={!window.matchMedia('(min-width: 64rem)').matches}
        />}
    />
  </ServoraAntProvider>,
);
