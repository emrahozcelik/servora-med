/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingDetailsSection } from '../src/jobs/MeetingDetails';
import type { JobCard, MeetingDetails, PatchMeetingDetailsInput } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let uuidSeq = 0;
const user: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@x', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
};
const job = {
  id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'IN_PROGRESS', version: 3,
  title: 'Görüşme', description: null, customerId: 'c1', contactId: null, assignedTo: 'staff-1',
  createdBy: 'staff-1', priority: 'normal', dueDate: '2026-07-15',
  assignee: { id: 'staff-1', name: 'Ayşe' }, customer: { id: 'c1', name: 'Klinik' },
  contact: null, workflowContext,
} satisfies JobCard;
const details: MeetingDetails = {
  jobCardId: 'job-1', meetingAt: null, outcome: null, unsuccessfulReason: null,
  meetingSummary: null, nextFollowUpAt: null, metContactId: null, metContact: null, jobCardVersion: 3,
};

const contactPayload = (overrides: Record<string, unknown>) => ({
  id: 'ct-1', organizationId: 'org-1', customerId: 'c1', name: 'Dr. Deniz',
  title: 'Başhekim', phone: '0532 111 22 33', email: null,
  isPrimary: true, isActive: true, version: 1, ...overrides,
});
const customerPayload = (contacts: unknown[], overrides: Record<string, unknown> = {}) => ({
  id: 'c1', organizationId: 'org-1', name: 'Klinik', customerType: 'clinic', taxNumber: null,
  phone: '+905321112233', email: null, city: null, district: null, address: null,
  assignedStaffUserId: null, status: 'active', version: 7, assignedStaffName: null,
  primaryContact: null, contacts, hasOperationHistory: false, openJobCount: 0, completedJobCount: 0,
  ...overrides,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

type Handler = {
  match: (url: string, init?: RequestInit) => boolean;
  reply: (init?: RequestInit) => Response;
};
function fetchRouter(handlers: Handler[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const handler of handlers) {
      if (handler.match(url, init)) return handler.reply(init);
    }
    throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
  });
}
const getCustomerHandler = (payload: unknown): Handler => ({
  match: (url) => url === '/api/customers/c1',
  reply: () => json(payload),
});

function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
async function settle() { await act(async () => { await Promise.resolve(); }); }
async function settleTwice() { await settle(); await settle(); }

function renderSection(root: Root, options: {
  details?: MeetingDetails;
  onSave?: (input: PatchMeetingDetailsInput) => Promise<MeetingDetails>;
} = {}) {
  return act(async () => root.render(<MeetingDetailsSection job={job} details={options.details ?? details}
    user={user} mutationPending={false} onSave={options.onSave ?? vi.fn()} />));
}

function optionLabels(container: HTMLDivElement) {
  return Array.from(container.querySelectorAll('#meeting-met-contact option'))
    .map((option) => ({ label: option.textContent, value: option.getAttribute('value'), disabled: option.hasAttribute('disabled') }));
}

