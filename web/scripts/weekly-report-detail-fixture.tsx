import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { WeeklyReportDetail } from '../src/jobs/WeeklyReportDetail';
import type { CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd';

/**
 * Visual/layout fixture for the Weekly Report detail screen.
 *
 * It renders the REAL `WeeklyReportDetail` against a stubbed transport so the
 * browser measures the production information architecture — heading →
 * lifecycle steps → responsibility → main column + work rail → submission
 * history — instead of a hand-written copy of it. A copy could drift from the
 * component; this cannot.
 *
 * `?state=` selects the lifecycle status, `?role=` selects STAFF or MANAGER.
 */

const JOB_ID = 'job-1';
const STAFF_ID = 'staff-1';
const MANAGER_ID = 'manager-1';
const PERIOD_START = '2026-08-03';
const PERIOD_END = '2026-08-09';
const DUE_DATE = '2026-08-10';

type StateName =
  | 'NEW'
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'REVISION_REQUESTED'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'CANCELLED';

const STATE_NAMES: readonly StateName[] = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED', 'WAITING_APPROVAL',
  'COMPLETED', 'CANCELLED',
];

/** Server-declared command availability per status — the fixture never invents it. */
const ALLOWED_COMMANDS: Record<StateName, string[]> = {
  NEW: ['ACCEPT_ASSIGNMENT', 'CANCEL'],
  ACCEPTED: ['START', 'CANCEL'],
  IN_PROGRESS: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
  REVISION_REQUESTED: ['RESUME', 'CANCEL'],
  WAITING_APPROVAL: ['APPROVE', 'REQUEST_REVISION'],
  COMPLETED: [],
  CANCELLED: [],
};

const ACCEPTED_AT = '2026-08-03T08:00:00.000Z';
const STARTED_AT = '2026-08-03T09:00:00.000Z';
const SUBMITTED_AT = '2026-08-05T12:00:00.000Z';
const REVISION_AT = '2026-08-06T09:00:00.000Z';
const APPROVED_AT = '2026-08-07T10:00:00.000Z';
const CANCELLED_AT = '2026-08-06T15:00:00.000Z';

function person(id: string, name: string) {
  return { id, name };
}

const STAFF_PERSON = person(STAFF_ID, 'Ayşe Personel');
const MANAGER_PERSON = person(MANAGER_ID, 'Murat Yönetici');

/** Mirrors `parseLifecycleFacts` — every key is required by the parser. */
function lifecycleFor(state: StateName) {
  const accepted = state !== 'NEW';
  const started = state === 'IN_PROGRESS' || state === 'REVISION_REQUESTED'
    || state === 'WAITING_APPROVAL' || state === 'COMPLETED' || state === 'CANCELLED';
  const submitted = state === 'REVISION_REQUESTED' || state === 'WAITING_APPROVAL'
    || state === 'COMPLETED' || state === 'CANCELLED';
  return {
    createdAt: '2026-08-03T07:00:00.000Z',
    acceptedAt: accepted ? ACCEPTED_AT : null,
    acceptedBy: accepted ? STAFF_PERSON : null,
    startedAt: started ? STARTED_AT : null,
    submittedAt: submitted ? SUBMITTED_AT : null,
    submittedBy: submitted ? STAFF_PERSON : null,
    submissionNote: submitted ? 'Hafta tamamlandı.' : null,
    approvedAt: state === 'COMPLETED' ? APPROVED_AT : null,
    approvedBy: state === 'COMPLETED' ? MANAGER_PERSON : null,
    approvalNote: null,
    revisionRequestedAt: state === 'REVISION_REQUESTED' ? REVISION_AT : null,
    revisionRequestedBy: state === 'REVISION_REQUESTED' ? MANAGER_PERSON : null,
    revisionReason: state === 'REVISION_REQUESTED' ? 'Saha gözlemleri eksik.' : null,
    cancelledAt: state === 'CANCELLED' ? CANCELLED_AT : null,
    cancelledBy: state === 'CANCELLED' ? MANAGER_PERSON : null,
    cancelReason: state === 'CANCELLED' ? 'Müşteri talebi iptal edildi.' : null,
    cancelledFromStatus: state === 'CANCELLED' ? 'IN_PROGRESS' : null,
    invalidatedAt: null,
    invalidatedBy: null,
    invalidationReasonCode: null,
    invalidatedFromStatus: null,
  };
}

