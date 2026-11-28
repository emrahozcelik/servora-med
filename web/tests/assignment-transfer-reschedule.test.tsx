/** @vitest-environment jsdom */
/**
 * RESCUE-003: one combined management PATCH transfers the job to a different
 * active Staff member and moves its planned interval. These tests cover the
 * form contract (validation, draft preservation, one request, pending,
 * receipt), the past-start acknowledgement replay, the optional evidence-bound
 * `RESCHEDULED` closure and the real JobDetail page wiring.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import { AssignmentOfferSection } from '../src/jobs/AssignmentOffer';
import { AssignmentTransferAction } from '../src/jobs/AssignmentTransferForm';
import { patchJobCard } from '../src/jobs/jobs-api';
import { isoInstantToLocalDateTime } from '../src/jobs/scheduling';
import type { StaffProfile } from '../src/services/people-api';
import type { CurrentUser } from '../src/services/api';
import type {
  AssignmentOffer,
  JobCard,
  JobChangeRequest,
  JobLifecycleFacts,
  JobWorkflowContext,
} from '../src/jobs/jobs-api';
import { withoutSaleCapability } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const realtimeDetail = vi.hoisted(() => ({ invalidate: () => {} }));
vi.mock('../src/realtime/RealtimeProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/realtime/RealtimeProvider')>();
  return {
    ...actual,
    useRealtimeInvalidation(keys: readonly string[], onInvalidate: () => void) {
      actual.useRealtimeInvalidation(keys, onInvalidate);
      if (keys.includes('job-detail:job-1')) realtimeDetail.invalidate = onInvalidate;
    },
  };
});

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Mehmet Yönetici', email: 'm@x',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};

const lifecycle: JobLifecycleFacts = {
  createdAt: '2026-11-20T06:00:00.000Z', acceptedAt: null, acceptedBy: null,
  startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
  cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
};

const baseWorkflow: JobWorkflowContext = {
  allowedCommands: ['CANCEL'], allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
  startLocationCaptureEnabled: false, submitLocationCaptureEnabled: false,
  lifecycle, submissionReadiness: null,
};

function workflow(
  actions: JobWorkflowContext['allowedActions'] = ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
): JobWorkflowContext {
  return { ...baseWorkflow, allowedActions: actions };
}

const NEW_START = '2026-11-21T12:30:00.000Z';
const NEW_START_LOCAL = isoInstantToLocalDateTime(NEW_START);
const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };

function staffProfile(id: string, name: string): StaffProfile {
  return {
    id,
    user: {
      id, organizationId: 'org-1', name, email: `${id}@example.invalid`, role: 'STAFF',
      mustChangePassword: false, isActive: true, version: 1,
      lastLoginAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    title: null, phone: null, region: null, managerUserId: null, managerName: null, version: 1,
    counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
  };
}

const currentStaff = staffProfile('staff-1', 'Ayşe Personel');
const nextStaff = staffProfile('staff-2', 'Mehmet Personel');
const thirdStaff = staffProfile('staff-3', 'Zeynep Personel');

const declinedOffer: AssignmentOffer = {
  id: 'offer-1',
  state: 'DECLINED',
  openedAt: '2026-11-20T07:00:00.000Z',
  acceptanceDueAt: '2026-11-20T09:00:00.000Z',
  urgentReason: null,
  assignee: { id: currentStaff.user.id, name: currentStaff.user.name },
  closedAt: '2026-11-20T07:20:00.000Z',
  closeReason: 'ON_LEAVE',
  closeText: 'İzinliyim.',
  suggestedSolution: 'REASSIGN',
  proposedScheduledAt: null,
  proposedScheduledEndsAt: null,
  proposalAcceptedAt: null,
};

function jobCard(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', organizationTimezone: 'Europe/Istanbul',
    type: 'PRODUCT_DELIVERY', status: 'NEW', version: 4,
    title: 'Klinik ürün teslimi', description: null, customerId: 'c1', contactId: null,
    assignedTo: currentStaff.user.id, createdBy: manager.id, priority: 'normal', dueDate: null,
    scheduledAt: '2026-11-21T10:00:00.000Z', scheduledEndsAt: '2026-11-21T11:00:00.000Z',
    engagementKind: null,
    assignee: { id: currentStaff.user.id, name: currentStaff.user.name },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    workflowContext: workflow(),
    followUpContext: null, followUpProposal: null,
    earlyStartAuthorization: null, submitLocationComparison: null,
    changeRequest: null,
    assignmentOffer: declinedOffer,
    hasOpenOverdueIncident: false, correctionDueAt: null,
    ...overrides,
  };
}

const changeRequest: JobChangeRequest = {
  id: 'request-1',
  reasonCode: 'CUSTOMER_POSTPONED',
  reasonText: 'Klinik teslimatı bir gün sonraya almak istiyor.',
  requestedAt: '2026-11-20T07:30:00.000Z',
  requestedBy: { id: currentStaff.user.id, name: currentStaff.user.name },
};

function updatedJob(patch: Record<string, unknown>): JobCard {
  return jobCard({
    version: 5,
    assignedTo: String(patch.assignedTo),
    assignee: { id: String(patch.assignedTo), name: nextStaff.user.name },
    scheduledAt: String(patch.scheduledAt),
    scheduledEndsAt: '2026-11-21T12:00:00.000Z',
    changeRequest: null,
    assignmentOffer: {
      ...declinedOffer,
      id: 'offer-2',
      state: 'OPEN',
      assignee: { id: nextStaff.user.id, name: nextStaff.user.name },
      closedAt: null,
      closeReason: null,
      closeText: null,
      suggestedSolution: null,
      openedAt: '2026-11-20T08:00:00.000Z',
      acceptanceDueAt: NEW_START,
    },
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubMatchMedia(desktop: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: desktop,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function setNativeValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

function buttonByText(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

function patchCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, init]) => (
    (init as RequestInit | undefined)?.method ?? 'GET'
  ).toUpperCase() === 'PATCH');
}

function patchBody(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const call = patchCalls(fetchMock)[index];
  if (!call) throw new Error(`Missing PATCH call ${index}`);
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

describe('RESCUE-003 assignment transfer and reschedule', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubMatchMedia(true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderSection(
    job: JobCard,
    options: {
      canTransferAndReschedule?: boolean;
      onCommitted?: ReturnType<typeof vi.fn>;
      onRefresh?: ReturnType<typeof vi.fn>;
      canSetNewTime?: boolean;
    } = {},
  ) {
    const onCommitted = options.onCommitted ?? vi.fn(async () => {});
    const onRefresh = options.onRefresh ?? vi.fn(async () => true);
    await act(async () => {
      root.render(
        <AssignmentOfferSection
          job={job}
          user={manager}
          onReassign={vi.fn()}
          canSetNewTime={options.canSetNewTime ?? true}
          renderTransferAction={options.canTransferAndReschedule === false ? undefined : ({ disabled, primary }) => (
            <AssignmentTransferAction
              job={job}
              disabled={disabled}
              primary={primary}
              onTransfer={async (input, onConfirmed) => {
                const patched = await patchJobCard(job.id, input);
                onCommitted(onConfirmed(patched));
              }}
              onRefresh={onRefresh}
            />
          )}
        />,
      );
    });
    await settle();
    return { onCommitted, onRefresh };
  }

  async function openTransfer() {
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-assignment-offer-action="transfer-and-reschedule"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());
    await settle();
    const form = container.querySelector<HTMLFormElement>('[data-assignment-transfer-form="true"]');
    expect(form).not.toBeNull();
    return form!;
  }

  async function chooseStaff(form: ParentNode, id: string) {
    await act(async () => setNativeValue(
      form.querySelector<HTMLSelectElement>('select[name=assignedTo]')!,
      id,
    ));
  }

  async function chooseLocalTime(form: ParentNode, value: string) {
    await act(async () => setNativeValue(
      form.querySelector<HTMLInputElement>('input[name=scheduledAt]')!,
      value,
    ));
  }

  async function submit(form: ParentNode) {
    const button = buttonByText(form, 'Devret ve planla');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    await settle();
  }

  it('keeps the separate recovery actions and adds the combined action for an eligible pre-start interval job', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/staff?')) return json([currentStaff, nextStaff, thirdStaff]);
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    await renderSection(jobCard());

    const actions = Array.from(container.querySelectorAll<HTMLButtonElement>(
      '[data-assignment-offer-recovery] [data-assignment-offer-action]',
    ));
    expect(actions.map((button) => button.textContent?.trim())).toEqual([
      'Sorumlu personeli değiştir',
      'Yeni zaman belirle',
      'Personeli ve zamanı birlikte değiştir',
      'Aynı zamanla yeniden teklif et',
    ]);
    expect(actions[0]?.className).toContain('primary-button');
    expect(actions[2]?.className).toContain('secondary-button');
  });

  it('does not offer the combined action when the server-derived schedule capability is unavailable', async () => {
    await renderSection(jobCard(), { canTransferAndReschedule: false });
    expect(container.querySelector('[data-assignment-offer-action="transfer-and-reschedule"]')).toBeNull();

    await renderSection(jobCard({ status: 'ACCEPTED' }));
    expect(container.querySelector('[data-assignment-offer-action="transfer-and-reschedule"]')).toBeNull();
  });

  it('validates the different staff and the changed interval before sending any PATCH', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/staff?')) return json([currentStaff, nextStaff, thirdStaff]);
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderSection(jobCard());
    const form = await openTransfer();
    // The current assignee is never offered as the transfer target.
    const options = Array.from(form.querySelectorAll<HTMLOptionElement>('select[name=assignedTo] option'))
      .map((option) => option.value);
    expect(options).toEqual(['', nextStaff.user.id, thirdStaff.user.id]);
    expect(document.activeElement).toBe(form.querySelector('select[name=assignedTo]'));

    await submit(form);
    expect(form.querySelector('[data-assignment-transfer-error="validation"]')?.textContent)
      .toContain('Devretmeden önce işaretli alanları düzeltin.');
    expect(form.querySelector('[id$=-staff-error]')?.textContent)
      .toContain('Yeni sorumlu personel seçin.');
    expect(document.activeElement).toBe(form.querySelector('select[name=assignedTo]'));

    await chooseStaff(form, nextStaff.user.id);
    await submit(form);
    expect(form.querySelector('[id$=-time-error]')?.textContent)
      .toContain('Planlanan zamanı değiştirin.');
    expect(patchCalls(fetchMock)).toHaveLength(0);
  });

  it('sends exactly one combined PATCH with the version, new staff and changed interval, then hands the receipt to the page', async () => {
    let releasePatch!: (response: Response) => void;
    const pendingPatch = new Promise<Response>((resolve) => { releasePatch = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = String(input).split('?')[0];
      if (String(input).startsWith('/api/staff?')) return json([currentStaff, nextStaff, thirdStaff]);
      if (method === 'POST' && path === '/api/job-cards/available-slots') {
        return json({ slots: [{ startsAt: '2026-11-21T13:00:00.000Z', endsAt: '2026-11-21T14:00:00.000Z' }] });
      }
      if (method === 'PATCH' && path === '/api/job-cards/job-1') return pendingPatch;
      throw new Error(`Unexpected request: ${method} ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onCommitted, onRefresh } = await renderSection(jobCard());
    const form = await openTransfer();

    await chooseStaff(form, nextStaff.user.id);
    await chooseLocalTime(form, NEW_START_LOCAL);
    await submit(form);
    const pending = buttonByText(form, 'Kaydediliyor…');
    expect(pending).not.toBeNull();
    expect(pending!.hasAttribute('disabled')).toBe(true);
    expect(pending!.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    await act(async () => releasePatch(json(updatedJob({
      assignedTo: nextStaff.user.id,
      scheduledAt: NEW_START,
    }))));
    await settle();
    await settle();

    expect(patchCalls(fetchMock)).toHaveLength(1);
    expect(patchBody(fetchMock)).toEqual({
      expectedVersion: 4,
      assignedTo: nextStaff.user.id,
      scheduledAt: NEW_START,
    });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(onCommitted.mock.calls[0]?.[0]).toContain(
      `Personel ve plan güncellendi. ${nextStaff.user.name} için yeni atama teklifi açıldı. Personelin yanıtı bekleniyor.`,
    );
    expect(container.querySelector('[data-assignment-transfer-form="true"]')).toBeNull();
  });

  it('keeps the draft and shows the canonical stale message on a version conflict', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (String(input).startsWith('/api/staff?')) return json([currentStaff, nextStaff, thirdStaff]);
      if (method === 'PATCH') {
        return json({ error: 'JobCard başka bir işlem tarafından güncellendi.', code: 'VERSION_CONFLICT' }, 409);
      }
      throw new Error(`Unexpected request: ${method} ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onCommitted, onRefresh } = await renderSection(jobCard());
    const form = await openTransfer();
    await chooseStaff(form, nextStaff.user.id);
    await chooseLocalTime(form, NEW_START_LOCAL);
    await submit(form);

    expect(form.querySelector('[data-assignment-transfer-error="submit"]')?.textContent)
      .toContain('İş başka bir işlemle güncellendi. Devam etmek için güncel bilgileri inceleyip formu yeniden açın.');
    expect((form.querySelector<HTMLSelectElement>('select[name=assignedTo]')!).value)
      .toBe(nextStaff.user.id);
    expect((form.querySelector<HTMLInputElement>('input[name=scheduledAt]')!).value)
      .toBe(NEW_START_LOCAL);
    expect(buttonByText(form, 'Devret ve planla')).toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();
    await act(async () => buttonByText(form, 'En güncel bilgileri yükle')!.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(patchCalls(fetchMock)).toHaveLength(1);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('keeps the draft on a calendar/occupancy rejection', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (String(input).startsWith('/api/staff?')) return json([currentStaff, nextStaff, thirdStaff]);
      if (method === 'PATCH') {
        return json({
          error: 'Yeni personelin takviminde bu zaman dolu.',
          code: 'CALENDAR_CONFLICT',
        }, 409);
      }
      throw new Error(`Unexpected request: ${method} ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onCommitted, onRefresh } = await renderSection(jobCard());
    const form = await openTransfer();
    await chooseStaff(form, nextStaff.user.id);
    await chooseLocalTime(form, NEW_START_LOCAL);
    await submit(form);

    expect(form.querySelector('[data-assignment-transfer-error="submit"]')?.textContent)
      .toContain('Yeni personelin takviminde bu zaman dolu.');
    expect((form.querySelector<HTMLSelectElement>('select[name=assignedTo]')!).value)
      .toBe(nextStaff.user.id);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('never retargets an open transfer to a version that arrived after opening', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/staff?')) return json([currentStaff, nextStaff]);
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderSection(jobCard());
    const form = await openTransfer();
    await chooseStaff(form, nextStaff.user.id);
    await chooseLocalTime(form, NEW_START_LOCAL);
    await renderSection(jobCard({ version: 5 }));
    expect(form.querySelector('[data-assignment-transfer-error="submit"]')?.textContent)
      .toContain('İş başka bir işlemle güncellendi.');
    expect(buttonByText(form, 'Devret ve planla')).toBeNull();
    expect(patchCalls(fetchMock)).toHaveLength(0);
  });

  it('closes the form for the past-start acknowledgement and replays both fields with the acknowledgement', async () => {
    let patchAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (String(input).startsWith('/api/staff?')) return json([currentStaff, nextStaff, thirdStaff]);
      if (method === 'PATCH') {
        patchAttempt += 1;
        if (patchAttempt === 1) {
          return json({ error: 'Başlangıç saati geçti.', code: 'PAST_START_ACKNOWLEDGEMENT_REQUIRED' }, 409);
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json(updatedJob(body));
      }
      throw new Error(`Unexpected request: ${method} ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onCommitted } = await renderSection(jobCard());
    const form = await openTransfer();
    await chooseStaff(form, nextStaff.user.id);
    await chooseLocalTime(form, NEW_START_LOCAL);
    await submit(form);

    expect(container.querySelector('[data-assignment-transfer-form="true"]')).toBeNull();
    const ack = container.querySelector<HTMLElement>('[data-past-start-acknowledgement="true"]');
    expect(ack).not.toBeNull();
    await act(async () => {
      setNativeValue(ack!.querySelector<HTMLSelectElement>('#past-start-ack-code')!, 'CUSTOMER_CONFIRMED_LATER_TIME');
      setNativeValue(ack!.querySelector<HTMLTextAreaElement>('#past-start-ack-text')!, 'Müşteri yeni saati onayladı.');
    });
    const confirm = buttonByText(ack!, 'Onayla ve devam et');
    await act(async () => confirm!.click());
    await settle();
    await settle();

    expect(patchAttempt).toBe(2);
    expect(patchBody(fetchMock, 1)).toEqual({
      expectedVersion: 4,
      assignedTo: nextStaff.user.id,
      scheduledAt: NEW_START,
      pastStartAcknowledgement: {
        code: 'CUSTOMER_CONFIRMED_LATER_TIME',
        text: 'Müşteri yeni saati onayladı.',
      },
    });
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it('reveals the deadline reason only when the server requires it and keeps the draft', async () => {
    let patchAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (String(input).startsWith('/api/staff?')) return json([currentStaff, nextStaff, thirdStaff]);
      if (method === 'PATCH') {
        patchAttempt += 1;
        if (patchAttempt === 1) {
          return json({
            error: 'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.',
            code: 'DEADLINE_EXTENSION_REASON_REQUIRED',
            fieldErrors: { deadlineExtensionReason: 'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.' },
          }, 400);
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json(updatedJob(body));
      }
      throw new Error(`Unexpected request: ${method} ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onCommitted } = await renderSection(jobCard());
    const form = await openTransfer();
    await chooseStaff(form, nextStaff.user.id);
    await chooseLocalTime(form, NEW_START_LOCAL);
    await submit(form);

    const reasonDialog = container.querySelector('.reason-dialog');
    expect(reasonDialog?.querySelector('h2')?.textContent).toBe('Tarih değişikliği gerekçesi');
    expect(reasonDialog?.querySelector('[role=alert]')?.textContent).toContain('gerekçe yazın');
    await act(async () => setNativeValue(
      reasonDialog!.querySelector('textarea')!,
      'Müşteri yeni zamanı onayladı ve tarih değişikliği kayda alındı.',
    ));
    await submit(reasonDialog!);
    expect(patchBody(fetchMock, 1).deadlineExtensionReason)
      .toBe('Müşteri yeni zamanı onayladı ve tarih değişikliği kayda alındı.');
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it('offers the evidence-bound RESCHEDULED closure only as an explicit opt-in for an open request', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (String(input).startsWith('/api/staff?')) return json([currentStaff, nextStaff, thirdStaff]);
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json(updatedJob(body));
      }
      throw new Error(`Unexpected request: ${method} ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onCommitted = vi.fn(async () => {});
    const requestJob = jobCard({
      changeRequest,
      workflowContext: workflow(['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'RESOLVE_CHANGE_REQUEST']),
    });
    await renderSection(requestJob, { onCommitted });
    const form = await openTransfer();
    const checkbox = form.querySelector<HTMLInputElement>('input[name=resolveChangeRequest]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);

    await chooseStaff(form, nextStaff.user.id);
    await chooseLocalTime(form, NEW_START_LOCAL);
    await submit(form);
    expect(patchBody(fetchMock, 0)).toEqual({
      expectedVersion: 4,
      assignedTo: nextStaff.user.id,
      scheduledAt: NEW_START,
    });
    expect(onCommitted.mock.calls[0]?.[0]).not.toContain('Yeniden planlandı');

    // A second render proves the explicit opt-in sends the closure in the same PATCH.
    await renderSection(requestJob, { onCommitted });
    const optedForm = await openTransfer();
    await chooseStaff(optedForm, nextStaff.user.id);
    await chooseLocalTime(optedForm, NEW_START_LOCAL);
    await act(async () => {
      optedForm.querySelector<HTMLInputElement>('input[name=resolveChangeRequest]')!.click();
    });
    await submit(optedForm);
    expect(patchBody(fetchMock, 1)).toEqual({
      expectedVersion: 4,
      assignedTo: nextStaff.user.id,
      scheduledAt: NEW_START,
      changeRequestResolution: { changeRequestId: 'request-1', resolution: 'RESCHEDULED' },
    });
    expect(onCommitted.mock.calls[1]?.[0]).toContain('“Yeniden planlandı” olarak kapatıldı');
  });
});

describe('RESCUE-003 on the real JobDetail page', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubMatchMedia(true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function settle() {
    await act(async () => {
      for (let index = 0; index < 6; index += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }

  it.each(['offer', 'no offer', 'lost response'] as const)('settles the page-owned result for %s', async (outcome) => {
    const opensOffer = outcome === 'offer';
    const losesResponse = outcome === 'lost response';
    const before = opensOffer ? jobCard() : jobCard({
      status: 'ACCEPTED',
      scheduledAt: '2099-11-21T10:00:00.000Z',
      scheduledEndsAt: '2099-11-21T11:00:00.000Z',
      changeRequest,
      assignmentOffer: null,
      workflowContext: workflow(['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'RESOLVE_CHANGE_REQUEST']),
    });
    let after: JobCard | null = null;
    let loseResponse!: (error: Error) => void;
    let messagingReads = 0;
    let overlapping = false;
    let allowFreshRead = false;
    const oldReads: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.split('?')[0] ?? url;
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (path === '/api/messaging/conversations/job/job-1') {
        messagingReads += 1;
        return json({}, 404);
      }
      if (url.includes('/delivery-items')) return json(emptyPage);
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (url.startsWith('/api/staff?')) return json([currentStaff, nextStaff, thirdStaff]);
      if (method === 'POST' && path === '/api/job-cards/available-slots') return json({ slots: [] });
      if (method === 'PATCH' && path === '/api/job-cards/job-1') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        after = updatedJob(body);
        if (!opensOffer) {
          after.assignmentOffer = null;
          after.changeRequest = changeRequest;
          after.workflowContext = before.workflowContext;
        }
        if (losesResponse) return new Promise<Response>((_resolve, reject) => { loseResponse = reject; });
        return json(after);
      }
      if (path === '/api/job-cards/job-1') {
        if (overlapping && oldReads.length < 2) {
          return new Promise<Response>((resolve) => { oldReads.push(resolve); });
        }
        if (overlapping && !allowFreshRead) return json({}, 503);
        return json(after ?? before);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <JobDetailScreen
          jobId={before.id}
          user={losesResponse ? { ...manager, capabilities: { ...manager.capabilities, messaging: true } } : manager}
          onBack={() => {}}
          onChanged={() => {}}
          onOpenMessaging={() => {}}
        />,
      );
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();

    const trigger = container.querySelector<HTMLButtonElement>('[data-manager-recovery-trigger="true"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());
    await settle();

    const form = container.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]');
    expect(form).not.toBeNull();
    const transferRadio = form!.querySelector<HTMLInputElement>(
      'input[name="manager-recovery-decision"][value="REASSIGN_AND_RESCHEDULE"]',
    );
    expect(transferRadio).not.toBeNull();
    await act(async () => transferRadio!.click());
    await settle();

    await act(async () => {
      setNativeValue(form!.querySelector<HTMLSelectElement>('select[name=assignedTo]')!, nextStaff.user.id);
      setNativeValue(form!.querySelector<HTMLInputElement>('input[name=scheduledAt]')!, NEW_START_LOCAL);
    });
    if (losesResponse) {
      overlapping = true;
      await act(async () => realtimeDetail.invalidate());
      expect(oldReads).toHaveLength(1);
    }
    const submit = buttonByText(form!, 'Devret ve planla');
    await act(async () => submit!.click());
    await settle();
    await settle();

    expect(patchCalls(fetchMock)).toHaveLength(1);
    expect(patchBody(fetchMock)).toEqual({
      expectedVersion: 4,
      assignedTo: nextStaff.user.id,
      scheduledAt: NEW_START,
    });
    if (losesResponse) {
      const earlyStart = () => container.querySelector<HTMLButtonElement>('[data-early-start-authorization-reveal]');
      expect(earlyStart()?.disabled).toBe(true);
      const initialMessagingReads = messagingReads;
      expect(initialMessagingReads).toBeGreaterThan(0);
      await act(async () => oldReads[0]!(json(before)));
      await settle();
      expect(oldReads).toHaveLength(2);
      await act(async () => loseResponse(new TypeError('Connection lost after commit')));
      await settle();

      const notice = container.querySelector('[data-job-detail-committed-refresh]');
      expect(notice?.textContent).toContain('Personel ve plan değişikliği kaydedilemedi. İşlemin sonucu doğrulanamadı.');
      expect(container.querySelector('[data-manager-recovery-form]')).toBeNull();
      expect(container.querySelector<HTMLButtonElement>('[data-manager-recovery-trigger="true"]')?.disabled).toBe(true);
      expect(earlyStart()?.disabled).toBe(true);
      expect(messagingReads).toBe(initialMessagingReads);
      await act(async () => oldReads[1]!(json(before)));
      await settle();
      expect(container.querySelector('[data-job-detail-committed-refresh]')).toBe(notice);

      allowFreshRead = true;
      await act(async () => buttonByText(notice!, 'Güncel durumu yenile')!.click());
      await settle();
      expect(container.querySelector('[data-job-detail-committed-refresh]')).toBeNull();
      expect(container.querySelector<HTMLButtonElement>('[data-manager-recovery-trigger="true"]')?.disabled).toBe(false);
      expect(messagingReads).toBeGreaterThan(initialMessagingReads);
      expect(patchCalls(fetchMock)).toHaveLength(1);
      return;
    }
    const receipt = container.querySelector<HTMLElement>('[data-job-detail-section="feedback"]');
    expect(receipt?.textContent).toContain('Personel ve plan güncellendi.');
    expect(receipt?.textContent?.includes('Personelin yanıtı bekleniyor.')).toBe(opensOffer);
    expect(receipt?.classList.contains('detail-feedback-confirmed')).toBe(true);
    expect(receipt?.getAttribute('role')).toBe('status');
    expect(receipt?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    // The refreshed card shows the new offer state, distinct from "accepted".
    expect(container.querySelector('[data-assignment-offer-state="OPEN"]')?.textContent)
      .toBe(opensOffer ? 'Yanıt bekliyor' : undefined);
    expect(Boolean(container.querySelector('[data-manager-recovery="true"]'))).toBe(!opensOffer);
  });
});
