import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource-variable/source-sans-3';
import { AssignmentOfferSection, type AssignmentReasonDraft } from '../src/jobs/AssignmentOffer';
import { JobWorkflowDialog } from '../src/jobs/JobWorkflowDialog';
import type {
  AssignmentOffer,
  AssignmentReasonCode,
  JobCard,
  JobLifecycleFacts,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd';

/**
 * RESCUE-002 rendered fixture: the real Staff decline dialog and the real
 * management offer panel, driven by deterministic local state. No API calls.
 */

const params = new URLSearchParams(window.location.search);
const fixtureCase = params.get('case') ?? 'staff-empty';

const lifecycle: JobLifecycleFacts = {
  createdAt: '2026-11-21T08:00:00.000Z', acceptedAt: null, acceptedBy: null,
  startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
  cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
};

const staffUser: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'ayse@example.com',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Sistem yöneticiniz', email: null, helpUrl: null },
};
const managerUser: CurrentUser = {
  ...staffUser, id: 'manager-1', name: 'Mehmet Yönetici', role: 'MANAGER',
  email: 'mehmet@example.com',
};

const openOffer: AssignmentOffer = {
  id: 'offer-1',
  state: 'OPEN',
  openedAt: '2026-11-21T11:00:00.000Z',
  acceptanceDueAt: '2026-11-21T12:00:00.000Z',
  urgentReason: 'SHORT_NOTICE',
  assignee: { id: 'staff-1', name: 'Ayşe Personel' },
  closedAt: null,
  closeReason: null,
  closeText: null,
  suggestedSolution: null,
  proposedScheduledAt: null,
  proposedScheduledEndsAt: null,
  proposalAcceptedAt: null,
};

function futureIso(days: number): string {
  const value = new Date(Date.now() + days * 86_400_000);
  value.setSeconds(0, 0);
  return value.toISOString();
}

function localDateTimeValue(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function jobCard(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', organizationTimezone: 'Europe/Istanbul',
    type: 'PRODUCT_DELIVERY', status: 'NEW', version: 3,
    title: 'Anadolu Dental Polikliniği ürün teslimi', description: null,
    customerId: 'customer-1', contactId: null, assignedTo: staffUser.id,
    createdBy: managerUser.id, priority: 'normal', dueDate: null,
    scheduledAt: '2026-11-21T11:00:00.000Z', scheduledEndsAt: '2026-11-21T12:00:00.000Z',
    engagementKind: null,
    assignee: { id: staffUser.id, name: staffUser.name },
    customer: { id: 'customer-1', name: 'Anadolu Dental Polikliniği' },
    contact: null,
    workflowContext: {
      allowedCommands: ['ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT'],
      allowedActions: ['VIEW_NOTES'],
      startLocationCaptureEnabled: false,
      submitLocationCaptureEnabled: false,
      lifecycle,
      submissionReadiness: null,
    },
    followUpContext: null,
    followUpProposal: null,
    earlyStartAuthorization: null,
    submitLocationComparison: null,
    changeRequest: null,
    assignmentOffer: openOffer,
    hasOpenOverdueIncident: false,
    correctionDueAt: null,
    ...overrides,
  };
}

function closedOffer(overrides: Partial<AssignmentOffer> = {}): AssignmentOffer {
  return {
    ...openOffer,
    state: 'DECLINED',
    urgentReason: null,
    closedAt: '2026-11-21T11:20:00.000Z',
    closeReason: 'OUT_OF_TOWN',
    closeText: 'Şehir dışında bir kongredeyim; klinik ziyaretine yetişemem.',
    suggestedSolution: 'REASSIGN',
    ...overrides,
  };
}

const declinePresentation = {
  command: 'DECLINE_ASSIGNMENT' as const,
  label: 'Görevi reddet',
  consequence: 'Görev yöneticinin listesine düşer.',
  successMessage: 'Görev reddedildi.',
};

function StaffForm({ draft, codeError = null, suggestionError, scheduleError }: {
  draft: AssignmentReasonDraft;
  codeError?: string | null;
  suggestionError: string | null;
  scheduleError: string | null;
}) {
  const [current, setCurrent] = useState(draft);
  return (
    <JobWorkflowDialog
      dialog={{ kind: 'decline', presentation: declinePresentation }}
      pending={false}
      onClose={() => {}}
      onConfirm={() => {}}
      assignmentReason={{
        draft: current,
        inlineError: codeError,
        suggestionError,
        scheduleError,
        onChange: (patch) => setCurrent((value) => {
          const clearsProposal = patch.suggestedSolution !== undefined
            && patch.suggestedSolution !== 'RESCHEDULE_SELF';
          return clearsProposal
            ? { ...value, ...patch, proposedScheduledLocal: '' }
            : { ...value, ...patch };
        }),
      }}
    />
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        <h1 className="page-header-title">{title}</h1>
        <p>{subtitle}</p>
      </div>
    </header>
  );
}