/**
 * Readiness is server-owned. NEW/ACCEPTED/IN_PROGRESS carry items so the rail
 * shows the shared requirements checklist; terminal states carry none.
 */
function readinessFor(state: StateName) {
  if (state === 'COMPLETED' || state === 'CANCELLED') {
    return { evaluatedAt: '2026-08-07T09:00:00.000Z', ready: true, items: [] };
  }
  return {
    evaluatedAt: '2026-08-05T09:00:00.000Z',
    ready: false,
    items: [
      { code: 'WEEKLY_DRAFT_VALID', state: 'met' },
      { code: 'WEEKLY_ANSWERS_COMPLETE', state: state === 'IN_PROGRESS' ? 'missing' : 'met' },
      { code: 'WEEKLY_SOURCE_WORK_READY', state: 'met' },
    ],
  };
}

function jobFor(state: StateName) {
  return {
    id: JOB_ID,
    organizationId: 'org-1',
    type: 'WEEKLY_REPORT',
    status: state,
    version: 3,
    title: `Haftalık Rapor (${PERIOD_START} – ${PERIOD_END})`,
    description: null,
    customerId: null,
    contactId: null,
    assignedTo: STAFF_ID,
    createdBy: MANAGER_ID,
    priority: 'normal',
    dueDate: DUE_DATE,
    scheduledAt: null,
    scheduledEndsAt: null,
    engagementKind: null,
    assignee: STAFF_PERSON,
    customer: null,
    contact: null,
    workflowContext: {
      allowedCommands: ALLOWED_COMMANDS[state],
      allowedActions: ['VIEW_NOTES', 'ADD_NOTE'],
      startLocationCaptureEnabled: false,
      lifecycle: lifecycleFor(state),
      submissionReadiness: readinessFor(state),
    },
    followUpContext: null,
    followUpProposal: null,
  };
}

const SOURCE_WORK = [
  {
    jobCardId: 'job-9', type: 'GENERAL_TASK', title: 'Klinik ziyareti',
    customerName: 'Dünya Dental', staffCompletedAt: '2026-08-05T09:00:00.000Z',
    statusAtSnapshot: 'COMPLETED',
  },
  {
    jobCardId: 'job-10', type: 'PRODUCT_DELIVERY', title: 'Membran teslimi',
    customerName: 'Ege Ağız Sağlığı', staffCompletedAt: '2026-08-06T13:00:00.000Z',
    statusAtSnapshot: 'COMPLETED',
  },
];

function reportFor(state: StateName) {
  return {
    id: 'report-1',
    organizationId: 'org-1',
    staffUserId: STAFF_ID,
    jobCardId: JOB_ID,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    draft: {
      summary: 'Bu hafta iki klinik ziyareti tamamlandı ve bir teslim gerçekleşti.',
      blockers: null,
      nextWeekPlan: 'Ege bölgesindeki iki klinikle demo görüşmesi planlanacak.',
      highlights: null,
      fieldObservations: null,
      supportNeeded: null,
    },
    questions: [{ key: 'q1', prompt: 'Bu hafta ne öğrendin?' }],
    answers: [{ questionKey: 'q1', answer: 'Membran stok takibi klinikte darboğaz.' }],
    version: 2,
    jobStatus: state,
    jobVersion: 3,
    dueDate: DUE_DATE,
    assignedTo: STAFF_ID,
    instructions: 'Saha ziyaretlerini özetleyin ve gelecek haftanın planını yazın.',
    liveSourceWork: SOURCE_WORK,
    submissionSummaries: [],
    createdAt: '2026-08-03T07:00:00.000Z',
    updatedAt: '2026-08-04T10:00:00.000Z',
  };
}

