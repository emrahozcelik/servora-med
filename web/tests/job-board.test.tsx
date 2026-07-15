/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobBoard } from '../src/jobs/JobBoard';
import { JobWorkspace } from '../src/jobs/JobWorkspace';
import type { JobCardBoard, JobCardListItem, Paginated } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: '22222222-2222-4222-8222-222222222222', organizationId: 'org-1', name: 'Murat Yönetici',
  email: 'murat@example.com', role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};
const baseItem: JobCardListItem = {
  id: 'job-new', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 2, title: 'ABC Klinik teslimi',
  priority: 'urgent', dueDate: '2026-07-20', createdAt: '2026-07-10T10:00:00.000Z',
  updatedAt: '2026-07-13T10:00:00.000Z', staffCompletedAt: null,
  customer: { id: 'customer-1', name: 'ABC Klinik' }, contact: { id: 'contact-1', name: 'Dr. Deniz' },
  assignee: { id: 'staff-1', name: 'Ayşe Personel' }, deliveryItemCount: 2,
};

function item(status: JobCardListItem['status'], id: string, title = baseItem.title): JobCardListItem {
  return { ...baseItem, id, status, title };
}

const board: JobCardBoard = {
  columns: {
    NEW: { items: [item('NEW', 'job-new')], count: 1 },
    PLANNED: { items: [item('PLANNED', 'job-planned')], count: 1 },
    IN_PROGRESS: { items: [item('IN_PROGRESS', 'job-progress')], count: 1 },
    WAITING_APPROVAL: { items: [item('WAITING_APPROVAL', 'job-waiting')], count: 4 },
    REVISION_REQUESTED: { items: [item('REVISION_REQUESTED', 'job-revision')], count: 1 },
  },
  closedCounts: { COMPLETED: 6, CANCELLED: 2 },
};

