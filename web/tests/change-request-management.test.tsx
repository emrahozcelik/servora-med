/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChangeRequestSection } from '../src/jobs/ChangeRequests';
import type { JobCard } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Müdür', email: 'm@x', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
};

const openRequest = {
  id: 'request-1',
  reasonCode: 'CUSTOMER_POSTPONED' as const,
  reasonText: 'Müşteri kliniği bugün kapalı, teslim yapılamadı.',
  requestedAt: '2026-11-20T09:15:00.000Z',
  requestedBy: { id: 'staff-1', name: 'Ayşe Personel' },
};

const job = {
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
} as JobCard;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
  });
}

describe('ManagementChangeRequestPanel', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(target: JobCard, onResolved = vi.fn()) {
    await act(async () => root.render(
      <ChangeRequestSection job={target} user={manager} onChanged={onResolved} />,
    ));
  }

  function button(text: string) {
    return Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === text);
  }

  async function submitForm(form: HTMLFormElement) {
    await act(async () => form.requestSubmit());
    await settle();
  }

  it('renders nothing without an open request', async () => {
    await render({ ...job, changeRequest: null });
    expect(container.textContent).toBe('');
  });

  it('shows the open request with the four decisions and the cancel hint', async () => {
    await render(job);
    const section = container.querySelector('[data-change-request="management"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('Personel önerisi');
    expect(section?.textContent).toContain('Müşteri erteledi');
    expect(section?.textContent).toContain('Ayşe Personel');
    expect(section?.textContent).toContain('Müşteri kliniği bugün kapalı, teslim yapılamadı.');
    expect(button('Düzeltildi')).toBeDefined();
    expect(button('Yeniden planlandı')).toBeDefined();
    expect(button('Bağlı yeni iş oluşturuldu')).toBeDefined();
    expect(button('Reddet')).toBeDefined();
    expect(section?.textContent).toContain('İşi iptal et');
  });

  it('keeps the request visible but read-only without RESOLVE_CHANGE_REQUEST', async () => {
    await render({ ...job, workflowContext: { ...job.workflowContext, allowedActions: ['VIEW_NOTES'] } });
    expect(container.textContent).toContain('Müşteri erteledi');
    expect(button('Düzeltildi')).toBeUndefined();
    expect(button('Reddet')).toBeUndefined();
  });

  it.each([
    ['CORRECTED', 'Düzeltildi'],
    ['RESCHEDULED', 'Yeniden planlandı'],
  ] as const)('posts %s directly and confirms the decision', async (resolution, label) => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      jobCardId: 'job-1', changeRequestId: 'request-1', resolution,
      resolvedAt: '2026-11-20T10:00:00.000Z',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onResolved = vi.fn();
    await render(job, onResolved);

    await act(async () => button(label)!.click());
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/job-cards/job-1/change-requests/request-1/resolve',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ resolution });
    expect(typeof body.clientActionId).toBe('string');
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(container.querySelector(`[data-change-request-resolved="${resolution}"]`)?.textContent)
      .toContain('Öneri karara bağlandı');
  });

  it('requires a note to reject and posts it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      jobCardId: 'job-1', changeRequestId: 'request-1', resolution: 'REJECTED',
      resolvedAt: '2026-11-20T10:00:00.000Z',
    }));
    vi.stubGlobal('fetch', fetchMock);
    await render(job);

    await act(async () => button('Reddet')!.click());
    const form = container.querySelector('form.change-request-form') as HTMLFormElement;
    await submitForm(form);
    expect(container.textContent).toContain('Reddetmek için açıklama zorunludur.');
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => setNativeValue(
      container.querySelector('#change-request-reject-note') as HTMLTextAreaElement,
      '  Teslim yeniden planlandı.  ',
    ));
    await submitForm(form);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/job-cards/job-1/change-requests/request-1/resolve',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      resolution: 'REJECTED',
      note: 'Teslim yeniden planlandı.',
    });
    expect(container.querySelector('[data-servora-form-drawer="true"]')).toBeNull();
    expect(container.textContent).toContain('Öneri karara bağlandı: Reddedildi');
  });

  it('requires a valid linked job id and posts it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      jobCardId: 'job-1', changeRequestId: 'request-1', resolution: 'LINKED_JOB_CREATED',
      resolvedAt: '2026-11-20T10:00:00.000Z',
    }));
    vi.stubGlobal('fetch', fetchMock);
    await render(job);

    await act(async () => button('Bağlı yeni iş oluşturuldu')!.click());
    const form = container.querySelector('form.change-request-form') as HTMLFormElement;
    await submitForm(form);
    expect(container.textContent).toContain('Bağlı yeni işin numarasını girin.');
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => setNativeValue(
      container.querySelector('#change-request-linked-job') as HTMLInputElement,
      'job-1',
    ));
    await submitForm(form);
    expect(container.textContent).toContain('Bir iş kendi kaydına bağlanamaz.');
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => setNativeValue(
      container.querySelector('#change-request-linked-job') as HTMLInputElement,
      '  job-2  ',
    ));
    await submitForm(form);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      resolution: 'LINKED_JOB_CREATED',
      linkedJobCardId: 'job-2',
    });
  });

  it('keeps the dialog open and reports a failed decision', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: 'Öneri başka bir yönetici tarafından kapatıldı.', code: 'CHANGE_REQUEST_NOT_OPEN',
    }, 409)));
    await render(job);

    await act(async () => button('Reddet')!.click());
    const form = container.querySelector('form.change-request-form') as HTMLFormElement;
    await act(async () => setNativeValue(
      container.querySelector('#change-request-reject-note') as HTMLTextAreaElement,
      'Uygun değil.',
    ));
    await submitForm(form);

    expect(container.querySelector('[data-servora-form-drawer="true"]')).not.toBeNull();
    expect(container.textContent).toContain('Öneri başka bir yönetici tarafından kapatıldı.');
  });
});
