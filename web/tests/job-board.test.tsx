/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobBoard } from '../src/jobs/JobBoard';
import { JobWorkspace } from '../src/jobs/JobWorkspace';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';
import type { JobCardBoard, JobCardListItem, Paginated } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: '22222222-2222-4222-8222-222222222222', organizationId: 'org-1', name: 'Murat Yönetici',
  email: 'murat@example.com', role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};
const baseItem: JobCardListItem = {
  id: 'job-new', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 2, title: 'ABC Klinik teslimi',
  engagementKind: null,
  priority: 'urgent', dueDate: '2026-07-20', scheduledAt: null,
  createdAt: '2026-07-10T10:00:00.000Z',
  updatedAt: '2026-07-13T10:00:00.000Z', staffCompletedAt: null,
  customer: { id: 'customer-1', name: 'ABC Klinik' }, contact: { id: 'contact-1', name: 'Dr. Deniz' },
  assignee: { id: 'staff-1', name: 'Ayşe Personel' }, deliveryItemCount: 2,
  allowedCommands: ['ACCEPT_ASSIGNMENT', 'CANCEL'],
};

function item(status: JobCardListItem['status'], id: string, title = baseItem.title): JobCardListItem {
  return { ...baseItem, id, status, title };
}

const board: JobCardBoard = {
  columns: {
    NEW: { items: [item('NEW', 'job-new')], count: 1 },
    ACCEPTED: { items: [item('ACCEPTED', 'job-accepted')], count: 1 },
    IN_PROGRESS: { items: [item('IN_PROGRESS', 'job-progress')], count: 1 },
    WAITING_APPROVAL: { items: [item('WAITING_APPROVAL', 'job-waiting')], count: 4 },
    REVISION_REQUESTED: { items: [item('REVISION_REQUESTED', 'job-revision')], count: 1 },
  },
  closedCounts: { COMPLETED: 6, CANCELLED: 2 },
};

