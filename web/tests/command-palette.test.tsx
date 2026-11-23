/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  listJobCards: vi.fn(),
}));

vi.mock('../src/services/crm-api', async () => {
  const actual = await vi.importActual<typeof import('../src/services/crm-api')>('../src/services/crm-api');
  return {
    ...actual,
    listCustomers: mocks.listCustomers,
  };
});

vi.mock('../src/jobs/jobs-api', async () => {
  const actual = await vi.importActual<typeof import('../src/jobs/jobs-api')>('../src/jobs/jobs-api');
  return {
    ...actual,
    listJobCards: mocks.listJobCards,
  };
});

import { AppShell } from '../src/AppShell';
import type { CurrentUser } from '../src/services/api';
import { buildNavigationModel } from '../src/shell/navigation-model';
import { CommandPalette } from '../src/shell/CommandPalette';
import { NEW_JOB_OPTIONS } from '../src/jobs/new-job-options';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1',
  organizationId: 'org-1',
  name: 'Murat Yönetici',
  email: 'murat@example.com',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
};

function LocationDisplay() {
  return <span data-location>{useLocation().pathname}</span>;
}

function setDesktop(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches,
    media: '(min-width: 64rem)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('CommandPalette', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.listCustomers.mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    mocks.listJobCards.mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens from topbar button or Ctrl/Cmd+K shortcut and restores focus on Escape', async () => {
    setDesktop(true);
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/overview']}>
        <AppShell user={manager} pendingSignOut={false} onSignOut={() => {}}>
          <main><h1>Genel Bakış</h1><LocationDisplay /></main>
        </AppShell>
      </MemoryRouter>,
    ));

    const trigger = container.querySelector<HTMLButtonElement>('.desktop-shell-search-trigger')!;
    trigger.focus();
    await act(async () => trigger.click());
    await act(async () => {});

    const dialog = container.querySelector<HTMLElement>('.command-palette-dialog')!;
    expect(dialog).not.toBeNull();
    expect(document.activeElement?.className).toContain('command-palette-input');

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('.command-palette-dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    await act(async () => {});
    expect(container.querySelector('.command-palette-dialog')).not.toBeNull();
  });

  it('offers every create flow as a quick action and keeps options out of the Tab order', async () => {
    const model = buildNavigationModel(manager);
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/jobs']}>
        <CommandPalette user={manager} destinations={model.destinations} onClose={vi.fn()} />
      </MemoryRouter>,
    ));

    const actionGroup = container.querySelector<HTMLElement>('.command-palette-group[aria-label="Hızlı işlemler"]')!;
    const actionLabels = Array.from(
      actionGroup.querySelectorAll('.command-palette-option-label'),
      (label) => label.textContent,
    );
    for (const option of NEW_JOB_OPTIONS) expect(actionLabels).toContain(option.label);
    expect(actionLabels).toContain('Satış kaydı');

    // Combobox pattern: the input owns focus; options are reached with arrows.
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('.command-palette-option'));
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) expect(option.tabIndex).toBe(-1);
  });

  it('filters pages with Turkish case folding and navigates with keyboard', async () => {
    const model = buildNavigationModel(manager);
    const onClose = vi.fn();

    await act(async () => root.render(
      <MemoryRouter initialEntries={['/jobs']}>
        <LocationDisplay />
        <CommandPalette user={manager} destinations={model.destinations} onClose={onClose} />
      </MemoryRouter>,
    ));

    const input = container.querySelector<HTMLInputElement>('.command-palette-input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'İ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const dialog = container.querySelector<HTMLElement>('.command-palette-dialog')!;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('.command-palette-option'));
    expect(options.length).toBeGreaterThan(1);
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledWith(false);
    expect(container.querySelector('[data-location]')?.textContent).not.toBe('/jobs');
  });

  it('debounces remote customer & job searches and tolerates partial endpoint failure', async () => {
    const model = buildNavigationModel(manager);
    const onClose = vi.fn();

    mocks.listCustomers.mockResolvedValue({
      items: [
        {
          id: 'cust-1',
          organizationId: 'org-1',
          name: 'Anadolu Dental Kliniği',
          customerType: 'clinic',
          taxNumber: null,
          phone: null,
          email: null,
          city: 'Ankara',
          district: 'Çankaya',
          address: null,
          assignedStaffUserId: null,
          status: 'active',
          version: 1,
          assignedStaffName: null,
          primaryContact: null,
        },
      ],
      total: 1,
      limit: 5,
      offset: 0,
    });
    mocks.listJobCards.mockRejectedValue(new Error('network'));

    await act(async () => root.render(
      <MemoryRouter initialEntries={['/jobs']}>
        <LocationDisplay />
        <CommandPalette user={manager} destinations={model.destinations} onClose={onClose} />
      </MemoryRouter>,
    ));

    const input = container.querySelector<HTMLInputElement>('.command-palette-input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

    await act(async () => {
      setter.call(input, 'anadolu');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(mocks.listCustomers).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await act(async () => {});

    expect(mocks.listCustomers).toHaveBeenCalledWith({ q: 'anadolu', limit: 5 });
    expect(mocks.listJobCards).toHaveBeenCalledWith({ q: 'anadolu', limit: 5 });
    expect(container.textContent).toContain('Anadolu Dental Kliniği');
    expect(container.textContent).toContain('Bazı arama sonuçları yüklenemedi.');

    const customerOption = Array.from(container.querySelectorAll<HTMLButtonElement>('.command-palette-option'))
      .find((option) => option.textContent?.includes('Anadolu Dental Kliniği'))!;
    await act(async () => customerOption.click());
    expect(onClose).toHaveBeenCalledWith(false);
    expect(container.querySelector('[data-location]')?.textContent).toBe('/customers/cust-1');
  });
});
