/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import type { CurrentUser } from '../src/services/api';
import type {
  JobCard, JobCardStatus, JobLifecycleFacts, JobWorkflowContext, LifecycleCommand,
  SubmissionReadiness,
} from '../src/jobs/jobs-api';
import type { SaleDetails } from '../src/jobs/sale-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'a@x',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const manager: CurrentUser = {
  ...staff, id: 'manager-1', name: 'Mehmet Yönetici', email: 'm@x', role: 'MANAGER',
};

const lifecycle: JobLifecycleFacts = {
  createdAt: '2026-11-20T08:00:00.000Z', acceptedAt: null, acceptedBy: null,
  startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
  cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
};

function workflowContext(input: {
  commands: LifecycleCommand[];
  actions?: JobWorkflowContext['allowedActions'];
  lifecycle?: Partial<JobLifecycleFacts>;
  readiness?: SubmissionReadiness | null;
}): JobWorkflowContext {
  return {
    allowedCommands: input.commands,
    allowedActions: input.actions ?? ['VIEW_NOTES', 'ADD_NOTE'],
    startLocationCaptureEnabled: false,
    submitLocationCaptureEnabled: false,
    lifecycle: { ...lifecycle, ...input.lifecycle },
    submissionReadiness: input.readiness ?? null,
  };
}

const READY_SALE: SubmissionReadiness = {
  evaluatedAt: '2026-11-23T09:00:00.000Z', ready: true,
  items: [
    { code: 'CUSTOMER_ELIGIBLE', state: 'met', field: 'customerId' },
    { code: 'SALE_ITEM_PRESENT', state: 'met', field: 'saleItems' },
  ],
};

const NOT_READY_SALE: SubmissionReadiness = {
  evaluatedAt: '2026-11-23T09:00:00.000Z', ready: false,
  items: [
    { code: 'SALE_ITEM_PRESENT', state: 'missing', field: 'saleItems' },
    { code: 'SALE_TIME_VALID', state: 'met', field: 'soldAt' },
  ],
};

