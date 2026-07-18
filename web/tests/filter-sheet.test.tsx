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

  it('selects board view from the compact filter sheet through the existing callback', async () => {
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
    const view = host.querySelector<HTMLSelectElement>('#job-view-sheet')!;
    expect(view).not.toBeNull();
    expect(Array.from(view.options).map((option) => option.textContent)).toEqual(['Liste', 'Pano']);
    await act(async () => {
      view.value = 'board';
      view.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onViewChange).toHaveBeenCalledWith('board');
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