function submissionsFor(state: StateName) {
  if (state !== 'WAITING_APPROVAL' && state !== 'COMPLETED' && state !== 'CANCELLED') return [];
  return [{
    id: 'sub-1',
    organizationId: 'org-1',
    weeklyReportId: 'report-1',
    jobCardId: JOB_ID,
    seqNo: 1,
    submittedBy: STAFF_ID,
    submittedAt: SUBMITTED_AT,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    body: {
      summary: 'Gönderilen özet.',
      blockers: null,
      nextWeekPlan: 'Gönderilen plan.',
      highlights: null,
      fieldObservations: null,
      supportNeeded: null,
    },
    questions: [{ key: 'q1', prompt: 'Bu hafta ne öğrendin?' }],
    answers: [{ questionKey: 'q1', answer: 'Gönderilen yanıt.' }],
    sourceWork: SOURCE_WORK,
    jobVersion: 4,
    sourceActivityId: 'act-1',
    createdAt: SUBMITTED_AT,
  }];
}

function userFor(role: string): CurrentUser {
  const management = role === 'MANAGER' || role === 'ADMIN';
  return {
    id: management ? MANAGER_ID : STAFF_ID,
    organizationId: 'org-1',
    name: management ? 'Murat Yönetici' : 'Ayşe Personel',
    email: management ? 'm@test.local' : 'a@test.local',
    role: management ? 'MANAGER' : 'STAFF',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

function installTransport(state: StateName) {
  const job = JSON.stringify(jobFor(state));
  const report = JSON.stringify(reportFor(state));
  const submissions = JSON.stringify(submissionsFor(state));
  // The shared activity timeline always has a backing page in the fixture so
  // the layout smoke measures the real timeline slot, not its error state.
  const activity = JSON.stringify({ items: [], total: 0, limit: 50, offset: 0 });
  const routes: [string, string][] = [
    [`/api/job-cards/${JOB_ID}/weekly-report/submissions`, submissions],
    [`/api/job-cards/${JOB_ID}/weekly-report`, report],
    [`/api/job-cards/${JOB_ID}/activity`, activity],
    [`/api/job-cards/${JOB_ID}`, job],
  ];

  window.fetch = (async (input: RequestInfo | URL) => {
    const raw = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : input.url;
    // Query-tolerant: the detail reader appends the Slice 1 capability gate
    // (`?includeSubmitLocationCapability=true`) to the same resource path.
    const withoutQuery = raw.split('?')[0] ?? raw;
    const path = withoutQuery.startsWith('http') ? new URL(withoutQuery).pathname : withoutQuery;
    const match = routes.find(([route]) => path === route);
    if (!match) {
      return new Response(JSON.stringify({ error: `no fixture route for ${path}` }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(match[1], {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof window.fetch;
}

function ReadySignal() {
  useEffect(() => {
    document.documentElement.dataset.weeklyDetailReady = 'true';
  }, []);
  return null;
}

const params = new URLSearchParams(window.location.search);
const requested = params.get('state') ?? 'NEW';
const state: StateName = (STATE_NAMES as readonly string[]).includes(requested)
  ? requested as StateName
  : 'NEW';
const role = params.get('role') ?? (state === 'WAITING_APPROVAL' ? 'MANAGER' : 'STAFF');

installTransport(state);

const rootNode = document.getElementById('weekly-detail-root');
if (rootNode) {
  createRoot(rootNode).render(
    <ServoraAntProvider>
      <WeeklyReportDetail jobCardId={JOB_ID} user={userFor(role)} />
      <ReadySignal />
    </ServoraAntProvider>,
  );
}
