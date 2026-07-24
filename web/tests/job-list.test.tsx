/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobList, type JobListState } from '../src/jobs/JobList';
import { JobWorkspace } from '../src/jobs/JobWorkspace';
import type { JobCardBoard, JobCardListItem, LifecycleCommand, Paginated } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staff: CurrentUser = { id: '11111111-1111-4111-8111-111111111111', organizationId: 'org-1', name: 'Ayşe Personel', email: 'ayse@example.com', role: 'STAFF', mustChangePassword: false, isActive: true, version: 1 };
const manager: CurrentUser = { ...staff, id: '22222222-2222-4222-8222-222222222222', name: 'Murat Yönetici', role: 'MANAGER' };
const item: JobCardListItem = {
  id: 'job-1', type: 'PRODUCT_DELIVERY', status: 'WAITING_APPROVAL', version: 7,
  engagementKind: null,
  title: 'ABC Klinik teslimi', priority: 'urgent', dueDate: '2026-07-20',
  scheduledAt: null,
  createdAt: '2026-07-10T10:00:00.000Z', updatedAt: '2026-07-13T10:00:00.000Z',
  staffCompletedAt: '2026-07-12T10:00:00.000Z', customer: { id: 'customer-1', name: 'ABC Klinik' },
  contact: { id: 'contact-1', name: 'Dr. Deniz' }, assignee: { id: staff.id, name: staff.name }, deliveryItemCount: 2,
  allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'],
};

function listJob(overrides: Partial<JobCardListItem> = {}): JobCardListItem {
  return { ...item, ...overrides };
}

function page(items: JobCardListItem[], offset = 0, total = items.length): Paginated<JobCardListItem> {
  return { items, total, limit: 25, offset };
}

function renderList(
  state: JobListState,
  user = manager,
  hasFilters = false,
  onCommand: (intent: { name: LifecycleCommand; jobId: string; expectedVersion: number }) => void = () => {},
) {
  return renderToStaticMarkup(<MemoryRouter><JobList state={state} user={user} hasFilters={hasFilters}
    onRetry={() => {}} onOffsetChange={() => {}} onCommand={onCommand} /></MemoryRouter>);
}

function renderListJob(
  job: JobCardListItem,
  user = manager,
  onCommand: (intent: { name: LifecycleCommand; jobId: string; expectedVersion: number }) => void = () => {},
) {
  return renderList({ kind: 'ready', page: page([job]) }, user, false, onCommand);
}