function visitCard(input: {
  status: JobCardStatus;
  version?: number;
  commands: LifecycleCommand[];
  lifecycle?: Partial<JobLifecycleFacts>;
  assignedTo?: string;
}): JobCard {
  return {
    id: 'visit-1', organizationId: 'org-1', type: 'SALES_MEETING',
    engagementKind: 'SALES_MEETING',
    status: input.status, version: input.version ?? 4, title: 'ABC Klinik ziyareti',
    description: null, customerId: 'c1', contactId: null,
    assignedTo: input.assignedTo ?? staff.id, createdBy: manager.id,
    priority: 'normal', dueDate: null,
    scheduledAt: '2026-11-23T09:00:00.000Z', scheduledEndsAt: null,
    assignee: { id: input.assignedTo ?? staff.id, name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    followUpContext: null, followUpProposal: null,
    earlyStartAuthorization: null, submitLocationComparison: null,
    changeRequest: null, assignmentOffer: null,
    hasOpenOverdueIncident: false, correctionDueAt: null,
    workflowContext: workflowContext({
      commands: input.commands,
      lifecycle: input.lifecycle ?? {},
    }),
  };
}

function saleCard(input: {
  status: JobCardStatus;
  version?: number;
  commands: LifecycleCommand[];
  readiness?: SubmissionReadiness | null;
  assignedTo?: string;
  title?: string;
}): JobCard {
  return {
    id: 'sale-1', organizationId: 'org-1', type: 'SALE', engagementKind: null,
    status: input.status, version: input.version ?? 7,
    title: input.title ?? 'Kasım anlaşması',
    description: null, customerId: 'c1', contactId: null,
    assignedTo: input.assignedTo ?? staff.id, createdBy: manager.id,
    priority: 'normal', dueDate: null, scheduledAt: null, scheduledEndsAt: null,
    assignee: { id: input.assignedTo ?? staff.id, name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    followUpContext: null, followUpProposal: null,
    earlyStartAuthorization: null, submitLocationComparison: null,
    changeRequest: null, assignmentOffer: null,
    hasOpenOverdueIncident: false, correctionDueAt: null,
    workflowContext: workflowContext({
      commands: input.commands,
      readiness: input.readiness === undefined ? READY_SALE : input.readiness,
    }),
  };
}

const saleItems: SaleDetails['items'] = [{
  id: 'line-1', productId: 'product-1', name: 'Dental implant seti', sku: 'IMP-01',
  brand: 'Servora', model: 'S1', unit: 'set', quantity: '3',
}];

type Scenario = {
  visit: JobCard;
  sale: JobCard | null;
  items?: SaleDetails['items'];
  activeSale?: 'full' | 'restricted' | 'none';
  /** SALE-002: the sale's own origin projection. */
  saleOrigin?: 'visit' | 'standalone';
  onLifecycle?: (path: string, body: Record<string, unknown>) => Response | null;
  /** Holds the pair discovery requests until resolved, to observe the loading pair. */
  pairGate?: Promise<void>;
};

function saleDetailsFor(s: Scenario) {
  const sale = s.sale!;
  return {
    jobCardId: sale.id, jobCardVersion: sale.version, soldAt: '2026-11-20T09:30:00.000Z',
    saleContact: null,
    sourceVisit: s.saleOrigin === 'standalone'
      ? { kind: 'STANDALONE' }
      : {
          access: 'FULL', kind: 'SALE_FROM_VISIT', id: s.visit.id, title: s.visit.title,
          status: s.visit.status, versionAtCreation: 2, titleSnapshot: s.visit.title,
          customerNameSnapshot: 'ABC Klinik', plannedContact: null, metContact: null,
        },
    items: s.items ?? saleItems,
  };
}

function saleCreateContextFor(s: Scenario) {
  const mode = s.activeSale ?? (s.sale ? 'full' : 'none');
  return {
    sourceVisitId: s.visit.id, sourceVersion: s.visit.version,
    eligible: mode === 'none',
    blockedReason: mode === 'none' ? null : 'ACTIVE_SALE_EXISTS',
    customer: { id: 'c1', name: 'ABC Klinik' },
    assignee: { id: s.visit.assignedTo, name: s.visit.assignee.name },
    plannedContact: null, metContact: null,
    activeSale: mode === 'none' || s.sale === null
      ? null
      : mode === 'restricted'
        ? { access: 'RESTRICTED' }
        : { access: 'FULL', id: s.sale.id, title: s.sale.title, status: s.sale.status },
  };
}

const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };

function mockFetch(s: Scenario) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://test.invalid');
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    if (method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      posts.push({ path, body });
      const handled = s.onLifecycle?.(path, body);
      if (handled) return handled;
      throw new Error(`Unexpected POST ${path}`);
    }
    if (path.endsWith('/sale-create-context')) {
      if (s.pairGate) await s.pairGate;
      return Response.json(saleCreateContextFor(s));
    }
    if (path.endsWith('/sale-details')) return Response.json(saleDetailsFor(s));
    if (path.endsWith('/sales')) return Response.json({ ...emptyPage, limit: 20, offset: 0 });
    if (path.endsWith('/activity')) return Response.json({ ...emptyPage, limit: 50 });
    if (path === '/api/notifications/read-by-entity') return Response.json({ updated: 0 });
    if (path.endsWith('/notes')) return Response.json({ ...emptyPage, nextCursor: null });
    if (path.endsWith('/overdue-incidents')) return Response.json(emptyPage);
    if (path.endsWith('/follow-ups')) return Response.json({ ...emptyPage, limit: 100 });
    if (path === '/api/calendar/assignees') return Response.json({ items: [] });
    // SALE-002 S3: the approve dialog's delivery section loads the active staff;
    // an empty list keeps these S2 pair tests about the pair, not the delivery.
    if (path === '/api/staff') return Response.json([]);
    if (s.sale && path === `/api/job-cards/${s.sale.id}`) {
      if (s.pairGate) await s.pairGate;
      return Response.json(s.sale);
    }
    if (path === `/api/job-cards/${s.visit.id}`) return Response.json(s.visit);
    throw new Error(`Unexpected GET ${path}`);
  });
  return { fetch, posts };
}

