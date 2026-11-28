/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import { deriveJobWorkflowPresentation } from '../src/jobs/job-workflow-presentation';
import type {
  AssignmentOffer,
  JobCard,
  JobCardChangeRequest,
  JobCardListItem,
  MeetingDetails,
} from '../src/jobs/jobs-api';
import {
  buildManagerRecoveryPlan,
  buildManagerRecoveryPreview,
  type ManagerRecoveryDecisionId,
} from '../src/jobs/manager-recovery-policy';
import { ManagerRecoverySection } from '../src/jobs/ManagerRecoverySection';
import type { CurrentUser, StaffMember } from '../src/services/api';
import { withoutSaleCapability, workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOW_MS = Date.parse('2026-11-28T09:00:00.000Z');
const FUTURE_START = '2026-11-30T10:00:00.000Z';
const FUTURE_END = '2026-11-30T11:00:00.000Z';
const PROPOSED_FUTURE_START = '2026-12-01T13:00:00.000Z';
const PROPOSED_FUTURE_END = '2026-12-01T14:00:00.000Z';
const EXPIRED_PROPOSED_START = '2026-11-28T08:00:00.000Z';
const EXPIRED_PROPOSED_END = '2026-11-28T09:00:00.000Z';

const managerUser: CurrentUser = {
  id: 'manager-1',
  organizationId: 'org-1',
  name: 'Murat Yönetici',
  email: 'manager@servora.local',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const staffUser: CurrentUser = {
  id: 'staff-1',
  organizationId: 'org-1',
  name: 'Ayşe Personel',
  email: 'ayse@servora.local',
  role: 'STAFF',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: false, calendar: true, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const staffList: StaffMember[] = [
  {
    user: {
      id: 'staff-1',
      organizationId: 'org-1',
      name: 'Ayşe Personel',
      email: 'ayse@servora.local',
      role: 'STAFF',
      mustChangePassword: false,
      isActive: true,
      version: 1,
    },
    profile: { id: 'p-1', phone: null, jobTitle: 'Satış Temsilcisi', notes: null },
  },
  {
    user: {
      id: 'staff-2',
      organizationId: 'org-1',
      name: 'Mehmet Personel',
      email: 'mehmet@servora.local',
      role: 'STAFF',
      mustChangePassword: false,
      isActive: true,
      version: 1,
    },
    profile: { id: 'p-2', phone: null, jobTitle: 'Saha Uzmanı', notes: null },
  },
  {
    user: {
      id: 'manager-1',
      organizationId: 'org-1',
      name: 'Murat Yönetici',
      email: 'manager@servora.local',
      role: 'MANAGER',
      mustChangePassword: false,
      isActive: true,
      version: 1,
    },
    profile: { id: 'p-3', phone: null, jobTitle: 'Yönetici', notes: null },
  },
];

function makeOffer(overrides: Partial<AssignmentOffer> = {}): AssignmentOffer {
  return {
    id: 'offer-1',
    state: 'DECLINED',
    openedAt: '2026-11-28T07:00:00.000Z',
    acceptanceDueAt: '2026-11-28T08:00:00.000Z',
    urgentReason: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    closedAt: '2026-11-28T07:20:00.000Z',
    closeReason: 'SCHEDULE_CONFLICT',
    closeText: 'Başka randevu çakışıyor.',
    suggestedSolution: 'RESCHEDULE_SELF',
    proposedScheduledAt: PROPOSED_FUTURE_START,
    proposedScheduledEndsAt: PROPOSED_FUTURE_END,
    proposalAcceptedAt: null,
    ...overrides,
  };
}

function makeChangeRequest(overrides: Partial<JobCardChangeRequest> = {}): JobCardChangeRequest {
  return {
    id: 'cr-1',
    reasonCode: 'CUSTOMER_POSTPONED',
    reasonText: 'Müşteri yarın öğleden sonra uygun.',
    requestedAt: '2026-11-28T08:15:00.000Z',
    requestedBy: { id: 'staff-1', name: 'Ayşe Personel' },
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobCard> = {}): JobCard {
  const status = overrides.status ?? 'NEW';
  const type = overrides.type ?? 'SALES_MEETING';
  const defaultCommands: JobCard['workflowContext']['allowedCommands'] =
    status === 'NEW'
      ? ['CANCEL']
      : status === 'ACCEPTED'
        ? ['START', 'CANCEL']
        : status === 'IN_PROGRESS'
          ? ['SUBMIT_FOR_APPROVAL', 'CANCEL']
          : status === 'WAITING_APPROVAL'
            ? ['APPROVE', 'REQUEST_REVISION', 'CANCEL']
            : status === 'REVISION_REQUESTED'
              ? ['SUBMIT_FOR_APPROVAL', 'CANCEL']
              : [];
  return {
    id: 'job-1',
    organizationId: 'org-1',
    title: 'Diş Kliniği İlk Ziyareti',
    description: 'İmplant tanıtım ziyareti.',
    type,
    engagementKind: type === 'SALES_MEETING' ? 'SALES_MEETING' : null,
    status,
    priority: 'normal',
    assignedTo: 'staff-1',
    createdBy: 'manager-1',
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customerId: 'cust-1',
    contactId: null,
    customer: { id: 'cust-1', name: 'Özel Dent Klinik' },
    contact: null,
    dueDate: '2026-12-05',
    scheduledAt: FUTURE_START,
    scheduledEndsAt: FUTURE_END,
    version: 3,
    followUpContext: null,
    followUpProposal: null,
    hasOpenOverdueIncident: false,
    correctionDueAt: null,
    earlyStartAuthorization: null,
    submitLocationComparison: null,
    changeRequest: null,
    assignmentOffer: null,
    workflowContext: {
      ...workflowContext,
      allowedCommands: defaultCommands,
      allowedActions: ['EDIT_JOB_FIELDS', 'ADD_NOTE', 'RESOLVE_CHANGE_REQUEST'],
      ...(overrides.workflowContext ?? {}),
    },
    ...overrides,
  };
}

function present(job: JobCard, meetingDetails: MeetingDetails | null = null) {
  return deriveJobWorkflowPresentation({
    job,
    user: managerUser,
    workflowContext: job.workflowContext,
    deliveryItems: [],
    meetingDetails,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  const eventName = element instanceof HTMLSelectElement ? 'change' : 'input';
  element.dispatchEvent(new Event(eventName, { bubbles: true }));
  if (element instanceof HTMLInputElement && (element.type === 'datetime-local' || element.type === 'date')) {
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function decisionIds(job: JobCard, nowMs = NOW_MS): ManagerRecoveryDecisionId[] {
  return buildManagerRecoveryPlan({
    job,
    presentation: present(job),
    nowMs,
  }).options.map((option) => option.id);
}

describe('RESCUE-003/B pure policy & preview (MF-02, MF-03, MF-05)', () => {
  it('RESCHEDULE_SELF with valid future proposal puts ACCEPT_PROPOSED_TIME first and defaults to it', () => {
    const job = makeJob({ assignmentOffer: makeOffer({ suggestedSolution: 'RESCHEDULE_SELF' }) });
    const plan = buildManagerRecoveryPlan({ job, presentation: present(job), nowMs: NOW_MS });

    expect(plan.defaultSelectedId).toBe('ACCEPT_PROPOSED_TIME');
    expect(plan.options[0]).toMatchObject({ id: 'ACCEPT_PROPOSED_TIME', suggestedByStaff: true });
    expect(plan.options.slice(1, 5).map((o) => o.id)).toEqual([
      'RESCHEDULE',
      'REASSIGN_AND_RESCHEDULE',
      'REASSIGN_KEEP_TIME',
      'REOFFER',
    ]);
  });

  it('RESCHEDULE_SELF with expired proposal omits ACCEPT_PROPOSED_TIME, explains why, and puts RESCHEDULE first', () => {
    const job = makeJob({
      assignmentOffer: makeOffer({
        suggestedSolution: 'RESCHEDULE_SELF',
        proposedScheduledAt: EXPIRED_PROPOSED_START,
        proposedScheduledEndsAt: EXPIRED_PROPOSED_END,
      }),
    });
    const plan = buildManagerRecoveryPlan({ job, presentation: present(job), nowMs: NOW_MS });

    expect(plan.options.some((o) => o.id === 'ACCEPT_PROPOSED_TIME')).toBe(false);
    expect(plan.options[0]?.id).toBe('RESCHEDULE');
    expect(plan.defaultSelectedId).toBe('RESCHEDULE');
    expect(plan.unavailableNotes.some((note) => note.includes('geçmişte'))).toBe(true);
  });

  it('REASSIGN orders REASSIGN_AND_RESCHEDULE first when urgentReason is START_PASSED, else REASSIGN_KEEP_TIME', () => {
    const startPassed = makeJob({
      assignmentOffer: makeOffer({
        suggestedSolution: 'REASSIGN',
        urgentReason: 'START_PASSED',
        proposedScheduledAt: null,
        proposedScheduledEndsAt: null,
      }),
    });
    const normalReassign = makeJob({
      assignmentOffer: makeOffer({
        suggestedSolution: 'REASSIGN',
        urgentReason: null,
        proposedScheduledAt: null,
        proposedScheduledEndsAt: null,
      }),
    });

    expect(decisionIds(startPassed).slice(0, 2)).toEqual(['REASSIGN_AND_RESCHEDULE', 'REASSIGN_KEEP_TIME']);
    expect(decisionIds(normalReassign).slice(0, 2)).toEqual(['REASSIGN_KEEP_TIME', 'REASSIGN_AND_RESCHEDULE']);
  });

  it('CORRECT_DETAILS puts CORRECT first on SALES_MEETING/GENERAL_TASK and explains PRODUCT_DELIVERY limit', () => {
    const visit = makeJob({
      type: 'SALES_MEETING',
      assignmentOffer: makeOffer({ suggestedSolution: 'CORRECT_DETAILS', proposedScheduledAt: null, proposedScheduledEndsAt: null }),
    });
    expect(decisionIds(visit)[0]).toBe('CORRECT');

    const delivery = makeJob({
      type: 'PRODUCT_DELIVERY',
      assignmentOffer: makeOffer({ suggestedSolution: 'CORRECT_DETAILS', proposedScheduledAt: null, proposedScheduledEndsAt: null }),
    });
    const deliveryPlan = buildManagerRecoveryPlan({ job: delivery, presentation: present(delivery), nowMs: NOW_MS });
    expect(deliveryPlan.options.some((o) => o.id === 'CORRECT')).toBe(false);
    expect(deliveryPlan.unavailableNotes.some((n) => n.includes('Ürün teslim kalemleri'))).toBe(true);
  });

  it('CANCEL_REQUEST and CUSTOMER_CHANGED_MIND never pre-select destructive CANCEL and keep non-destructive options', () => {
    const cancelOfferJob = makeJob({
      assignmentOffer: makeOffer({
        suggestedSolution: 'CANCEL_REQUEST',
        proposedScheduledAt: null,
        proposedScheduledEndsAt: null,
      }),
    });
    const plan1 = buildManagerRecoveryPlan({ job: cancelOfferJob, presentation: present(cancelOfferJob), nowMs: NOW_MS });
    expect(plan1.defaultSelectedId).toBeNull();
    expect(plan1.options.find((o) => o.id === 'CANCEL')?.suggestedByStaff).toBe(true);
    expect(plan1.options.some((o) => o.id === 'RESCHEDULE')).toBe(true);

    const changedMindJob = makeJob({
      status: 'ACCEPTED',
      changeRequest: makeChangeRequest({ reasonCode: 'CUSTOMER_CHANGED_MIND' }),
    });
    const plan2 = buildManagerRecoveryPlan({ job: changedMindJob, presentation: present(changedMindJob), nowMs: NOW_MS });
    expect(plan2.defaultSelectedId).toBeNull();
    expect(plan2.options.find((o) => o.id === 'CANCEL')?.suggestedByStaff).toBe(true);
    expect(plan2.options.some((o) => o.id === 'RESCHEDULE')).toBe(true);
  });

  it('started cases (IN_PROGRESS / WAITING_APPROVAL / REVISION_REQUESTED) hide pre-start decisions with clear explanation', () => {
    for (const status of ['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'] as const) {
      const started = makeJob({
        status,
        changeRequest: makeChangeRequest({ reasonCode: 'WRONG_PRODUCT' }),
        workflowContext: {
          ...workflowContext,
          allowedCommands: status === 'WAITING_APPROVAL' ? ['APPROVE', 'REQUEST_REVISION', 'CANCEL'] : ['CANCEL'],
          allowedActions: status === 'WAITING_APPROVAL'
            ? ['ADD_NOTE', 'RESOLVE_CHANGE_REQUEST']
            : ['EDIT_JOB_FIELDS', 'ADD_NOTE', 'RESOLVE_CHANGE_REQUEST'],
        },
      });
      const plan = buildManagerRecoveryPlan({ job: started, presentation: present(started), nowMs: NOW_MS });
      expect(plan.isStartedCase).toBe(true);
      expect(plan.options.some((o) => o.id === 'RESCHEDULE')).toBe(false);
      expect(plan.options.some((o) => o.id === 'REASSIGN_KEEP_TIME')).toBe(false);
      expect(plan.options.some((o) => o.id === 'REASSIGN_AND_RESCHEDULE')).toBe(false);
      expect(plan.options.some((o) => o.id === 'REOFFER')).toBe(false);
      expect(plan.options.map((o) => o.id)).toContain('ACKNOWLEDGED_ONLY');
      expect(plan.options.map((o) => o.id)).toContain('REJECT_CHANGE_REQUEST');
      expect(plan.options.map((o) => o.id)).toContain('LINKED_JOB_CREATED');
      expect(plan.unavailableNotes.some((n) => n.includes('İş başlatıldığı için'))).toBe(true);
    }
  });

  it('preview reports exact side effects and non-effects when offer and change request coexist', () => {
    const job = makeJob({
      assignmentOffer: makeOffer({ suggestedSolution: 'RESCHEDULE_SELF' }),
      changeRequest: makeChangeRequest(),
    });
    const reschedWithoutClosingCr = buildManagerRecoveryPreview({
      job,
      selectedDecisionId: 'RESCHEDULE',
      hasRecoveryOffer: true,
      hasOpenChangeRequest: true,
      scheduledTimeLabel: '01 Ara 2026 14:00',
      resolveChangeRequest: false,
    });
    expect(reschedWithoutClosingCr.effects.join(' ')).toContain('planlanan zaman aralığı (mevcut süre korunarak) güncellenir');
    expect(reschedWithoutClosingCr.nonEffects.join(' ')).toContain('Açık personel talebi işaretlenmezse açık kalır.');

    const ackOnly = buildManagerRecoveryPreview({
      job,
      selectedDecisionId: 'ACKNOWLEDGED_ONLY',
      hasRecoveryOffer: true,
      hasOpenChangeRequest: true,
    });
    expect(ackOnly.tone).toBe('info');
    expect(ackOnly.nonEffects.join(' ')).toContain('İş durumu, iş bilgileri, planlanan zaman ve sorumlu personel değişmez.');
    expect(ackOnly.nonEffects.join(' ')).toContain('Teslim son tarihi, atama teklifi ve mevcut gecikme sorumluluğu korunur.');
  });
});

describe('RESCUE-003/B ManagerRecoverySection & JobDetail UI integration', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('min-width'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('MF-01: renders single recovery section and single CTA button when offer + change request coexist, with no <details class="job-recovery">', async () => {
    const job = makeJob({
      assignmentOffer: makeOffer(),
      changeRequest: makeChangeRequest(),
    });

    await act(async () => {
      root.render(
        <ManagerRecoverySection
          job={job}
          user={managerUser}
          onCommitted={vi.fn().mockResolvedValue(undefined)}
          onActionStart={vi.fn()}
          onRefresh={vi.fn().mockResolvedValue(true)}
          onUnknownOutcome={vi.fn()}
          onReassigned={vi.fn()}
          onChanged={vi.fn()}
          loadStaffFn={vi.fn().mockResolvedValue(staffList)}
          loadLinkedJobsFn={vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 })}
        />,
      );
    });
    await settle();

    expect(host.querySelectorAll('[data-manager-recovery="true"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-manager-recovery-trigger="true"]')).toHaveLength(1);
    expect(host.querySelector('details.job-recovery')).toBeNull();
    expect(host.querySelector('[data-assignment-offer="DECLINED"]')).not.toBeNull();
    expect(host.querySelector('[data-change-request="management"]')).not.toBeNull();
    // No scattered buttons inside source summaries
    expect(host.querySelectorAll('section[data-manager-recovery="true"] button')).toHaveLength(1);
  });

  it('MF-04/MF-08: uses single <form> + <fieldset><legend>Kararınız</legend>, native radios not inside <ul>, preserves draft across decision switches, and validates with focus recovery', async () => {
    const job = makeJob({
      assignmentOffer: makeOffer({ suggestedSolution: 'CANCEL_REQUEST', proposedScheduledAt: null, proposedScheduledEndsAt: null }),
      changeRequest: makeChangeRequest({ reasonCode: 'CUSTOMER_POSTPONED' }),
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = withoutSaleCapability(String(input));
      if (url.startsWith('/api/staff?')) return json(staffList);
      if (url.startsWith('/api/job-cards?')) return json({ items: [], total: 0, limit: 20, offset: 0 });
      if (url === '/api/job-cards/available-slots') return json({ slots: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <ManagerRecoverySection
          job={job}
          user={managerUser}
          onCommitted={vi.fn().mockResolvedValue(undefined)}
          onActionStart={vi.fn()}
          onRefresh={vi.fn().mockResolvedValue(true)}
          onUnknownOutcome={vi.fn()}
          onReassigned={vi.fn()}
          onChanged={vi.fn()}
          loadStaffFn={vi.fn().mockResolvedValue(staffList)}
          loadLinkedJobsFn={vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 })}
        />,
      );
    });
    await settle();

    const trigger = host.querySelector<HTMLButtonElement>('[data-manager-recovery-trigger="true"]')!;
    await act(async () => { trigger.click(); });
    await settle();

    const forms = host.querySelectorAll('form[data-manager-recovery-form="true"]');
    expect(forms).toHaveLength(1);
    const form = forms[0]!;
    expect(form.querySelector('form')).toBeNull();

    const fieldset = form.querySelector('fieldset.manager-recovery-decisions');
    expect(fieldset?.querySelector('legend')?.textContent).toBe('Kararınız');
    expect(fieldset?.querySelectorAll('ul, li')).toHaveLength(0);

    // CANCEL_REQUEST: nothing pre-selected
    const checked = form.querySelectorAll('input[name="manager-recovery-decision"]:checked');
    expect(checked).toHaveLength(0);

    // Submitting without selection shows error summary and focuses it
    await act(async () => { form.requestSubmit(); });
    await settle();
    const summary = form.querySelector<HTMLElement>('[data-recovery-submit-error="true"]');
    expect(summary?.textContent).toContain('Devam etmek için bir karar seçin.');
    expect(document.activeElement).toBe(summary);

    // Select REJECT_CHANGE_REQUEST, enter draft, switch away to ACKNOWLEDGED_ONLY, switch back -> draft preserved
    const rejectRadio = form.querySelector<HTMLInputElement>('input[value="REJECT_CHANGE_REQUEST"]')!;
    await act(async () => { rejectRadio.click(); });
    await settle();
    const rejectTextarea = form.querySelector<HTMLTextAreaElement>('textarea[name="rejectNote"]')!;
    await act(async () => { setNativeValue(rejectTextarea, 'Mevcut plan korunmalı.'); });

    const ackRadio = form.querySelector<HTMLInputElement>('input[value="ACKNOWLEDGED_ONLY"]')!;
    await act(async () => { ackRadio.click(); });
    await settle();
    expect(form.querySelector('textarea[name="rejectNote"]')).toBeNull();
    expect(form.querySelector('textarea[name="acknowledgeNote"]')).not.toBeNull();

    await act(async () => { rejectRadio.click(); });
    await settle();
    expect(form.querySelector<HTMLTextAreaElement>('textarea[name="rejectNote"]')?.value).toBe('Mevcut plan korunmalı.');
  });

  it('CORRECT disables resolveChangeRequest until a field changes and sends PATCH with CORRECTED resolution', async () => {
    const job = makeJob({
      status: 'ACCEPTED',
      changeRequest: makeChangeRequest({ reasonCode: 'WRONG_PRODUCT' }),
    });
    const patchedBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/notes?') || url.includes('/activity?') || url.includes('/overdue-incidents') || url.includes('/follow-ups')) {
        return json({ items: [], total: 0, limit: 50, offset: 0 });
      }
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.startsWith('/api/customers')) return json({ items: [{ id: 'cust-1', name: 'Özel Dent Klinik', isActive: true }], total: 1, limit: 20, offset: 0 });
      if (url.startsWith('/api/staff?')) return json(staffList);
      if (url.startsWith('/api/job-cards?')) return json({ items: [], total: 0, limit: 20, offset: 0 });
      if ((url.split('?')[0] ?? url) === '/api/job-cards/job-1/sales') return json({ items: [], total: 0, limit: 20, offset: 0 });
      if ((url.split('?')[0] ?? url) === '/api/job-cards/job-1/meeting-details') return json(null, 404);
      if (method === 'PATCH' && url === '/api/job-cards/job-1') {
        patchedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ...job, title: 'Güncellenmiş Ziyaret', version: 4, changeRequest: null });
      }
      if (url.split('?')[0] === '/api/job-cards/job-1') {
        return json(patchedBodies.length > 0 ? { ...job, title: 'Güncellenmiş Ziyaret', version: 4, changeRequest: null } : job);
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <JobDetailScreen jobId="job-1" user={managerUser} onBack={() => {}} onChanged={() => {}} />,
      );
    });
    await settle();

    // No old <details class="job-recovery"> on JobDetailScreen
    expect(host.querySelector('details.job-recovery')).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>('[data-manager-recovery-trigger="true"]')!;
    await act(async () => { trigger.click(); });
    await settle();

    const correctRadio = host.querySelector<HTMLInputElement>('input[value="CORRECT"]')!;
    await act(async () => { correctRadio.click(); });
    await settle();

    const resolveCheckbox = host.querySelector<HTMLInputElement>('input[name="resolveChangeRequest"]')!;
    expect(resolveCheckbox.disabled).toBe(true);

    const titleInput = host.querySelector<HTMLInputElement>('input[name="title"]')!;
    await act(async () => { setNativeValue(titleInput, 'Güncellenmiş Ziyaret'); });
    await settle();

    expect(resolveCheckbox.disabled).toBe(false);
    await act(async () => { resolveCheckbox.click(); });
    await settle();

    const form = host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!;
    await act(async () => { form.requestSubmit(); });
    await settle();

    expect(patchedBodies).toHaveLength(1);
    expect(patchedBodies[0]).toMatchObject({
      expectedVersion: 3,
      title: 'Güncellenmiş Ziyaret',
      changeRequestResolution: { changeRequestId: 'cr-1', resolution: 'CORRECTED' },
    });
    const feedback = host.querySelector('[data-job-detail-section="feedback"]');
    expect(feedback?.classList.contains('detail-feedback-confirmed')).toBe(true);
    expect(feedback?.textContent).toContain('Görüşme bilgileri güncellendi.');
  });

  it('ACKNOWLEDGED_ONLY and REJECT_CHANGE_REQUEST use non-green detail-feedback-info on JobDetailScreen', async () => {
    for (const mode of ['ACKNOWLEDGED_ONLY', 'REJECT_CHANGE_REQUEST'] as const) {
      const job = makeJob({ status: 'IN_PROGRESS', changeRequest: makeChangeRequest() });
      let resolvedBody: Record<string, unknown> | null = null;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = withoutSaleCapability(String(input));
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.endsWith('/api/notifications/read-by-entity')) return json({});
        if (url.includes('/notes?') || url.includes('/activity?') || url.includes('/overdue-incidents') || url.includes('/follow-ups')) {
          return json({ items: [], total: 0, limit: 50, offset: 0 });
        }
        if (url.includes('/submission-lateness')) return json({ open: null });
        if (url.startsWith('/api/staff?')) return json(staffList);
        if (url.startsWith('/api/job-cards?')) return json({ items: [], total: 0, limit: 20, offset: 0 });
        if ((url.split('?')[0] ?? url) === '/api/job-cards/job-1/sales') return json({ items: [], total: 0, limit: 20, offset: 0 });
        if ((url.split('?')[0] ?? url) === '/api/job-cards/job-1/meeting-details') return json(null, 404);
        if (method === 'POST' && url === '/api/job-cards/job-1/change-requests/cr-1/resolve') {
          resolvedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json({
            jobCardId: 'job-1',
            changeRequestId: 'cr-1',
            resolution: mode === 'ACKNOWLEDGED_ONLY' ? 'ACKNOWLEDGED_ONLY' : 'REJECTED',
            resolvedAt: '2026-11-28T09:10:00.000Z',
          });
        }
        if (url.split('?')[0] === '/api/job-cards/job-1') {
          return json(resolvedBody ? { ...job, version: 4, changeRequest: null } : job);
        }
        throw new Error(`Unexpected ${method} ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      await act(async () => {
        root.render(<JobDetailScreen key={mode} jobId="job-1" user={managerUser} onBack={() => {}} onChanged={() => {}} />);
      });
      await settle();

      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-manager-recovery-trigger="true"]')!.click();
      });
      await settle();

      const radio = host.querySelector<HTMLInputElement>(`input[value="${mode}"]`)!;
      await act(async () => { radio.click(); });
      await settle();

      if (mode === 'REJECT_CHANGE_REQUEST') {
        const note = host.querySelector<HTMLTextAreaElement>('textarea[name="rejectNote"]')!;
        await act(async () => { setNativeValue(note, 'Ziyaret devam edecek.'); });
      } else {
        const note = host.querySelector<HTMLTextAreaElement>('textarea[name="acknowledgeNote"]')!;
        await act(async () => { setNativeValue(note, 'Talep incelendi, mevcut akış sürüyor.'); });
      }
      await act(async () => {
        host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!.requestSubmit();
      });
      await settle();

      expect(resolvedBody).toMatchObject({
        resolution: mode === 'ACKNOWLEDGED_ONLY' ? 'ACKNOWLEDGED_ONLY' : 'REJECTED',
        note: mode === 'ACKNOWLEDGED_ONLY'
          ? 'Talep incelendi, mevcut akış sürüyor.'
          : 'Ziyaret devam edecek.',
      });
      const feedback = host.querySelector('[data-job-detail-section="feedback"]');
      expect(feedback?.classList.contains('detail-feedback-info')).toBe(true);
      expect(feedback?.classList.contains('detail-feedback-confirmed')).toBe(false);
    }
  });

  it('MF-13: CANCEL hands off to ReasonDialog without stacking two active overlays, and cancelling returns to recovery drawer', async () => {
    const job = makeJob({
      status: 'ACCEPTED',
      assignmentOffer: null,
      changeRequest: makeChangeRequest({ reasonCode: 'CUSTOMER_CHANGED_MIND' }),
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = withoutSaleCapability(String(input));
      if (url.startsWith('/api/staff?')) return json(staffList);
      if (url.startsWith('/api/job-cards?')) return json({ items: [], total: 0, limit: 20, offset: 0 });
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <ManagerRecoverySection
          job={job}
          user={managerUser}
          onCommitted={vi.fn().mockResolvedValue(undefined)}
          onActionStart={vi.fn()}
          onRefresh={vi.fn().mockResolvedValue(true)}
          onUnknownOutcome={vi.fn()}
          onReassigned={vi.fn()}
          onChanged={vi.fn()}
          loadStaffFn={vi.fn().mockResolvedValue(staffList)}
          loadLinkedJobsFn={vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 })}
        />,
      );
    });
    await settle();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-manager-recovery-trigger="true"]')!.click();
    });
    await settle();

    const cancelRadio = host.querySelector<HTMLInputElement>('input[value="CANCEL"]')!;
    await act(async () => { cancelRadio.click(); });
    await settle();

    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!.requestSubmit();
    });
    await settle();

    // Never two active dialogs stacked at once: recovery form is hidden while ReasonDialog is active
    expect(host.querySelector('[data-manager-recovery-form="true"]')).toBeNull();
    const reasonDialog = host.querySelector('.reason-dialog');
    expect(reasonDialog).not.toBeNull();

    const backButton = Array.from(reasonDialog!.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Vazgeç'),
    )!;
    await act(async () => { backButton.click(); });
    await settle();

    expect(host.querySelector('.reason-dialog')).toBeNull();
    expect(host.querySelector('[data-manager-recovery-form="true"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[value="CANCEL"]')?.checked).toBe(true);
  });

  it('MF-09 & MF-10: LINKED_JOB_CREATED loads eligible customer jobs, handles VERSION_CONFLICT while keeping draft, and Staff never sees management recovery', async () => {
    const linkedList: JobCardListItem[] = [
      {
        id: 'job-2',
        title: 'Yeni Planlanan Ziyaret',
        type: 'SALES_MEETING',
        engagementKind: 'SALES_MEETING',
        status: 'NEW',
        priority: 'normal',
        scheduledAt: FUTURE_START,
        scheduledEndsAt: FUTURE_END,
        dueDate: null,
        assignedTo: 'staff-2',
        assignee: { id: 'staff-2', name: 'Mehmet Personel' },
        customer: { id: 'cust-1', name: 'Özel Dent Klinik' },
      },
    ];
    const job = makeJob({
      status: 'ACCEPTED',
      changeRequest: makeChangeRequest(),
    });
    const loadLinkedJobsFn = vi.fn().mockResolvedValue({ items: linkedList, total: 1, limit: 20, offset: 0 });
    const onRefresh = vi.fn().mockResolvedValue(true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url === '/api/job-cards/job-1/change-requests/cr-1/resolve') {
        return json({ error: 'İş güncellendi.', code: 'VERSION_CONFLICT' }, 409);
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <ManagerRecoverySection
          job={job}
          user={managerUser}
          onCommitted={vi.fn().mockResolvedValue(undefined)}
          onActionStart={vi.fn()}
          onRefresh={onRefresh}
          onUnknownOutcome={vi.fn()}
          onReassigned={vi.fn()}
          onChanged={vi.fn()}
          loadStaffFn={vi.fn().mockResolvedValue(staffList)}
          loadLinkedJobsFn={loadLinkedJobsFn}
        />,
      );
    });
    await settle();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-manager-recovery-trigger="true"]')!.click();
    });
    await settle();

    await act(async () => {
      host.querySelector<HTMLInputElement>('input[value="LINKED_JOB_CREATED"]')!.click();
    });
    await settle();

    const select = host.querySelector<HTMLSelectElement>('select[name="linkedJobCardId"]')!;
    expect(Array.from(select.options).some((o) => o.value === 'job-2')).toBe(true);
    await act(async () => { setNativeValue(select, 'job-2'); });

    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!.requestSubmit();
    });
    await settle();

    // Draft preserved and explicit refresh button exposed
    expect(host.querySelector('[data-recovery-submit-error="true"]')?.textContent).toContain('İş başka bir işlemle güncellendi.');
    expect(select.value).toBe('job-2');
    const reloadButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('En güncel bilgileri yükle'),
    );
    expect(reloadButton).toBeDefined();
    await act(async () => { reloadButton!.click(); });
    await settle();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Staff user never gets management recovery surface
    await act(async () => {
      root.render(
        <ManagerRecoverySection
          job={job}
          user={staffUser}
          onCommitted={vi.fn().mockResolvedValue(undefined)}
          onActionStart={vi.fn()}
          onRefresh={vi.fn().mockResolvedValue(true)}
          onUnknownOutcome={vi.fn()}
          onReassigned={vi.fn()}
          onChanged={vi.fn()}
          loadStaffFn={vi.fn().mockResolvedValue(staffList)}
          loadLinkedJobsFn={loadLinkedJobsFn}
        />,
      );
    });
    await settle();
    expect(host.querySelector('[data-manager-recovery="true"]')).toBeNull();
  });
});