describe('structured JobCard list', () => {
  it('renders explicit loading, empty-organization, no-results, error, forbidden, and retry states', () => {
    const loading = renderList({ kind: 'loading' });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('data-servora-loading-skeleton="true"');
    expect(loading).toContain('data-job-results-state="loading"');
    expect(loading).toContain('İşler yükleniyor');
    const empty = renderList({ kind: 'ready', page: page([]) });
    expect(empty).toContain('Henüz iş kaydı yok');
    expect(empty).toContain('data-servora-empty-state="true"');
    expect(empty).toContain('data-job-results-state="empty"');
    const filtered = renderList({ kind: 'ready', page: page([]) }, manager, true);
    expect(filtered).toContain('Filtrelere uygun iş bulunamadı');
    expect(filtered).toContain('data-job-results-state="filtered-empty"');
    const retry = renderList({ kind: 'error', code: 'NETWORK_ERROR', message: 'Bağlantı kurulamadı.', retryable: true });
    expect(retry).toContain('role="alert"');
    expect(retry).toContain('Tekrar dene');
    expect(retry).toContain('data-servora-result-state="true"');
    expect(retry).toContain('data-job-results-state="error"');
    const forbidden = renderList({ kind: 'error', code: 'FORBIDDEN', message: 'Yetkiniz yok.', retryable: false });
    expect(forbidden).toContain('Bu alana erişim yetkiniz yok');
    expect(forbidden).not.toContain('Tekrar dene');
    expect(forbidden).toContain('data-job-results-state="forbidden"');
  });

  it('renders semantic operational rows, text-plus-shape status, and hides technical version', () => {
    const html = renderList({ kind: 'ready', page: page([item]) });
    expect(html).toContain('<ul'); expect(html).toContain('<article');
    for (const value of ['ABC Klinik teslimi', 'Yönetici kontrolünde', 'Acil öncelik', 'ABC Klinik', 'Dr. Deniz', 'Ayşe Personel', '20 Tem 2026', '2 ürün kalemi']) expect(html).toContain(value);
    expect(html).toContain('Müşteri'); expect(html).toContain('İlgili kişi');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('Sürüm'); expect(html).not.toContain('Kayıt sürümü');
    expect(renderList({ kind: 'ready', page: page([{ ...item, contact: null }]) })).not.toContain('İlgili kişi');
  });

  it('shows the compact workflow summary for waiting approval', () => {
    const html = renderListJob(listJob({
      status: 'WAITING_APPROVAL',
      allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'],
    }), manager);
    expect(html).toContain('4 / 5');
    expect(html).toContain('Yönetici kontrolünde');
    expect(html).toContain('İşlem beklenen: Yönetici');
    expect(html).toContain('compact-workflow');
    expect(html).not.toContain('compact-workflow--attention');
  });

  it('marks correction attention without claiming phases are completed', () => {
    const html = renderListJob(listJob({
      status: 'REVISION_REQUESTED',
      allowedCommands: ['RESUME', 'CANCEL'],
    }), staff);
    expect(html).toContain('3 / 5');
    expect(html).toContain('Düzeltme istendi');
    expect(html).toContain('Yönetici notu mevcut');
    expect(html).toContain('compact-workflow--attention');
    expect(html).not.toContain('3 aşama tamamlandı');
    expect(html).not.toContain('İşlem beklenen:');
  });

  it('uses backend allowed commands for open-for-action controls without a detail disclosure', () => {
    const html = renderListJob(listJob({
      status: 'IN_PROGRESS',
      allowedCommands: ['CANCEL'],
    }), staff);
    expect(html).not.toContain('Kontrole göndermek için aç');
    expect(html).not.toContain('Onaya göndermek için aç');
    expect(html).not.toContain('Tüm iş detaylarını aç');
    expect(html).not.toContain('Özeti aç');
    expect(html).not.toContain('Özeti kapat');
    expect(html).toContain('href="/jobs/job-1"');
  });

  it('offers open-for-action controls only for allowed primary and labelled secondary commands', () => {
    const html = renderListJob(listJob({
      status: 'WAITING_APPROVAL',
      allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'],
    }), manager);
    expect(html).toContain('Yönetici kontrolünü aç');
    expect(html).toContain('Düzeltme kararını aç');
    expect(html).not.toContain('Onaylamak için aç');
    expect(html).not.toContain('Düzeltme istemek için aç');
    expect(html).not.toContain('Kontrolden geri çek');
    expect(html).not.toContain('Özeti aç');
    expect(html).not.toContain('Tüm iş detaylarını aç');
    expect(html).toContain('data-job-command="APPROVE"');
    expect(html).toContain('data-job-command-priority="primary"');
    expect(html).toContain('data-job-command="REQUEST_REVISION"');
    expect(html).toContain('data-job-command-priority="secondary"');
    // Only the owned primary command uses primary fill; REQUEST_REVISION stays secondary.
    expect(html).toMatch(/class="[^"]*primary-button[^"]*"[^>]*data-job-command="APPROVE"/);
    expect(html).toMatch(/class="[^"]*secondary-button[^"]*"[^>]*data-job-command="REQUEST_REVISION"/);
  });

  it('keeps scannable information order: title, type, customer, then metadata and actions', () => {
    const html = renderListJob(listJob({
      status: 'WAITING_APPROVAL',
      allowedCommands: ['APPROVE', 'REQUEST_REVISION'],
    }), manager);
    const titleAt = html.indexOf('ABC Klinik teslimi');
    const typeAt = html.indexOf('Ürün teslimi');
    const customerAt = html.indexOf('<dt>Müşteri</dt>');
    const signalsAt = html.indexOf('data-job-row-signals="true"');
    const commandsAt = html.indexOf('data-job-row-commands="true"');
    expect(titleAt).toBeGreaterThan(-1);
    expect(typeAt).toBeGreaterThan(titleAt);
    expect(customerAt).toBeGreaterThan(typeAt);
    expect(signalsAt).toBeGreaterThan(customerAt);
    expect(commandsAt).toBeGreaterThan(signalsAt);
    expect(html).toContain('data-job-list-card="true"');
    expect(html).not.toContain('box-shadow');
  });

  it('does not fabricate delivery facts for General Task rows', () => {
    const html = renderList({ kind: 'ready', page: page([{
      ...item, type: 'GENERAL_TASK', title: 'Teklif dönüşünü takip et', deliveryItemCount: 0,
      engagementKind: null,
    }]) });

    expect(html).not.toContain('<dt>Teslim</dt>');
    expect(html).not.toContain('0 ürün kalemi');
  });

  it('labels Sales Meeting rows with planned day and no delivery fact', () => {
    const html = renderList({ kind: 'ready', page: page([{
      ...item, type: 'SALES_MEETING', title: 'İmplant görüşmesi', deliveryItemCount: 0,
      engagementKind: 'SALES_MEETING',
    }]) });
    expect(html).toContain('Satış görüşmesi'); expect(html).toContain('Planlanan görüşme günü');
    expect(html).not.toContain('ürün kalemi');
  });

  it('prefers scheduledAt over dueDate on list cards', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'));
    try {
      const html = renderList({ kind: 'ready', page: page([{
        ...item,
        scheduledAt: '2026-07-21T09:30:00.000Z',
        dueDate: '2026-07-25',
      }]) });
      expect(html).toContain('Planlanan teslim');
      expect(html).toContain('dateTime="2026-07-21T09:30:00.000Z"');
      expect(html).not.toContain('<dt>Termin</dt>');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the server page range and explicit previous/next actions', () => {
    const html = renderList({ kind: 'ready', page: page([item], 25, 80) });
    expect(html).toContain('26–50 / 80'); expect(html).toContain('Önceki'); expect(html).toContain('Sonraki');
  });

});

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('routed JobCard workspace', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

  async function mount(initialEntry: string, load: Parameters<typeof JobWorkspace>[0]['load'], user = manager,
    loadBoard?: Parameters<typeof JobWorkspace>[0]['loadBoard']) {
    const router = createMemoryRouter([{ path: '/jobs', element: <JobWorkspace user={user} load={load} loadBoard={loadBoard} /> }], { initialEntries: [initialEntry] });
    await act(async () => root.render(<RouterProvider router={router} />));
    return router;
  }

  it('initializes exact labelled filters from URL and requests the canonical server page', async () => {
    const assignedTo = '33333333-3333-4333-8333-333333333333';
    const customerId = '44444444-4444-4444-8444-444444444444';
    const load = vi.fn().mockResolvedValue(page([item], 25, 80));
    const router = await mount(`/jobs?q=klinik&status=WAITING_APPROVAL&type=PRODUCT_DELIVERY&assignedTo=${assignedTo}&customerId=${customerId}&priority=urgent&dueAfter=2026-07-01&dueBefore=2026-07-31&offset=25`, load);
    await act(async () => { await Promise.resolve(); });
    expect(load).toHaveBeenCalledWith({ q: 'klinik', status: 'WAITING_APPROVAL', type: 'PRODUCT_DELIVERY', assignedTo, customerId, priority: 'urgent', dueAfter: '2026-07-01', dueBefore: '2026-07-31', limit: 25, offset: 25 });
    for (const id of ['job-search', 'job-status', 'job-priority', 'job-type', 'job-assignee', 'job-customer', 'job-due-after', 'job-due-before']) {
      expect(container.querySelector(`label[for="${id}"]`)).not.toBeNull();
    }
    expect(container.textContent).toContain('En uzun süredir onay bekleyen işler önce gösterilir.');
    const assignee = container.querySelector<HTMLInputElement>('#job-assignee')!;
    await act(async () => change(assignee, '3333'));
    expect(assignee.value).toBe('3333');
    expect(router.state.location.search).toContain(`assignedTo=${assignedTo}`);
    const replacement = '55555555-5555-4555-8555-555555555555';
    await act(async () => change(assignee, replacement));
    await act(async () => assignee.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(router.state.location.search).toContain(`assignedTo=${replacement}`);
    expect(router.state.location.search).not.toContain('offset=25');
  });

  it('trims submitted search, resets offset, and writes quick views as canonical URLs', async () => {
    const load = vi.fn().mockResolvedValue(page([]));
    const router = await mount('/jobs?q=eski&offset=25', load); await act(async () => { await Promise.resolve(); });
    const search = container.querySelector<HTMLInputElement>('#job-search')!;
    await act(async () => change(search, '  klinik  '));
    await act(async () => search.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(router.state.location.search).toBe('?q=klinik');
    const approval = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find((link) => link.textContent === 'Onay kuyruğu')!;
    await act(async () => approval.click());
    expect(router.state.location.search).toBe('?q=klinik&status=WAITING_APPROVAL');
    const revision = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find((link) => link.textContent === 'Düzeltme istenenler')!;
    await act(async () => revision.click());
    expect(router.state.location.search).toBe('?q=klinik&status=REVISION_REQUESTED');
    const active = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find((link) => link.textContent === 'Aktif işler')!;
    await act(async () => active.click());
    expect(router.state.location.search).toBe('?q=klinik');
    const closed = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find((link) => link.textContent === 'Biten işler')!;
    await act(async () => closed.click());
    expect(router.state.location.search).toBe('?q=klinik&status=closed');
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'closed', limit: 25 }));
  });

  it('renders Biten işler after the existing quick views and resets list pagination', async () => {
    const load = vi.fn().mockResolvedValue(page([item], 25, 80));
    await mount('/jobs?q=klinik&status=closed&priority=high&offset=25', load);
    await act(async () => { await Promise.resolve(); });
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('.job-quick-views a'));
    expect(links.map((link) => link.textContent)).toEqual([
      'Aktif işler', 'Onay kuyruğu', 'Düzeltme istenenler', 'Biten işler',
    ]);
    const closed = links.at(-1)!;
    expect(closed.getAttribute('href')).toBe('/jobs?q=klinik&status=closed&priority=high');
    expect(closed.getAttribute('aria-current')).toBe('page');
    expect(closed.getAttribute('data-state')).toBe('current');
    expect(links.slice(0, -1).every((link) => link.getAttribute('data-state') === 'idle')).toBe(true);
  });

  it('shows Biten işler to Staff without exposing the approval queue', async () => {
    const load = vi.fn().mockResolvedValue(page([]));
    await mount('/jobs', load, staff); await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Biten işler');
    expect(container.textContent).not.toContain('Onay kuyruğu');
  });

  it('canonicalizes a closed board URL and loads only the terminal list', async () => {
    const load = vi.fn().mockResolvedValue(page([item], 25, 80));
    const loadBoard = vi.fn();
    const router = createMemoryRouter([{
      path: '/jobs', element: <JobWorkspace user={manager} load={load} loadBoard={loadBoard} />,
    }], { initialEntries: ['/jobs?q=klinik&status=closed&view=board&offset=25'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => { await Promise.resolve(); });
    expect(router.state.location.search).toBe('?q=klinik&status=closed&offset=25');
    expect(load).toHaveBeenCalledWith(expect.objectContaining({
      q: 'klinik', status: 'closed', offset: 25, limit: 25,
    }));
    expect(loadBoard).not.toHaveBeenCalled();
  });

  it('ignores stale list responses while keeping URL-owned controls mounted', async () => {
    const initial = deferred<Paginated<JobCardListItem>>(); const latest = deferred<Paginated<JobCardListItem>>();
    const load = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(latest.promise);
    const router = await mount('/jobs', load);
    const status = container.querySelector<HTMLSelectElement>('#job-status')!;
    await act(async () => change(status, 'closed'));
    expect(router.state.location.search).toBe('?status=closed');
    await act(async () => latest.resolve(page([{ ...item, id: 'latest', title: 'Güncel iş' }])));
    await act(async () => initial.resolve(page([{ ...item, id: 'stale', title: 'Eski iş' }])));
    expect(container.textContent).toContain('Güncel iş'); expect(container.textContent).not.toContain('Eski iş');
    expect(container.querySelector('#job-status')).toBe(status);
  });

  it('restores URL filters through browser history', async () => {
    const load = vi.fn().mockResolvedValue(page([]));
    const router = await mount('/jobs?status=closed', load); await act(async () => { await Promise.resolve(); });
    await act(async () => change(container.querySelector<HTMLSelectElement>('#job-status')!, 'active'));
    expect(router.state.location.search).toBe('');
    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.search).toBe('?status=closed');
    expect(container.querySelector<HTMLSelectElement>('#job-status')!.value).toBe('closed');
  });

  it('replaces non-canonical initial and history URLs while preserving valid allowed state', async () => {
    const customerId = '44444444-4444-4444-8444-444444444444';
    const load = vi.fn().mockResolvedValue(page([]));
    const router = await mount(`/jobs?unknown=x&status=active&view=list&offset=0&q=bir&q=iki&priority=urgent&customerId=${customerId}`, load);
    await act(async () => { await Promise.resolve(); });
    expect(router.state.location.search).toBe(`?customerId=${customerId}&priority=urgent`);
    expect(router.state.historyAction).toBe('REPLACE');
    expect(load).toHaveBeenLastCalledWith({ status: 'active', customerId, priority: 'urgent', limit: 25, offset: 0 });

    await act(async () => { await router.navigate('/jobs?status=closed'); });
    await act(async () => { await router.navigate('/jobs?unknown=x&status=active&q=bir&q=iki'); });
    expect(router.state.location.search).toBe('');
    expect(router.state.historyAction).toBe('REPLACE');
    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.search).toBe('?status=closed');
    await act(async () => { await router.navigate(1); });
    expect(router.state.location.search).toBe('');
  });

  it('keeps invalid UUID drafts unapplied with accessible errors and reconciles valid history state', async () => {
    const original = '33333333-3333-4333-8333-333333333333';
    const replacement = '55555555-5555-4555-8555-555555555555';
    const load = vi.fn().mockResolvedValue(page([]));
    const router = await mount(`/jobs?assignedTo=${original}`, load);
    await act(async () => { await Promise.resolve(); });
    const assignee = container.querySelector<HTMLInputElement>('#job-assignee')!;
    const customer = container.querySelector<HTMLInputElement>('#job-customer')!;

    await act(async () => change(assignee, 'not-a-uuid'));
    await act(async () => change(customer, 'also-not-a-uuid'));
    await act(async () => assignee.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(router.state.location.search).toBe(`?assignedTo=${original}`);
    expect(assignee.value).toBe('not-a-uuid');
    expect(assignee.getAttribute('aria-invalid')).toBe('true');
    const errorId = assignee.getAttribute('aria-describedby')!;
    expect(container.querySelector(`#${errorId}`)?.textContent).toContain('Geçerli bir personel kimliği girin');
    expect(customer.getAttribute('aria-invalid')).toBe('true');
    const customerErrorId = customer.getAttribute('aria-describedby')!;
    expect(container.querySelector(`#${customerErrorId}`)?.textContent).toContain('Geçerli bir müşteri kimliği girin');

    await act(async () => change(assignee, replacement));
    await act(async () => change(customer, ''));
    await act(async () => assignee.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(router.state.location.search).toBe(`?assignedTo=${replacement}`);
    expect(assignee.getAttribute('aria-invalid')).not.toBe('true');
    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.search).toBe(`?assignedTo=${original}`);
    expect(container.querySelector<HTMLInputElement>('#job-assignee')!.value).toBe(original);
  });

  it('replaces an out-of-range empty page with the last valid offset before rendering results', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(page([], 50, 50))
      .mockResolvedValueOnce(page([item], 25, 50));
    const router = await mount('/jobs?offset=50', load);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(router.state.location.search).toBe('?offset=25');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(container.textContent).toContain('26–50 / 50');
    expect(container.textContent).not.toContain('76–50');
    expect(container.textContent).not.toContain('Henüz iş kaydı yok');
    expect(container.textContent).not.toContain('Filtrelere uygun iş bulunamadı');
    expect(load).toHaveBeenNthCalledWith(2, { status: 'active', limit: 25, offset: 25 });
  });

  it.each([
    ['/jobs?offset=25', '', 'Henüz iş kaydı yok', 'Filtrelere uygun iş bulunamadı'],
    ['/jobs?q=klinik&offset=25', '?q=klinik', 'Filtrelere uygun iş bulunamadı', 'Henüz iş kaydı yok'],
  ])('removes a positive offset before rendering an empty total for %s', async (initialEntry, expectedSearch, expectedEmpty, unexpectedEmpty) => {
    const initial = deferred<Paginated<JobCardListItem>>();
    const corrected = deferred<Paginated<JobCardListItem>>();
    const load = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(corrected.promise);
    const router = await mount(initialEntry, load);

    await act(async () => initial.resolve(page([], 25, 0)));
    expect(router.state.location.search).toBe(expectedSearch);
    expect(router.state.historyAction).toBe('REPLACE');
    expect(container.textContent).not.toContain('Henüz iş kaydı yok');
    expect(container.textContent).not.toContain('Filtrelere uygun iş bulunamadı');

    await act(async () => corrected.resolve(page([], 0, 0)));
    expect(container.textContent).toContain(expectedEmpty);
    expect(container.textContent).not.toContain(unexpectedEmpty);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('loads the compact PR B board without issuing a list request', async () => {
    const load = vi.fn().mockResolvedValue(page([]));
    const board: JobCardBoard = {
      columns: {
        NEW: { items: [], count: 0 },
        ACCEPTED: { items: [], count: 0 },
        IN_PROGRESS: { items: [], count: 0 },
        WAITING_APPROVAL: { items: [item], count: 1 },
        REVISION_REQUESTED: { items: [], count: 0 },
      },
      closedCounts: { COMPLETED: 0, CANCELLED: 0 },
    };
    const loadBoard = vi.fn().mockResolvedValue(board);
    await mount('/jobs?view=board', load, manager, loadBoard);
    await act(async () => { await Promise.resolve(); });
    expect(load).not.toHaveBeenCalled();
    expect(loadBoard).toHaveBeenCalledWith({});
    expect(container.querySelector('[data-workflow-lane]')?.getAttribute('data-workflow-lane'))
      .toBe('WAITING_APPROVAL');
    expect(container.textContent).toContain('ABC Klinik teslimi');
  });

  it('opens detail from the title link without a summary disclosure and emits only permitted commands', async () => {
    const command = vi.fn();
    const load = vi.fn().mockResolvedValue(page([{
      ...item,
      status: 'IN_PROGRESS',
      allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
    }]));
    const router = createMemoryRouter([{ path: '/jobs', element: <JobWorkspace user={staff} load={load} onCommand={command} /> }], { initialEntries: ['/jobs'] });
    await act(async () => root.render(<RouterProvider router={router} />)); await act(async () => { await Promise.resolve(); });

    const row = container.querySelector<HTMLElement>('[data-job-id="job-1"]')!;
    const titleLink = Array.from(row.querySelectorAll<HTMLAnchorElement>('a')).find((link) => link.textContent === 'ABC Klinik teslimi')!;
    expect(titleLink.getAttribute('href')).toBe('/jobs/job-1');
    expect(row.querySelector('[aria-expanded]')).toBeNull();
    expect(container.textContent).not.toContain('Özeti aç');
    expect(container.textContent).not.toContain('Özeti kapat');
    expect(container.textContent).not.toContain('Tüm iş detaylarını aç');
    expect(container.textContent).toContain('Kontrole göndermek için aç');
    expect(container.textContent).not.toContain('Yönetici kontrolünü aç');
    expect(container.textContent).not.toContain('Sürüm 7');
    for (const value of ['Uygulanıyor', 'Acil öncelik', 'ABC Klinik', 'Ayşe Personel', '20 Tem 2026']) {
      expect(row.textContent).toContain(value);
    }

    await act(async () => (Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Kontrole göndermek için aç') as HTMLButtonElement).click());
    expect(command).toHaveBeenCalledWith({ name: 'SUBMIT_FOR_APPROVAL', jobId: 'job-1', expectedVersion: 7 });
    expect(command.mock.results[0]?.value).toBeUndefined();
    expect(router.state.location.pathname).toBe('/jobs');
  });

  it('shows primary and labelled secondary open controls without expand for management review', async () => {
    const command = vi.fn();
    const load = vi.fn().mockResolvedValue(page([item]));
    const router = createMemoryRouter([{
      path: '/jobs', element: <JobWorkspace user={manager} load={load} onCommand={command} />,
    }], { initialEntries: ['/jobs'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Yönetici kontrolünü aç');
    expect(container.textContent).toContain('Düzeltme kararını aç');
    expect(container.textContent).not.toContain('Kontrolden geri çek');
    expect(container.textContent).not.toContain('Özeti aç');
    await act(async () => (
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Düzeltme kararını aç') as HTMLButtonElement
    ).click());
    expect(command).toHaveBeenCalledWith({
      name: 'REQUEST_REVISION', jobId: 'job-1', expectedVersion: 7,
    });
    expect(router.state.location.pathname).toBe('/jobs');
  });

  it('shows the canonical General Task type on the card without an expand step', async () => {
    const load = vi.fn().mockResolvedValue(page([{
      ...item, type: 'GENERAL_TASK', title: 'Klinik dönüşünü takip et', deliveryItemCount: 0,
      engagementKind: null,
    }]));
    await mount('/jobs', load);
    await act(async () => { await Promise.resolve(); });

    const row = container.querySelector<HTMLElement>('[data-job-id="job-1"]')!;
    expect(row.textContent).toContain('Genel görev');
    expect(row.textContent).not.toContain('Ürün teslimi');
    expect(row.textContent).not.toContain('ürün kalemi');
    expect(row.querySelector('[aria-expanded]')).toBeNull();
    expect(row.textContent).not.toContain('Özeti aç');
  });
});
