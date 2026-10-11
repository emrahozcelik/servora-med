/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomerCompletenessAction } from '../src/jobs/CustomerCompletenessAction';
import type { JobCard } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const user: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@x', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
};
const waitingJob = {
  id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'WAITING_APPROVAL', version: 5,
  title: 'Görüşme', description: null, customerId: 'c1', contactId: null, assignedTo: 'staff-1',
  createdBy: 'staff-1', priority: 'normal', dueDate: null,
  assignee: { id: 'staff-1', name: 'Ayşe' }, customer: { id: 'c1', name: 'Klinik' },
  contact: null, workflowContext,
} satisfies JobCard;

const contactPayload = (overrides: Record<string, unknown>) => ({
  id: 'ct-1', organizationId: 'org-1', customerId: 'c1', name: 'Dr. Deniz',
  title: 'Başhekim', phone: '0532 111 22 33', email: null,
  isPrimary: true, isActive: true, version: 1, ...overrides,
});
const customerPayload = (contacts: unknown[], overrides: Record<string, unknown> = {}) => ({
  id: 'c1', organizationId: 'org-1', name: 'Klinik', customerType: 'clinic', taxNumber: null,
  phone: null, email: null, city: null, district: null, address: null,
  assignedStaffUserId: null, status: 'active', version: 7, assignedStaffName: null,
  primaryContact: null, contacts, hasOperationHistory: true, openJobCount: 1, completedJobCount: 0,
  ...overrides,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

type Handler = { match: (url: string, init?: RequestInit) => boolean; reply: (init?: RequestInit) => Response };
function fetchRouter(handlers: Handler[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const handler of handlers) {
      if (handler.match(url, init)) return handler.reply(init);
    }
    throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
  });
}

function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
async function settle() { await act(async () => { await Promise.resolve(); }); }
async function settleTwice() { await settle(); await settle(); }
function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent === text)!;
}