function buttonByName(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function typeInto(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      ?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('SALE-002 S2 pair UI', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width'),
      media: query,
      onchange: null,
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

  async function render(jobId: string, user: CurrentUser, s: Scenario) {
    const mock = mockFetch(s);
    vi.stubGlobal('fetch', mock.fetch);
    await act(async () => {
      root.render(<JobDetailScreen jobId={jobId} user={user} onChanged={() => {}} />);
      await flush(); await flush(); await flush();
    });
    return mock;
  }

  function dialog() {
    return host.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  it('submits the visit with the linked sale version and says the sale goes with it', async () => {
    const visit = visitCard({
      status: 'IN_PROGRESS', commands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
      lifecycle: { startedAt: '2026-11-23T09:05:00.000Z' },
    });
    const sale = saleCard({ status: 'ACCEPTED', commands: ['START', 'CANCEL'] });
    const submitted = {
      ...visit, status: 'WAITING_APPROVAL' as const, version: 5,
      workflowContext: workflowContext({ commands: [], lifecycle: { submittedAt: '2026-11-23T12:00:00.000Z' } }),
    };
    const mock = await render(visit.id, staff, {
      visit, sale,
      onLifecycle: (path) => (path.endsWith('/submit-for-approval')
        ? Response.json({ ...submitted, linkedSaleJobCardId: 'sale-1' })
        : null),
    });

    await act(async () => { buttonByName(host, 'Kontrole gönder')!.click(); await flush(); });
    const submitDialog = dialog();
    expect(submitDialog.textContent).toContain('Bu gönderim bağlı satış kaydını da onaya gönderir');
    expect(submitDialog.querySelector('a[href="/jobs/sale-1"]')).not.toBeNull();

    await typeInto(submitDialog.querySelector('textarea')!, 'Görüşme tamamlandı');
    await act(async () => {
      buttonByName(submitDialog, 'Kontrole gönder')!.click();
      await flush(); await flush();
    });

    const submit = mock.posts.find((post) => post.path.endsWith('/submit-for-approval'));
    expect(submit?.body).toMatchObject({
      expectedVersion: 4,
      expectedSaleVersion: 7,
      note: 'Görüşme tamamlandı',
    });
    expect(host.textContent).toContain('Bağlı satış kaydı da onaya gönderildi.');
  });

  it('blocks the joint submit with the sale readiness panel and links the sale', async () => {
    const visit = visitCard({
      status: 'IN_PROGRESS', commands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
      lifecycle: { startedAt: '2026-11-23T09:05:00.000Z' },
    });
    const sale = saleCard({
      status: 'ACCEPTED', commands: ['START', 'CANCEL'], readiness: NOT_READY_SALE,
    });
    await render(visit.id, staff, { visit, sale });

    await act(async () => { buttonByName(host, 'Kontrole gönder')!.click(); await flush(); });
    const submitDialog = dialog();
    const alert = submitDialog.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Bağlı satış kaydı hazır değil');
    expect(alert?.textContent).toContain('En az bir satış ürünü');
    expect(alert?.querySelector('a[href="/jobs/sale-1"]')?.textContent).toBe('Satış kaydını aç');
  });

  it('names the acceptance step before a joint submit of a management-created sale', async () => {
    const visit = visitCard({
      status: 'IN_PROGRESS', commands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
      lifecycle: { startedAt: '2026-11-23T09:05:00.000Z' },
    });
    const sale = saleCard({ status: 'NEW', commands: ['ACCEPT_ASSIGNMENT', 'CANCEL'], readiness: null });
    await render(visit.id, staff, { visit, sale });

    await act(async () => { buttonByName(host, 'Kontrole gönder')!.click(); await flush(); });
    expect(dialog().textContent).toContain('Bağlı satış kaydı önce kabul edilmeli');
    expect(dialog().querySelector('a[href="/jobs/sale-1"]')).not.toBeNull();
  });

  it('approves the pair with one action and shows the linked sale products for review', async () => {
    const visit = visitCard({
      status: 'WAITING_APPROVAL',
      commands: ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'],
      lifecycle: {
        startedAt: '2026-11-23T09:05:00.000Z',
        submittedAt: '2026-11-23T12:00:00.000Z',
        submittedBy: { id: staff.id, name: staff.name },
      },
    });
    const sale = saleCard({ status: 'WAITING_APPROVAL', commands: [] });
    const completed = {
      ...visit, status: 'COMPLETED' as const, version: 5,
      workflowContext: workflowContext({
        commands: [],
        lifecycle: {
          startedAt: '2026-11-23T09:05:00.000Z',
          submittedAt: '2026-11-23T12:00:00.000Z',
          approvedAt: '2026-11-23T13:00:00.000Z',
          approvedBy: { id: manager.id, name: manager.name },
        },
      }),
    };
    const mock = await render(visit.id, manager, {
      visit, sale,
      onLifecycle: (path) => (path.endsWith('/approve')
        ? Response.json({ ...completed, linkedSaleJobCardId: 'sale-1', followUpJobCardId: null })
        : null),
    });

    await act(async () => { buttonByName(host, 'Kontrolü tamamla ve işi kapat')!.click(); await flush(); });
    const approveDialog = dialog();
    expect(approveDialog.textContent).toContain('Bu onay bağlı satış kaydını da tamamlar');
    expect(approveDialog.textContent).toContain('Dental implant seti');
    expect(approveDialog.textContent).toContain('3 ürün');
    expect(approveDialog.querySelector('a[href="/jobs/sale-1"]')).not.toBeNull();

    await act(async () => {
      buttonByName(approveDialog, 'İşi onayla')!.click();
      await flush(); await flush();
    });
    const approve = mock.posts.find((post) => post.path.endsWith('/approve'));
    expect(approve?.body).toMatchObject({ expectedVersion: 4, expectedSaleVersion: 7 });
    expect(approve?.body).not.toHaveProperty('delivery');
    expect(host.textContent).toContain('Bağlı satış kaydı da tamamlandı.');
  });

  it('locks the approve confirm while the pair loads without reporting it as a follow-up error', async () => {
    const visit = visitCard({
      status: 'WAITING_APPROVAL',
      commands: ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'],
      lifecycle: {
        startedAt: '2026-11-23T09:05:00.000Z',
        submittedAt: '2026-11-23T12:00:00.000Z',
        submittedBy: { id: staff.id, name: staff.name },
      },
    });
    const sale = saleCard({ status: 'WAITING_APPROVAL', commands: [] });
    let releasePair!: () => void;
    const pairGate = new Promise<void>((resolve) => { releasePair = resolve; });
    const mock = await render(visit.id, manager, { visit, sale, pairGate });

    await act(async () => { buttonByName(host, 'Kontrolü tamamla ve işi kapat')!.click(); await flush(); });
    const approveDialog = dialog();
    expect(approveDialog.textContent).toContain('Bağlı satış bilgisi yükleniyor…');
    const confirm = buttonByName(approveDialog, 'İşi onayla')!;
    expect(confirm.disabled).toBe(true);
    expect(approveDialog.querySelector('.form-error')).toBeNull();

    await act(async () => { releasePair(); await flush(); await flush(); await flush(); });
    expect(buttonByName(dialog(), 'İşi onayla')!.disabled).toBe(false);
    expect(dialog().querySelector('.form-error')).toBeNull();
    expect(dialog().textContent).not.toContain('Bağlı satış kaydı yükleniyor');
    expect(mock.posts.some((post) => post.path.endsWith('/approve'))).toBe(false);
  });

  it('warns that a legacy unsubmitted sale stays open when the visit is approved', async () => {
    const visit = visitCard({
      status: 'WAITING_APPROVAL',
      commands: ['APPROVE', 'REQUEST_REVISION', 'CANCEL'],
      lifecycle: {
        startedAt: '2026-11-23T09:05:00.000Z',
        submittedAt: '2026-11-23T12:00:00.000Z',
      },
    });
    const sale = saleCard({ status: 'IN_PROGRESS', commands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'] });
    await render(visit.id, manager, { visit, sale });

    await act(async () => { buttonByName(host, 'Kontrolü tamamla ve işi kapat')!.click(); await flush(); });
    const approveDialog = dialog();
    expect(approveDialog.textContent).toContain('Bağlı satış kaydı onaylanmadan kalacak');
    expect(approveDialog.textContent).not.toContain('Bu onay bağlı satış kaydını da tamamlar');
    expect(approveDialog.textContent).toContain('satış kaydı kendi kartından yürütülür');
  });

  it('sends the pair version on a revision request and states the pair moves together', async () => {
    const visit = visitCard({
      status: 'WAITING_APPROVAL',
      commands: ['APPROVE', 'REQUEST_REVISION', 'CANCEL'],
      lifecycle: {
        startedAt: '2026-11-23T09:05:00.000Z',
        submittedAt: '2026-11-23T12:00:00.000Z',
      },
    });
    const sale = saleCard({ status: 'WAITING_APPROVAL', commands: [] });
    const revised = {
      ...visit, status: 'REVISION_REQUESTED' as const, version: 5,
      workflowContext: workflowContext({ commands: [], lifecycle: { revisionRequestedAt: '2026-11-23T13:00:00.000Z' } }),
    };
    const mock = await render(visit.id, manager, {
      visit, sale,
      onLifecycle: (path) => (path.endsWith('/request-revision')
        ? Response.json({ ...revised, linkedSaleJobCardId: 'sale-1' })
        : null),
    });

    await act(async () => {
      buttonByName(host, 'Düzeltme için personele geri gönder')!.click();
      await flush();
    });
    const revisionDialog = dialog();
    expect(revisionDialog.textContent).toContain('Bağlı satış kaydı da birlikte düzeltmeye gönderilir');

    await typeInto(revisionDialog.querySelector('textarea')!, 'Ürün miktarı düzeltilmeli');
    await act(async () => {
      buttonByName(revisionDialog, 'Düzeltme için geri gönder')!.click();
      await flush(); await flush();
    });
    const revision = mock.posts.find((post) => post.path.endsWith('/request-revision'));
    expect(revision?.body).toMatchObject({ expectedVersion: 4, expectedSaleVersion: 7 });
  });

  it('sends the pair version on a single-card visit withdraw and states the pair moves together', async () => {
    const visit = visitCard({
      status: 'WAITING_APPROVAL',
      commands: ['APPROVE', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'],
      lifecycle: {
        startedAt: '2026-11-23T09:05:00.000Z',
        submittedAt: '2026-11-23T12:00:00.000Z',
      },
    });
    const sale = saleCard({ status: 'WAITING_APPROVAL', commands: [] });
    const withdrawn = {
      ...visit, status: 'IN_PROGRESS' as const, version: 5,
      workflowContext: workflowContext({ commands: [], lifecycle: { startedAt: '2026-11-23T09:05:00.000Z' } }),
    };
    const mock = await render(visit.id, manager, {
      visit, sale,
      onLifecycle: (path) => (path.endsWith('/withdraw-from-approval')
        ? Response.json({ ...withdrawn, linkedSaleJobCardId: 'sale-1' })
        : null),
    });

    await act(async () => { buttonByName(host, 'Kontrolden geri çek')!.click(); await flush(); await flush(); });
    const withdraw = mock.posts.find((post) => post.path.endsWith('/withdraw-from-approval'));
    expect(withdraw?.body).toMatchObject({ expectedVersion: 4, expectedSaleVersion: 7 });
    expect(host.textContent).toContain('Bağlı satış kaydı da yeniden düzenlemeye açıldı.');
  });

  it('states the pair outcome in the withdraw-and-edit confirmation and sends the sale version', async () => {
    const visit = visitCard({
      status: 'WAITING_APPROVAL',
      commands: ['APPROVE', 'CANCEL'],
      lifecycle: {
        startedAt: '2026-11-23T09:05:00.000Z',
        submittedAt: '2026-11-23T12:00:00.000Z',
      },
    });
    const visitWithEdit = {
      ...visit,
      workflowContext: {
        ...visit.workflowContext,
        allowedActions: ['WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_NOTES'] as JobWorkflowContext['allowedActions'],
      },
    };
    const sale = saleCard({ status: 'WAITING_APPROVAL', commands: [] });
    const mock = await render(visit.id, manager, {
      visit: visitWithEdit, sale,
      onLifecycle: (path) => (path.endsWith('/withdraw-from-approval')
        ? Response.json({ ...visitWithEdit, status: 'IN_PROGRESS', version: 5 })
        : null),
    });

    await act(async () => {
      buttonByName(host, 'Kontrolden çıkar ve kayıtları düzenle')!.click();
      await flush();
    });
    const confirmation = dialog();
    expect(confirmation.textContent).toContain('Bağlı satış kaydı da birlikte yeniden düzenlemeye açılır');
    expect(confirmation.textContent).toContain('Kasım anlaşması');
    await act(async () => {
      buttonByName(confirmation, 'Kontrolden çıkar ve düzenle')!.click();
      await flush(); await flush();
    });
    const withdraw = mock.posts.find((post) => post.path.endsWith('/withdraw-from-approval'));
    expect(withdraw?.body).toMatchObject({ expectedSaleVersion: 7 });
  });

  it('omits expectedSaleVersion when the visit has no active linked sale', async () => {
    const visit = visitCard({
      status: 'IN_PROGRESS', commands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
      lifecycle: { startedAt: '2026-11-23T09:05:00.000Z' },
    });
    const mock = await render(visit.id, staff, { visit, sale: null });

    await act(async () => { buttonByName(host, 'Kontrole gönder')!.click(); await flush(); });
    const submitDialog = dialog();
    expect(submitDialog.textContent).not.toContain('Bu gönderim bağlı satış kaydını da');
    expect(submitDialog.querySelector('[data-sale-pair="submit"]')).toBeNull();

    await typeInto(submitDialog.querySelector('textarea')!, 'Ziyaret tamamlandı');
    await act(async () => {
      buttonByName(submitDialog, 'Kontrole gönder')!.click();
      await flush(); await flush();
    });
    const submit = mock.posts.find((post) => post.path.endsWith('/submit-for-approval'));
    expect(submit?.body).toMatchObject({ expectedVersion: 4 });
    expect(submit?.body).not.toHaveProperty('expectedSaleVersion');
  });

  it('shows the sale pair state and the withheld submit command on the sale card', async () => {
    const visit = visitCard({ status: 'IN_PROGRESS', commands: [] });
    const sale = saleCard({ status: 'ACCEPTED', commands: ['START', 'CANCEL'] });
    await render(sale.id, staff, { visit, sale });

    const panel = host.querySelector('[data-sale-pair="sale"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Bağlı ziyaret');
    expect(panel?.querySelector('a[href="/jobs/visit-1"]')?.textContent).toBe('ABC Klinik ziyareti');
    expect(panel?.textContent).toContain('gönderimi bağlı ziyaret kaydıyla birlikte yapılır');
    expect(panel?.querySelector('a[href="/jobs/visit-1"]')).not.toBeNull();
  });

  function responsibilityText() {
    return host.querySelector('[data-job-workflow-panel="responsibility"]')?.textContent ?? '';
  }

  it('points the staff next-step panel at the visit card while the pair coordinates the sale', async () => {
    const visit = visitCard({ status: 'IN_PROGRESS', commands: [] });
    const sale = saleCard({ status: 'IN_PROGRESS', commands: ['CANCEL'] });
    await render(sale.id, staff, { visit, sale });

    const text = responsibilityText();
    expect(text).toContain('Şimdi sizden beklenen');
    expect(text).toContain('Bu satış kaydı bağlı ziyaretle birlikte gönderilir. '
      + 'Ziyaret kartını açıp ziyareti kontrole gönderin.');
    expect(text).not.toContain('işi yönetici kontrolüne gönderin');
  });

  it('points the management next-step panel at the visit card for a coordinated sale approval', async () => {
    const visit = visitCard({ status: 'WAITING_APPROVAL', commands: [] });
    const sale = saleCard({ status: 'WAITING_APPROVAL', commands: ['CANCEL'] });
    await render(sale.id, manager, { visit, sale });

    const text = responsibilityText();
    expect(text).toContain('Bu satış kaydı bağlı ziyaretle birlikte onaylanır. '
      + 'Onayı ziyaret kartından verin.');
    expect(text).not.toContain('tamamlar veya düzeltme ister');
  });

  it('keeps the standard next-step text for a standalone sale and a sale of a completed visit', async () => {
    const standaloneVisit = visitCard({ status: 'COMPLETED', commands: [] });
    const standalone = saleCard({ status: 'IN_PROGRESS', commands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'] });
    await render(standalone.id, staff, {
      visit: standaloneVisit, sale: standalone, activeSale: 'none', saleOrigin: 'standalone',
    });
    expect(responsibilityText())
      .toContain('Gerekli kayıtları tamamlayıp işi yönetici kontrolüne gönderin.');

    await act(async () => root.unmount());
    root = createRoot(host);
    const completedVisit = visitCard({ status: 'COMPLETED', commands: [] });
    const fromCompleted = saleCard({ status: 'IN_PROGRESS', commands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'] });
    await render(fromCompleted.id, staff, {
      visit: completedVisit, sale: fromCompleted, activeSale: 'none',
    });
    expect(responsibilityText())
      .toContain('Gerekli kayıtları tamamlayıp işi yönetici kontrolüne gönderin.');
    expect(responsibilityText()).not.toContain('Ziyaret kartını açıp');
  });

  it('offers SUBMIT from ACCEPTED for a standalone sale without a START step (Q1)', async () => {
    const visit = visitCard({ status: 'COMPLETED', commands: [] });
    const sale = saleCard({
      status: 'ACCEPTED', commands: ['START', 'SUBMIT_FOR_APPROVAL', 'CANCEL'],
    });
    await render(sale.id, staff, { visit, sale, activeSale: 'none', saleOrigin: 'standalone' });

    const decision = host.querySelector('[data-job-decision-panel="true"]')!;
    const first = decision.querySelector('button');
    expect(first?.textContent?.trim()).toBe('Kontrole gönder');
    expect(buttonByName(decision, 'İşi başlat')).not.toBeNull();
    expect(host.querySelector('[data-sale-pair="sale"]')).toBeNull();
  });

  it('turns a redirected sale approval into the exact next action', async () => {
    const visit = visitCard({ status: 'WAITING_APPROVAL', commands: [] });
    const sale = saleCard({ status: 'WAITING_APPROVAL', commands: ['APPROVE', 'REQUEST_REVISION', 'CANCEL'] });
    await render(sale.id, manager, {
      visit, sale,
      onLifecycle: (path) => (path.endsWith('/approve')
        ? Response.json({
            code: 'SALE_APPROVE_VIA_VISIT_REQUIRED',
            error: 'Satış kaydı bağlı ziyaret üzerinden onaylanır.',
            details: {
              visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'WAITING_APPROVAL',
              allowedSaleCommand: 'APPROVE',
            },
          }, { status: 409 })
        : null),
    });

    await act(async () => { buttonByName(host, 'Kontrolü tamamla ve işi kapat')!.click(); await flush(); });
    await act(async () => {
      buttonByName(dialog(), 'İşi onayla')!.click();
      await flush(); await flush();
    });

    const guidance = host.querySelector('[data-sale-pair="guidance"]');
    expect(guidance).not.toBeNull();
    expect(guidance?.getAttribute('role')).toBe('alert');
    expect(guidance?.textContent).toContain('bağlı ziyaret kaydıyla birlikte verilir');
    expect(guidance?.querySelector('a[href="/jobs/visit-1"]')?.textContent).toBe('Ziyaret kartını aç');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain('İşlem tamamlanamadı');
  });

  it('turns a pair state conflict into the named next step on the visit card', async () => {
    const visit = visitCard({
      status: 'IN_PROGRESS', commands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
      lifecycle: { startedAt: '2026-11-23T09:05:00.000Z' },
    });
    const sale = saleCard({ status: 'NEW', commands: ['ACCEPT_ASSIGNMENT', 'CANCEL'], readiness: null });
    const mock = await render(visit.id, staff, {
      visit, sale,
      onLifecycle: (path) => (path.endsWith('/submit-for-approval')
        ? Response.json({
            code: 'SALE_PAIR_STATE_CONFLICT',
            error: 'Bağlı satış kaydı kabul edilmeden gönderilemez.',
            details: { allowedSaleCommand: 'ACCEPT_ASSIGNMENT', saleId: 'sale-1' },
          }, { status: 409 })
        : null),
    });

    await act(async () => { buttonByName(host, 'Kontrole gönder')!.click(); await flush(); });
    await typeInto(dialog().querySelector('textarea')!, 'Ziyaret tamamlandı');
    await act(async () => {
      buttonByName(dialog(), 'Kontrole gönder')!.click();
      await flush(); await flush();
    });

    expect(mock.posts.some((post) => post.path.endsWith('/submit-for-approval'))).toBe(true);
    const guidance = host.querySelector('[data-sale-pair="guidance"]');
    expect(guidance).not.toBeNull();
    expect(guidance?.textContent).toContain('“Satış kaydını kabul et”');
    expect(guidance?.querySelector('a[href="/jobs/sale-1"]')?.textContent).toBe('Satış kaydını aç');
  });

  it('never shows a restricted pair: an unreadable active sale is not coordinated', async () => {
    const visit = visitCard({
      status: 'IN_PROGRESS', commands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
      lifecycle: { startedAt: '2026-11-23T09:05:00.000Z' },
    });
    const sale = saleCard({ status: 'ACCEPTED', commands: ['START'] });
    const mock = await render(visit.id, staff, { visit, sale, activeSale: 'restricted' });

    await act(async () => { buttonByName(host, 'Kontrole gönder')!.click(); await flush(); });
    const submitDialog = dialog();
    expect(submitDialog.querySelector('[data-sale-pair="submit"]')).toBeNull();
    expect(submitDialog.textContent).not.toContain('Kasım anlaşması');

    await typeInto(submitDialog.querySelector('textarea')!, 'Ziyaret tamamlandı');
    await act(async () => {
      buttonByName(submitDialog, 'Kontrole gönder')!.click();
      await flush(); await flush();
    });
    const submit = mock.posts.find((post) => post.path.endsWith('/submit-for-approval'));
    expect(submit?.body).not.toHaveProperty('expectedSaleVersion');
  });
});