describe('MeetingDetailsSection görüşülen kişi', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    uuidSeq = 0;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: vi.fn(() => `save-${++uuidSeq}`) });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('lists only active contacts and saves the selected reference in the patch body', async () => {
    vi.stubGlobal('fetch', fetchRouter([getCustomerHandler(customerPayload([
      contactPayload({ id: 'ct-1', name: 'Dr. Deniz' }),
      contactPayload({ id: 'ct-2', name: 'Sekreter Ece', title: null, isPrimary: false }),
      contactPayload({ id: 'ct-3', name: 'Eski kişi', isActive: false, isPrimary: false }),
    ]))]));
    const onSave = vi.fn(async (input: PatchMeetingDetailsInput) => ({ ...details, ...input, jobCardVersion: 4 }));
    await renderSection(root, { onSave });
    await settleTwice();
    expect(optionLabels(container)).toEqual([
      { label: 'Kişi seçilmedi', value: '', disabled: false },
      { label: 'Dr. Deniz — Başhekim', value: 'ct-1', disabled: false },
      { label: 'Sekreter Ece', value: 'ct-2', disabled: false },
    ]);
    change(container.querySelector('#meeting-met-contact')!, 'ct-2');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      clientActionId: 'save-1', expectedVersion: 3, metContactId: 'ct-2',
    }));
  });

  it('keeps a persisted inactive selection visible as a disabled historical option', async () => {
    vi.stubGlobal('fetch', fetchRouter([getCustomerHandler(customerPayload([
      contactPayload({ id: 'ct-1', name: 'Dr. Deniz' }),
    ]))]));
    const persisted = {
      ...details, metContactId: 'ct-9',
      metContact: { id: 'ct-9', name: 'Eski kişi', title: 'Uzm.' },
    };
    await renderSection(root, { details: persisted });
    await settleTwice();
    const options = optionLabels(container);
    expect(options).toContainEqual({ label: 'Eski kişi — Uzm. (pasif)', value: 'ct-9', disabled: true });
    expect((container.querySelector('#meeting-met-contact') as HTMLSelectElement).value).toBe('ct-9');
  });

  it('shows a retry affordance when the contact list fails to load', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
      return json(customerPayload([contactPayload({ id: 'ct-1', name: 'Dr. Deniz' })]));
    }));
    await renderSection(root);
    await settleTwice();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('İlgili kişiler yüklenemedi.');
    await act(async () => {
      (Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Tekrar dene') as HTMLButtonElement).click();
    });
    await settleTwice();
    expect(optionLabels(container)).toEqual([
      { label: 'Kişi seçilmedi', value: '', disabled: false },
      { label: 'Dr. Deniz — Başhekim', value: 'ct-1', disabled: false },
    ]);
  });

  it('creates a scoped contact inline, selects it and preserves the meeting draft', async () => {
    const created = contactPayload({ id: 'ct-9', name: 'Yeni Doktor', title: 'Ortodontist', isPrimary: false });
    const createdCustomer = customerPayload([], { version: 8 });
    vi.stubGlobal('fetch', fetchRouter([
      getCustomerHandler(customerPayload([contactPayload({ id: 'ct-1', name: 'Dr. Deniz' })])),
      {
        match: (url, init) => url === '/api/customers/c1/enrichment/contacts' && init?.method === 'POST',
        reply: (init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body).toEqual({ expectedVersion: 7, name: 'Yeni Doktor', title: 'Ortodontist', phone: null, email: null });
          return json({ customer: createdCustomer, contact: created }, 201);
        },
      },
    ]));
    await renderSection(root);
    await settleTwice();
    change(container.querySelector('#meeting-summary')!, 'Taslak özet korunmalı');
    await act(async () => {
      (Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Yeni ilgili kişi ekle') as HTMLButtonElement).click();
    });
    change(container.querySelector('#meeting-new-contact-name')!, 'Yeni Doktor');
    change(container.querySelector('#meeting-new-contact-title')!, 'Ortodontist');
    await act(async () => {
      (Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'İlgili kişiyi ekle') as HTMLButtonElement).click();
    });
    await settleTwice();
    expect((container.querySelector('#meeting-met-contact') as HTMLSelectElement).value).toBe('ct-9');
    expect(optionLabels(container)).toContainEqual({ label: 'Yeni Doktor — Ortodontist', value: 'ct-9', disabled: false });
    // The open meeting draft survives the inline creation round-trip.
    expect((container.querySelector('#meeting-summary') as HTMLTextAreaElement).value).toBe('Taslak özet korunmalı');
    expect(container.querySelector('#meeting-new-contact-name')).toBeNull();
  });

  it('fails closed on a forbidden inline creation and keeps the draft', async () => {
    vi.stubGlobal('fetch', fetchRouter([
      getCustomerHandler(customerPayload([contactPayload({ id: 'ct-1', name: 'Dr. Deniz' })])),
      {
        match: (url, init) => url === '/api/customers/c1/enrichment/contacts' && init?.method === 'POST',
        reply: () => json({ error: 'Bu işlem için yetkiniz yok.', code: 'FORBIDDEN' }, 403),
      },
    ]));
    await renderSection(root);
    await settleTwice();
    change(container.querySelector('#meeting-summary')!, 'Taslak');
    await act(async () => {
      (Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Yeni ilgili kişi ekle') as HTMLButtonElement).click();
    });
    change(container.querySelector('#meeting-new-contact-name')!, 'Yeni Doktor');
    await act(async () => {
      (Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'İlgili kişiyi ekle') as HTMLButtonElement).click();
    });
    await settleTwice();
    expect(container.querySelector('.meeting-contact-create [role="alert"]')?.textContent)
      .toBe('Bu işlem için yetkiniz bulunmuyor.');
    expect((container.querySelector('#meeting-met-contact') as HTMLSelectElement).value).toBe('');
    expect((container.querySelector('#meeting-summary') as HTMLTextAreaElement).value).toBe('Taslak');
  });
});