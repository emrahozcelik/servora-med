/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../src/AppShell';
import type { CurrentUser } from '../src/services/api';
import {
  InstallOpportunityProvider,
  type InstallOpportunityController,
  type InstallOpportunitySnapshot,
} from '../src/install/InstallOpportunity';
import { AppleInstallGuidance } from '../src/install/AppleInstallGuidance';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'ayse@example.com',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const manager: CurrentUser = { ...staff, id: 'manager-1', name: 'Murat Yönetici', role: 'MANAGER' };
const admin: CurrentUser = { ...manager, id: 'admin-1', name: 'Deniz Admin', role: 'ADMIN' };

function setDesktop(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches, media: '(min-width: 64rem)', onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

function setStandaloneDisplayMode() {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: query === '(display-mode: standalone)', media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })));
}

function LocationProbe() {
  return <span data-location>{useLocation().pathname}</span>;
}

/** Sibling of the shell inside the router: navigates without touching overlays. */
function NavigateProbe({ back = false }: { back?: boolean }) {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" data-navigate-to onClick={() => navigate('/customers')}>Git</button>
      {back ? <button type="button" data-navigate-back onClick={() => navigate(-1)}>Geri</button> : null}
    </>
  );
}

describe('responsive authenticated AppShell', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });

  async function render(user: CurrentUser, desktop: boolean, path = '/jobs') {
    setDesktop(desktop);
    await act(async () => root.render(
      <MemoryRouter initialEntries={[path]}>
        <AppShell user={user} pendingSignOut={false} onSignOut={() => {}}>
          <main><h1>İçerik</h1><LocationProbe /></main>
        </AppShell>
      </MemoryRouter>,
    ));
  }

  async function renderWithNavigateProbe({ back = false }: { back?: boolean } = {}) {
    setDesktop(false);
    await act(async () => root.render(
      <MemoryRouter initialEntries={back ? ['/jobs', '/customers'] : ['/jobs']} initialIndex={back ? 1 : 0}>
        <NavigateProbe back={back} />
        <AppShell user={staff} pendingSignOut={false} onSignOut={() => {}}>
          <main><h1>İçerik</h1><LocationProbe /></main>
        </AppShell>
      </MemoryRouter>,
    ));
  }

  function fakeInstallController(snapshot: Partial<InstallOpportunitySnapshot>): InstallOpportunityController {
    const state: InstallOpportunitySnapshot = {
      canPrompt: false, installed: false, outcome: null,
      appleCandidate: false, guidanceDismissed: false, shouldOfferAppleGuidance: false,
      ...snapshot,
    };
    return {
      start: () => {}, stop: () => {},
      subscribe: () => () => {},
      getSnapshot: () => state,
      prompt: async () => {}, dismissGuidance: () => {}, resetGuidance: () => {},
    };
  }

  async function renderWithInstall(snapshot: Partial<InstallOpportunitySnapshot>, desktop = false, path = '/jobs') {
    setDesktop(desktop);
    await act(async () => root.render(
      <MemoryRouter key={path} initialEntries={[path]}>
        <InstallOpportunityProvider controller={fakeInstallController(snapshot)}>
          <AppShell user={staff} pendingSignOut={false} onSignOut={() => {}}>
            <main><h1>İçerik</h1></main>
          </AppShell>
        </InstallOpportunityProvider>
      </MemoryRouter>,
    ));
  }

  it('shows the Apple install guidance card only when the controller offers it', async () => {
    await renderWithInstall({ shouldOfferAppleGuidance: true });
    expect(container.querySelector('[data-install-guidance="true"]')).not.toBeNull();
    expect(container.textContent).toContain("Dünya Dental'i ana ekrana ekleyin");
    expect(container.textContent).toContain('Ana Ekrana Ekle');
    await renderWithInstall({ shouldOfferAppleGuidance: false });
    expect(container.querySelector('[data-install-guidance="true"]')).toBeNull();
  });

  it('keeps a single global guidance surface on normal authenticated routes', async () => {
    await renderWithInstall({ appleCandidate: true, shouldOfferAppleGuidance: true });
    expect(container.querySelectorAll('[data-install-guidance="true"]')).toHaveLength(1);
  });

  it('suppresses the global Apple guidance card on the application settings route', async () => {
    await renderWithInstall({ appleCandidate: true, shouldOfferAppleGuidance: true }, false, '/settings/application');
    expect(container.querySelector('[data-install-guidance="true"]')).toBeNull();
    expect(container.textContent).not.toContain("Dünya Dental'i ana ekrana ekleyin");
  });

  it('shows the global guidance again after leaving application settings without auto-dismissal', async () => {
    await renderWithInstall({ appleCandidate: true, shouldOfferAppleGuidance: true }, false, '/settings/application');
    expect(container.querySelector('[data-install-guidance="true"]')).toBeNull();
    await renderWithInstall({ appleCandidate: true, shouldOfferAppleGuidance: true }, false, '/jobs');
    expect(container.querySelector('[data-install-guidance="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-install-guidance="true"]')).toHaveLength(1);
  });

  it('keeps the global Apple guidance card absent on application settings in Chromium and standalone states', async () => {
    await renderWithInstall({ canPrompt: true, appleCandidate: true }, false, '/settings/application');
    expect(container.querySelector('[data-install-guidance="true"]')).toBeNull();
    await renderWithInstall({ installed: true, appleCandidate: true }, false, '/settings/application');
    expect(container.querySelector('[data-install-guidance="true"]')).toBeNull();
  });

  it('does not show Apple guidance when already installed or dismissed', async () => {
    await renderWithInstall({ installed: true, appleCandidate: true });
    expect(container.querySelector('[data-install-guidance="true"]')).toBeNull();
    await renderWithInstall({ appleCandidate: true, guidanceDismissed: true });
    expect(container.querySelector('[data-install-guidance="true"]')).toBeNull();
  });

  it('renders the Apple guidance card with accessible dismiss action', async () => {
    let dismissed = false;
    const state: InstallOpportunitySnapshot = {
      canPrompt: false, installed: false, outcome: null,
      appleCandidate: true, guidanceDismissed: false, shouldOfferAppleGuidance: true,
    };
    setDesktop(false);
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/jobs']}>
        <InstallOpportunityProvider controller={{
          start: () => {}, stop: () => {},
          subscribe: () => () => {}, getSnapshot: () => state,
          prompt: async () => {}, resetGuidance: () => {},
          dismissGuidance: () => { dismissed = true; },
        }}>
          <AppShell user={staff} pendingSignOut={false} onSignOut={() => {}}>
            <main><h1>İçerik</h1></main>
          </AppShell>
        </InstallOpportunityProvider>
      </MemoryRouter>,
    ));
    const card = container.querySelector('[data-install-guidance="true"]')!;
    expect(card.getAttribute('role')).toBe('region');
    const dismiss = container.querySelector('.apple-install-guidance-dismiss') as HTMLButtonElement;
    expect(dismiss.getAttribute('aria-label')).toBe('Kurulum yönergesini kapat');
    await act(async () => dismiss.click());
    expect(dismissed).toBe(true);
  });

  it.each([
    [staff, ['İşler', 'Müşteriler', 'Ürünler', 'Profilim', 'Dokümantasyon', 'Yardım Merkezi', 'Ayarlar'], ['Personel', 'Kullanıcılar']],
    [manager, ['İşler', 'Müşteriler', 'Ürünler', 'Raporlar', 'Personel', 'Dokümantasyon', 'Yardım Merkezi', 'Ayarlar'], ['Profilim', 'Kullanıcılar']],
    [admin, ['İşler', 'Müşteriler', 'Ürünler', 'Raporlar', 'Personel', 'Kullanıcılar', 'Dokümantasyon', 'Yardım Merkezi', 'Ayarlar'], ['Profilim']],
  ] as const)('renders exact desktop destinations for %s', async (user, visible, hidden) => {
    await render(user, true);
    const aside = container.querySelector('aside')!;
    expect(aside).not.toBeNull();
    const navigation = aside.querySelector('nav')!;
    expect(navigation.getAttribute('aria-label')).toBe('Ana navigasyon');
    const groups = Array.from(navigation.querySelectorAll<HTMLElement>('[data-nav-section]'));
    const expectedGroups = user.role === 'STAFF'
      ? ['Operasyon', 'Ekip', 'Destek', 'Hesap']
      : ['Operasyon', 'Analiz', 'Ekip', 'Destek', 'Hesap'];
    expect(groups.map((group) => group.getAttribute('data-nav-section'))).toEqual(expectedGroups);
    expect(groups.map((group) => group.querySelector('h2')?.textContent)).toEqual(expectedGroups);
    for (const label of visible) expect(navigation.textContent).toContain(label);
    for (const label of hidden) expect(navigation.textContent).not.toContain(label);
    expect(navigation.querySelectorAll('a')).toHaveLength(visible.length);
    for (const link of navigation.querySelectorAll('a')) {
      expect(link.querySelector('svg.shell-nav-icon')?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(aside.querySelector('.shell-account')).toBeNull();
    expect(aside.querySelector('.shell-sidebar nav a[href="/jobs"]')?.getAttribute('aria-current')).toBe('page');
    const sidebarBrand = aside.querySelector<HTMLAnchorElement>('.shell-sidebar-brand .dunya-dental-brand--full');
    expect(sidebarBrand).not.toBeNull();
    expect(sidebarBrand?.getAttribute('href')).toBe('/jobs');
    expect(aside.querySelectorAll('.dunya-dental-brand')).toHaveLength(1);
    expect(aside.querySelector('.notification-center')).toBeNull();
    expect(aside.querySelector('.shell-copyright img')).toBeNull();
    const copyright = aside.querySelector('.shell-copyright');
    expect(copyright?.textContent).toContain('Dünya Dental');
    expect(getComputedStyle(copyright!).textAlign === 'center'
      || copyright!.className.includes('shell-copyright')).toBe(true);
    const topbar = container.querySelector('.desktop-shell-topbar')!;
    expect(topbar.querySelector('.desktop-shell-topbar-brand')).toBeNull();
    expect(topbar.querySelector('.dunya-dental-brand')).toBeNull();
    expect(topbar.querySelector('.desktop-shell-search-trigger')).not.toBeNull();
    expect(topbar.querySelector('.desktop-shell-new-job .new-job-menu-trigger')).not.toBeNull();
    expect(topbar.querySelector('[aria-label="Bildirimler"] svg')).not.toBeNull();
    expect(topbar.querySelector('.shell-user-menu-trigger')?.textContent).toContain(user.name);
  });

  it.each([
    [false, '/jobs'],
    [true, '/overview'],
  ] as const)('uses the role-aware home target for the linked desktop brand (%s)', async (overviewEnabled, expectedPath) => {
    const user = overviewEnabled
      ? { ...manager, capabilities: { ...manager.capabilities, overviewDashboard: true } }
      : manager;
    await render(user, true);
    expect(container.querySelector<HTMLAnchorElement>('.shell-sidebar-brand .dunya-dental-brand--full')?.getAttribute('href'))
      .toBe(expectedPath);
  });

  it('renders no shell route title on migrated pages and updates document title after navigation', async () => {
    await render(manager, true, '/products');
    const topbar = container.querySelector('.desktop-shell-topbar')!;
    expect(topbar.querySelector('.desktop-shell-title')).toBeNull();
    expect(topbar.querySelector('h1')).toBeNull();
    expect(topbar.querySelector('[aria-label="Bildirimler"]')).not.toBeNull();

    const customers = Array.from(container.querySelectorAll<HTMLAnchorElement>('.shell-sidebar nav a'))
      .find((link) => link.textContent === 'Müşteriler')!;
    await act(async () => customers.click());

    expect(document.title).toBe('Müşteriler · Dünya Dental');
    expect(container.querySelector('[data-location]')?.textContent).toBe('/customers');
    expect(topbar.querySelector('[aria-label="Bildirimler"]')).not.toBeNull();
  });

  it('uses the unified resolved title in standalone mode without repeating the product name', async () => {
    setStandaloneDisplayMode();
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/products']}>
        <AppShell user={manager} pendingSignOut={false} onSignOut={() => {}}>
          <main><h1>İçerik</h1></main>
        </AppShell>
      </MemoryRouter>,
    ));

    expect(document.title).toBe('Ürünler · Dünya Dental');
  });

  it('renders only compact structure below 64rem and opens one labelled modal menu', async () => {
    await render(staff, false);
    expect(container.querySelector('aside')).toBeNull();
    expect(container.querySelector('.compact-shell-header')).not.toBeNull();
    expect(container.querySelector('.compact-shell-header .dunya-dental-brand')).toBeNull();
    expect(container.querySelector('.mobile-top-bar-actions [aria-label="Bildirimler"] svg')).not.toBeNull();
    expect(container.querySelector('.mobile-shell-title')?.textContent).toBe('İşlerim');
    expect(container.querySelector('.mobile-bottom-nav')?.textContent).not.toContain('Profilim');
    expect(container.querySelector('.mobile-bottom-nav')?.textContent).toContain('Menü');
    const triggers = container.querySelectorAll<HTMLButtonElement>('[aria-controls="app-navigation-drawer"]');
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0];
    expect(trigger.closest('.mobile-bottom-nav')).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('app-navigation-title');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(dialog.querySelector('button, a'));
    expect(dialog.querySelector('.dunya-dental-brand')).toBeNull();
    expect(dialog.textContent).toContain('Profilim');
    expect(dialog.textContent).toContain('Yardım Merkezi');
  });

  it('keeps the account row and sign-out before the destinations in the menu panel', async () => {
    await render(manager, false);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="app-navigation-drawer"]')!;
    await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const blocks = Array.from(dialog.children).map((child) => child.className);
    expect(blocks[0]).toContain('drawer-heading');
    expect(blocks[1]).toContain('shell-account');
    expect(blocks[2]).toContain('shell-nav');
    const groupLabels = Array.from(dialog.querySelectorAll('[data-nav-section]'))
      .map((group) => group.getAttribute('data-nav-section'));
    expect(groupLabels).toEqual(['Çalışma', 'Hesap ve destek']);
    const account = dialog.querySelector('.shell-account')!;
    expect(account.querySelector('.shell-identity strong')?.textContent).toBe(manager.name);
    expect(account.querySelector('.shell-identity > div > span')?.textContent).toBe('Yönetici');
    expect(account.querySelector('.shell-signout')?.textContent).toBe('Oturumu kapat');
    // Every destination renders below the account row, in model order.
    const navTop = dialog.querySelector('.shell-nav')!.getBoundingClientRect().top;
    expect(account.getBoundingClientRect().bottom).toBeLessThanOrEqual(navTop);
  });

  it('closes the menu panel and restores focus when the close control is activated', async () => {
    await render(manager, false);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="app-navigation-drawer"]')!;
    await act(async () => trigger.click());
    const close = container.querySelector<HTMLButtonElement>('.shell-drawer .drawer-close')!;
    await act(async () => close.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('uses the single Menü bottom control to open the grouped panel and restores focus', async () => {
    await render(manager, false);
    const bottom = container.querySelector('.mobile-bottom-nav')!;
    expect(bottom.textContent).toContain('Rapor');
    const menu = Array.from(bottom.querySelectorAll('button'))
      .find((button) => button.textContent === 'Menü')!;
    expect(menu.tagName).toBe('BUTTON');
    expect(menu.getAttribute('aria-controls')).toBe('app-navigation-drawer');
    expect(container.querySelector('.mobile-top-bar .shell-menu-button')).toBeNull();
    menu.focus();
    await act(async () => menu.click());
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('Personel');
    expect(dialog.textContent).toContain('Ürünler');
    // The single grouped panel no longer hides direct destinations.
    expect(dialog.textContent).toContain('Raporlar');
    expect(dialog.textContent).toContain('Oturumu kapat');
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('moves the mobile create into the bottom navigation and opens the create sheet', async () => {
    await render(staff, false, '/jobs');
    expect(container.querySelector('.sticky-new-job')).toBeNull();
    const create = container.querySelector<HTMLElement>('.mobile-bottom-nav-create')!;
    expect(create).not.toBeNull();
    const trigger = create.querySelector<HTMLButtonElement>('.new-job-menu-trigger')!;
    expect(trigger.textContent).toContain('Yeni iş');
    expect(trigger.querySelector('svg.mobile-nav-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => trigger.click());
    const sheet = document.querySelector<HTMLElement>('.new-job-menu-panel--sheet')!;
    expect(sheet).not.toBeNull();
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(sheet.textContent).toContain('Görüşme / ziyaret planla');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(sheet.querySelector('button'));
    expect(trigger.getAttribute('aria-controls')).toBe(sheet.id);
  });

  it('renders the create sheet as a global body layer, not inside the bottom navigation', async () => {
    await render(staff, false, '/jobs');
    const trigger = container.querySelector<HTMLButtonElement>('.mobile-bottom-nav-create .new-job-menu-trigger')!;
    await act(async () => trigger.click());
    const sheet = document.querySelector<HTMLElement>('.new-job-menu-panel--sheet')!;
    const backdrop = document.querySelector<HTMLElement>('.new-job-menu-backdrop')!;
    expect(sheet).not.toBeNull();
    expect(backdrop).not.toBeNull();
    // A fixed bottom-nav ancestor would trap the sheet's own z-index inside the
    // nav stacking context (z 20), below the shell drawer (30), notifications
    // (40) and dialog (50) layers.
    expect(container.querySelector('.mobile-bottom-nav [role="dialog"]')).toBeNull();
    expect(container.querySelector('.mobile-bottom-nav .new-job-menu-backdrop')).toBeNull();
    expect(sheet.closest('.mobile-bottom-nav')).toBeNull();
    expect(backdrop.closest('.mobile-bottom-nav')).toBeNull();
    expect(sheet.parentElement).toBe(document.body);
    expect(backdrop.parentElement).toBe(document.body);
  });

  it('closes the create sheet on Escape and restores focus to the bottom-nav create', async () => {
    await render(staff, false, '/jobs');
    const trigger = container.querySelector<HTMLButtonElement>('.mobile-bottom-nav-create .new-job-menu-trigger')!;
    await act(async () => trigger.click());
    expect(document.querySelector('.new-job-menu-panel--sheet')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('.new-job-menu-panel--sheet')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens the create sheet from the bottom navigation on every mobile route', async () => {
    await render(staff, false, '/customers');
    expect(container.querySelector('.mobile-shell-title')?.textContent).toBe('Müşteriler');
    expect(container.querySelector('.sticky-new-job')).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>('.mobile-bottom-nav-create .new-job-menu-trigger')!;
    expect(trigger).not.toBeNull();
    await act(async () => trigger.click());
    const sheet = document.querySelector<HTMLElement>('.new-job-menu-panel--sheet')!;
    const delivery = Array.from(sheet.querySelectorAll('button'))
      .find((button) => button.textContent === 'Yeni teslim')!;
    await act(async () => delivery.click());
    expect(document.querySelector('.new-job-menu-panel--sheet')).toBeNull();
    expect(container.querySelector('[data-location]')?.textContent).toBe('/jobs/new-delivery');
  });

  it('opens the standalone Satış kaydı form from the mobile create sheet', async () => {
    await render(staff, false, '/jobs');
    const trigger = container.querySelector<HTMLButtonElement>('.mobile-bottom-nav-create .new-job-menu-trigger')!;
    await act(async () => trigger.click());
    const sheet = document.querySelector<HTMLElement>('.new-job-menu-panel--sheet')!;
    const sale = Array.from(sheet.querySelectorAll('button'))
      .find((button) => button.textContent === 'Satış kaydı')!;
    await act(async () => sale.click());
    expect(document.querySelector('.new-job-menu-panel--sheet')).toBeNull();
    expect(container.querySelector('[data-location]')?.textContent).toBe('/jobs/new-sale');
  });

  it('closes the open menu panel on programmatic navigation without focusing the stale trigger', async () => {
    await renderWithNavigateProbe();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="app-navigation-drawer"]')!;
    await act(async () => trigger.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');

    const navigateAway = container.querySelector<HTMLButtonElement>('[data-navigate-to]')!;
    await act(async () => navigateAway.click());

    expect(container.querySelector('[data-location]')?.textContent).toBe('/customers');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).not.toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the open menu panel on browser Back without focusing the stale trigger', async () => {
    await renderWithNavigateProbe({ back: true });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="app-navigation-drawer"]')!;
    await act(async () => trigger.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('[data-navigate-back]')!.click());

    expect(container.querySelector('[data-location]')?.textContent).toBe('/jobs');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).not.toBe(trigger);
  });

  it('closes the open create sheet on programmatic navigation and releases the scroll lock', async () => {
    await renderWithNavigateProbe();
    const trigger = container.querySelector<HTMLButtonElement>('.mobile-bottom-nav-create .new-job-menu-trigger')!;
    await act(async () => trigger.click());
    expect(document.querySelector('.new-job-menu-panel--sheet')).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');

    await act(async () => container.querySelector<HTMLButtonElement>('[data-navigate-to]')!.click());

    expect(container.querySelector('[data-location]')?.textContent).toBe('/customers');
    expect(document.querySelector('.new-job-menu-panel--sheet')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).not.toBe(trigger);
  });

  it('links Staff own profile navigation to the stable /staff area', async () => {
    await render(staff, true);
    const profile = Array.from(container.querySelectorAll<HTMLAnchorElement>('aside nav a'))
      .find((link) => link.textContent === 'Profilim');
    expect(profile?.getAttribute('href')).toBe('/staff');
  });

  it('contains focus, closes on Escape, and restores trigger focus', async () => {
    await render(manager, false);
    const trigger = container.querySelector<HTMLButtonElement>('.mobile-bottom-nav [aria-controls="app-navigation-drawer"]')!;
    trigger.focus(); await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
    expect(first.getAttribute('aria-label') || first.textContent).toMatch(/Kapat|Menü/);
    last.focus();
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement).toBe(first);
    first.focus();
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })));
    expect(document.activeElement).toBe(last);
    const outside = document.createElement('button'); document.body.append(outside); outside.focus();
    expect(dialog.contains(document.activeElement)).toBe(true); outside.remove();
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes the drawer when a destination changes the route', async () => {
    await render(manager, false);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="app-navigation-drawer"]')!;
    await act(async () => trigger.click());
    const customers = Array.from(container.querySelectorAll<HTMLAnchorElement>('[role="dialog"] a'))
      .find((link) => link.textContent === 'Müşteriler')!;
    await act(async () => customers.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-location]')?.textContent).toBe('/customers');
    expect(document.activeElement).toBe(trigger);
  });

  it('locks body scrolling only while the compact drawer is open', async () => {
    await render(manager, false);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="app-navigation-drawer"]')!;
    await act(async () => trigger.click());
    expect(document.body.style.overflow).toBe('hidden');
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.body.style.overflow).toBe('');
  });

  it('closes the drawer when the backdrop overlay is clicked', async () => {
    await render(manager, false);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="app-navigation-drawer"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const backdrop = container.querySelector<HTMLElement>('.shell-drawer-backdrop')!;
    expect(backdrop).not.toBeNull();
    // Click directly on the backdrop element (not on the inner drawer panel)
    await act(async () => backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('does not introduce drawer motion styling', () => {
    const css = readFileSync(
      new URL('../src/styles.css', 'file://' + __dirname + '/'),
      'utf8',
    );

    // Extract all CSS rule blocks whose selector contains .shell-drawer or .shell-drawer-backdrop
    const drawerRules =
      css.match(/\.shell-drawer(?:-backdrop)?[^{]*\{[^}]*\}/g)?.join('\n') ?? '';

    // Assert that no transition or animation properties are present in those rules.
    // If motion is intentionally added in the future, a @media (prefers-reduced-motion: reduce)
    // counterpart must be added at the same time — update this test then.
    expect(drawerRules).not.toMatch(/\b(?:transition|animation)(?:-[\w-]+)?\s*:/);
  });

  it('keeps desktop shell hierarchy without mobile chrome', async () => {
    await render(manager, true);
    const shell = container.querySelector('.authenticated-shell--desktop');
    expect(shell).not.toBeNull();
    expect(container.querySelector('.shell-sidebar')).not.toBeNull();
    expect(container.querySelector('.desktop-shell-topbar')).not.toBeNull();
    expect(container.querySelector('.shell-content')).not.toBeNull();
    expect(container.querySelector('.compact-shell-header')).toBeNull();
    expect(container.querySelector('.mobile-bottom-nav')).toBeNull();
    expect(container.querySelector('.mobile-bottom-nav-create')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const aside = container.querySelector('.shell-sidebar')!;
    expect(aside.querySelector('.shell-sidebar-brand .dunya-dental-brand--full')).not.toBeNull();
    expect(aside.querySelector('.shell-sidebar-footer .shell-account')).toBeNull();
    expect(aside.querySelector('.shell-sidebar-footer .shell-copyright')).not.toBeNull();

    const topbar = container.querySelector('.desktop-shell-topbar')!;
    expect(topbar.querySelector('.desktop-shell-search-trigger')).not.toBeNull();
    expect(topbar.querySelector('.desktop-shell-new-job .new-job-menu-trigger')).not.toBeNull();
    expect(topbar.querySelector('.notification-center')).not.toBeNull();
    const userTrigger = topbar.querySelector<HTMLButtonElement>('.shell-user-menu-trigger')!;
    expect(userTrigger).not.toBeNull();
    expect(userTrigger.textContent).toContain(manager.name);
    expect(userTrigger.querySelector('.servora-user-avatar')).not.toBeNull();

    await act(async () => userTrigger.click());
    const userPanel = topbar.querySelector('.shell-user-menu-panel')!;
    expect(userPanel).not.toBeNull();
    expect(userPanel.textContent).toContain('Yönetici');
    expect(userPanel.querySelector('.shell-signout')?.textContent).toContain('Oturumu kapat');
  });

  it('preserves pending sign-out copy on the desktop user menu control', async () => {
    setDesktop(true);
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/jobs']}>
        <AppShell user={admin} pendingSignOut onSignOut={() => {}}>
          <main>İçerik</main>
        </AppShell>
      </MemoryRouter>,
    ));
    const userTrigger = container.querySelector<HTMLButtonElement>('.desktop-shell-topbar .shell-user-menu-trigger')!;
    await act(async () => userTrigger.click());
    const signOut = container.querySelector<HTMLButtonElement>('.desktop-shell-topbar .shell-signout')!;
    expect(signOut.disabled).toBe(true);
    expect(signOut.textContent).toContain('Kapatılıyor…');
  });

  it('contracts desktop shell CSS hierarchy, active weight, and workspace frame', () => {
    const css = readFileSync(
      new URL('../src/styles.css', 'file://' + __dirname + '/'),
      'utf8',
    );

    // Exact rule body for a selector line (does not match longer `.shell-sidebar …` prefixes).
    function exactRuleBody(selector: string): string {
      const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
      const match = cleaned.match(pattern);
      if (!match?.[1]) throw new Error(`Missing exact CSS rule for ${selector}`);
      return match[1];
    }

    // Shared/mobile baseline (drawer uses DestinationNav + Account without .shell-sidebar).
    expect(exactRuleBody('.shell-nav')).toMatch(/gap:\s*1\.15rem/);
    expect(exactRuleBody('.shell-nav')).not.toMatch(/gap:\s*1\.35rem/);
    expect(exactRuleBody('.shell-nav-section')).toMatch(/gap:\s*0\.35rem/);
    expect(exactRuleBody('.shell-nav-links')).toMatch(/gap:\s*0\.25rem/);
    expect(exactRuleBody('.shell-nav a')).toMatch(/border-radius:\s*0\.5rem/);
    expect(exactRuleBody('.shell-nav a')).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(exactRuleBody('.shell-nav a[aria-current="page"]')).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(exactRuleBody('.shell-nav a[aria-current="page"]')).not.toMatch(/font-weight:/);
    expect(exactRuleBody('.shell-account')).toMatch(/gap:\s*0\.9rem/);
    expect(exactRuleBody('.shell-identity strong')).toMatch(/font-size:\s*0\.9rem/);
    expect(exactRuleBody('.shell-identity strong')).not.toMatch(/font-weight:\s*720/);
    expect(exactRuleBody('.shell-signout')).toMatch(/width:\s*100%/);
    expect(exactRuleBody('.shell-signout')).not.toMatch(/font-weight:\s*680/);

    // T2A + Topbar B polish is scoped to desktop only.
    expect(exactRuleBody('.shell-sidebar .shell-nav')).toMatch(/gap:\s*1\.35rem/);
    expect(exactRuleBody('.shell-sidebar .shell-nav a')).toMatch(/border-radius:\s*0\.55rem/);
    expect(exactRuleBody('.shell-sidebar .shell-nav a')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(exactRuleBody('.shell-sidebar .shell-nav a[aria-current="page"]')).toMatch(/font-weight:\s*760/);
    expect(css).toMatch(/\.shell-sidebar-brand\s*\{/s);
    expect(css).toMatch(/\.shell-sidebar-footer\s*\{[^}]*margin-top:\s*auto/s);
    expect(exactRuleBody('.desktop-shell-topbar')).toMatch(/justify-content:\s*flex-end/);
    expect(exactRuleBody('.desktop-shell-topbar')).toMatch(/position:\s*sticky/);
    expect(exactRuleBody('.desktop-shell-search-trigger')).toMatch(/margin-inline-end:\s*auto/);
    expect(exactRuleBody('.desktop-shell-search-trigger')).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(exactRuleBody('.shell-user-menu-trigger')).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(css).not.toMatch(/\.desktop-shell-topbar-brand/);
    // Default operational workspace stays near 68rem; board gates remain separate.
    expect(css).toMatch(/\.workspace\s*\{[^}]*width:\s*min\(100% - 2rem,\s*68rem\)/s);
    expect(css).toMatch(/@container job-board \(min-width: 68rem\)/);
    // Desktop canvas shell vs paper content frame.
    expect(css).toMatch(
      /@media \(min-width: 64rem\)[\s\S]*\.authenticated-shell--desktop\s*\{[^}]*background:\s*var\(--canvas\)/s,
    );
    expect(css).toMatch(
      /@media \(min-width: 64rem\)[\s\S]*\.shell-content\s*\{[^}]*background:\s*var\(--paper\)/s,
    );
  });

  it('keeps mobile drawer DestinationNav and Account without adopting desktop polish hooks', async () => {
    await render(manager, false);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="app-navigation-drawer"]')!;
    await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    // Shared components still render inside the drawer.
    expect(dialog.querySelector('.shell-nav')).not.toBeNull();
    expect(dialog.querySelector('.shell-account')).not.toBeNull();
    expect(dialog.querySelector('.shell-identity strong')?.textContent).toBe(manager.name);
    expect(dialog.querySelector('.shell-identity .servora-user-avatar')).not.toBeNull();
    // Desktop-only structural hooks must not appear in the mobile drawer.
    expect(dialog.querySelector('.shell-sidebar-brand')).toBeNull();
    expect(dialog.querySelector('.shell-sidebar-footer')).toBeNull();
    expect(dialog.closest('.shell-sidebar')).toBeNull();
  });

  it('keeps the mobile top bar free of menu chrome and moves the create into the bottom navigation', async () => {
    await render(staff, false, '/jobs');
    expect(container.querySelector('.mobile-top-bar')).not.toBeNull();
    expect(container.querySelector('.mobile-top-bar-start .mobile-shell-title')?.textContent).toBe('İşlerim');
    expect(container.querySelector('.mobile-top-bar .shell-menu-button')).toBeNull();
    expect(container.querySelector('.mobile-top-bar-actions [aria-label="Bildirimler"]')).not.toBeNull();
    expect(container.querySelector('.sticky-new-job')).toBeNull();
    expect(container.querySelector('.mobile-bottom-nav-create')).not.toBeNull();
  });

  it('keeps the create action in the bottom navigation outside the jobs list path', async () => {
    await render(staff, false, '/customers');
    expect(container.querySelector('.mobile-shell-title')?.textContent).toBe('Müşteriler');
    expect(container.querySelector('.sticky-new-job')).toBeNull();
    expect(container.querySelector('.mobile-bottom-nav-create')).not.toBeNull();
  });

  it('does not close the drawer when the panel itself is clicked', async () => {
    await render(manager, false);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="app-navigation-drawer"]')!;
    await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('contracts mobile chrome CSS without changing shared desktop baseline selectors', () => {
    const css = readFileSync(
      new URL('../src/styles.css', 'file://' + __dirname + '/'),
      'utf8',
    );

    function exactRuleBody(selector: string): string {
      const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
      const match = cleaned.match(pattern);
      if (!match?.[1]) throw new Error(`Missing exact CSS rule for ${selector}`);
      return match[1];
    }

    // Top bar: balanced zones + title truncation + safe-area + 44px controls already shared.
    expect(css).toMatch(/\.compact-shell-header\.mobile-top-bar\s*\{[^}]*safe-area-inset-top/s);
    expect(exactRuleBody('.mobile-shell-title')).toMatch(/text-overflow:\s*ellipsis/);
    expect(exactRuleBody('.mobile-shell-title')).toMatch(/white-space:\s*nowrap/);
    expect(exactRuleBody('.shell-notification-trigger')).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(exactRuleBody('.shell-notification-trigger')).toMatch(/(?:flex:\s*0\s+0\s+2\.75rem|width:\s*2\.75rem)/);

    // Bottom nav: active uses weight channel; labels can wrap safely.
    expect(exactRuleBody('.mobile-bottom-nav')).toMatch(/safe-area-inset-bottom/);
    expect(exactRuleBody('.mobile-bottom-nav-item')).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(exactRuleBody('.mobile-bottom-nav-item')).toMatch(/overflow-wrap:\s*break-word/);
    const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(cleaned).toMatch(
      /\.mobile-bottom-nav-item--active,\s*\.mobile-bottom-nav a\[aria-current=["']page["']\],\s*\.mobile-bottom-nav-menu\[aria-expanded=["']true["']\]\s*\{[^}]*font-weight:\s*760/s,
    );

    // Bottom-nav create owns the mobile create slot; the sticky bar is gone.
    expect(css).not.toMatch(/\.sticky-new-job/);
    expect(exactRuleBody('.authenticated-shell--mobile .shell-content')).toMatch(/safe-area-inset-bottom/);
    expect(css).toMatch(
      /\.authenticated-shell--mobile \.shell-content > :first-child,\s*\.authenticated-shell--mobile \.shell-content > main\s*\{[^}]*margin-top:\s*0/s,
    );
    expect(exactRuleBody('.mobile-nav-icon')).toMatch(/width:\s*1\.25rem/);
    expect(css).toMatch(
      /\.mobile-bottom-nav \.mobile-bottom-nav-create \.new-job-menu-trigger\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    );

    // Menu panel polish is panel-scoped; shared nav baseline stays T2A isolation values.
    expect(exactRuleBody('.shell-drawer')).toMatch(/background:\s*var\(--paper\)/);
    expect(exactRuleBody('.shell-drawer')).toMatch(/safe-area-inset-top/);
    expect(exactRuleBody('.shell-drawer')).toMatch(/safe-area-inset-bottom/);
    expect(exactRuleBody('.shell-drawer')).toMatch(/safe-area-inset-right/);
    expect(exactRuleBody('.shell-drawer')).toMatch(/box-shadow:\s*var\(--shadow-drawer\)/);
    expect(exactRuleBody('.shell-drawer')).toMatch(/border-left:/);
    expect(exactRuleBody('.shell-drawer-backdrop')).toMatch(/justify-content:\s*flex-end/);
    expect(exactRuleBody('.shell-drawer .shell-nav')).toMatch(/(?:margin-top:\s*1\.15rem|flex:\s*1\s+1\s+auto)/);
    expect(exactRuleBody('.shell-drawer .shell-account')).toMatch(/margin-top:\s*0\.85rem/);
    expect(exactRuleBody('.shell-drawer .shell-account')).toMatch(/border-top:\s*0/);
    expect(css).not.toMatch(/\.shell-drawer-brand/);
    expect(exactRuleBody('.shell-nav')).toMatch(/gap:\s*1\.15rem/);
    expect(exactRuleBody('.shell-nav a')).toMatch(/border-radius:\s*0\.5rem/);
    expect(exactRuleBody('.shell-nav a[aria-current="page"]')).not.toMatch(/font-weight:/);

    // No Ant Layout/Menu.
    expect(css).not.toMatch(/ant-layout|ant-menu/);
  });

  it('keeps the compact header sticky in normal flow below overlay layers', () => {
    const css = readFileSync(
      new URL('../src/styles.css', 'file://' + __dirname + '/'),
      'utf8',
    );

    function exactRuleBody(selector: string): string {
      const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
      const match = cleaned.match(pattern);
      if (!match?.[1]) throw new Error(`Missing exact CSS rule for ${selector}`);
      return match[1];
    }

    // The compact header sticks in normal flow, while drawer/modal layers keep
    // precedence via their higher z-index values.
    const body = exactRuleBody('.compact-shell-header');
    const mobileBody = exactRuleBody('.compact-shell-header.mobile-top-bar');
    expect(mobileBody).toMatch(/\bposition:\s*sticky/);
    expect(mobileBody).toMatch(/\btop:\s*0\s*;/);
    expect(mobileBody).toMatch(/\bz-index:\s*10/);
    expect(mobileBody).toMatch(/safe-area-inset-top/);
    expect(body).not.toMatch(/\bposition:\s*fixed/);
    expect(css).toMatch(/\.shell-drawer-backdrop\s*\{[^}]*z-index:\s*30/);
    expect(css).toMatch(/\.notification-center-desktop-layer, \.notification-center-backdrop\s*\{[^}]*z-index:\s*40/);
  });
});