function ManagerPanels() {
  const reassign = jobCard({
    assignmentOffer: closedOffer({ suggestedSolution: 'REASSIGN' }),
  });
  const proposalStart = futureIso(2);
  const reschedule = jobCard({
    assignmentOffer: closedOffer({
      closeReason: 'OUT_OF_TOWN',
      closeText: null,
      suggestedSolution: 'RESCHEDULE_SELF',
      proposedScheduledAt: proposalStart,
      proposedScheduledEndsAt: new Date(Date.parse(proposalStart) + 30 * 60_000).toISOString(),
      proposalAcceptedAt: null,
    }),
  });
  return (
    <main className="app-main" style={{ maxWidth: '72rem', margin: '0 auto', padding: '1rem' }}>
      <PageHeader
        title="İş detayı — personel önerisi"
        subtitle="RESCUE-002 yönetim paneli: yazılı çözüm önerisi ve bağlı zaman önerisi"
      />
      <AssignmentOfferSection job={reassign} user={managerUser} />
      <AssignmentOfferSection job={reschedule} user={managerUser} />
    </main>
  );
}

function ManagerCancelled() {
  const proposalStart = futureIso(2);
  const cancelled = jobCard({
    status: 'CANCELLED',
    assignmentOffer: closedOffer({
      closeReason: 'OUT_OF_TOWN',
      closeText: 'Klinik ziyareti iptal edildi.',
      suggestedSolution: 'RESCHEDULE_SELF',
      proposedScheduledAt: proposalStart,
      proposedScheduledEndsAt: new Date(Date.parse(proposalStart) + 30 * 60_000).toISOString(),
      proposalAcceptedAt: null,
    }),
  });
  return (
    <main className="app-main" style={{ maxWidth: '72rem', margin: '0 auto', padding: '1rem' }}>
      <PageHeader
        title="İş detayı — iptal edilmiş iş"
        subtitle="Kayıtlı personel önerisi iptal sonrasında da okunabilir kalır"
      />
      <AssignmentOfferSection job={cancelled} user={managerUser} />
    </main>
  );
}

function root() {
  if (fixtureCase === 'staff-empty') {
    return (
      <StaffForm
        draft={{ code: '', suggestedSolution: null, proposedScheduledLocal: '' }}
        suggestionError={null}
        scheduleError={null}
      />
    );
  }
  if (fixtureCase === 'staff-reschedule') {
    return (
      <StaffForm
        draft={{
          code: 'OUT_OF_TOWN' as AssignmentReasonCode,
          suggestedSolution: 'RESCHEDULE_SELF',
          proposedScheduledLocal: localDateTimeValue(2),
        }}
        suggestionError={null}
        scheduleError={null}
      />
    );
  }
  if (fixtureCase === 'staff-error') {
    return (
      <StaffForm
        draft={{
          code: 'WRONG_PRODUCT' as AssignmentReasonCode,
          suggestedSolution: null,
          proposedScheduledLocal: '',
        }}
        suggestionError="Çözüm önerisi zorunludur."
        scheduleError={null}
      />
    );
  }
  if (fixtureCase === 'staff-code-error') {
    return (
      <StaffForm
        draft={{
          code: '',
          suggestedSolution: 'REASSIGN',
          proposedScheduledLocal: '',
        }}
        codeError="Görevi reddetme nedenini seçin."
        suggestionError={null}
        scheduleError={null}
      />
    );
  }
  if (fixtureCase === 'staff-time-error') {
    return (
      <StaffForm
        draft={{
          code: 'ON_LEAVE' as AssignmentReasonCode,
          suggestedSolution: 'RESCHEDULE_SELF',
          proposedScheduledLocal: '',
        }}
        suggestionError={null}
        scheduleError="Önerilen zaman zorunludur."
      />
    );
  }
  if (fixtureCase === 'manager-cancelled') {
    return <ManagerCancelled />;
  }
  return <ManagerPanels />;
}

function Fixture() {
  useEffect(() => {
    document.documentElement.setAttribute('data-rescue-002-ready', 'true');
  }, []);
  return root();
}

createRoot(document.getElementById('rescue-002-root')!).render(
  <ServoraAntProvider>
    <Fixture />
  </ServoraAntProvider>,
);