describe('CustomerCompletenessAction', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  function render(job: JobCard = waitingJob) {
    return act(async () => root.render(<CustomerCompletenessAction job={job} user={user} />));
  }

  async function postThenFailedRefresh(action: 'enrichment' | 'contact', canEnrich = true) {
    let completenessCalls = 0;
    const posts: Record<string, unknown>[] = [];
    const fetchMock = fetchRouter([
      { match: (url, init) => url === '/api/customers/c1/enrichment' && init?.method !== 'POST',
        reply: () => json({ canEnrich, canCreateContact: true }) },
      { match: (url) => url === '/api/customers/c1/completeness', reply: () => {
        completenessCalls += 1;
        return completenessCalls === 2 ? json({ error: 'Refresh unavailable' }, 500)
          : json({ missingInfo: completenessCalls === 1 ? ['CUSTOMER_PHONE_MISSING', 'ACTIVE_CONTACT_MISSING'] : [] });
      } },
      { match: (url) => url === '/api/customers/c1', reply: () => json(customerPayload([])) },
      { match: (_url, init) => init?.method === 'POST', reply: (init) => {
        posts.push(JSON.parse(String(init?.body)));
        const customer = customerPayload([], { version: 8, phone: '0532 111 22 33' });
        return action === 'enrichment' ? json(customer)
          : json({ customer, contact: contactPayload({ isPrimary: false }) }, 201);
      } },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    await render();
    await settleTwice();
    await act(async () => buttonByText(container, 'Müşteri bilgilerini tamamla').click());
    await settleTwice();
    if (action === 'enrichment') {
      change(container.querySelector('#enrichment-phone')!, '0532 111 22 33');
      change(container.querySelector('#job-completeness-contact-name')!, 'Kaydedilmemiş kişi taslağı');
      await act(async () => { (container.querySelector('.record-form') as HTMLFormElement).requestSubmit(); });
    } else {
      change(container.querySelector('#job-completeness-contact-name')!, 'Dr. Deniz');
      await act(async () => buttonByText(container, 'İlgili kişiyi ekle').click());
    }
    await settleTwice();
    return { fetchMock, posts };
  }

  it('keeps a close control and success notice after a committed enrichment and failed refresh', async () => {
    const { posts } = await postThenFailedRefresh('enrichment');
    expect(container.textContent).toContain('İletişim bilgileri kaydedildi.');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Müşteri bilgileri durumu alınamadı.');
    expect(buttonByText(container, 'Tekrar dene')).toBeDefined();
    const close = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent === 'Kapat' || button.textContent === 'Vazgeç');
    expect(close).toBeDefined();
    await act(async () => close!.click());
    expect(container.querySelector('.record-form')).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it('retries only scope/completeness GETs, preserves the contact draft and committed customer version', async () => {
    const { fetchMock, posts } = await postThenFailedRefresh('enrichment');
    const draft = container.querySelector<HTMLInputElement>('#job-completeness-contact-name');
    expect(draft?.value).toBe('Kaydedilmemiş kişi taslağı');
    expect(buttonByText(container, 'İletişim bilgilerini kaydet').disabled).toBe(true);
    expect(buttonByText(container, 'İlgili kişiyi ekle').disabled).toBe(true);
    // Programmatic submission and Enter must also fail closed on unknown scope.
    await act(async () => {
      (container.querySelector('.record-form') as HTMLFormElement).requestSubmit();
      container.querySelector('#job-completeness-contact-name')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(posts).toHaveLength(1);
    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => buttonByText(container, 'Tekrar dene').click());
    await settleTwice();
    expect(fetchMock.mock.calls.slice(callsBefore).map(([url, init]) => [String(url), init?.method ?? 'GET']))
      .toEqual([['/api/customers/c1/enrichment', 'GET'], ['/api/customers/c1/completeness', 'GET']]);
    expect(posts).toHaveLength(1);
    expect(container.querySelector('#job-completeness-contact-name')).toBe(draft);
    expect(draft!.value).toBe('Kaydedilmemiş kişi taslağı');
    expect(container.textContent).not.toContain('Müşterinin telefon numarası eksik.');
    expect(container.textContent).toContain('İletişim bilgileri kaydedildi.');
    // A deliberate new save uses the committed version; retry itself never posts.
    change(container.querySelector('#enrichment-city')!, 'Ankara');
    await act(async () => { (container.querySelector('.record-form') as HTMLFormElement).requestSubmit(); });
    await settleTwice();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ expectedVersion: 8, city: 'Ankara' });
  });

  it('recovers from a refresh failure after contact creation without creating a second contact', async () => {
    const { posts } = await postThenFailedRefresh('contact');
    expect(container.textContent).toContain('İlgili kişi eklendi.');
    expect(container.textContent).toContain('Müşteri bilgileri durumu alınamadı.');
    await act(async () => buttonByText(container, 'Tekrar dene').click());
    await settleTwice();
    expect(posts).toHaveLength(1);
    expect(container.textContent).not.toContain('Müşterinin aktif ilgili kişisi yok.');
    await act(async () => buttonByText(container, 'Vazgeç').click());
    expect(container.querySelector('.record-form')).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it('keeps contact-only editor errors closable without a duplicate close button', async () => {
    const { posts } = await postThenFailedRefresh('contact', false);
    expect(container.querySelector('.record-form')).toBeNull();
    expect(Array.from(container.querySelectorAll('button')).filter((button) => button.textContent === 'Kapat')).toHaveLength(1);
    await act(async () => buttonByText(container, 'Kapat').click());
    expect(container.querySelector('[aria-label="Yeni ilgili kişi ekle"]')).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it('preserves draft nodes, disables mutations and permits closing during a pending GET retry', async () => {
    const { fetchMock, posts } = await postThenFailedRefresh('enrichment');
    const form = container.querySelector<HTMLFormElement>('.record-form')!;
    const draft = container.querySelector<HTMLInputElement>('#job-completeness-contact-name')!;
    let finishRefresh!: (response: Response) => void;
    const deferred = new Promise<Response>((resolve) => { finishRefresh = resolve; });
    fetchMock.mockImplementation(async (input) => String(input).endsWith('/completeness')
      ? deferred : json({ canEnrich: true, canCreateContact: true }));
    await act(async () => buttonByText(container, 'Tekrar dene').click());
    expect(container.textContent).toContain('Müşteri bilgileri kontrol ediliyor…');
    expect(container.querySelector('.record-form')).toBe(form);
    expect(container.querySelector('#job-completeness-contact-name')).toBe(draft);
    expect(draft.value).toBe('Kaydedilmemiş kişi taslağı');
    expect(buttonByText(container, 'İletişim bilgilerini kaydet').disabled).toBe(true);
    await act(async () => form.requestSubmit());
    expect(posts).toHaveLength(1);
    await act(async () => buttonByText(container, 'Vazgeç').click());
    expect(container.querySelector('.record-form')).toBeNull();
    await act(async () => finishRefresh(json({ missingInfo: [] })));
    await settleTwice();
    expect(container.textContent).toBe('');
    expect(posts).toHaveLength(1);
  });

  it('fails closed when GET retry confirms revocation and preserves the committed success notice', async () => {
    const { fetchMock, posts } = await postThenFailedRefresh('enrichment');
    fetchMock.mockImplementation(async (input) => String(input).endsWith('/completeness')
      ? json({ missingInfo: ['CUSTOMER_PHONE_MISSING'] })
      : json({ canEnrich: false, canCreateContact: false }));
    await act(async () => buttonByText(container, 'Tekrar dene').click());
    await settleTwice();
    expect(container.textContent).toContain('İletişim bilgileri kaydedildi.');
    expect(container.textContent).toContain('Bu işlem için yetkiniz bulunmuyor.');
    expect(container.querySelector('.record-form')).toBeNull();
    expect(container.querySelector('[aria-label="Yeni ilgili kişi ekle"]')).toBeNull();
    expect(Array.from(container.querySelectorAll('button')).filter((button) => button.textContent === 'Kapat')).toHaveLength(1);
    await act(async () => buttonByText(container, 'Kapat').click());
    expect(posts).toHaveLength(1);
  });

  it('allows closing while the initial customer GET is still loading', async () => {
    let finishCustomer!: (response: Response) => void;
    const customerResponse = new Promise<Response>((resolve) => { finishCustomer = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/customers/c1') return customerResponse;
      if (url.endsWith('/completeness')) return json({ missingInfo: ['CUSTOMER_PHONE_MISSING'] });
      return json({ canEnrich: true, canCreateContact: false });
    });
    vi.stubGlobal('fetch', fetchMock);
    await render();
    await settleTwice();
    await act(async () => buttonByText(container, 'Müşteri bilgilerini tamamla').click());
    expect(container.textContent).toContain('Müşteri bilgileri yükleniyor…');
    await act(async () => buttonByText(container, 'Kapat').click());
    await act(async () => finishCustomer(json(customerPayload([]))));
    await settleTwice();
    expect(container.querySelector('.record-form')).toBeNull();
    expect(buttonByText(container, 'Müşteri bilgilerini tamamla')).toBeDefined();
    expect(fetchMock.mock.calls).toHaveLength(3);
  });

  it('renders nothing for non-applicable states without fetching', async () => {
    const fetchMock = fetchRouter([]);
    vi.stubGlobal('fetch', fetchMock);
    await render({ ...waitingJob, status: 'COMPLETED' });
    await settleTwice();
    expect(container.textContent).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => root.render(<CustomerCompletenessAction job={waitingJob}
      user={{ ...user, role: 'MANAGER' }} />));
    await settleTwice();
    expect(container.textContent).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hides when the capability is revoked or nothing is actionable', async () => {
    vi.stubGlobal('fetch', fetchRouter([
      { match: (url) => url === '/api/customers/c1/enrichment', reply: () => json({ canEnrich: false, canCreateContact: false }) },
      { match: (url) => url === '/api/customers/c1/completeness', reply: () => json({ missingInfo: ['CUSTOMER_PHONE_MISSING'] }) },
    ]));
    await render();
    await settleTwice();
    expect(container.textContent).toBe('');

    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', fetchRouter([
      { match: (url, init) => url === '/api/customers/c1/enrichment' && init?.method !== 'POST', reply: () => json({ canEnrich: true, canCreateContact: true }) },
      { match: (url) => url === '/api/customers/c1/completeness', reply: () => json({ missingInfo: [] }) },
    ]));
    await act(async () => root.render(<CustomerCompletenessAction job={{ ...waitingJob, version: 6 }} user={user} />));
    await settleTwice();
    expect(container.textContent).toBe('');
  });

  it('shows guidance, opens the editor, saves enrichment and refreshes the guidance without closing', async () => {
    let completenessCalls = 0;
    let submittedBody: Record<string, unknown> | null = null;
    const updated = { ...customerPayload([]), version: 8, phone: '0532 111 22 33' };
    const fetchMock = fetchRouter([
      { match: (url, init) => url === '/api/customers/c1/enrichment' && init?.method !== 'POST', reply: () => json({ canEnrich: true, canCreateContact: true }) },
      {
        match: (url) => url === '/api/customers/c1/completeness',
        reply: () => {
          completenessCalls += 1;
          return json(completenessCalls === 1
            ? { missingInfo: ['CUSTOMER_PHONE_MISSING', 'ACTIVE_CONTACT_MISSING'] }
            : { missingInfo: [] });
        },
      },
      { match: (url, init) => url === '/api/customers/c1' && init?.method !== 'POST', reply: () => json(customerPayload([])) },
      {
        match: (url, init) => url === '/api/customers/c1/enrichment' && init?.method === 'POST',
        reply: (init) => {
          submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json(updated);
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    await render();
    await settleTwice();
    expect(container.textContent).toContain('Müşterinin telefon numarası eksik.');
    expect(container.textContent).toContain('Müşterinin aktif ilgili kişisi yok.');

    await act(async () => buttonByText(container, 'Müşteri bilgilerini tamamla').click());
    await settleTwice();
    expect(container.querySelector('#enrichment-phone')).not.toBeNull();
    change(container.querySelector('#enrichment-phone')!, '0532 111 22 33');
    await act(async () => {
      (container.querySelector('.record-form') as HTMLFormElement).requestSubmit();
    });
    await settleTwice();
    expect(container.textContent).toContain('İletişim bilgileri kaydedildi.');
    expect(submittedBody).toMatchObject({ expectedVersion: 7, email: null, city: null, district: null, address: null });
    expect(String(submittedBody!.phone)).toContain('532');
    // Guidance refreshed; the editor stays open until the user closes it.
    expect(container.textContent).not.toContain('Müşterinin telefon numarası eksik.');
    expect(container.querySelector('#enrichment-phone')).not.toBeNull();
    expect(completenessCalls).toBe(2);
  });

  it('fails closed on a revoked enrichment save and never breaks the host page', async () => {
    vi.stubGlobal('fetch', fetchRouter([
      { match: (url, init) => url === '/api/customers/c1/enrichment' && init?.method !== 'POST', reply: () => json({ canEnrich: true, canCreateContact: true }) },
      { match: (url) => url === '/api/customers/c1/completeness', reply: () => json({ missingInfo: ['CUSTOMER_PHONE_MISSING'] }) },
      { match: (url, init) => url === '/api/customers/c1' && init?.method !== 'POST', reply: () => json(customerPayload([])) },
      {
        match: (url, init) => url === '/api/customers/c1/enrichment' && init?.method === 'POST',
        reply: () => json({ error: 'Bu işlem için yetkiniz yok.', code: 'FORBIDDEN' }, 403),
      },
    ]));
    await render();
    await settleTwice();
    await act(async () => buttonByText(container, 'Müşteri bilgilerini tamamla').click());
    await settleTwice();
    change(container.querySelector('#enrichment-phone')!, '0532 111 22 33');
    await act(async () => { (container.querySelector('.record-form') as HTMLFormElement).requestSubmit(); });
    await settleTwice();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Bu işlem için yetkiniz bulunmuyor.');
    await act(async () => buttonByText(container, 'Kapat').click());
    await settleTwice();
    expect(container.textContent).toBe('');
  });

  it('offers retry when the initial status fetch fails', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/customers/c1/completeness') {
        attempts += 1;
        if (attempts === 1) return json({ error: 'Boom' }, 500);
        return json({ missingInfo: ['CUSTOMER_PHONE_MISSING'] });
      }
      if (url === '/api/customers/c1/enrichment') return json({ canEnrich: true, canCreateContact: false });
      throw new Error(`unexpected ${url}`);
    }));
    await render();
    await settleTwice();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Müşteri bilgileri durumu alınamadı.');
    await act(async () => buttonByText(container, 'Tekrar dene').click());
    await settleTwice();
    expect(container.textContent).toContain('Müşterinin telefon numarası eksik.');
  });

  it('creates a scoped contact when the customer has no active contact', async () => {
    const created = contactPayload({ id: 'ct-9', name: 'Yeni Kişi', isPrimary: false });
    const createdCustomer = customerPayload([], { version: 8 });
    vi.stubGlobal('fetch', fetchRouter([
      { match: (url, init) => url === '/api/customers/c1/enrichment' && init?.method !== 'POST', reply: () => json({ canEnrich: true, canCreateContact: true }) },
      { match: (url) => url === '/api/customers/c1/completeness', reply: () => json({ missingInfo: ['ACTIVE_CONTACT_MISSING'] }) },
      { match: (url, init) => url === '/api/customers/c1' && init?.method !== 'POST', reply: () => json(customerPayload([])) },
      {
        match: (url, init) => url === '/api/customers/c1/enrichment/contacts' && init?.method === 'POST',
        reply: (init) => {
          expect(JSON.parse(String(init?.body))).toEqual({
            expectedVersion: 7, name: 'Yeni Kişi', title: null, phone: null, email: null,
          });
          return json({ customer: createdCustomer, contact: created }, 201);
        },
      },
    ]));
    await render();
    await settleTwice();
    await act(async () => buttonByText(container, 'Müşteri bilgilerini tamamla').click());
    await settleTwice();
    change(container.querySelector('#job-completeness-contact-name')!, 'Yeni Kişi');
    await act(async () => buttonByText(container, 'İlgili kişiyi ekle').click());
    await settleTwice();
    expect(container.textContent).toContain('İlgili kişi eklendi.');
  });

  it('lists active contacts that lack a usable phone without offering contact editing', async () => {
    vi.stubGlobal('fetch', fetchRouter([
      { match: (url) => url === '/api/customers/c1/enrichment', reply: () => json({ canEnrich: true, canCreateContact: false }) },
      { match: (url) => url === '/api/customers/c1/completeness', reply: () => json({ missingInfo: ['CONTACT_PHONE_MISSING'] }) },
      {
        match: (url, init) => url === '/api/customers/c1' && init?.method !== 'POST',
        reply: () => json(customerPayload([
          contactPayload({ id: 'ct-1', name: 'Dr. Deniz', phone: null }),
          contactPayload({ id: 'ct-2', name: 'Sekreter Ece', phone: '0212 444 55 66', isPrimary: false }),
          contactPayload({ id: 'ct-3', name: 'Eski kişi', phone: null, isActive: false, isPrimary: false }),
        ])),
      },
    ]));
    await render();
    await settleTwice();
    await act(async () => buttonByText(container, 'Müşteri bilgilerini tamamla').click());
    await settleTwice();
    const list = container.querySelector('.job-completeness-contacts');
    expect(list?.textContent).toContain('Dr. Deniz — Başhekim');
    expect(list?.textContent).not.toContain('Sekreter Ece');
    expect(list?.textContent).not.toContain('Eski kişi');
    expect(container.querySelector('#job-completeness-contact-name')).toBeNull();
  });
});
