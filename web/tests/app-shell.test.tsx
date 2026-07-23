/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
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
    expect(aside.querySelector('.dunya-dental-brand--sidebar')).not.toBeNull();
    expect(aside.querySelector('.notification-center')).toBeNull();
    expect(aside.querySelector('.shell-copyright img')).toBeNull();
    const copyright = aside.querySelector('.shell-copyright');
    expect(copyright?.textContent).toContain('Dünya Dental');
    expect(getComputedStyle(copyright!).textAlign === 'center'
      || copyright!.className.includes('shell-copyright')).toBe(true);
    const topbar = container.querySelector('.desktop-shell-topbar')!;
    expect(topbar.querySelector('.dunya-dental-brand')).toBeNull();
    expect(topbar.querySelector('[aria-label="Bildirimler"] svg')).not.toBeNull();
  });

  it('renders only compact structure below 64rem and opens a labelled modal drawer', async () => {
    await render(staff, false);
    expect(container.querySelector('aside')).toBeNull();
    expect(container.querySelector('.compact-shell-header')).not.toBeNull();
    expect(container.querySelector('.compact-shell-header .dunya-dental-brand--topbar')).not.toBeNull();
    expect(container.querySelector('.mobile-top-bar-actions [aria-label="Bildirimler"] svg')).not.toBeNull();
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
    expect(container.querySelector('.sticky-new-job')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const aside = container.querySelector('.shell-sidebar')!;
    expect(aside.querySelector('.shell-sidebar-brand .dunya-dental-brand--sidebar')).not.toBeNull();
    expect(aside.querySelector('.shell-sidebar-footer .shell-account')).not.toBeNull();
    expect(aside.querySelector('.shell-sidebar-footer .shell-copyright')).not.toBeNull();
    expect(aside.querySelector('.shell-identity strong')?.textContent).toBe(manager.name);
    expect(aside.querySelector('.shell-identity span')?.textContent).toBe('Yönetici');
    expect(aside.querySelector('.shell-signout')?.textContent).toBe('Oturumu kapat');
  });

  it('preserves pending sign-out copy on the desktop account control', async () => {
    setDesktop(true);
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/jobs']}>
        <AppShell user={admin} pendingSignOut onSignOut={() => {}}>
          <main>İçerik</main>
        </AppShell>
      </MemoryRouter>,
    ));
    const signOut = container.querySelector<HTMLButtonElement>('.shell-sidebar .shell-signout')!;
    expect(signOut.disabled).toBe(true);
    expect(signOut.textContent).toBe('Kapatılıyor…');
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

    // T2A polish is scoped to the desktop sidebar only.
    expect(exactRuleBody('.shell-sidebar .shell-nav')).toMatch(/gap:\s*1\.35rem/);
    expect(exactRuleBody('.shell-sidebar .shell-nav a')).toMatch(/border-radius:\s*0\.55rem/);
    expect(exactRuleBody('.shell-sidebar .shell-nav a')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(exactRuleBody('.shell-sidebar .shell-nav a[aria-current="page"]')).toMatch(/font-weight:\s*760/);
    expect(exactRuleBody('.shell-sidebar .shell-account')).toMatch(/gap:\s*0\.75rem/);
    expect(exactRuleBody('.shell-sidebar .shell-identity strong')).toMatch(/font-weight:\s*720/);
    expect(exactRuleBody('.shell-sidebar .shell-signout')).toMatch(/font-weight:\s*680/);
    expect(css).toMatch(/\.shell-sidebar-brand\s*\{/s);
    expect(css).toMatch(/\.shell-sidebar-footer\s*\{[^}]*margin-top:\s*auto/s);
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
    // Desktop-only structural hooks must not appear in the mobile drawer.
    expect(dialog.querySelector('.shell-sidebar-brand')).toBeNull();
    expect(dialog.querySelector('.shell-sidebar-footer')).toBeNull();
    expect(dialog.closest('.shell-sidebar')).toBeNull();
  });

  it('preserves mobile top bar zones on the jobs list with sticky create', async () => {
    await render(staff, false, '/jobs');
    expect(container.querySelector('.sticky-new-job')).not.toBeNull();
    expect(container.querySelector('.mobile-top-bar')).not.toBeNull();
    expect(container.querySelector('.mobile-top-bar-start .mobile-shell-title')?.textContent).toBe('İşlerim');
    expect(container.querySelector('.mobile-top-bar-actions .shell-menu-button')).not.toBeNull();
    expect(container.querySelector('.mobile-top-bar-actions [aria-label="Bildirimler"]')).not.toBeNull();
  });

  it('hides sticky create outside the jobs list path', async () => {
    await render(staff, false, '/customers');
    expect(container.querySelector('.mobile-shell-title')?.textContent).toBe('Müşteriler');
    expect(container.querySelector('.sticky-new-job')).toBeNull();
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
    expect(exactRuleBody('.mobile-top-back')).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(exactRuleBody('.shell-notification-trigger')).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(exactRuleBody('.shell-notification-trigger')).toMatch(/(?:flex:\s*0\s+0\s+2\.75rem|width:\s*2\.75rem)/);

    // Bottom nav: active uses weight channel; labels can wrap safely.
    expect(exactRuleBody('.mobile-bottom-nav')).toMatch(/safe-area-inset-bottom/);
    expect(exactRuleBody('.mobile-bottom-nav-item')).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(exactRuleBody('.mobile-bottom-nav-item')).toMatch(/overflow-wrap:\s*anywhere/);
    const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(cleaned).toMatch(
      /\.mobile-bottom-nav-item--active,\s*\.mobile-bottom-nav a\[aria-current=["']page["']\],\s*\.mobile-bottom-nav-menu\[aria-expanded=["']true["']\]\s*\{[^}]*font-weight:\s*760/s,
    );

    // Sticky create clears bottom nav via safe-area-aware offset.
    expect(exactRuleBody('.sticky-new-job')).toMatch(/bottom:\s*calc\(4\.35rem \+ env\(safe-area-inset-bottom/);
    expect(exactRuleBody('.authenticated-shell--mobile .shell-content')).toMatch(/safe-area-inset-bottom/);
    expect(css).toMatch(
      /\.authenticated-shell--mobile\.authenticated-shell:has\(\.sticky-new-job\) \.shell-content\s*\{[^}]*padding-bottom:\s*calc\(8\.75rem/s,
    );

    // Drawer visual polish is drawer-scoped; shared nav baseline stays T2A isolation values.
    expect(exactRuleBody('.shell-drawer')).toMatch(/background:\s*var\(--paper\)/);
    expect(exactRuleBody('.shell-drawer')).toMatch(/safe-area-inset-bottom/);
    expect(exactRuleBody('.shell-drawer')).toMatch(/box-shadow:/);
    expect(exactRuleBody('.shell-drawer .shell-nav')).toMatch(/(?:margin-top:\s*1\.15rem|flex:\s*1\s+1\s+auto)/);
    expect(exactRuleBody('.shell-drawer .shell-account')).toMatch(/margin-top:\s*auto/);
    expect(exactRuleBody('.shell-nav')).toMatch(/gap:\s*1\.15rem/);
    expect(exactRuleBody('.shell-nav a')).toMatch(/border-radius:\s*0\.5rem/);
    expect(exactRuleBody('.shell-nav a[aria-current="page"]')).not.toMatch(/font-weight:/);

    // No Ant Layout/Menu.
    expect(css).not.toMatch(/ant-layout|ant-menu/);
  });
});
