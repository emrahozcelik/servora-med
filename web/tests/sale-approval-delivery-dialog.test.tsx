/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import type { CurrentUser } from '../src/services/api';
import type {
  JobCard, JobCardStatus, JobLifecycleFacts, JobWorkflowContext, LifecycleCommand,
} from '../src/jobs/jobs-api';
import type { SaleDetails } from '../src/jobs/sale-api';
import { defaultDeliveryScheduledLocal } from '../src/jobs/sale-approval-delivery';
import { parseSaleDetails } from '../src/jobs/sale-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Mehmet Yönetici', email: 'm@x',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};

const lifecycle: JobLifecycleFacts = {
  createdAt: '2026-11-20T08:00:00.000Z', acceptedAt: null, acceptedBy: null,
  startedAt: '2026-11-23T09:05:00.000Z', submittedAt: '2026-11-23T12:00:00.000Z',
  submittedBy: { id: 'staff-1', name: 'Ayşe Personel' }, submissionNote: null,
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
  cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
};

function context(commands: LifecycleCommand[]): JobWorkflowContext {
  return {
    allowedCommands: commands,
    allowedActions: ['VIEW_NOTES', 'ADD_NOTE'],
    startLocationCaptureEnabled: false,
    submitLocationCaptureEnabled: false,
    lifecycle,
    submissionReadiness: null,
  };
}

const baseCard = {
  organizationId: 'org-1', engagementKind: null, description: null, customerId: 'c1',
  contactId: null, createdBy: manager.id, priority: 'normal' as const, dueDate: null,
  scheduledAt: null, scheduledEndsAt: null,
  assignee: { id: 'staff-1', name: 'Ayşe Personel' }, assignedTo: 'staff-1',
  customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
  followUpContext: null, followUpProposal: null,
  earlyStartAuthorization: null, submitLocationComparison: null,
  changeRequest: null, assignmentOffer: null,
  hasOpenOverdueIncident: false, correctionDueAt: null,
};

function visitCard(status: JobCardStatus = 'WAITING_APPROVAL', extra: Partial<JobCard> = {}): JobCard {
  return {
    ...baseCard, id: 'visit-1', type: 'SALES_MEETING', engagementKind: 'SALES_MEETING',
    status, version: 4, title: 'ABC Klinik ziyareti',
    scheduledAt: '2026-11-23T09:00:00.000Z',
    workflowContext: context(['APPROVE', 'REQUEST_REVISION', 'CANCEL']),
    ...extra,
  };
}

function saleCard(status: JobCardStatus = 'WAITING_APPROVAL', extra: Partial<JobCard> = {}): JobCard {
  return {
    ...baseCard, id: 'sale-1', type: 'SALE', status, version: 7, title: 'Kasım anlaşması',
    workflowContext: context([]),
    ...extra,
  };
}

const twoItems: SaleDetails['items'] = [
  {
    id: 'line-1', productId: 'product-1', name: 'Dental implant seti', sku: 'IMP-01',
    brand: 'Servora', model: 'S1', unit: 'set', quantity: '3',
  },
  {
    id: 'line-2', productId: 'product-2', name: 'Cerrahi frez', sku: 'FRZ-02',
    brand: null, model: null, unit: 'adet', quantity: '10',
  },
];

