/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { countActiveJobFilters, JobFilters } from '../src/jobs/JobFilters';
import { countActiveCustomerFilters } from '../src/CustomerList';
import { FilterSheet } from '../src/ui/FilterSheet';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'm1', organizationId: 'o1', name: 'M', email: 'm@t.local', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
};

function setNarrow(narrow: boolean) {
  // JobFilters uses !(min-width: 64rem).matches
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('min-width: 64rem') ? !narrow : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

describe('filter sheets and active counts', () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    host?.remove();
    root = null;
    host = null;
    vi.unstubAllGlobals();
  });

  it('counts active job filters without counting default active status', () => {
    expect(countActiveJobFilters({ view: 'list', offset: 0, status: 'active' })).toBe(0);
    expect(countActiveJobFilters({
      view: 'list', offset: 0, status: 'WAITING_APPROVAL', q: 'abc', priority: 'urgent',
    })).toBe(3);
  });

  it('counts customer filters including unassigned', () => {
    expect(countActiveCustomerFilters({})).toBe(0);
    expect(countActiveCustomerFilters({ city: 'Ankara', unassigned: true })).toBe(2);
  });

  it('opens job filter sheet from compact trigger and applies draft', async () => {
    setNarrow(true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const onApply = vi.fn();
    const onChange = vi.fn();
    await act(async () => {
      root!.render(
        <JobFilters
          user={manager}
          filters={{ view: 'list', offset: 0, status: 'active', q: 'klinik' }}
          onApply={onApply}
          onChange={onChange}
          onViewChange={() => {}}
          showViewControl={false}
        />,
      );
    });
    expect(host.textContent).toContain('Filtreler');
    const trigger = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Filtreler'));
    await act(async () => trigger?.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    const priority = host.querySelector('#job-priority') as HTMLSelectElement;
    await act(async () => {
      priority.value = 'urgent';
      priority.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const apply = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Uygula');
    await act(async () => apply?.click());
    expect(onApply).toHaveBeenCalled();
    const payload = onApply.mock.calls.at(-1)?.[0];
    expect(payload).toMatchObject({ q: 'klinik', priority: 'urgent', status: 'active' });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('exposes immediate compact view controls outside the filter sheet', async () => {
    setNarrow(true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const onViewChange = vi.fn();
    await act(async () => {
      root!.render(
        <JobFilters
          user={manager}
          filters={{ view: 'list', offset: 0, status: 'active' }}
          onApply={() => undefined}
          onChange={() => undefined}
          onViewChange={onViewChange}
          showViewControl
        />,
      );
    });
    const switcher = host.querySelector<HTMLElement>('[aria-label="İş görünümü"]')!;
    const list = Array.from(switcher.querySelectorAll('button')).find((button) => button.textContent === 'Liste')!;
    const board = Array.from(switcher.querySelectorAll('button')).find((button) => button.textContent === 'Pano')!;
    expect(list.getAttribute('aria-pressed')).toBe('true');
    expect(board.getAttribute('aria-pressed')).toBe('false');
    await act(async () => board.click());
    expect(onViewChange).toHaveBeenCalledWith('board');

    const trigger = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Filtreler');
    await act(async () => trigger?.click());
    expect(host.querySelector('#job-view-sheet')).toBeNull();
    expect(host.querySelector('[role="dialog"]')?.contains(switcher)).toBe(false);
  });

  it('keeps list view unchanged when the compact filter sheet is cancelled', async () => {
    setNarrow(true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const onViewChange = vi.fn();
    await act(async () => {
      root!.render(
        <JobFilters
          user={manager}
          filters={{ view: 'list', offset: 0, status: 'active' }}
          onApply={() => undefined}
          onChange={() => undefined}
          onViewChange={onViewChange}
          showViewControl
        />,
      );
    });
    const trigger = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Filtreler');
    await act(async () => trigger?.click());
    const status = host.querySelector<HTMLSelectElement>('#job-status-sheet')!;
    await act(async () => {
      status.value = 'WAITING_APPROVAL';
      status.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const cancel = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Vazgeç');
    await act(async () => cancel?.click());
    expect(onViewChange).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="İş görünümü"] button[aria-pressed="true"]')?.textContent).toBe('Liste');
  });

  it('uses the workflow presentation labels in compact status filters', async () => {
    setNarrow(true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <JobFilters
          user={manager}
          filters={{ view: 'list', offset: 0, status: 'active' }}
          onApply={() => undefined}
          onChange={() => undefined}
          onViewChange={() => undefined}
          showViewControl
        />,
      );
    });
    const trigger = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Filtreler');
    await act(async () => trigger?.click());
    const labels = Array.from(host.querySelectorAll<HTMLOptionElement>('#job-status-sheet option'))
      .map((option) => [option.value, option.textContent]);
    expect(labels).toEqual([
      ['active', 'Aktif'],
      ['closed', 'Kapalı'],
      ['all', 'Tümü'],
      ['NEW', 'Hazırlanıyor'],
      ['ACCEPTED', 'Atandı'],
      ['IN_PROGRESS', 'Uygulanıyor'],
      ['WAITING_APPROVAL', 'Yönetici kontrolünde'],
      ['REVISION_REQUESTED', 'Düzeltme istendi'],
      ['COMPLETED', 'Tamamlandı'],
      ['CANCELLED', 'İptal edildi'],
    ]);
  });

  it('dismisses FilterSheet without calling apply', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const onClear = vi.fn();
    await act(async () => {
      root!.render(
        <FilterSheet open title="Test" onApply={onApply} onDismiss={onDismiss} onClear={onClear}>
          <p>alan</p>
        </FilterSheet>,
      );
    });
    const vazgec = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Vazgeç');
    await act(async () => vazgec?.click());
    expect(onDismiss).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});
