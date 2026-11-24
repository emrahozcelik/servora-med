/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import type {
  JobCard,
  JobChangeRequest,
  JobLifecycleFacts,
  JobWorkflowContext,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { localDateTimeToIso } from '../src/jobs/scheduling';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staffUser: CurrentUser = {
  id: 's1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'a@x',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const managerUser: CurrentUser = {
  ...staffUser, id: 'm1', name: 'Murat Yönetici', role: 'MANAGER', email: 'm@x',
};

const baseLifecycle: JobLifecycleFacts = {
  createdAt: '2026-11-12T06:00:00.000Z', acceptedAt: null, acceptedBy: null,
  startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
  cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
};

const openRequest: JobChangeRequest = {
  id: 'request-1',
  reasonCode: 'CUSTOMER_POSTPONED',
  reasonText: 'Müşteri kliniği bugün kapalı, teslim yapılamadı.',
  requestedAt: '2026-11-20T09:15:00.000Z',
  requestedBy: { id: 's1', name: 'Ayşe Personel' },
};

function taskContext(overrides: Partial<JobWorkflowContext> = {}): JobWorkflowContext {
  return {
    ...workflowContext,
    allowedCommands: ['ACCEPT_ASSIGNMENT', 'CANCEL'],
    allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
    lifecycle: baseLifecycle,
    submissionReadiness: null,
    ...overrides,
  };
}

function generalTask(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', organizationTimezone: 'Europe/Istanbul',
    type: 'GENERAL_TASK', status: 'NEW', version: 2,
    engagementKind: null, title: 'Teklif dönüşünü takip et', description: 'Mevcut açıklama',
    customerId: null, contactId: null, assignedTo: 's1', createdBy: 'm1',
    priority: 'normal', dueDate: '2026-11-30', scheduledAt: '2026-11-20T09:00:00.000Z',
    assignee: { id: 's1', name: 'Ayşe Personel' }, customer: null, contact: null,
    followUpContext: null, followUpProposal: null,
    earlyStartAuthorization: null, submitLocationComparison: null,
    changeRequest: null, assignmentOffer: null,
    hasOpenOverdueIncident: false, correctionDueAt: null,
    workflowContext: taskContext(),
    ...overrides,
  };
}

const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };

const staffProfiles = [
  {
    id: 'staff-s1', user: {
      ...staffUser, email: 'ayse@example.test', lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    title: null, phone: null, region: null, managerUserId: null, managerName: null,
    version: 1, counters: {
      open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0,
    },
  },
  {
    id: 'staff-s2', user: {
      ...staffUser, id: 's2', name: 'Burak Personel', email: 'burak@example.test', lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    title: null, phone: null, region: null, managerUserId: null, managerName: null,
    version: 1, counters: {
      open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0,
    },
  },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function buttonByName(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

function makeFetch(options: {
  card: JobCard;
  patchResult?: (body: Record<string, unknown>, attempt: number) => Response | null;
}) {
  const patchBodies: Array<Record<string, unknown>> = [];
  let currentCard = options.card;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.split('?')[0] ?? url;
    if (path.endsWith('/notes')) return json(emptyPage);
    if (path.endsWith('/activity')) return json({ ...emptyPage, limit: 50 });
    if (path.endsWith('/overdue-incidents')) return json(emptyPage);
    if (path.endsWith('/follow-ups')) return json(emptyPage);
    if (path.endsWith('/submission-lateness')) return json({ open: null });
    if (path === '/api/staff') return json(staffProfiles);
    if (path.endsWith('/delivery-items')) return json({ items: [] });
    if (path.endsWith('/api/job-cards/job-1') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      patchBodies.push(body);
      const overridden = options.patchResult?.(body, patchBodies.length) ?? null;
      if (overridden) return overridden;
      currentCard = { ...currentCard, ...body, version: currentCard.version + 1 };
      return json({ ...currentCard, assignmentTransitionId: null });
    }
    if (path.endsWith('/api/job-cards/job-1')) return json(currentCard);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return { fetch, patchBodies, currentCard: () => currentCard };
}

describe('OVR-5 deadline extension UI', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(user: CurrentUser, harness: ReturnType<typeof makeFetch>) {
    vi.stubGlobal('fetch', harness.fetch);
    await act(async () => {
      root.render(<JobDetailScreen jobId="job-1" user={user} onBack={() => {}}
        onChanged={() => {}} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function openEdit() {
    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
  }

  async function setInput(selector: string, value: string) {
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!field) throw new Error(`field ${selector} not found`);
    await act(async () => {
      const prototype = field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
  }
  async function setSelect(selector: string, value: string) {
    const field = host.querySelector<HTMLSelectElement>(selector);
    if (!field) throw new Error(`field ${selector} not found`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
  }
  async function submit(buttonName: string) {
    await act(async () => {
      buttonByName(host, buttonName)?.click();
      await settle();
    });
  }

  it('disables Staff deadline fields and points to the change request', async () => {
    const harness = makeFetch({ card: generalTask({ hasOpenOverdueIncident: true }) });
    await render(staffUser, harness);

    const scheduleInput = host.querySelector<HTMLInputElement>('#job-scheduled-at')!;
    expect(scheduleInput).not.toBeNull();
    expect(scheduleInput.disabled).toBe(true);
    expect(host.textContent).toContain(
      'Gecikmesi açık işin tarihini yalnızca yönetim değiştirebilir. Değişiklik talebi gönderin.',
    );

    await openEdit();
    const dueDate = host.querySelector<HTMLInputElement>('#general-task-edit-due-date')!;
    expect(dueDate).not.toBeNull();
    expect(dueDate.disabled).toBe(true);
  });

  it('requires the management reason before saving a deadline change', async () => {
    const harness = makeFetch({ card: generalTask({ hasOpenOverdueIncident: true }) });
    await render(managerUser, harness);
    await openEdit();

    const reason = host.querySelector<HTMLTextAreaElement>('#general-task-edit-extension-reason')!;
    expect(reason).not.toBeNull();
    expect(host.textContent).toContain('Tarih değişikliği gerekçesi');
    expect(host.textContent).toContain('En fazla 500 karakter.');
    expect(reason.getAttribute('aria-describedby')).toContain('general-task-edit-extension-reason-help');

    await setInput('#general-task-edit-due-date', '2026-12-05');
    await submit('Değişiklikleri kaydet');

    expect(harness.patchBodies).toHaveLength(0);
    expect(host.textContent).toContain(
      'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.',
    );
    expect(reason.getAttribute('aria-describedby')).toContain('general-task-edit-extension-reason-error');
    // OVR-5b visual review: the invalid reason field owns focus, not the footer.
    expect(document.activeElement).toBe(reason);

    const textarea = host.querySelector<HTMLTextAreaElement>('#general-task-edit-extension-reason')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      ?.set?.call(textarea, 'Müşteri yeni teslim tarihini onayladı.');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await submit('Değişiklikleri kaydet');

    expect(harness.patchBodies).toHaveLength(1);
    expect(harness.patchBodies[0]).toMatchObject({
      dueDate: '2026-12-05',
      deadlineExtensionReason: 'Müşteri yeni teslim tarihini onayladı.',
    });
  });

  it('submits title, description, priority and assignee without a reason on a lateness-open task', async () => {
    const harness = makeFetch({ card: generalTask({ hasOpenOverdueIncident: true }) });
    await render(managerUser, harness);
    await openEdit();

    const reason = host.querySelector<HTMLTextAreaElement>('#general-task-edit-extension-reason')!;
    expect(reason).not.toBeNull();
    expect(reason.required).toBe(false);

    await setInput('#general-task-edit-title', 'Güncel teklif takibi');
    await setInput('#general-task-edit-description', 'Yeni açıklama');
    await setSelect('#general-task-edit-priority', 'high');
    await setSelect('#general-task-edit-assignee', 's2');
    await submit('Değişiklikleri kaydet');

    expect(host.textContent)
      .not.toContain('Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.');
    expect(harness.patchBodies).toHaveLength(1);
    expect(harness.patchBodies[0]).toMatchObject({
      title: 'Güncel teklif takibi',
      description: 'Yeni açıklama',
      priority: 'high',
      assignedTo: 's2',
    });
    expect(harness.patchBodies[0]).not.toHaveProperty('deadlineExtensionReason');
    expect(harness.patchBodies[0]).not.toHaveProperty('dueDate');
  });

  it('requires the reason once the due date actually changes on a lateness-open task', async () => {
    const harness = makeFetch({ card: generalTask({ hasOpenOverdueIncident: true }) });
    await render(managerUser, harness);
    await openEdit();

    await setInput('#general-task-edit-due-date', '2026-12-05');
    expect(
      host.querySelector<HTMLTextAreaElement>('#general-task-edit-extension-reason')!.required,
    ).toBe(true);
  });

  it('reveals the reason field after 400 DEADLINE_EXTENSION_REASON_REQUIRED and keeps values', async () => {
    const harness = makeFetch({
      card: generalTask({ hasOpenOverdueIncident: false }),
      patchResult: (_body, attempt) => attempt === 1
        ? json({
            error: 'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.',
            code: 'DEADLINE_EXTENSION_REASON_REQUIRED',
            details: {
              fieldErrors: {
                deadlineExtensionReason: 'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.',
              },
            },
          }, 400)
        : null,
    });
    await render(managerUser, harness);
    await openEdit();

    expect(host.querySelector('#general-task-edit-extension-reason')).toBeNull();
    await setInput('#general-task-edit-title', 'Güncel teklif takibi');
    await setInput('#general-task-edit-due-date', '2026-12-05');
    await submit('Değişiklikleri kaydet');

    expect(harness.patchBodies).toHaveLength(1);
    expect(harness.patchBodies[0]).not.toHaveProperty('deadlineExtensionReason');
    expect(host.querySelector<HTMLInputElement>('#general-task-edit-title')?.value)
      .toBe('Güncel teklif takibi');
    expect(host.querySelector<HTMLInputElement>('#general-task-edit-due-date')?.value)
      .toBe('2026-12-05');
    expect(host.querySelector('#general-task-edit-extension-reason')).not.toBeNull();
    expect(host.textContent).toContain(
      'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.',
    );
    // OVR-5b visual review: the server field error moves focus to the field.
    const revealedReason = host.querySelector<HTMLTextAreaElement>(
      '#general-task-edit-extension-reason',
    )!;
    expect(revealedReason.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(revealedReason);

    const textarea = host.querySelector<HTMLTextAreaElement>('#general-task-edit-extension-reason')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      ?.set?.call(textarea, 'Yeni tarih müşteriyle netleşti.');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await submit('Değişiklikleri kaydet');

    expect(harness.patchBodies).toHaveLength(2);
    expect(harness.patchBodies[1]).toMatchObject({
      dueDate: '2026-12-05',
      deadlineExtensionReason: 'Yeni tarih müşteriyle netleşti.',
    });
  });

  it('sends changeRequestResolution from the checked box and omits it when unticked', async () => {
    const harness = makeFetch({
      card: generalTask({ changeRequest: openRequest }),
    });
    await render(managerUser, harness);
    await openEdit();

    expect(host.querySelector('#general-task-edit-resolve-change-request')).toBeNull();
    await setInput('#general-task-edit-due-date', '2026-12-05');
    await settle();

    const checkbox = host.querySelector<HTMLInputElement>('#general-task-edit-resolve-change-request')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);
    await submit('Değişiklikleri kaydet');

    expect(harness.patchBodies).toHaveLength(1);
    expect(harness.patchBodies[0]).toMatchObject({
      changeRequestResolution: { changeRequestId: 'request-1', resolution: 'RESCHEDULED' },
    });

    await openEdit();
    await setInput('#general-task-edit-due-date', '2026-12-08');
    await settle();
    const unchecked = host.querySelector<HTMLInputElement>('#general-task-edit-resolve-change-request')!;
    await act(async () => {
      unchecked.click();
      await Promise.resolve();
    });
    await submit('Değişiklikleri kaydet');

    expect(harness.patchBodies).toHaveLength(2);
    expect(harness.patchBodies[1]).not.toHaveProperty('changeRequestResolution');
  });

  it('shows OPEN_LATENESS_DEADLINE_REQUIRED through the existing page error', async () => {
    const harness = makeFetch({
      card: generalTask({ hasOpenOverdueIncident: false }),
      patchResult: () => json({
        error: 'Gecikmesi açık işin son tarihi kaldırılamaz; ileri bir tarih seçin.',
        code: 'OPEN_LATENESS_DEADLINE_REQUIRED',
      }, 409),
    });
    await render(managerUser, harness);
    await openEdit();
    await setInput('#general-task-edit-due-date', '');
    await submit('Değişiklikleri kaydet');

    expect(harness.patchBodies).toHaveLength(1);
    expect(host.textContent)
      .toContain('Gecikmesi açık işin son tarihi kaldırılamaz; ileri bir tarih seçin.');
  });

  it('sends the schedule reason and change-request resolution from the plan editor', async () => {
    const harness = makeFetch({
      card: generalTask({ hasOpenOverdueIncident: true, changeRequest: openRequest }),
    });
    await render(managerUser, harness);

    expect(host.querySelector('#job-schedule-extension-reason')).not.toBeNull();
    await setInput('#job-scheduled-at', '2026-11-25T09:00');
    await settle();
    const checkbox = host.querySelector<HTMLInputElement>('#job-schedule-resolve-change-request')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);

    const textarea = host.querySelector<HTMLTextAreaElement>('#job-schedule-extension-reason')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      ?.set?.call(textarea, 'Başlangıç müşteri talebiyle ertelendi.');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await submit('Planlanan zamanı kaydet');

    expect(harness.patchBodies).toHaveLength(1);
    expect(harness.patchBodies[0]).toMatchObject({
      scheduledAt: localDateTimeToIso('2026-11-25T09:00'),
      deadlineExtensionReason: 'Başlangıç müşteri talebiyle ertelendi.',
      changeRequestResolution: { changeRequestId: 'request-1', resolution: 'RESCHEDULED' },
    });
  });

  it('treats clearing an optional planned time as a deadline change', async () => {
    const harness = makeFetch({
      card: generalTask({
        scheduledAt: '2026-11-20T09:00:00.000Z',
        changeRequest: openRequest,
      }),
    });
    await render(managerUser, harness);

    expect(host.querySelector('#job-schedule-resolve-change-request')).toBeNull();
    await setInput('#job-scheduled-at', '');
    await settle();

    const checkbox = host.querySelector<HTMLInputElement>('#job-schedule-resolve-change-request');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(true);
    await submit('Planlanan zamanı kaydet');

    expect(harness.patchBodies).toHaveLength(1);
    expect(harness.patchBodies[0]).toMatchObject({
      scheduledAt: null,
      changeRequestResolution: { changeRequestId: 'request-1', resolution: 'RESCHEDULED' },
    });
  });

  it('sends the change-request resolution only when the planned time really changed', async () => {
    const harness = makeFetch({
      card: generalTask({ scheduledAt: '2026-11-20T09:00:00.000Z', changeRequest: openRequest }),
    });
    await render(managerUser, harness);

    // Unchanged interval: no closure is offered and none is sent.
    expect(host.querySelector('#job-schedule-resolve-change-request')).toBeNull();
    await submit('Planlanan zamanı kaydet');
    expect(harness.patchBodies).toHaveLength(1);
    expect(harness.patchBodies[0]).not.toHaveProperty('changeRequestResolution');

    // A real change offers the checked closure; unticking keeps the request open.
    await setInput('#job-scheduled-at', '2026-11-26T09:00');
    await settle();
    const checkbox = host.querySelector<HTMLInputElement>('#job-schedule-resolve-change-request')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);
    expect(
      host.querySelector('label[for="job-schedule-resolve-change-request"]')?.textContent?.trim(),
    ).toBe("Personel önerisini 'Yeniden planlandı' olarak kapat");

    await act(async () => {
      checkbox.click();
      await Promise.resolve();
    });
    await submit('Planlanan zamanı kaydet');

    expect(harness.patchBodies).toHaveLength(2);
    expect(harness.patchBodies[1]).toMatchObject({
      scheduledAt: localDateTimeToIso('2026-11-26T09:00'),
    });
    expect(harness.patchBodies[1]).not.toHaveProperty('changeRequestResolution');
  });

  it('shows DEADLINE_CHANGE_REQUIRES_MANAGEMENT for a Staff deadline edit', async () => {
    const harness = makeFetch({
      card: generalTask({ hasOpenOverdueIncident: false }),
      patchResult: () => json({
        error: 'Gecikmesi açık işin tarihini yalnızca yönetim değiştirebilir. Değişiklik talebi gönderin.',
        code: 'DEADLINE_CHANGE_REQUIRES_MANAGEMENT',
      }, 409),
    });
    await render(staffUser, harness);
    await openEdit();
    await setInput('#general-task-edit-due-date', '2026-12-05');
    await submit('Değişiklikleri kaydet');

    expect(harness.patchBodies).toHaveLength(1);
    expect(host.textContent).toContain(
      'Gecikmesi açık işin tarihini yalnızca yönetim değiştirebilir. Değişiklik talebi gönderin.',
    );

    // OVR-5b visual review: the open form keeps the patch error and the focus
    // instead of leaving only the page feedback behind it.
    expect(host.querySelector('#general-task-edit-due-date')).not.toBeNull();
    const inlineAlert = host.querySelector<HTMLElement>('.general-task-edit-form [role="alert"]')!;
    expect(inlineAlert.textContent)
      .toContain('Gecikmesi açık işin tarihini yalnızca yönetim değiştirebilir. Değişiklik talebi gönderin.');
    expect(document.activeElement).toBe(inlineAlert);
  });

  it('shows CHANGE_REQUEST_NOT_OPEN when the open request was resolved meanwhile', async () => {
    const harness = makeFetch({
      card: generalTask({ changeRequest: openRequest }),
      patchResult: () => json({
        error: 'Bu öneri zaten sonuçlandırılmış.',
        code: 'CHANGE_REQUEST_NOT_OPEN',
      }, 409),
    });
    await render(managerUser, harness);
    await openEdit();
    await setInput('#general-task-edit-due-date', '2026-12-05');
    await settle();
    await submit('Değişiklikleri kaydet');

    expect(harness.patchBodies).toHaveLength(1);
    expect(harness.patchBodies[0]).toMatchObject({
      changeRequestResolution: { changeRequestId: 'request-1', resolution: 'RESCHEDULED' },
    });
    expect(host.textContent).toContain('Bu öneri zaten sonuçlandırılmış.');
    const inlineAlert = host.querySelector<HTMLElement>('.general-task-edit-form [role="alert"]')!;
    expect(inlineAlert.textContent).toContain('Bu öneri zaten sonuçlandırılmış.');
    expect(document.activeElement).toBe(inlineAlert);
  });

  it('focuses the schedule reason field on its required client error', async () => {
    const harness = makeFetch({ card: generalTask({ hasOpenOverdueIncident: true }) });
    await render(managerUser, harness);

    const reason = host.querySelector<HTMLTextAreaElement>('#job-schedule-extension-reason')!;
    expect(reason).not.toBeNull();
    expect(host.textContent).toContain('En fazla 500 karakter.');
    expect(reason.getAttribute('aria-describedby')).toContain('job-schedule-extension-reason-help');

    await submit('Planlanan zamanı kaydet');

    expect(harness.patchBodies).toHaveLength(0);
    expect(host.textContent).toContain(
      'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.',
    );
    // OVR-5b visual review: the invalid reason field owns focus, not the footer.
    expect(document.activeElement).toBe(reason);
  });

  it('reveals and focuses the schedule reason field after DEADLINE_EXTENSION_REASON_REQUIRED', async () => {
    const harness = makeFetch({
      card: generalTask({ hasOpenOverdueIncident: false }),
      patchResult: () => json({
        error: 'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.',
        code: 'DEADLINE_EXTENSION_REASON_REQUIRED',
        details: {
          fieldErrors: {
            deadlineExtensionReason: 'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.',
          },
        },
      }, 400),
    });
    await render(managerUser, harness);

    expect(host.querySelector('#job-schedule-extension-reason')).toBeNull();
    await setInput('#job-scheduled-at', '2026-11-25T09:00');
    await settle();
    await submit('Planlanan zamanı kaydet');

    const reason = host.querySelector<HTMLTextAreaElement>('#job-schedule-extension-reason')!;
    expect(reason).not.toBeNull();
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(reason);
  });

  it('keeps schedule patch errors inline and focused instead of the page feedback', async () => {
    const harness = makeFetch({
      card: generalTask({ hasOpenOverdueIncident: true }),
      patchResult: () => json({
        error: 'Gecikmesi açık işin tarihini yalnızca yönetim değiştirebilir. Değişiklik talebi gönderin.',
        code: 'DEADLINE_CHANGE_REQUIRES_MANAGEMENT',
      }, 409),
    });
    await render(managerUser, harness);

    const reason = host.querySelector<HTMLTextAreaElement>('#job-schedule-extension-reason')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      ?.set?.call(reason, 'Müşteri ertelemeyi istedi.');
    reason.dispatchEvent(new Event('input', { bubbles: true }));
    await submit('Planlanan zamanı kaydet');

    expect(harness.patchBodies).toHaveLength(1);
    const inlineError = host.querySelector<HTMLElement>('.job-schedule-edit p.field-error')!;
    expect(inlineError.textContent).toContain(
      'Gecikmesi açık işin tarihini yalnızca yönetim değiştirebilir. Değişiklik talebi gönderin.',
    );
    expect(document.activeElement).toBe(inlineError);
    expect(document.activeElement).not.toBe(host.querySelector('.detail-feedback-error'));
  });
});
