/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChangeRequestSection,
  ManagementChangeRequestPanel,
} from '../src/jobs/ChangeRequests';
import type {
  JobCard,
  JobCardListItem,
  JobChangeRequest,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Müdür', email: 'm@x', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
};

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'a@x', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
};

const openRequest: JobChangeRequest = {
  id: 'request-1',
  reasonCode: 'CUSTOMER_POSTPONED',
  reasonText: 'Müşteri kliniği bugün kapalı, teslim yapılamadı.',
  requestedAt: '2026-11-20T09:15:00.000Z',
  requestedBy: { id: 'staff-1', name: 'Ayşe Personel' },
};

const baseJob = {
  id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'ACCEPTED', version: 4,
  title: 'Klinik teslimi', description: null, customerId: 'c1', contactId: null, assignedTo: 'staff-1',
  createdBy: 'manager-1', priority: 'normal', dueDate: null,
  scheduledAt: '2026-11-20T11:00:00.000Z',
  engagementKind: null, invalidatedAt: null, invalidatedBy: null, invalidationReasonCode: null,
  assignee: { id: 'staff-1', name: 'Ayşe Personel' }, customer: { id: 'c1', name: 'Klinik' },
  contact: null,
  workflowContext: { ...workflowContext, allowedCommands: ['CANCEL'], allowedActions: ['RESOLVE_CHANGE_REQUEST'] },
  followUpContext: null, followUpProposal: null,
  submitLocationComparison: null,
  earlyStartAuthorization: null,
  changeRequest: openRequest,
  hasOpenOverdueIncident: false,
  correctionDueAt: null,
} as JobCard;

function jobCard(overrides: Partial<JobCard> = {}): JobCard {
  return { ...baseJob, ...overrides } as JobCard;
}