function page(items: JobCardListItem[]): Paginated<JobCardListItem> {
  return { items, total: items.length, limit: 25, offset: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() { return matches; }, media: '(min-width: 64rem)', onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
  } as MediaQueryList;
  vi.stubGlobal('matchMedia', vi.fn(() => query));
  return {
    set(next: boolean) {
      matches = next;
      const event = { matches, media: query.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

describe('read-only JobCard board', () => {
  it('renders exactly five labelled active columns, counts, canonical cards, and closed list links', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<MemoryRouter><JobBoard board={board} params={new URLSearchParams('q=klinik&view=board')} /></MemoryRouter>);
    const columns = Array.from(host.querySelectorAll<HTMLElement>('[data-board-column]'));
    expect(columns).toHaveLength(5);
    expect(columns.map((column) => column.querySelector('h2')?.textContent)).toEqual([
      'Yeni1', 'Planlandı1', 'Devam ediyor1', 'Onay bekliyor4', 'Düzeltme istendi1',
    ]);
    expect(host.querySelectorAll('.job-status-shape')).toHaveLength(5);

    const card = host.querySelector<HTMLElement>('[data-board-card="job-waiting"]')!;
    for (const value of ['ABC Klinik teslimi', 'Ürün teslimi', 'Acil öncelik', 'ABC Klinik', 'Dr. Deniz', 'Ayşe Personel', '20 Tem 2026', '2 ürün kalemi']) {
      expect(card.textContent).toContain(value);
    }
    expect(card.querySelectorAll('a')).toHaveLength(1);
    expect(card.querySelector('a')?.getAttribute('href')).toBe('/jobs/job-waiting');

    const closedLinks = Array.from(host.querySelectorAll<HTMLAnchorElement>('.job-board-closed a'));
    expect(closedLinks.map((link) => link.textContent)).toEqual(['Tamamlandı6', 'İptal edildi2']);
    expect(closedLinks[0]?.getAttribute('href')).toContain('status=COMPLETED');
    expect(closedLinks[0]?.getAttribute('href')).toContain('view=list');
    expect(closedLinks[0]?.getAttribute('href')).toContain('offset=0');
    expect(host.querySelector('button, [role="menu"], [draggable="true"]')).toBeNull();
    expect(host.textContent?.toLocaleLowerCase('tr-TR')).not.toMatch(/sürükle|drag|bırak/);
  });

  it('labels General Task cards without delivery facts or empty delivery state', () => {
    const generalTask = {
      ...baseItem, id: 'task-1', type: 'GENERAL_TASK' as const,
      title: 'Teklif dönüşünü takip et', deliveryItemCount: 0,
    };
    const mixedBoard: JobCardBoard = {
      ...board,
      columns: { ...board.columns, NEW: { items: [generalTask], count: 1 } },
    };
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <MemoryRouter><JobBoard board={mixedBoard} params={new URLSearchParams()} /></MemoryRouter>,
    );
    const card = host.querySelector<HTMLElement>('[data-board-card="task-1"]')!;

    expect(card.textContent).toContain('Genel görev');
    expect(card.textContent).not.toContain('Teslim');
    expect(card.textContent).not.toContain('ürün kalemi');
  });

  it('labels Sales Meeting cards and omits delivery facts', () => {
    const meeting = { ...baseItem, id: 'meeting-1', type: 'SALES_MEETING' as const,
      title: 'İmplant görüşmesi', deliveryItemCount: 0 };
    const meetingBoard = { ...board, columns: { ...board.columns,
      NEW: { items: [meeting], count: 1 } } };
    const host = document.createElement('div'); host.innerHTML = renderToStaticMarkup(
      <MemoryRouter><JobBoard board={meetingBoard} params={new URLSearchParams()} /></MemoryRouter>);
    const card = host.querySelector('[data-board-card="meeting-1"]')!;
    expect(card.textContent).toContain('Satış görüşmesi'); expect(card.textContent).toContain('Planlanan görüşme günü');
    expect(card.textContent).not.toContain('ürün kalemi');
  });
});

describe('responsive routed JobCard board', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function mount(initialEntry: string, listLoad = vi.fn().mockResolvedValue(page([])), boardLoad = vi.fn().mockResolvedValue(board)) {
    const router = createMemoryRouter([{
      path: '/jobs', element: <JobWorkspace user={manager} load={listLoad} loadBoard={boardLoad} />,
    }], { initialEntries: [initialEntry] });
    await act(async () => root.render(<RouterProvider router={router} />));
    return { router, listLoad, boardLoad };
  }

  it('canonicalizes desktop board URLs before requesting only non-status filters', async () => {
    installMatchMedia(true);
    const { router, listLoad, boardLoad } = await mount('/jobs?q=klinik&status=closed&offset=50&view=board');
    await act(async () => { await Promise.resolve(); });
    expect(router.state.location.search).toBe('?q=klinik&view=board');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(boardLoad).toHaveBeenCalledWith({ q: 'klinik' });
    expect(listLoad).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-board-column]')).toHaveLength(5);
  });

  it('enters board without status/offset and status selection returns to canonical list offset zero', async () => {
    installMatchMedia(true);
    const { router, listLoad, boardLoad } = await mount('/jobs?status=closed&offset=25');
    await act(async () => { await Promise.resolve(); });
    const view = container.querySelector<HTMLSelectElement>('#job-view')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(view, 'board');
      view.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(router.state.location.search).toBe('?view=board');
    expect(boardLoad).toHaveBeenCalledTimes(1);

    const status = container.querySelector<HTMLSelectElement>('#job-status')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(status, 'COMPLETED');
      status.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(router.state.location.search).toBe('?status=COMPLETED');
    expect(listLoad).toHaveBeenLastCalledWith({ status: 'COMPLETED', limit: 25, offset: 0 });
    expect(container.querySelector('[data-board-column]')).toBeNull();
  });

  it('replaces compact board URLs before board render/request and loads list only after transition', async () => {
    installMatchMedia(false);
    const { router, listLoad, boardLoad } = await mount('/jobs?q=klinik&view=board');
    await act(async () => { await Promise.resolve(); });
    expect(router.state.location.search).toBe('?q=klinik');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(boardLoad).not.toHaveBeenCalled();
    expect(listLoad).toHaveBeenCalledWith({ q: 'klinik', status: 'active', limit: 25, offset: 0 });
    expect(container.querySelector('[data-board-column]')).toBeNull();
    expect(container.querySelector('#job-view')).toBeNull();
  });

  it('offers the list and board view control only at desktop widths', async () => {
    const viewport = installMatchMedia(false);
    await mount('/jobs');
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('#job-view')).toBeNull();

    await act(async () => viewport.set(true));
    expect(container.querySelector<HTMLSelectElement>('#job-view')?.value).toBe('list');
  });

  it('invalidates in-flight board data on compact resize and never restores board after desktop growth', async () => {
    const viewport = installMatchMedia(true);
    const pendingBoard = deferred<JobCardBoard>();
    const listLoad = vi.fn().mockResolvedValue(page([{ ...baseItem, id: 'list-job', title: 'Güncel liste işi' }]));
    const boardLoad = vi.fn().mockReturnValue(pendingBoard.promise);
    const { router } = await mount('/jobs?view=board', listLoad, boardLoad);
    expect(boardLoad).toHaveBeenCalledTimes(1);

    await act(async () => viewport.set(false));
    expect(router.state.location.search).toBe('');
    expect(container.querySelector('[data-board-column]')).toBeNull();
    await act(async () => pendingBoard.resolve({
      ...board,
      columns: { ...board.columns, NEW: { items: [item('NEW', 'stale-board', 'Eski pano işi')], count: 1 } },
    }));
    expect(container.textContent).toContain('Güncel liste işi');
    expect(container.textContent).not.toContain('Eski pano işi');

    await act(async () => viewport.set(true));
    expect(router.state.location.search).toBe('');
    expect(boardLoad).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-board-column]')).toBeNull();
  });
});