function staffProfile(id: string, name: string) {
  return {
    id: `profile-${id}`,
    user: {
      id, organizationId: 'org-1', name, email: `${id}@example.test`, role: 'STAFF',
      mustChangePassword: false, isActive: true, version: 1, lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    title: null, phone: null, region: null, managerUserId: null, managerName: null,
    version: 1, counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
  };
}

const activeStaff = [staffProfile('staff-1', 'Ayşe Personel'), staffProfile('staff-2', 'Burak Personel')];

function productRow(id: string, name: string) {
  return {
    id, organizationId: 'org-1', name, sku: `SKU-${id}`, brand: null, category: null, model: null,
    unit: 'adet', referencePrice: null, isActive: true, version: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

type Scenario = {
  main: JobCard;
  visit?: JobCard;
  sale: JobCard;
  items?: SaleDetails['items'];
  standalone?: boolean;
  staff?: unknown[];
  saleExtra?: Record<string, unknown>;
  respond?: (path: string, body: Record<string, unknown>, index: number) => Response | Promise<Response> | null;
};

const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };

function mockFetch(s: Scenario) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const urls: string[] = [];
  const visit = s.visit ?? s.main;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://test.invalid');
    const path = url.pathname;
    urls.push(path + url.search);
    const method = init?.method ?? 'GET';
    if (method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      posts.push({ path, body });
      const handled = await s.respond?.(path, body, posts.filter((post) => post.path === path).length - 1);
      if (handled) return handled;
      throw new Error(`Unexpected POST ${path}`);
    }
    if (path.endsWith('/sale-create-context')) {
      return Response.json({
        sourceVisitId: visit.id, sourceVersion: visit.version, eligible: false,
        blockedReason: 'ACTIVE_SALE_EXISTS', customer: { id: 'c1', name: 'ABC Klinik' },
        assignee: { id: 'staff-1', name: 'Ayşe Personel' }, plannedContact: null, metContact: null,
        activeSale: { access: 'FULL', id: s.sale.id, title: s.sale.title, status: s.sale.status },
      });
    }
    if (path.endsWith('/sale-details')) {
      return Response.json({
        jobCardId: s.sale.id, jobCardVersion: s.sale.version, soldAt: '2026-11-20T09:30:00.000Z',
        saleContact: null,
        sourceVisit: s.standalone
          ? { kind: 'STANDALONE' }
          : {
              access: 'FULL', kind: 'SALE_FROM_VISIT', id: visit.id, title: visit.title,
              status: visit.status, versionAtCreation: 2, titleSnapshot: visit.title,
              customerNameSnapshot: 'ABC Klinik', plannedContact: null, metContact: null,
            },
        items: s.items ?? twoItems,
        ...s.saleExtra,
      });
    }
    if (path.endsWith('/sales')) return Response.json({ ...emptyPage, limit: 20, offset: 0 });
    if (path.endsWith('/activity')) return Response.json({ ...emptyPage, limit: 50 });
    if (path === '/api/notifications/read-by-entity') return Response.json({ updated: 0 });
    if (path.endsWith('/notes')) return Response.json({ ...emptyPage, nextCursor: null });
    if (path.endsWith('/overdue-incidents')) return Response.json(emptyPage);
    if (path.endsWith('/follow-ups')) return Response.json({ ...emptyPage, limit: 100 });
    if (path.endsWith('/delivery-items')) return Response.json({ items: [] });
    if (path === '/api/calendar/assignees') return Response.json({ items: [] });
    if (path === '/api/staff') return Response.json(s.staff ?? activeStaff);
    if (path === '/api/products') {
      return Response.json({
        items: [productRow('product-9', 'Sterilizasyon poşeti')], total: 1, limit: 25, offset: 0,
      });
    }
    if (path === `/api/job-cards/${s.sale.id}`) return Response.json(s.sale);
    if (path === `/api/job-cards/${visit.id}`) return Response.json(visit);
    if (path === `/api/job-cards/${s.main.id}`) return Response.json(s.main);
    throw new Error(`Unexpected GET ${path}`);
  });
  return { fetch, posts, urls };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonByName(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

function setNative(element: HTMLElement, prototype: object, value: string) {
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
}

async function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    setNative(element, element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    setNative(element, HTMLSelectElement.prototype, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('SALE-002 S3 approval delivery section', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width'), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(s: Scenario) {
    const mock = mockFetch(s);
    vi.stubGlobal('fetch', mock.fetch);
    await act(async () => {
      root.render(<JobDetailScreen jobId={s.main.id} user={manager} onChanged={() => {}} />);
      await flush(); await flush(); await flush();
    });
    return mock;
  }

  const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')!;
  // The confirm label depends on the delivery switch; the submit button does not.
  const submitButton = () => dialog().querySelector<HTMLButtonElement>('button[type="submit"]');
  const section = () => dialog().querySelector<HTMLElement>('[data-sale-delivery]')!;
  const checkbox = () => section().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const quantity = (productId: string) => section()
    .querySelector<HTMLInputElement>(`input[id$="-qty-${productId}"]`)!;
  const assignee = () => section().querySelector<HTMLSelectElement>('select[id$="-assignee"]')!;
  const scheduled = () => section().querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
  const purpose = () => section().querySelector<HTMLSelectElement>('select[id$="-purpose"]')!;

  async function openVisitApproval(s: Scenario) {
    const mock = await render(s);
    await act(async () => {
      buttonByName(host, 'Kontrolü tamamla ve işi kapat')!.click();
      await flush(); await flush();
    });
    return mock;
  }

  async function confirm() {
    await act(async () => {
      submitButton()!.click();
      await flush(); await flush();
    });
  }

  const pairScenario = (extra: Partial<Scenario> = {}): Scenario => ({
    main: visitCard(), sale: saleCard(), ...extra,
  });

  function resizeTo(width: number) {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
  }

  it('renders and commits the compact wheel trigger for the delivery time', async () => {
    resizeTo(390);
    await openVisitApproval(pairScenario());
    const trigger = section().querySelector<HTMLButtonElement>('.wheel-field-trigger')!;
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.hasAttribute('name')).toBe(false);
    const before = trigger.textContent;
    await act(async () => trigger.click());
    const hour = document.querySelector<HTMLElement>('[role="spinbutton"][aria-label="Saat"]')!;
    await act(async () => {
      hour.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    const ok = [...document.querySelectorAll<HTMLButtonElement>('.wheel-sheet-actions button')]
      .find((button) => button.textContent === 'Tamam')!;
    await act(async () => ok.click());
    expect(trigger.textContent).not.toBe(before);
    resizeTo(1024);
  });
  const independentScenario = (extra: Partial<Scenario> = {}): Scenario => ({
    main: saleCard('WAITING_APPROVAL', { workflowContext: context(['APPROVE', 'REQUEST_REVISION', 'CANCEL']) }),
    sale: saleCard('WAITING_APPROVAL', { workflowContext: context(['APPROVE', 'REQUEST_REVISION', 'CANCEL']) }),
    visit: visitCard('COMPLETED', { workflowContext: context([]) }),
    ...extra,
  });

  const approvedVisit = () => ({
    ...visitCard('COMPLETED', { version: 5, workflowContext: context([]) }),
    linkedSaleJobCardId: 'sale-1', deliveryJobCardId: 'delivery-9', followUpJobCardId: null,
  });

  it('mounts the section in the visit approve dialog: default on, prefilled, helper once', async () => {
    await openVisitApproval(pairScenario());

    const root = section();
    expect(root.querySelector('fieldset > legend')).not.toBeNull();
    expect(checkbox().type).toBe('checkbox');
    expect(checkbox().checked).toBe(true);
    const label = root.querySelector<HTMLLabelElement>(`label[for="${checkbox().id}"]`);
    expect(label?.textContent).toBe('Teslim işi aç');

    expect(quantity('product-1').value).toBe('3');
    expect(quantity('product-2').value).toBe('10');
    for (const input of [quantity('product-1'), quantity('product-2')]) {
      expect(input.min).toBe('1');
      expect(input.max).toBe('999999999');
      expect(input.step).toBe('1');
      expect(input.inputMode).toBe('numeric');
    }
    expect(root.textContent).toContain('Dental implant seti');

    expect(assignee().value).toBe('staff-1');
    expect(Array.from(assignee().options).map((option) => option.value))
      .toEqual(['', 'staff-1', 'staff-2']);
    expect(purpose().value).toBe('SALE');
    expect(root.textContent).toContain('Cihazınızın yerel saat dilimi');

    const helper = 'Onayla birlikte planlanmış bir ürün teslimi oluşturulur; teslim personeli '
      + 'kabul edip gerçekleşen zamanı girdikten sonra onaya gönderir.';
    expect(dialog().textContent!.split(helper).length - 1).toBe(1);
    expect(root.textContent).not.toContain('tek sonraki iş');
    // The existing pair summary stays: the approval completes the sale too.
    expect(dialog().textContent).toContain('Bu onay bağlı satış kaydını da tamamlar');
  });

  it('defaults the planned time to tomorrow at the next half hour, device-local', async () => {
    const before = Date.now();
    await openVisitApproval(pairScenario());
    const value = scheduled().value;
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:(00|30)$/);
    const expected = defaultDeliveryScheduledLocal(new Date(before));
    // Allow the clock to cross one half-hour boundary while the test ran.
    const ms = (local: string) => new Date(local).getTime();
    expect(ms(value) - ms(expected)).toBeGreaterThanOrEqual(0);
    expect(ms(value) - ms(expected)).toBeLessThanOrEqual(30 * 60 * 1000);
    expect(ms(value) - before).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it('renders the follow-up proposal first and the delivery section second', async () => {
    const proposal = {
      scheduledAt: '2026-12-01T09:00:00.000Z', type: 'SALES_MEETING' as const,
      assignedTo: 'staff-1', followUpInstructions: 'Ürünleri yerinde kontrol edin.',
      origin: 'SYSTEM' as const, proposedBy: { id: 'staff-1', name: 'Ayşe Personel' },
    };
    await openVisitApproval(pairScenario({ main: visitCard('WAITING_APPROVAL', { followUpProposal: proposal }) }));

    const followUp = dialog().querySelector('[aria-label="Takip işi planı"]');
    expect(followUp).not.toBeNull();
    expect(section()).not.toBeNull();
    expect(followUp!.compareDocumentPosition(section()) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('sends the delivery next to expectedSaleVersion and reports the opened delivery', async () => {
    const mock = await openVisitApproval(pairScenario({
      respond: (path) => (path.endsWith('/approve') ? Response.json(approvedVisit()) : null),
    }));

    await confirm();

    const approve = mock.posts.find((post) => post.path.endsWith('/approve'))!;
    expect(approve.body).toMatchObject({ expectedVersion: 4, expectedSaleVersion: 7 });
    expect(typeof approve.body.clientActionId).toBe('string');
    const delivery = approve.body.delivery as Record<string, unknown>;
    expect(delivery).toEqual({
      assignedTo: 'staff-1',
      scheduledAt: expect.any(String),
      deliveryPurpose: 'SALE',
      items: [
        { productId: 'product-1', quantity: 3 },
        { productId: 'product-2', quantity: 10 },
      ],
    });
    expect(typeof delivery.scheduledAt).toBe('string');
    expect(new Date(String(delivery.scheduledAt)).toISOString()).toBe(delivery.scheduledAt);
    expect(delivery).not.toHaveProperty('note');
    expect(delivery).not.toHaveProperty('pastStartAcknowledgement');
    expect(host.textContent).toContain('Bağlı satış kaydı da tamamlandı.');
    expect(host.textContent).toContain('Teslim işi oluşturuldu.');
  });

  it('renders the approve consequences as a list with a description covering both', async () => {
    await openVisitApproval(pairScenario());

    const description = dialog().getAttribute('aria-describedby')!.split(' ');
    expect(description).toHaveLength(2);
    const paragraph = document.getElementById(description[0])!;
    const list = document.getElementById(description[1])!;
    expect(paragraph.tagName).toBe('P');
    expect(paragraph.textContent).toBe(
      'İş “Tamamlandı” durumuna geçecek ve aktif iş listesinden kaldırılacaktır.',
    );
    expect(list.tagName).toBe('UL');
    expect(list.classList.contains('workflow-dialog-details')).toBe(true);
    expect(Array.from(list.querySelectorAll('li')).map((item) => item.textContent)).toEqual([
      'Yönetici kontrolünü tamamlar',
      'İşi “Tamamlandı” durumuna geçirir',
      'Aktif iş listesinden kaldırır',
      'İş geçmişine onay kaydı ekler',
      'Satıştan planlı bir ürün teslim işi oluşturur',
    ]);
  });

  it('names the delivery in the approve copy only while the switch is on', async () => {
    await openVisitApproval(pairScenario());
    const items = () => Array.from(dialog().querySelectorAll('ul.workflow-dialog-details li'))
      .map((item) => item.textContent);
    const delivery = 'Satıştan planlı bir ürün teslim işi oluşturur';

    expect(submitButton()!.textContent).toBe('İşi onayla ve teslim işini aç');
    expect(items()).toContain(delivery);

    await act(async () => { checkbox().click(); await flush(); });
    expect(submitButton()!.textContent).toBe('İşi onayla');
    expect(items()).not.toContain(delivery);

    await act(async () => { checkbox().click(); await flush(); });
    expect(submitButton()!.textContent).toBe('İşi onayla ve teslim işini aç');
    expect(items()).toContain(delivery);
  });

  it('names the follow-up and the delivery when both are created', async () => {
    const proposal = {
      scheduledAt: '2026-12-01T09:00:00.000Z', type: 'SALES_MEETING' as const,
      assignedTo: 'staff-1', followUpInstructions: 'Ürünleri yerinde kontrol edin.',
      origin: 'SYSTEM' as const, proposedBy: { id: 'staff-1', name: 'Ayşe Personel' },
    };
    await openVisitApproval(pairScenario({ main: visitCard('WAITING_APPROVAL', { followUpProposal: proposal }) }));

    expect(submitButton()!.textContent).toBe('İşi onayla, takip ve teslim işlerini aç');
    await act(async () => { checkbox().click(); await flush(); });
    expect(submitButton()!.textContent).toBe('İşi onayla ve takip işini planla');
  });

  it('omits delivery entirely when the switch is off', async () => {
    const mock = await openVisitApproval(pairScenario({
      respond: (path) => (path.endsWith('/approve') ? Response.json(approvedVisit()) : null),
    }));

    await act(async () => { checkbox().click(); await flush(); });
    expect(checkbox().checked).toBe(false);
    expect(section().querySelector('input[type="datetime-local"]')).toBeNull();

    await confirm();
    const approve = mock.posts.find((post) => post.path.endsWith('/approve'))!;
    expect(approve.body).toMatchObject({ expectedSaleVersion: 7 });
    expect(approve.body).not.toHaveProperty('delivery');
  });

  it('edits quantities, removes a line, adds a product and changes assignee, time, purpose and note', async () => {
    const mock = await openVisitApproval(pairScenario({
      respond: (path) => (path.endsWith('/approve') ? Response.json(approvedVisit()) : null),
    }));

    await fill(quantity('product-1'), '5');
    await act(async () => {
      section().querySelector<HTMLButtonElement>('button[aria-label="Kaldır: Cerrahi frez"]')!.click();
      await flush();
    });
    expect(section().querySelector('input[id$="-qty-product-2"]')).toBeNull();

    await fill(section().querySelector<HTMLInputElement>('input[type="search"]')!, 'poşet');
    await act(async () => { buttonByName(section(), 'Ürün ara')!.click(); await flush(); await flush(); });
    expect(mock.urls.some((url) => url.startsWith('/api/products') && url.includes('dataClass=BUSINESS')
      && url.includes('status=active'))).toBe(true);
    await act(async () => {
      section().querySelector<HTMLButtonElement>('button[data-product-id="product-9"]')!.click();
      await flush();
    });
    expect(quantity('product-9').value).toBe('1');
    await fill(quantity('product-9'), '12');

    await choose(assignee(), 'staff-2');
    await fill(scheduled(), '2030-05-17T10:30');
    await choose(purpose(), 'SAMPLE');
    await fill(section().querySelector<HTMLTextAreaElement>('textarea')!, '  Kapı girişinden teslim  ');

    await confirm();
    const delivery = mock.posts.find((post) => post.path.endsWith('/approve'))!.body.delivery as Record<string, unknown>;
    expect(delivery).toMatchObject({
      assignedTo: 'staff-2',
      scheduledAt: new Date(2030, 4, 17, 10, 30).toISOString(),
      deliveryPurpose: 'SAMPLE',
      note: 'Kapı girişinden teslim',
      items: [
        { productId: 'product-1', quantity: 5 },
        { productId: 'product-9', quantity: 12 },
      ],
    });
  });

  it('pre-checks empty and fractional quantities and an empty line list without a request', async () => {
    const mock = await openVisitApproval(pairScenario());

    await fill(quantity('product-1'), '2.5');
    await fill(quantity('product-2'), '');
    await confirm();

    expect(mock.posts.filter((post) => post.path.endsWith('/approve'))).toHaveLength(0);
    const alert = section().querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Dental implant seti için 1–999999999 arasında tam sayı adet girin.');
    expect(alert?.textContent).toContain('Cerrahi frez için 1–999999999 arasında tam sayı adet girin.');
    expect(quantity('product-1').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(quantity('product-1'));

    // Removing every line is also refused locally, with the product search focused.
    for (const name of ['Dental implant seti', 'Cerrahi frez']) {
      await act(async () => {
        section().querySelector<HTMLButtonElement>(`button[aria-label="Kaldır: ${name}"]`)!.click();
        await flush();
      });
    }
    await confirm();
    expect(mock.posts.filter((post) => post.path.endsWith('/approve'))).toHaveLength(0);
    expect(section().querySelector('[role="alert"]')?.textContent)
      .toContain('Teslim işi için en az bir ürün gerekli.');
  });

  it('turns the switch off and explains it when no active staff can take the delivery', async () => {
    const mock = await openVisitApproval(pairScenario({
      staff: [],
      respond: (path) => (path.endsWith('/approve') ? Response.json(approvedVisit()) : null),
    }));

    expect(checkbox().checked).toBe(false);
    expect(checkbox().disabled).toBe(true);
    expect(section().textContent).toContain('aktif personel bulunmadığı için teslim işi açılamaz');

    await confirm();
    expect(mock.posts.find((post) => post.path.endsWith('/approve'))!.body).not.toHaveProperty('delivery');
  });

  it('starts off when the sale has no product line', async () => {
    await openVisitApproval(pairScenario({ items: [] }));
    expect(checkbox().checked).toBe(false);
    expect(checkbox().disabled).toBe(false);
  });

  it('warns for a legacy sale that is not WAITING_APPROVAL and offers no delivery section', async () => {
    await openVisitApproval(pairScenario({ sale: saleCard('IN_PROGRESS') }));

    expect(dialog().textContent).toContain('Bağlı satış kaydı onaylanmadan kalacak');
    expect(dialog().querySelector('[data-sale-delivery]')).toBeNull();
  });

  it('mounts the same section in the independent sale approve dialog, without expectedSaleVersion', async () => {
    const s = independentScenario({
      standalone: true,
      respond: (path) => (path.endsWith('/approve')
        ? Response.json({ ...saleCard('COMPLETED', { version: 8 }), deliveryJobCardId: 'delivery-9' })
        : null),
    });
    const mock = await openVisitApproval(s);

    expect(section()).not.toBeNull();
    expect(checkbox().checked).toBe(true);
    expect(quantity('product-1').value).toBe('3');
    expect(assignee().value).toBe('staff-1');
    expect(section().textContent).toContain('Bu onayın oluşturacağı tek sonraki iş bu teslim işidir');
    const helper = 'Onayla birlikte planlanmış bir ürün teslimi oluşturulur';
    expect(dialog().textContent!.split(helper).length - 1).toBe(1);

    await confirm();
    const approve = mock.posts.find((post) => post.path.endsWith('/approve'))!;
    expect(approve.body).toMatchObject({ expectedVersion: 7 });
    expect(approve.body).not.toHaveProperty('expectedSaleVersion');
    expect(approve.body.delivery).toMatchObject({
      assignedTo: 'staff-1', deliveryPurpose: 'SALE',
      items: [{ productId: 'product-1', quantity: 3 }, { productId: 'product-2', quantity: 10 }],
    });
    expect(host.textContent).toContain('Teslim işi oluşturuldu.');
  });

  it('offers the section for a sale whose source visit is already terminal', async () => {
    await openVisitApproval(independentScenario());
    expect(section()).not.toBeNull();
    expect(section().textContent).toContain('tek sonraki iş');
  });

  it('keeps every control locked while the approval is pending', async () => {
    let release: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const mock = await openVisitApproval(pairScenario({
      respond: (path) => (path.endsWith('/approve') ? pending : null),
    }));

    await act(async () => { submitButton()!.click(); await flush(); });

    expect(mock.posts.filter((post) => post.path.endsWith('/approve'))).toHaveLength(1);
    const fieldset = section().querySelector<HTMLFieldSetElement>('fieldset')!;
    expect(fieldset.disabled).toBe(true);
    const status = section().querySelector('[role="status"]');
    expect(status?.textContent).toContain('Onay işleniyor');
    for (const control of [checkbox(), quantity('product-1'), assignee(), scheduled(), purpose()]) {
      expect(control.matches(':disabled')).toBe(true);
    }
    expect(buttonByName(dialog(), 'İşleniyor…')?.disabled ?? true).toBe(true);

    await act(async () => { release(Response.json(approvedVisit())); await flush(); await flush(); });
  });

  describe('definitive failures', () => {
    function errorResponse(code: string, status: number, details: Record<string, unknown> = {}) {
      return Response.json({ code, error: `Sunucu: ${code}`, details }, { status });
    }

    it('maps ASSIGNMENT_WINDOW_TOO_SHORT to the datetime, focuses it and retries with a new key', async () => {
      const mock = await openVisitApproval(pairScenario({
        respond: (path, _body, index) => (path.endsWith('/approve')
          ? (index === 0 ? errorResponse('ASSIGNMENT_WINDOW_TOO_SHORT', 409) : Response.json(approvedVisit()))
          : null),
      }));

      await confirm();
      expect(dialog()).not.toBeNull();
      const error = scheduled().parentElement!.querySelector('.field-error');
      expect(error?.textContent).toContain('teslim personelinin kabul etmesi için çok yakın');
      expect(scheduled().getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(scheduled());
      expect(section().querySelector('[role="alert"]')).not.toBeNull();
      // Controls are usable again (definitive answer, nothing was written).
      expect(scheduled().disabled).toBe(false);
      expect(section().querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(false);
      expect(submitButton()!.disabled).toBe(false);
      expect(dialog().textContent).not.toContain('Özgün isteği tekrar dene');

      await fill(scheduled(), '2031-01-10T09:00');
      expect(section().querySelector('[role="alert"]')).toBeNull();
      await confirm();

      const approves = mock.posts.filter((post) => post.path.endsWith('/approve'));
      expect(approves).toHaveLength(2);
      expect(approves[1].body.clientActionId).not.toBe(approves[0].body.clientActionId);
      expect((approves[1].body.delivery as Record<string, unknown>).scheduledAt)
        .toBe(new Date(2031, 0, 10, 9, 0).toISOString());
    });

    it('asks for the past-start acknowledgement on the datetime and resends it with a new key', async () => {
      const mock = await openVisitApproval(pairScenario({
        respond: (path, _body, index) => (path.endsWith('/approve')
          ? (index === 0
            ? errorResponse('PAST_START_ACKNOWLEDGEMENT_REQUIRED', 409)
            : Response.json(approvedVisit()))
          : null),
      }));

      await fill(scheduled(), '2020-01-10T09:00');
      await confirm();

      expect(section().textContent).toContain('Planlanan teslim zamanı geçti');
      expect(document.activeElement).toBe(scheduled());
      const code = section().querySelector<HTMLSelectElement>('select[id$="-ack-code"]')!;
      const text = section().querySelector<HTMLTextAreaElement>('textarea[id$="-ack-text"]')!;
      expect(code).not.toBeNull();

      // The acknowledgement is mandatory once asked for.
      await confirm();
      expect(mock.posts.filter((post) => post.path.endsWith('/approve'))).toHaveLength(1);
      expect(section().textContent).toContain('Başlangıcın neden geçtiğini açıklayan bir neden seçin.');

      await choose(code, 'CUSTOMER_WAITING');
      await fill(text, '  Müşteri kapıda bekliyor.  ');
      await confirm();

      const approves = mock.posts.filter((post) => post.path.endsWith('/approve'));
      expect(approves).toHaveLength(2);
      expect(approves[1].body.clientActionId).not.toBe(approves[0].body.clientActionId);
      expect((approves[1].body.delivery as Record<string, unknown>).pastStartAcknowledgement)
        .toEqual({ code: 'CUSTOMER_WAITING', text: 'Müşteri kapıda bekliyor.' });
    });

    it('maps VALIDATION_ERROR on delivery.items to the product list', async () => {
      await openVisitApproval(pairScenario({
        respond: (path) => (path.endsWith('/approve')
          ? errorResponse('VALIDATION_ERROR', 400, {
              fieldErrors: { 'delivery.items': 'Aynı ürün birden fazla kez eklenemez.' },
            })
          : null),
      }));

      await confirm();

      expect(section().textContent).toContain('Aynı ürün birden fazla kez eklenemez.');
      expect(document.activeElement).toBe(
        section().querySelector('.product-select input[type="search"]'),
      );
    });

    it('maps PRODUCT_NOT_FOUND to the product list', async () => {
      await openVisitApproval(pairScenario({
        respond: (path) => (path.endsWith('/approve') ? errorResponse('PRODUCT_NOT_FOUND', 404) : null),
      }));
      await confirm();
      expect(section().textContent).toContain('Seçilen ürünlerden biri bulunamadı');
      expect(document.activeElement)
        .toBe(section().querySelector('.product-select input[type="search"]'));
    });

    it('switches the delivery off and explains CUSTOMER_INACTIVE; the corrected approval has no delivery', async () => {
      const mock = await openVisitApproval(pairScenario({
        respond: (path, _body, index) => (path.endsWith('/approve')
          ? (index === 0 ? errorResponse('CUSTOMER_INACTIVE', 409) : Response.json(approvedVisit()))
          : null),
      }));

      await confirm();
      expect(checkbox().checked).toBe(false);
      expect(section().textContent).toContain('Müşteri artık aktif değil');
      expect(document.activeElement).toBe(checkbox());

      await confirm();
      const approves = mock.posts.filter((post) => post.path.endsWith('/approve'));
      expect(approves).toHaveLength(2);
      expect(approves[1].body).not.toHaveProperty('delivery');
      expect(approves[1].body.clientActionId).not.toBe(approves[0].body.clientActionId);
    });

    it('explains SALE_DELIVERY_EXISTS and SALE_PAIR_ASSIGNEE_CONFLICT inside the section', async () => {
      await openVisitApproval(pairScenario({
        respond: (path) => (path.endsWith('/approve') ? errorResponse('SALE_DELIVERY_EXISTS', 409) : null),
      }));
      await confirm();
      expect(section().textContent).toContain('Bu satış için teslim işi zaten açılmış');
    });

    it('maps SALE_PAIR_ASSIGNEE_CONFLICT to the assignee control', async () => {
      await openVisitApproval(pairScenario({
        respond: (path) => (path.endsWith('/approve')
          ? errorResponse('SALE_PAIR_ASSIGNEE_CONFLICT', 409, {
              visitAssignee: 'staff-1', requestedAssignee: 'staff-2',
            })
          : null),
      }));
      await confirm();
      expect(section().textContent).toContain('aynı personelde kalmalıdır');
      expect(document.activeElement).toBe(assignee());
    });
  });

  it('retries an uncertain outcome byte-identically with the same key and keeps controls locked', async () => {
    let calls = 0;
    const mock = await openVisitApproval(pairScenario({
      respond: (path) => {
        if (!path.endsWith('/approve')) return null;
        calls += 1;
        if (calls === 1) throw new TypeError('network down');
        return Response.json(approvedVisit());
      },
    }));

    await confirm();

    expect(section().querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(true);
    expect(dialog().textContent).toContain('İşlemin sonucu henüz doğrulanamadı');
    expect(section().querySelector('[role="alert"]')).toBeNull();
    expect(submitButton()!.textContent).toBe('Özgün isteği tekrar dene');

    await act(async () => {
      buttonByName(dialog(), 'Özgün isteği tekrar dene')!.click();
      await flush(); await flush();
    });

    const approves = mock.posts.filter((post) => post.path.endsWith('/approve'));
    expect(approves).toHaveLength(2);
    expect(approves[1].body).toEqual(approves[0].body);
    expect(approves[1].body.delivery).toBeDefined();
  });

  describe('sale and delivery cards', () => {
    function renderCard(s: Scenario) {
      return render(s);
    }

    it('replaces the false "no delivery" copy with the MOD-001 wording', async () => {
      await renderCard({
        main: saleCard('COMPLETED', { workflowContext: context([]) }),
        sale: saleCard('COMPLETED', { workflowContext: context([]) }),
        standalone: true,
      });
      const text = host.textContent ?? '';
      expect(text).not.toContain('teslimat oluşturmaz');
      expect(text).toContain('Satış kaydı stok hareketi oluşturmaz');
      expect(text).toContain('Onay sırasında ürün teslimi için ayrı bir teslim işi açılabilir');
      expect(text).toContain('Satış kaydı finansal işlem oluşturmaz');
    });

    it('shows the linked delivery status and link when the DTO exposes it', async () => {
      const completed = saleCard('COMPLETED', {
        workflowContext: context([]),
        linkedDelivery: { id: 'delivery-9', status: 'NEW' },
      });
      await renderCard({ main: completed, sale: completed, standalone: true });
      const panel = host.querySelector('[data-sale-delivery-link]');
      expect(panel?.textContent).toContain('Bağlı teslimat');
      expect(panel?.querySelector('a[href="/jobs/delivery-9"]')).not.toBeNull();
      expect(panel?.textContent).toContain('Atandı');
    });

    it('shows the status without a link when another staff member carries the delivery', async () => {
      const completed = saleCard('COMPLETED', {
        workflowContext: context([]),
        linkedDelivery: { id: null, status: 'NEW' },
      });
      await renderCard({ main: completed, sale: completed, standalone: true });
      const panel = host.querySelector('[data-sale-delivery-link]');
      expect(panel?.textContent).toContain('başka bir personel teslim ediyor');
      expect(panel?.textContent).not.toContain('Henüz teslim işi açılmadı');
      expect(panel?.querySelector('a')).toBeNull();
    });

    it('says no delivery was opened when the DTO exposes a null link', async () => {
      const completed = saleCard('COMPLETED', { workflowContext: context([]), linkedDelivery: null });
      await renderCard({ main: completed, sale: completed, standalone: true });
      expect(host.querySelector('[data-sale-delivery-link]')?.textContent)
        .toContain('Henüz teslim işi açılmadı');
    });

    it('shows no linked delivery panel while the DTO does not carry the field', async () => {
      const completed = saleCard('COMPLETED', { workflowContext: context([]) });
      await renderCard({ main: completed, sale: completed, standalone: true });
      expect(host.querySelector('[data-sale-delivery-link]')).toBeNull();
    });

    function deliveryCard(extra: Partial<JobCard> = {}): JobCard {
      return {
        ...baseCard, id: 'delivery-9', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 1,
        title: 'ABC Klinik ürün teslimi', scheduledAt: '2026-11-24T07:00:00.000Z',
        workflowContext: context([]), ...extra,
      };
    }

    it('shows the provenance line with a link on a delivery created from a sale', async () => {
      const delivery = deliveryCard({ deliverySourceSaleId: 'sale-1' });
      await renderCard({ main: delivery, sale: saleCard() });
      const line = host.querySelector('[data-delivery-provenance]');
      expect(line?.textContent).toContain('Satış kaydından oluşturuldu');
      expect(line?.querySelector('a[href="/jobs/sale-1"]')).not.toBeNull();
    });

    it('shows nothing on a delivery without a readable source sale', async () => {
      await renderCard({ main: deliveryCard({ deliverySourceSaleId: null }), sale: saleCard() });
      expect(host.querySelector('[data-delivery-provenance]')).toBeNull();
      expect(host.textContent).not.toContain('Satış kaydından oluşturuldu');
      await act(async () => root.unmount());
      root = createRoot(host);
      await renderCard({ main: deliveryCard(), sale: saleCard() });
      expect(host.querySelector('[data-delivery-provenance]')).toBeNull();
    });
  });
});

describe('SALE-002 S3 sale detail DTO', () => {
  const base = {
    jobCardId: 'sale-1', jobCardVersion: 7, soldAt: '2026-11-20T09:30:00.000Z', saleContact: null,
    sourceVisit: { kind: 'STANDALONE' }, items: [],
  };

  it('keeps linkedDelivery absent unless the server sends it', () => {
    expect('linkedDelivery' in parseSaleDetails(base)).toBe(false);
  });

  it('accepts a null or {id,status} linkedDelivery and rejects any other shape', () => {
    expect(parseSaleDetails({ ...base, linkedDelivery: null }).linkedDelivery).toBeNull();
    expect(parseSaleDetails({ ...base, linkedDelivery: { id: 'delivery-9', status: 'NEW' } }).linkedDelivery)
      .toEqual({ id: 'delivery-9', status: 'NEW' });
    expect(() => parseSaleDetails({ ...base, linkedDelivery: { id: 'delivery-9', status: 'BOGUS' } })).toThrow();
    expect(() => parseSaleDetails({ ...base, linkedDelivery: 'delivery-9' })).toThrow();
    expect(parseSaleDetails({ ...base, linkedDelivery: { id: null, status: 'COMPLETED' } }).linkedDelivery)
      .toEqual({ id: null, status: 'COMPLETED' });
  });
});