function listItem(overrides: Partial<JobCardListItem> = {}): JobCardListItem {
  return {
    id: 'job-2', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 1,
    title: 'Klinik teslimi', priority: 'normal', dueDate: null,
    scheduledAt: '2026-11-21T11:00:00.000Z', scheduledEndsAt: null,
    engagementKind: null, createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:00.000Z', staffCompletedAt: null,
    customer: { id: 'c1', name: 'Klinik' }, contact: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    deliveryItemCount: 0, allowedCommands: [],
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function resolveReceipt(resolution: string) {
  return json({
    jobCardId: 'job-1', changeRequestId: 'request-1', resolution,
    resolvedAt: '2026-11-20T10:00:00.000Z',
  });
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

type PanelProps = {
  onChanged?: () => void;
  onReassign?: (trigger: HTMLButtonElement) => void;
  onCancel?: (trigger: HTMLButtonElement) => void;
  canSetNewTime?: boolean;
  disabled?: boolean;
  loadLinkedJobs?: () => Promise<{ items: JobCardListItem[]; total: number; limit: number; offset: number }>;
};

const ACTION_LABELS: Record<string, string> = {
  'new-time': 'Yeni zaman belirle',
  reassign: 'Sorumlu personeli değiştir',
  cancel: 'İşi iptal et',
};

describe('ManagementChangeRequestPanel', () => {
  let root: Root; let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderPanel(target: JobCard, props: PanelProps = {}) {
    await act(async () => root.render(
      <ManagementChangeRequestPanel job={target} {...props} />,
    ));
  }

  function button(text: string) {
    return Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.trim() === text);
  }

  function actionButtons() {
    return Array.from(container.querySelectorAll<HTMLButtonElement>(
      '[data-change-request-guidance]',
    ));
  }

  async function submitDrawer() {
    const form = container.querySelector('form.change-request-form') as HTMLFormElement;
    await act(async () => form.requestSubmit());
    await settle();
  }

  it('renders nothing without an open request', async () => {
    await renderPanel(jobCard({ changeRequest: null }));
    expect(container.textContent).toBe('');
  });

  it('leads with the requester headline and the request facts', async () => {
    await renderPanel(jobCard());
    const section = container.querySelector('[data-change-request="management"]');
    expect(section).not.toBeNull();
    expect(section?.querySelector('h3')?.textContent)
      .toBe('Ayşe Personel bu iş için değişiklik istiyor');
    expect(Array.from(section?.querySelectorAll('dt') ?? []).map((node) => node.textContent))
      .toEqual(['Neden', 'Personelin açıklaması', 'Gönderim']);
    expect(section?.textContent).toContain('Müşteri erteledi');
    expect(section?.querySelector('[data-change-request-reason-text="true"]')?.textContent)
      .toBe('Müşteri kliniği bugün kapalı, teslim yapılamadı.');
    expect(section?.querySelector('time')?.getAttribute('dateTime'))
      .toBe('2026-11-20T09:15:00.000Z');
  });

  it.each([
    ['CUSTOMER_POSTPONED', ['new-time', 'reassign', 'cancel']],
    ['CUSTOMER_ABSENT', ['new-time', 'reassign', 'cancel']],
    ['VISIT_NOT_POSSIBLE', ['new-time', 'reassign', 'cancel']],
    ['CUSTOMER_CHANGED_MIND', ['cancel', 'new-time', 'reassign']],
    ['OTHER', ['reassign', 'new-time', 'cancel']],
    ['WRONG_PRODUCT', ['reassign', 'new-time', 'cancel']],
    ['MISSING_STOCK_OR_EQUIPMENT', ['reassign', 'new-time', 'cancel']],
  ] as const)('orders the real actions for %s and marks only the first primary', async (reasonCode, order) => {
    await renderPanel(
      jobCard({ changeRequest: { ...openRequest, reasonCode } }),
      { onReassign: vi.fn(), onCancel: vi.fn() },
    );

    expect(actionButtons().map((entry) => entry.dataset.changeRequestGuidance)).toEqual([...order]);
    expect(actionButtons().map((entry) => entry.textContent?.trim()))
      .toEqual(order.map((key) => ACTION_LABELS[key]));
    expect(actionButtons()[0]?.classList.contains('primary-button')).toBe(true);
    expect(actionButtons().slice(1).every((entry) => entry.classList.contains('secondary-button')))
      .toBe(true);
    expect(container.textContent).toContain('Ne yapabilirsiniz');
  });

  it('moves the reader to the existing planned-time editor', async () => {
    const editor = document.createElement('input');
    editor.id = 'job-scheduled-at';
    document.body.append(editor);
    try {
      await renderPanel(jobCard());
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-change-request-guidance="new-time"]')!.click();
      });
      expect(document.activeElement).toBe(editor);
    } finally {
      editor.remove();
    }
  });

  it('offers the cancel command only when the server allows it and a handler exists', async () => {
    const onCancel = vi.fn();

    await renderPanel(
      jobCard({ workflowContext: { ...jobCard().workflowContext, allowedCommands: [] } }),
      { onCancel },
    );
    expect(container.querySelector('[data-change-request-guidance="cancel"]')).toBeNull();

    // CANCEL allowed, but this surface has no cancel dialog to open.
    await renderPanel(jobCard(), {});
    expect(container.querySelector('[data-change-request-guidance="cancel"]')).toBeNull();

    // CANCEL is not wired to a hander? The visible control calls the handler.
    await renderPanel(jobCard(), { onCancel });
    const cancel = container.querySelector<HTMLButtonElement>('[data-change-request-guidance="cancel"]')!;
    expect(cancel.textContent?.trim()).toBe('İşi iptal et');
    await act(async () => cancel.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('drops the new-time action when this viewer has no planned-time editor', async () => {
    await renderPanel(
      jobCard({ changeRequest: { ...openRequest, reasonCode: 'OTHER' } }),
      { canSetNewTime: false, onReassign: vi.fn(), onCancel: vi.fn() },
    );
    expect(actionButtons().map((entry) => entry.dataset.changeRequestGuidance))
      .toEqual(['reassign', 'cancel']);
    expect(actionButtons()[0]?.classList.contains('primary-button')).toBe(true);
  });

  it('separates the record-only closures and explains that they do not change the job', async () => {
    await renderPanel(jobCard());

    const group = container.querySelector('[data-change-request-closures="true"]');
    expect(group).not.toBeNull();
    expect(group?.textContent).toContain(
      'Bu seçenekler işi değiştirmez; yalnızca öneriyi kapatır ve personele bildirim gider.',
    );
    expect(Array.from(group?.querySelectorAll('button') ?? []).map((entry) => entry.textContent?.trim()))
      .toEqual([
        'Gerekli düzeltmeyi yaptım',
        'Zamanı değiştirdim',
        'Yerine yeni iş açtım',
        'Öneriyi reddet',
      ]);
  });

  it.each([
    ['Gerekli düzeltmeyi yaptım', 'CORRECTED'],
    ['Zamanı değiştirdim', 'RESCHEDULED'],
  ] as const)('confirms %s before recording %s', async (label, resolution) => {
    const fetchMock = vi.fn().mockResolvedValue(resolveReceipt(resolution));
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();
    await renderPanel(jobCard(), { onChanged });

    await act(async () => button(label)!.click());
    const drawer = container.querySelector('[data-servora-form-drawer="true"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.textContent).toContain(label);
    expect(drawer?.textContent).toContain(
      'Öneri kapatılır ve geri açılamaz. Personel gerekirse yeni bir öneri gönderebilir.',
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await submitDrawer();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/job-cards/job-1/change-requests/request-1/resolve',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ resolution });
    expect(typeof body.clientActionId).toBe('string');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-servora-form-drawer="true"]')).toBeNull();
    expect(container.querySelector(`[data-change-request-resolved="${resolution}"]`)?.textContent)
      .toContain('Öneri kapatıldı');
  });

  it('requires a note to reject and posts it after the confirmation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resolveReceipt('REJECTED'));
    vi.stubGlobal('fetch', fetchMock);
    await renderPanel(jobCard());

    await act(async () => button('Öneriyi reddet')!.click());
    expect(container.textContent).toContain(
      'Öneri kapatılır ve geri açılamaz. Personel gerekirse yeni bir öneri gönderebilir.',
    );
    await submitDrawer();
    expect(container.textContent).toContain('Reddetmek için açıklama zorunludur.');
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => setNativeValue(
      container.querySelector('#change-request-reject-note') as HTMLTextAreaElement,
      '  Teslim yeniden planlandı.  ',
    ));
    await submitDrawer();
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      resolution: 'REJECTED',
      note: 'Teslim yeniden planlandı.',
    });
    expect(container.querySelector('[data-servora-form-drawer="true"]')).toBeNull();
    expect(container.textContent).toContain('Öneri kapatıldı: Reddedildi');
  });

  it('chooses the linked job from the same customer list and excludes this job', async () => {
    const loadLinkedJobs = vi.fn().mockResolvedValue({
      items: [
        listItem({ id: 'job-1', title: 'Bu iş' }),
        listItem({ id: 'job-2', title: 'Yeni klinik ziyareti', type: 'SALES_MEETING' }),
      ],
      total: 2, limit: 50, offset: 0,
    });
    const fetchMock = vi.fn().mockResolvedValue(resolveReceipt('LINKED_JOB_CREATED'));
    vi.stubGlobal('fetch', fetchMock);
    await renderPanel(jobCard(), { loadLinkedJobs });

    await act(async () => button('Yerine yeni iş açtım')!.click());
    await settle();

    expect(loadLinkedJobs).toHaveBeenCalledWith({ customerId: 'c1', limit: 50 });
    const options = Array.from(
      container.querySelectorAll<HTMLOptionElement>('#change-request-linked-job option'),
    );
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toBe('İş seçin');
    expect(options[1]?.textContent).toContain('Yeni klinik ziyareti');
    expect(options[1]?.textContent).toContain('Satış görüşmesi');
    expect(options.map((entry) => entry.textContent).join(' ')).not.toContain('Bu iş');

    await submitDrawer();
    expect(container.textContent).toContain('Yeni işi listeden seçin.');
    expect(fetchMock).not.toHaveBeenCalled();

    const select = container.querySelector<HTMLSelectElement>('#change-request-linked-job')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
        ?.set?.call(select, 'job-2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await submitDrawer();

    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      resolution: 'LINKED_JOB_CREATED',
      linkedJobCardId: 'job-2',
    });
  });

  it('hides the linked-job closure when the job has no customer', async () => {
    await renderPanel(jobCard({ customerId: null }));
    expect(button('Yerine yeni iş açtım')).toBeUndefined();
    expect(button('Gerekli düzeltmeyi yaptım')).toBeDefined();
  });

  it('reminds management to close the request after a reassignment', async () => {
    await renderPanel(jobCard());
    expect(container.querySelector('[data-change-request-reassigned="true"]')).toBeNull();

    await renderPanel(jobCard({ assignedTo: 'staff-2' }));
    expect(container.querySelector('[data-change-request-reassigned="true"]')?.textContent)
      .toBe('Sorumlu personel değişti; öneriyi kapatmayı unutmayın.');
  });

  it('refreshes and explains when the request was already closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: 'Bu öneri zaten sonuçlandırılmış.', code: 'CHANGE_REQUEST_NOT_OPEN',
    }, 409)));
    const onChanged = vi.fn();
    await renderPanel(jobCard(), { onChanged });

    await act(async () => button('Gerekli düzeltmeyi yaptım')!.click());
    await submitDrawer();

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-servora-form-drawer="true"]')).toBeNull();
    expect(container.querySelector('[data-change-request-not-open="true"]')?.textContent)
      .toBe('Öneri zaten kapatılmış.');

    // The refreshed card no longer carries the closed request: the outcome stays.
    await renderPanel(jobCard({ changeRequest: null }), { onChanged });
    expect(container.querySelector('[data-change-request="management-closed"]')).not.toBeNull();
    expect(container.querySelector('[data-change-request-not-open="true"]')?.textContent)
      .toBe('Öneri zaten kapatılmış.');
  });

  it('keeps the closure outcome after the refreshed card drops the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resolveReceipt('CORRECTED')));
    await renderPanel(jobCard());
    await act(async () => button('Gerekli düzeltmeyi yaptım')!.click());
    await submitDrawer();

    await renderPanel(jobCard({ changeRequest: null }));
    const outcome = container.querySelector('[data-change-request-resolved="CORRECTED"]');
    expect(outcome?.textContent).toContain('Öneri kapatıldı: Düzeltildi');
    expect(document.activeElement).toBe(outcome);

    // A different job never inherits it.
    await renderPanel(jobCard({ id: 'job-2', changeRequest: null }));
    expect(container.querySelector('[data-change-request="management-closed"]')).toBeNull();
  });

  it('keeps the facts but withholds every closure without RESOLVE_CHANGE_REQUEST', async () => {
    await renderPanel(jobCard({
      workflowContext: { ...jobCard().workflowContext, allowedActions: ['VIEW_NOTES'] },
    }));
    expect(container.textContent).toContain('Müşteri erteledi');
    expect(container.querySelector('[data-change-request-closures="true"]')).toBeNull();
    expect(button('Gerekli düzeltmeyi yaptım')).toBeUndefined();
  });

  it('keeps the dialog open and reports a failed decision', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: 'Öneri başka bir yönetici tarafından kapatıldı.', code: 'VERSION_CONFLICT',
    }, 409)));
    await renderPanel(jobCard());

    await act(async () => button('Öneriyi reddet')!.click());
    await act(async () => setNativeValue(
      container.querySelector('#change-request-reject-note') as HTMLTextAreaElement,
      'Uygun değil.',
    ));
    await submitDrawer();

    expect(container.querySelector('[data-servora-form-drawer="true"]')).not.toBeNull();
    expect(container.textContent).toContain('Öneri başka bir yönetici tarafından kapatıldı.');
  });
});

describe('ChangeRequestSection', () => {
  let root: Root; let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('routes management to the open-request guidance panel', async () => {
    await act(async () => root.render(
      <ChangeRequestSection job={jobCard()} user={manager} onChanged={vi.fn()} />,
    ));
    expect(container.querySelector('[data-change-request="management"]')).not.toBeNull();
    expect(container.querySelector('[data-change-request-closures="true"]')).not.toBeNull();
  });

  it('routes staff to the request action instead of the guidance', async () => {
    await act(async () => root.render(
      <ChangeRequestSection
        job={jobCard({
          changeRequest: null,
          workflowContext: {
            ...jobCard().workflowContext,
            allowedActions: ['REQUEST_CHANGE'],
          },
        })}
        user={staff}
      />,
    ));
    expect(container.querySelector('[data-change-request="staff"]')).not.toBeNull();
    expect(container.querySelector('[data-change-request="management"]')).toBeNull();
  });
});