function page(items: JobCardListItem[], offset = 0, total = items.length): Paginated<JobCardListItem> {
  return { items, total, limit: 25, offset };
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

class FakeRealtimeEventSource implements RealtimeEventSource {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {}

  emitChange(data: object) {
    const event = new MessageEvent('servora.change', { data: JSON.stringify(data) });
    this.listeners.get('servora.change')?.forEach((listener) => listener(event));
  }
}

describe('read-only JobCard board', () => {
  it('renders five approved horizontal lanes, filtered list links, canonical cards, and closed counts', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <MemoryRouter><JobBoard board={board} user={manager} compact={false}
        params={new URLSearchParams('q=klinik&priority=urgent&offset=25&view=board')} /></MemoryRouter>,
    );
    const lanes = Array.from(host.querySelectorAll<HTMLElement>('[data-workflow-lane]'));
    expect(lanes).toHaveLength(5);
    expect(lanes.map((lane) => lane.getAttribute('data-workflow-lane'))).toEqual([
      'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
    ]);
    expect(lanes.map((lane) => lane.querySelector('h2')?.textContent)).toEqual([
      'Hazırlanıyor1', 'Atandı1', 'Uygulanıyor1', 'Yönetici kontrolünde4', 'Düzeltme istendi1',
    ]);
    expect(host.querySelectorAll('.job-status-shape')).toHaveLength(5);
    expect(host.querySelector('[data-workflow-lane="PLANNED"]')).toBeNull();
    expect(host.textContent).not.toContain('Planlandı');

    const laneLinks = Array.from(host.querySelectorAll<HTMLAnchorElement>('.workflow-lane-link'));
    expect(laneLinks).toHaveLength(5);
    expect(laneLinks.every((link) => link.textContent === 'Tümünü gör')).toBe(true);
    expect(laneLinks[2]?.getAttribute('href')).toContain('q=klinik');
    expect(laneLinks[2]?.getAttribute('href')).toContain('priority=urgent');
    expect(laneLinks[2]?.getAttribute('href')).toContain('status=IN_PROGRESS');
    expect(laneLinks[2]?.getAttribute('href')).not.toContain('view=');
    expect(laneLinks[2]?.getAttribute('href')).not.toContain('offset=');

    const card = host.querySelector<HTMLElement>('[data-board-card="job-waiting"]')!;
    for (const value of ['ABC Klinik teslimi', 'Ürün teslimi', 'Acil öncelik', 'ABC Klinik', 'Dr. Deniz', 'Ayşe Personel', '20 Tem 2026', '2 ürün kalemi']) {
      expect(card.textContent).toContain(value);
    }
    expect(card.querySelectorAll('a')).toHaveLength(1);
    expect(card.querySelector('a')?.getAttribute('href')).toBe('/jobs/job-waiting');
    expect(card.querySelector('a button, button a, a a')).toBeNull();

    const closedLinks = Array.from(host.querySelectorAll<HTMLAnchorElement>('.job-board-closed a'));
    expect(closedLinks.map((link) => link.textContent)).toEqual(['Tamamlandı6', 'İptal edildi2']);
    expect(closedLinks[0]?.getAttribute('href')).toContain('status=COMPLETED');
    expect(closedLinks[0]?.getAttribute('href')).not.toContain('view=');
    expect(closedLinks[0]?.getAttribute('href')).not.toContain('offset=');
    expect(host.querySelector('button, [role="menu"], [draggable="true"]')).toBeNull();
    expect(host.textContent?.toLocaleLowerCase('tr-TR')).not.toMatch(/sürükle|drag|bırak/);
  });

  it('uses role-priority source order only for compact lanes', () => {
    const renderOrder = (user: CurrentUser, compact: boolean) => {
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(
        <MemoryRouter><JobBoard board={board} user={user} compact={compact}
          params={new URLSearchParams('view=board')} /></MemoryRouter>,
      );
      return Array.from(host.querySelectorAll<HTMLElement>('[data-workflow-lane]'))
        .map((lane) => lane.dataset.workflowLane);
    };

    expect(renderOrder(manager, false)).toEqual([
      'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
    ]);
    expect(renderOrder(manager, true)).toEqual([
      'WAITING_APPROVAL', 'REVISION_REQUESTED', 'IN_PROGRESS', 'NEW', 'ACCEPTED',
    ]);
    expect(renderOrder({ ...manager, role: 'STAFF' }, true)).toEqual([
      'REVISION_REQUESTED', 'IN_PROGRESS', 'ACCEPTED', 'NEW', 'WAITING_APPROVAL',
    ]);
  });

  it('caps lane previews at four while preserving the backend count', () => {
    const previewBoard: JobCardBoard = {
      ...board,
      columns: {
        ...board.columns,
        NEW: {
          items: Array.from({ length: 5 }, (_, index) => item('NEW', `job-${index}`)),
          count: 9,
        },
      },
    };
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <MemoryRouter><JobBoard board={previewBoard} user={manager} compact={false}
        params={new URLSearchParams()} /></MemoryRouter>,
    );
    const lane = host.querySelector<HTMLElement>('[data-workflow-lane="NEW"]')!;
    expect(lane.querySelector('h2')?.textContent).toBe('Hazırlanıyor9');
    expect(lane.querySelectorAll('[data-board-card]')).toHaveLength(4);
  });

  it('shows an explicit empty lane state', () => {
    const emptyBoard: JobCardBoard = {
      ...board,
      columns: { ...board.columns, ACCEPTED: { items: [], count: 0 } },
    };
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <MemoryRouter><JobBoard board={emptyBoard} user={manager} compact={false}
        params={new URLSearchParams()} /></MemoryRouter>,
    );
    const emptyLane = host.querySelector<HTMLElement>('[data-workflow-lane="ACCEPTED"]')!;
    expect(emptyLane.classList.contains('workflow-lane--empty')).toBe(true);
    expect(emptyLane.getAttribute('data-lane-empty')).toBe('true');
    expect(emptyLane.querySelector('.workflow-lane-empty')?.textContent)
      .toBe('Bu aşamada iş yok.');
    expect(emptyLane.querySelector('.workflow-lane-count')?.textContent).toBe('0');
    expect(emptyLane.querySelector('.workflow-lane-link')?.textContent).toBe('Tümünü gör');
  });

  it('exposes lane label, count chip, and see-all control as distinct heading parts', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <MemoryRouter><JobBoard board={board} user={manager} compact={false}
        params={new URLSearchParams('view=board')} /></MemoryRouter>,
    );
    const waiting = host.querySelector<HTMLElement>('[data-workflow-lane="WAITING_APPROVAL"]')!;
    expect(waiting.querySelector('.workflow-lane-status')?.textContent).toBe('Yönetici kontrolünde');
    expect(waiting.querySelector('.workflow-lane-count')?.textContent).toBe('4');
    expect(waiting.querySelector('.workflow-lane-link')?.textContent).toBe('Tümünü gör');
    expect(host.querySelector('[data-job-board="true"]')?.getAttribute('data-board-layout')).toBe('wide');
    expect(host.querySelectorAll('.job-board-columns, .job-board-column')).toHaveLength(0);
  });

  it('shows the same compact workflow summary as list for waiting approval', () => {
    const waiting = {
      ...baseItem,
      id: 'job-waiting',
      status: 'WAITING_APPROVAL' as const,
      allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'] as JobCardListItem['allowedCommands'],
    };
    const summaryBoard: JobCardBoard = {
      ...board,
      columns: {
        ...board.columns,
        WAITING_APPROVAL: { items: [waiting], count: 1 },
      },
    };
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <MemoryRouter><JobBoard board={summaryBoard} user={manager} params={new URLSearchParams()} /></MemoryRouter>,
    );
    const card = host.querySelector<HTMLElement>('[data-board-card="job-waiting"]')!;
    expect(card.textContent).toContain('4 / 5');
    expect(card.textContent).toContain('Yönetici kontrolünde');
    expect(card.textContent).toContain('İşlem beklenen: Yönetici');
    expect(card.querySelector('.compact-workflow')).not.toBeNull();
  });

  it('marks correction attention on board cards without claiming completed phases', () => {
    const revision = {
      ...baseItem,
      id: 'job-revision',
      status: 'REVISION_REQUESTED' as const,
      allowedCommands: ['RESUME', 'CANCEL'] as JobCardListItem['allowedCommands'],
    };
    const revisionBoard: JobCardBoard = {
      ...board,
      columns: {
        ...board.columns,
        REVISION_REQUESTED: { items: [revision], count: 1 },
      },
    };
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <MemoryRouter><JobBoard board={revisionBoard} user={manager} params={new URLSearchParams()} /></MemoryRouter>,
    );
    const card = host.querySelector<HTMLElement>('[data-board-card="job-revision"]')!;
    expect(card.textContent).toContain('3 / 5');
    expect(card.textContent).toContain('Düzeltme istendi');
    expect(card.textContent).toContain('Yönetici notu mevcut');
    expect(card.querySelector('.compact-workflow--attention')).not.toBeNull();
    expect(card.textContent).not.toContain('3 aşama tamamlandı');
  });

  it('labels General Task cards without delivery facts or empty delivery state', () => {
    const generalTask = {
      ...baseItem, id: 'task-1', type: 'GENERAL_TASK' as const,
      engagementKind: null,
      title: 'Teklif dönüşünü takip et', deliveryItemCount: 0,
    };
    const mixedBoard: JobCardBoard = {
      ...board,
      columns: { ...board.columns, NEW: { items: [generalTask], count: 1 } },
    };
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <MemoryRouter><JobBoard board={mixedBoard} user={manager} params={new URLSearchParams()} /></MemoryRouter>,
    );
    const card = host.querySelector<HTMLElement>('[data-board-card="task-1"]')!;

    expect(card.textContent).toContain('Genel görev');
    expect(card.textContent).not.toContain('Teslim');
    expect(card.textContent).not.toContain('ürün kalemi');
  });

  it('labels Sales Meeting cards and omits delivery facts', () => {
    const meeting = { ...baseItem, id: 'meeting-1', type: 'SALES_MEETING' as const,
    engagementKind: 'SALES_MEETING',
      title: 'İmplant görüşmesi', deliveryItemCount: 0 };
    const meetingBoard = { ...board, columns: { ...board.columns,
      NEW: { items: [meeting], count: 1 } } };
    const host = document.createElement('div'); host.innerHTML = renderToStaticMarkup(
      <MemoryRouter><JobBoard board={meetingBoard} user={manager} params={new URLSearchParams()} /></MemoryRouter>);
    const card = host.querySelector('[data-board-card="meeting-1"]')!;
    expect(card.textContent).toContain('Satış görüşmesi'); expect(card.textContent).toContain('Planlanan görüşme günü');
  });

  it('prefers scheduledAt over dueDate on board cards', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T09:00:00.000Z'));

    try {
      const withSchedule: JobCardBoard = {
        ...board,
        columns: {
          ...board.columns,
          NEW: {
            items: [{
              ...baseItem,
              id: 'job-scheduled',
              scheduledAt: '2026-07-22T14:00:00.000Z',
              dueDate: '2026-07-30',
            }],
            count: 1,
          },
        },
      };

      const html = renderToStaticMarkup(
        <MemoryRouter><JobBoard board={withSchedule} user={manager} params={new URLSearchParams()} /></MemoryRouter>,
      );
      const card = html.includes('data-board-card="job-scheduled"')
        ? html.slice(html.indexOf('data-board-card="job-scheduled"'))
        : html;
      expect(card).toContain('Planlanan teslim');
      expect(card).toContain('dateTime="2026-07-22T14:00:00.000Z"');
      const scheduledFragment = card.slice(0, card.indexOf('</article>') + '</article>'.length);
      expect(scheduledFragment).not.toContain('<dt>Termin</dt>');
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels a scheduled job as today when its scheduled date is today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T09:00:00.000Z'));

    try {
      const withSchedule: JobCardBoard = {
        ...board,
        columns: {
          ...board.columns,
          NEW: {
            items: [{
              ...baseItem,
              id: 'job-scheduled',
              scheduledAt: '2026-07-22T14:00:00.000Z',
              dueDate: '2026-07-30',
            }],
            count: 1,
          },
        },
      };

      const html = renderToStaticMarkup(
        <MemoryRouter><JobBoard board={withSchedule} user={manager} params={new URLSearchParams()} /></MemoryRouter>,
      );
      const card = html.includes('data-board-card="job-scheduled"')
        ? html.slice(html.indexOf('data-board-card="job-scheduled"'))
        : html;
      expect(card).toContain('Bugün');
      expect(card).not.toContain('Planlanan teslim');
    } finally {
      vi.useRealTimers();
    }
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

  it('replaces a closed board URL with its canonical list URL and loads only the terminal list', async () => {
    installMatchMedia(true);
    const listLoad = vi.fn().mockResolvedValue(page([
      item('COMPLETED', 'job-completed'),
    ], 50, 80));
    const boardLoad = vi.fn().mockResolvedValue(board);
    const { router } = await mount(
      '/jobs?q=klinik&status=closed&offset=50&view=board', listLoad, boardLoad,
    );
    await act(async () => { await Promise.resolve(); });
    expect(router.state.location.search).toBe('?q=klinik&status=closed&offset=50');
    expect(listLoad).toHaveBeenCalledWith({ q: 'klinik', status: 'closed', limit: 25, offset: 50 });
    expect(boardLoad).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-board-column]')).toHaveLength(0);
    expect(container.textContent).toContain('ABC Klinik teslimi');
  });

  it('enters board without status/offset and status selection returns to canonical list offset zero', async () => {
    installMatchMedia(true);
    const listLoad = vi.fn().mockResolvedValue(page([baseItem], 25, 80));
    const boardLoad = vi.fn().mockResolvedValue(board);
    const { router } = await mount('/jobs?status=IN_PROGRESS&offset=25', listLoad, boardLoad);
    await act(async () => { await Promise.resolve(); });
    const view = container.querySelector<HTMLSelectElement>('#job-view')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(view, 'board');
      view.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(router.state.location.search).toBe('?view=board');
    expect(boardLoad).toHaveBeenCalledTimes(1);

    const closed = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'))
      .find((link) => link.textContent === 'Biten işler')!;
    expect(closed.getAttribute('href')).toBe('/jobs?status=closed');

    const status = container.querySelector<HTMLSelectElement>('#job-status')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(status, 'COMPLETED');
      status.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(router.state.location.search).toBe('?status=COMPLETED');
    expect(listLoad).toHaveBeenLastCalledWith({ status: 'COMPLETED', limit: 25, offset: 0 });
    expect(container.querySelector('[data-board-column]')).toBeNull();
  });

  it('reconciles the mounted board without changing its current URL filters', async () => {
    installMatchMedia(true);
    const source = new FakeRealtimeEventSource();
    const boardLoad = vi.fn().mockResolvedValue(board);
    const router = createMemoryRouter([{
      path: '/jobs',
      element: <RealtimeProvider eventSourceFactory={() => source}>
        <JobWorkspace user={manager} load={vi.fn().mockResolvedValue(page([]))} loadBoard={boardLoad} />
      </RealtimeProvider>,
    }], { initialEntries: ['/jobs?view=board&q=klinik&priority=urgent'] });
    await act(async () => { root.render(<RouterProvider router={router} />); });
    await act(async () => { await Promise.resolve(); });
    expect(boardLoad).toHaveBeenCalledTimes(1);
    const searchBeforeRealtimeInvalidation = router.state.location.search;

    await act(async () => {
      source.emitChange({
        id: '1', type: 'job.updated', entity: { type: 'job-card', id: 'job-1' },
        resourceKeys: ['job-board'], occurredAt: '2026-07-20T10:00:00.000Z',
      });
      await Promise.resolve();
    });

    expect(boardLoad).toHaveBeenCalledTimes(2);
    expect(router.state.location.search).toBe(searchBeforeRealtimeInvalidation);
  });

  it('keeps compact board URLs and renders Manager control-queue lanes', async () => {
    installMatchMedia(false);
    const { router, listLoad, boardLoad } = await mount('/jobs?q=klinik&view=board');
    await act(async () => { await Promise.resolve(); });
    expect(router.state.location.search).toBe('?q=klinik&view=board');
    expect(boardLoad).toHaveBeenCalledWith({ q: 'klinik' });
    expect(listLoad).not.toHaveBeenCalled();
    expect(container.querySelector('[data-workflow-lane]')?.getAttribute('data-workflow-lane'))
      .toBe('WAITING_APPROVAL');
    expect(container.querySelector('#job-view')).toBeNull();
  });

  it('switches a compact board status filter to the canonical list URL', async () => {
    installMatchMedia(false);
    const listLoad = vi.fn().mockResolvedValue(page([item('WAITING_APPROVAL', 'job-filtered')]));
    const { router } = await mount('/jobs?q=klinik&view=board', listLoad);
    await act(async () => { await Promise.resolve(); });
    const trigger = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.startsWith('Filtreler'))!;
    await act(async () => trigger.click());
    const status = container.querySelector<HTMLSelectElement>('#job-status-sheet')!;
    await act(async () => {
      status.value = 'WAITING_APPROVAL';
      status.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const apply = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Uygula')!;
    await act(async () => apply.click());
    expect(router.state.location.search).toBe('?q=klinik&status=WAITING_APPROVAL');
    expect(listLoad).toHaveBeenCalledWith({
      q: 'klinik', status: 'WAITING_APPROVAL', limit: 25, offset: 0,
    });
  });

  it('keeps the inline list and board view control for desktop widths', async () => {
    const viewport = installMatchMedia(false);
    await mount('/jobs');
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('#job-view')).toBeNull();

    await act(async () => viewport.set(true));
    expect(container.querySelector<HTMLSelectElement>('#job-view')?.value).toBe('list');
  });

  it('keeps one in-flight board request stable across compact and desktop composition changes', async () => {
    const viewport = installMatchMedia(true);
    const pendingBoard = deferred<JobCardBoard>();
    const listLoad = vi.fn().mockResolvedValue(page([{ ...baseItem, id: 'list-job', title: 'Güncel liste işi' }]));
    const boardLoad = vi.fn().mockReturnValue(pendingBoard.promise);
    const { router } = await mount('/jobs?view=board', listLoad, boardLoad);
    expect(boardLoad).toHaveBeenCalledTimes(1);

    await act(async () => viewport.set(false));
    expect(router.state.location.search).toBe('?view=board');
    expect(container.querySelector('[data-board-column]')).toBeNull();
    await act(async () => pendingBoard.resolve({
      ...board,
      columns: { ...board.columns, NEW: { items: [item('NEW', 'current-board', 'Güncel pano işi')], count: 1 } },
    }));
    expect(container.textContent).toContain('Güncel pano işi');
    expect(container.textContent).not.toContain('Güncel liste işi');
    expect(container.querySelector('[data-workflow-lane]')?.getAttribute('data-workflow-lane'))
      .toBe('WAITING_APPROVAL');

    await act(async () => viewport.set(true));
    expect(router.state.location.search).toBe('?view=board');
    expect(boardLoad).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-workflow-lane]')?.getAttribute('data-workflow-lane')).toBe('NEW');
  });
});
