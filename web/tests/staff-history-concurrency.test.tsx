/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrentUser } from '../src/services/api';
import type { JobHistoryItem, Paginated } from '../src/services/crm-api';

const people = vi.hoisted(() => ({ listStaffJobs: vi.fn() }));
const realtime = vi.hoisted(() => ({ useRealtimeInvalidation: vi.fn() }));

vi.mock('../src/services/people-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/people-api')>(),
  listStaffJobs: people.listStaffJobs,
}));
vi.mock('../src/realtime/RealtimeProvider', () => realtime);

import { StaffJobHistory } from '../src/StaffProfiles';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'manager@example.test', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
} as CurrentUser;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function page(title: string, offset = 0, total = 1): Paginated<JobHistoryItem> {
  return {
    items: [{
      id: title, title, type: 'GENERAL_TASK', status: 'IN_PROGRESS', priority: 'normal',
      scheduledAt: null, dueDate: null, createdAt: '2026-07-20T10:00:00.000Z',
      updatedAt: '2026-07-20T10:00:00.000Z', completedAt: null,
      assignee: { id: 'staff-1', name: 'Ayşe' }, customer: null, contact: null,
      followUp: null, childCount: null,
    }],
    total, limit: 20, offset,
  };
}

describe('StaffJobHistory concurrency', () => {
  let container: HTMLDivElement;
  let root: Root;
  let invalidate: (() => void) | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    invalidate = undefined;
    realtime.useRealtimeInvalidation.mockImplementation((_keys: string[], callback: () => void) => {
      invalidate = callback;
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderHistory() {
    await act(async () => {
      root.render(<MemoryRouter><StaffJobHistory actor={manager} staffUserId="staff-1" /></MemoryRouter>);
      await Promise.resolve();
    });
  }

  it('keeps the fast Open response when the older All response resolves later', async () => {
    const all = deferred<Paginated<JobHistoryItem>>();
    const open = deferred<Paginated<JobHistoryItem>>();
    people.listStaffJobs.mockImplementation((_id: string, filters: { status?: string }) =>
      filters.status === 'open' ? open.promise : all.promise);

    await renderHistory();
    const openTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Açık')!;
    await act(async () => openTab.click());
    await act(async () => open.resolve(page('Açık sonuç')));
    expect(container.textContent).toContain('Açık sonuç');

    await act(async () => all.resolve(page('Tümü sonuç')));
    expect(container.textContent).toContain('Açık sonuç');
    expect(container.textContent).not.toContain('Tümü sonuç');
  });

  it('ignores a slow page response after switching to Completed', async () => {
    const pageTwo = deferred<Paginated<JobHistoryItem>>();
    const completed = deferred<Paginated<JobHistoryItem>>();
    people.listStaffJobs
      .mockResolvedValueOnce(page('Tümü ilk sayfa', 0, 40))
      .mockImplementationOnce(() => pageTwo.promise)
      .mockImplementationOnce(() => completed.promise);

    await renderHistory();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      const more = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Daha fazla göster');
      expect(more).toBeTruthy();
      more?.click();
    });
    const completedTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Tamamlanan')!;
    await act(async () => completedTab.click());
    await act(async () => completed.resolve(page('Tamamlanan sonuç')));
    expect(container.textContent).toContain('Tamamlanan sonuç');

    await act(async () => pageTwo.resolve(page('Geç kalan sayfa 2', 20)));
    expect(container.textContent).toContain('Tamamlanan sonuç');
    expect(container.textContent).not.toContain('Geç kalan sayfa 2');
  });

  it('ignores a slow realtime refresh after a manual filter change', async () => {
    const realtimeRefresh = deferred<Paginated<JobHistoryItem>>();
    const completed = deferred<Paginated<JobHistoryItem>>();
    people.listStaffJobs
      .mockResolvedValueOnce(page('Tümü ilk'))
      .mockImplementationOnce(() => realtimeRefresh.promise)
      .mockImplementationOnce(() => completed.promise);

    await renderHistory();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => invalidate?.());
    const completedTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Tamamlanan')!;
    await act(async () => completedTab.click());
    await act(async () => completed.resolve(page('Manuel tamamlanan')));
    expect(container.textContent).toContain('Manuel tamamlanan');

    await act(async () => realtimeRefresh.resolve(page('Geç kalan realtime')));
    expect(container.textContent).toContain('Manuel tamamlanan');
    expect(container.textContent).not.toContain('Geç kalan realtime');
  });

  it('invalidates in-flight state on unmount', async () => {
    const pending = deferred<Paginated<JobHistoryItem>>();
    people.listStaffJobs.mockReturnValue(pending.promise);
    await renderHistory();
    await act(async () => root.unmount());
    await act(async () => pending.resolve(page('Unmount sonucu')));
    expect(container.textContent).toBe('');
  });
});
