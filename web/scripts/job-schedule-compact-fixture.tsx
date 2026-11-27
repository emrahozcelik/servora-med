import { createRoot } from 'react-dom/client';

import { JobDetailPanel } from '../src/JobDetail';
import type { AvailableSlot, JobCard } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd';

/**
 * Rendered evidence fixture for the compact job-detail schedule block.
 * `?case=compact` supplies six slots over two days; `?case=many` supplies 21
 * same-day slots so the desktop wrap/`Daha fazla göster` path can be measured.
 */
const params = new URLSearchParams(window.location.search);
const fixtureCase = params.get('case') === 'many' ? 'many' : 'compact';

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici',
  email: 'murat@servora.local', role: 'MANAGER', mustChangePassword: false,
  isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
};

/**
 * The evidence runner pins this instant with `page.clock.setFixedTime`, so every
 * planned/slot time below is reproducibly in the future or recent past relative
 * to the same clock on any machine and date.
 */
const FIXED_NOW = new Date('2026-11-26T08:00:00.000Z'); // 11:00 Europe/Istanbul
const DAY_START = new Date(Date.UTC(2026, 10, 26, 0, 0)); // 26 Nov 2026 00:00Z
const plannedStart = new Date(FIXED_NOW.valueOf() + 2 * 60 * 60_000); // 13:00 local
const plannedEnd = new Date(plannedStart.valueOf() + 30 * 60_000); // 13:30 local

const job: JobCard = {
  id: 'job-schedule-fixture', organizationId: 'org-1', type: 'SALES_MEETING',
  status: 'ACCEPTED', version: 3, engagementKind: 'SALES_MEETING',
  title: 'Klinik ürün tanıtım görüşmesi', description: null,
  customerId: 'customer-1', contactId: null, assignedTo: manager.id, createdBy: manager.id,
  priority: 'normal', dueDate: null,
  scheduledAt: plannedStart.toISOString(), scheduledEndsAt: plannedEnd.toISOString(),
  assignee: { id: manager.id, name: manager.name },
  customer: { id: 'customer-1', name: 'DentArt Ağız ve Diş Sağlığı' },
  contact: null, followUpContext: null, followUpProposal: null,
  hasOpenOverdueIncident: false, correctionDueAt: null,
  workflowContext: {
    allowedCommands: ['START', 'CANCEL'],
    allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
    startLocationCaptureEnabled: false,
    lifecycle: {
      createdAt: '2026-11-20T08:00:00.000Z', acceptedAt: '2026-11-20T08:30:00.000Z',
      acceptedBy: { id: manager.id, name: manager.name }, startedAt: null,
      submittedAt: null, submittedBy: null, submissionNote: null,
      approvedAt: null, approvedBy: null, approvalNote: null,
      revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
      cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
    },
    submissionReadiness: null,
  },
};

function slot(startsAt: string): AvailableSlot {
  const end = new Date(new Date(startsAt).valueOf() + 30 * 60_000);
  return { startsAt, endsAt: end.toISOString() };
}

const compactSlots = [0, 1].flatMap((dayOffset) => [7, 8.5, 10.5].map((hour) => slot(
  new Date(DAY_START.valueOf() + (dayOffset * 24 + hour) * 60 * 60_000).toISOString(),
)));

const manySlots = Array.from({ length: 21 }, (_, index) => slot(
  new Date(DAY_START.valueOf() + 5 * 60 * 60_000 + index * 30 * 60_000).toISOString(),
));

const slots = fixtureCase === 'many' ? manySlots : compactSlots;

window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('available-slots')) return Response.json({ slots });
  return Response.json({
    level: 'SAFE', safeMessage: null, conflicts: [], recentVisit: null,
    suggestedAlternativeAt: null, frequencyCount: 0,
  });
}) as typeof window.fetch;

const root = document.getElementById('schedule-evidence-root');
if (!root) throw new Error('missing schedule evidence mount');
createRoot(root).render(
  <ServoraAntProvider>
    <JobDetailPanel
      job={job}
      items={[]}
      user={manager}
      pending={false}
      message=""
      onCommand={() => undefined}
      onSaveSchedule={async () => undefined}
    />
  </ServoraAntProvider>,
);
