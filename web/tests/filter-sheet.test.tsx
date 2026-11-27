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

function resizeTo(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
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
    })).toBe(1);
    expect(countActiveJobFilters({
      view: 'list', offset: 0, status: 'NEW', q: 'abc', priority: 'urgent',
    })).toBe(2);
    expect(countActiveJobFilters({
      view: 'list', offset: 0, status: 'WAITING_APPROVAL', followUp: 'only', priority: 'urgent',
    })).toBe(2);
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
          onClear={() => undefined}
          onChange={onChange}
          onViewChange={() => {}}
          boardSupported={false}
        />,
      );
    });
    expect(host.querySelector<HTMLButtonElement>('button[aria-label^="Filtreler"]')?.getAttribute('aria-label'))
      .toBe('Filtreler');
    expect(host.querySelector('.job-search-submit')?.getAttribute('aria-label')).toBe('Ara');
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label^="Filtreler"]');
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

  it('uses the wheel date trigger at 768px, commits it and keeps the nested scroll lock balanced', async () => {
    setNarrow(true);
    resizeTo(768);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const onApply = vi.fn();
    await act(async () => {
      root!.render(
        <JobFilters
          user={manager}
          filters={{ view: 'list', offset: 0, status: 'active', dueAfter: '2026-11-20' }}
          onApply={onApply}
          onClear={() => undefined}
          onChange={() => undefined}
          onViewChange={() => {}}
          boardSupported={false}
        />,
      );
    });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label^="Filtreler"]');
    await act(async () => trigger?.click());

    const dueAfter = host.querySelector<HTMLButtonElement>('#job-due-after');
    expect(dueAfter).not.toBeNull();
    expect(dueAfter!.tagName).toBe('BUTTON');
    expect(dueAfter!.hasAttribute('name')).toBe(false);
    expect(document.body.style.overflow).toBe('hidden');

    await act(async () => dueAfter!.click());
    const day = document.querySelector<HTMLElement>(
      '[role="spinbutton"][aria-label="Gün"]',
    )!;
    await act(async () => {
      day.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    const ok = [...document.querySelectorAll<HTMLButtonElement>('.wheel-sheet-actions button')]
      .find((button) => button.textContent === 'Tamam')!;
    await act(async () => ok.click());
    expect(dueAfter!.textContent).toContain('21 Kas');

    const apply = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Uygula');
    await act(async () => apply?.click());
    expect(onApply).toHaveBeenCalled();
    expect(onApply.mock.calls.at(-1)?.[0]).toMatchObject({ dueAfter: '2026-11-21' });
    expect(document.body.style.overflow).toBe('');
    resizeTo(1024);
  });

  it('renders compact search and filters as icon-only 44px targets with badge and names', async () => {
    setNarrow(true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <JobFilters
          user={manager}
          filters={{ view: 'list', offset: 0, status: 'active', priority: 'urgent' }}
          onApply={() => undefined}
          onClear={() => undefined}
          onChange={() => undefined}
          onViewChange={() => {}}
          boardSupported={false}
        />,
      );
    });

    const submit = host.querySelector<HTMLButtonElement>('button.job-search-submit')!;
    expect(submit.getAttribute('aria-label')).toBe('Ara');
    expect(submit.getAttribute('title')).toBe('Ara');
    expect(submit.textContent?.trim()).toBe('');
    expect(submit.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    const trigger = host.querySelector<HTMLButtonElement>('button.filter-sheet-trigger')!;
    expect(trigger.getAttribute('aria-label')).toBe('Filtreler, 1 etkin');
    expect(trigger.getAttribute('title')).toBe('Filtreler, 1 etkin');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent?.trim()).toBe('1');
    const badge = trigger.querySelector<HTMLElement>('[data-filter-badge="true"]')!;
    expect(badge.textContent).toBe('1');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(trigger.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders desktop jobs search submit as an icon-only 44px target and has no compact trigger', async () => {
    setNarrow(false);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <JobFilters
          user={manager}
          filters={{ view: 'list', offset: 0, status: 'active', priority: 'urgent' }}
          onApply={() => undefined}
          onClear={() => undefined}
          onChange={() => undefined}
          onViewChange={() => {}}
          boardSupported={false}
        />,
      );
    });
    expect(host.querySelector('[data-job-filters="desktop"]')).not.toBeNull();
    const submit = host.querySelector<HTMLButtonElement>('button.job-search-submit')!;
    expect(submit.getAttribute('aria-label')).toBe('Ara');
    expect(submit.getAttribute('title')).toBe('Ara');
    expect(submit.textContent?.trim()).toBe('');
    expect(submit.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.filter-sheet-trigger')).toBeNull();
    expect(host.querySelector('[data-filter-badge="true"]')).toBeNull();
  });

  it('applies the compact sheet follow-up checkbox through the same AntD control', async () => {
    setNarrow(true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const onApply = vi.fn();
    const onClear = vi.fn();
    const onChange = vi.fn();
    await act(async () => {
      root!.render(
        <JobFilters
          user={manager}
          filters={{ view: 'list', offset: 0, status: 'active' }}
          onApply={onApply}
          onClear={onClear}
          onChange={onChange}
          onViewChange={() => {}}
          boardSupported={false}
        />,
      );
    });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label^="Filtreler"]');
    await act(async () => trigger?.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    const checkbox = host.querySelector<HTMLInputElement>('#job-follow-up')!;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.classList.contains('ant-checkbox-input')).toBe(true);
    expect(checkbox.closest('label')?.textContent).toContain('Yalnız takip işleri');
    expect(checkbox.closest('.field-group')).toBeNull();
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(true);
    const apply = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Uygula');
    await act(async () => apply?.click());
    const payload = onApply.mock.calls.at(-1)?.[0];
    expect(payload).toMatchObject({ followUp: 'only', status: 'active' });
    expect(host.querySelector('[role="dialog"]')).toBeNull();

    // Clear filters resets the checkbox draft back to unchecked.
    const triggerAgain = host.querySelector<HTMLButtonElement>('button[aria-label^="Filtreler"]');
    await act(async () => triggerAgain?.click());
    const clear = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Temizle');
    await act(async () => clear?.click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('keeps the compact view controls inside the filter sheet', async () => {
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
          onClear={() => undefined}
          onChange={() => undefined}
          onViewChange={onViewChange}
          boardSupported
        />,
      );
    });
    // The persistent mobile row keeps search; the view switch no longer
    // competes with the first record (DECISIONS.md UI-005).
    expect(host.querySelector('[aria-label="İş görünümü"]')).toBeNull();
    expect(host.querySelector('#job-search')).not.toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label^="Filtreler"]');
    await act(async () => trigger?.click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    const switcher = dialog.querySelector<HTMLElement>('[aria-label="İş görünümü"]')!;
    expect(switcher).not.toBeNull();
    const list = Array.from(switcher.querySelectorAll('button')).find((button) => button.textContent === 'Liste')!;
    const board = Array.from(switcher.querySelectorAll('button')).find((button) => button.textContent === 'Pano')!;
    expect(list.getAttribute('aria-pressed')).toBe('true');
    expect(board.getAttribute('aria-pressed')).toBe('false');
    await act(async () => board.click());
    expect(onViewChange).toHaveBeenCalledWith('board');
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
          onClear={() => undefined}
          onChange={() => undefined}
          onViewChange={onViewChange}
          boardSupported
        />,
      );
    });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label^="Filtreler"]');
    await act(async () => trigger?.click());
    const status = host.querySelector<HTMLSelectElement>('#job-status-sheet')!;
    await act(async () => {
      status.value = 'WAITING_APPROVAL';
      status.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const cancel = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Vazgeç');
    await act(async () => cancel?.click());
    expect(onViewChange).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[aria-label="İş görünümü"]')).toBeNull();
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
          onClear={() => undefined}
          onChange={() => undefined}
          onViewChange={() => undefined}
          boardSupported
        />,
      );
    });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label^="Filtreler"]');
    await act(async () => trigger?.click());
    const labels = Array.from(host.querySelectorAll<HTMLOptionElement>('#job-status-sheet option'))
      .map((option) => [option.value, option.textContent]);
    expect(labels).toEqual([
      ['active', 'Aktif'],
      ['closed', 'Kapalı'],
      ['all', 'Tümü'],
      ['NEW', 'Atandı'],
      ['ACCEPTED', 'Kabul edildi'],
      ['IN_PROGRESS', 'Uygulanıyor'],
      ['WAITING_APPROVAL', 'Yönetici kontrolünde'],
      ['REVISION_REQUESTED', 'Düzeltme istendi'],
      ['COMPLETED', 'Tamamlandı'],
      ['CANCELLED', 'İptal edildi'],
      ['INVALIDATED', 'Geçersiz'],
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

  it('shows desktop Filtreleri temizle only when filters are active and calls onClear', async () => {
    setNarrow(false);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const onClear = vi.fn();

    await act(async () => {
      root!.render(
        <JobFilters
          user={manager}
          filters={{ view: 'list', offset: 0, status: 'active' }}
          onApply={() => {}}
          onClear={onClear}
          onChange={() => {}}
          onViewChange={() => {}}
          boardSupported
        />,
      );
    });
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Filtreleri temizle')).toBe(false);

    // A quick-view membership is not a filter: no clear action that would
    // leave the chosen view.
    for (const status of ['WAITING_APPROVAL', 'REVISION_REQUESTED', 'closed'] as const) {
      await act(async () => {
        root!.render(
          <JobFilters
            user={manager}
            filters={{ view: 'list', offset: 0, status }}
            onApply={() => {}}
            onClear={onClear}
            onChange={() => {}}
            onViewChange={() => {}}
            boardSupported
          />,
        );
      });
      expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Filtreleri temizle'))
        .toBe(false);
    }

    await act(async () => {
      root!.render(
        <JobFilters
          user={manager}
          filters={{ view: 'list', offset: 0, status: 'active', q: 'klinik' }}
          onApply={() => {}}
          onClear={onClear}
          onChange={() => {}}
          onViewChange={() => {}}
          boardSupported
        />,
      );
    });
    const clearButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Filtreleri temizle');
    expect(clearButton).toBeTruthy();
    await act(async () => clearButton!.click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
