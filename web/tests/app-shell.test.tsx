/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../src/AppShell';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'ayse@example.com',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
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

function LocationProbe() {
  return <span data-location>{useLocation().pathname}</span>;
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

  it.each([
    [staff, ['İşler', 'Müşteriler', 'Ürünler', 'Profilim'], ['Personel', 'Kullanıcılar']],
    [manager, ['İşler', 'Müşteriler', 'Ürünler', 'Raporlar', 'Personel'], ['Profilim', 'Kullanıcılar']],
    [admin, ['İşler', 'Müşteriler', 'Ürünler', 'Raporlar', 'Personel', 'Kullanıcılar'], ['Profilim']],
  ] as const)('renders exact desktop destinations for %s', async (user, visible, hidden) => {
    await render(user, true);
    const aside = container.querySelector('aside')!;
    expect(aside).not.toBeNull();
    const navigation = aside.querySelector('nav')!;
    expect(navigation.getAttribute('aria-label')).toBe('Ana navigasyon');
    const groups = Array.from(navigation.querySelectorAll<HTMLElement>('[data-nav-section]'));
    const expectedGroups = user.role === 'STAFF' ? ['Operasyon', 'Ekip'] : ['Operasyon', 'Analiz', 'Ekip'];
    expect(groups.map((group) => group.getAttribute('data-nav-section'))).toEqual(expectedGroups);
    expect(groups.map((group) => group.querySelector('h2')?.textContent)).toEqual(expectedGroups);
    for (const label of visible) expect(navigation.textContent).toContain(label);
    for (const label of hidden) expect(navigation.textContent).not.toContain(label);
    expect(navigation.querySelectorAll('a')).toHaveLength(visible.length);
    expect(aside.textContent).toContain(user.name);
    expect(aside.textContent).toContain('Oturumu kapat');
    expect(aside.querySelector('a[href="/jobs"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('renders only compact structure below 64rem and opens a labelled modal drawer', async () => {
    await render(staff, false);
    expect(container.querySelector('aside')).toBeNull();
    expect(container.querySelector('.compact-shell-header')).not.toBeNull();
    expect(container.querySelector('.mobile-shell-title')?.textContent).toBe('İşlerim');
    expect(container.querySelector('.mobile-bottom-nav')?.textContent).toContain('Profilim');
    expect(container.querySelector('.mobile-bottom-nav')?.textContent).not.toContain('Menü');
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="app-navigation-drawer"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('app-navigation-title');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(dialog.querySelector('button, a'));
  });

  it('uses Menü bottom control as a button that opens overflow drawer and restores focus', async () => {
    await render(manager, false);
    const bottom = container.querySelector('.mobile-bottom-nav')!;
    expect(bottom.textContent).toContain('Raporlar');
    const menu = Array.from(bottom.querySelectorAll('button')).find((b) => b.textContent === 'Menü')!;
    expect(menu.tagName).toBe('BUTTON');
    expect(menu.getAttribute('aria-controls')).toBe('app-navigation-drawer');
    menu.focus();
    await act(async () => menu.click());
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('Personel');
    expect(dialog.textContent).toContain('Ürünler');
    expect(dialog.textContent).toContain('Oturumu kapat');
    expect(dialog.textContent).not.toContain('Raporlar');
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('shows sticky Yeni iş on the jobs list without a second heading brand bar', async () => {
    await render(staff, false, '/jobs');
    expect(container.querySelector('.sticky-new-job')).not.toBeNull();
    expect(container.querySelector('.sticky-new-job')?.textContent).toContain('Yeni iş');
    expect(container.querySelector('.brand-lockup')).toBeNull();
  });

  it('links Staff own profile navigation to the stable /staff area', async () => {
    await render(staff, true);
    const profile = Array.from(container.querySelectorAll<HTMLAnchorElement>('aside nav a'))
      .find((link) => link.textContent === 'Profilim');
    expect(profile?.getAttribute('href')).toBe('/staff');
  });

  it('contains focus, closes on Escape, and restores trigger focus', async () => {
    await render(manager, false);
    const trigger = container.querySelector<HTMLButtonElement>('.compact-shell-header [aria-controls="app-navigation-drawer"]')!;
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
      resolve(__dirname, '../src/styles.css'),
      'utf8',
    );

    // Extract rules whose selector contains .shell-drawer or .shell-drawer-backdrop
    const drawerRules =
      css.match(/\.shell-drawer(?:-backdrop)?[^{]*\{[^}]*\}/g)?.join('\n') ?? '';

    // If motion is ever added, a proper Playwright computed-style test is needed;
    // for now there is no motion in the drawer, so this guard must stay green.
    expect(drawerRules).not.toMatch(
      /\b(?:transition|animation)(?:-[\w-]+)?\s*:/,
    );
  });
});

