/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChangeRequestSection } from '../src/jobs/ChangeRequests';
import type { JobCard } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@x', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
};

const job = {
  id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'ACCEPTED', version: 4,
  title: 'Klinik teslimi', description: null, customerId: 'c1', contactId: null, assignedTo: 'staff-1',
  createdBy: 'manager-1', priority: 'normal', dueDate: null,
  scheduledAt: '2026-11-20T11:00:00.000Z',
  engagementKind: null, invalidatedAt: null, invalidatedBy: null, invalidationReasonCode: null,
  assignee: { id: 'staff-1', name: 'Ayşe' }, customer: { id: 'c1', name: 'Klinik' },
  contact: null,
  workflowContext: { ...workflowContext, allowedActions: ['REQUEST_CHANGE'] },
  followUpContext: null, followUpProposal: null,
  submitLocationComparison: null,
  earlyStartAuthorization: null,
  changeRequest: null,
  hasOpenOverdueIncident: false,
  correctionDueAt: null,
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

function selectValue(element: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function settle() {
  await act(async () => {
    // Response.json() resolves through the stream machinery, so let the event
    // loop turn before asserting on the settled mutation state.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('StaffChangeRequestAction', () => {
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

  async function render(target: JobCard, onSubmitted = vi.fn()) {
    await act(async () => root.render(
      <ChangeRequestSection job={target} user={staff} onChanged={onSubmitted} />,
    ));
  }

  function button(text: string) {
    return Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === text);
  }

  it('offers the action only when the server allows REQUEST_CHANGE', async () => {
    await render(job);
    expect(button('Düzenleme / sonlandırma önerisi gönder')).toBeDefined();

    await render({ ...job, workflowContext: { ...job.workflowContext, allowedActions: ['VIEW_NOTES'] } });
    expect(container.textContent).toBe('');
  });

  it('opens a dialog with a reason select and a mandatory explanation', async () => {
    await render(job);
    await act(async () => button('Düzenleme / sonlandırma önerisi gönder')!.click());

    const drawer = container.querySelector('[data-servora-form-drawer="true"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.querySelector('#change-request-reason')).not.toBeNull();
    expect(drawer?.querySelector('#change-request-text')?.getAttribute('required')).not.toBeNull();
    expect(drawer?.textContent).toContain('Neden seçin');
    expect(drawer?.textContent).toContain('Müşteri erteledi');
  });

  it('refuses to submit without a reason, then without an explanation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await render(job);
    await act(async () => button('Düzenleme / sonlandırma önerisi gönder')!.click());

    const form = container.querySelector('form.change-request-form') as HTMLFormElement;
    await act(async () => form.requestSubmit());
    expect(container.textContent).toContain('Öneri nedenini seçin.');
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => selectValue(
      container.querySelector('#change-request-reason') as HTMLSelectElement,
      'CUSTOMER_POSTPONED',
    ));
    await act(async () => form.requestSubmit());
    expect(container.textContent).toContain('Öneriyi açıklayan metin zorunludur.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the exact body and shows the waiting status line with the reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      jobCardId: 'job-1', changeRequestId: 'request-1', requestedAt: '2026-11-20T09:15:00.000Z',
    }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const onSubmitted = vi.fn();
    await render(job, onSubmitted);
    await act(async () => button('Düzenleme / sonlandırma önerisi gönder')!.click());
    await act(async () => selectValue(
      container.querySelector('#change-request-reason') as HTMLSelectElement,
      'CUSTOMER_POSTPONED',
    ));
    await act(async () => setNativeValue(
      container.querySelector('#change-request-text') as HTMLTextAreaElement,
      '  Müşteri kliniği bugün kapalı.  ',
    ));
    await act(async () => (
      container.querySelector('form.change-request-form') as HTMLFormElement
    ).requestSubmit());
    await settle();
    await settle();

    expect(fetchMock).toHaveBeenCalledWith('/api/job-cards/job-1/change-requests', expect.objectContaining({
      method: 'POST',
    }));
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      reasonCode: 'CUSTOMER_POSTPONED',
      reasonText: 'Müşteri kliniği bugün kapalı.',
    });
    expect(typeof body.clientActionId).toBe('string');
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Öneriniz yöneticide: Müşteri erteledi');
    expect(button('Düzenleme / sonlandırma önerisi gönder')).toBeUndefined();
  });

  it('keeps the dialog open and reports the server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: 'Bu iş için açık bir öneri zaten var.', code: 'CHANGE_REQUEST_ALREADY_OPEN',
    }, 409)));
    await render(job);
    await act(async () => button('Düzenleme / sonlandırma önerisi gönder')!.click());
    await act(async () => selectValue(
      container.querySelector('#change-request-reason') as HTMLSelectElement,
      'OTHER',
    ));
    await act(async () => setNativeValue(
      container.querySelector('#change-request-text') as HTMLTextAreaElement,
      'Klinik kapalı.',
    ));
    await act(async () => (
      container.querySelector('form.change-request-form') as HTMLFormElement
    ).requestSubmit());
    await settle();

    expect(container.querySelector('[data-servora-form-drawer="true"]')).not.toBeNull();
    expect(container.textContent).toContain('Bu iş için açık bir öneri zaten var.');
  });

  it('shows the canonical open request instead of the action', async () => {
    await render({
      ...job,
      changeRequest: {
        id: 'request-1',
        reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
        reasonText: 'Eldiven stoğu yok.',
        requestedAt: '2026-11-20T09:15:00.000Z',
        requestedBy: { id: 'staff-1', name: 'Ayşe' },
      },
      workflowContext: { ...job.workflowContext, allowedActions: ['VIEW_NOTES'] },
    });
    expect(container.textContent).toContain('Öneriniz yöneticide: Stok veya ekipman eksik');
    expect(button('Düzenleme / sonlandırma önerisi gönder')).toBeUndefined();
  });
});
