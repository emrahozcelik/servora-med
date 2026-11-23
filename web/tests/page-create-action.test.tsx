/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../src/AppShell';
import { CustomerListView } from '../src/CustomerList';
import { ProductListView } from '../src/ProductList';
import type { CurrentUser } from '../src/services/api';
import { useRegisterPageCreateAction, type PageCreateAction } from '../src/shell/page-create-action';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'ayse@example.com',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: true, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const manager: CurrentUser = { ...staff, id: 'manager-1', name: 'Murat Yönetici', role: 'MANAGER' };

function setDesktop(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches, media: '(min-width: 64rem)', onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

function RegisteringPage({ action }: { action: PageCreateAction | null }) {
  useRegisterPageCreateAction(action);
  return <main><h1>Sayfa</h1></main>;
}

function Go({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" data-go={to} onClick={() => navigate(to)}>Git</button>;
}

describe('desktop topbar contextual create', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });

  async function render(user: CurrentUser, routes: ReactNode, path: string, desktop = true) {
    setDesktop(desktop);
    await act(async () => root.render(
      <MemoryRouter initialEntries={[path]}>
        <AppShell user={user} pendingSignOut={false} onSignOut={() => {}}>
          <Routes>{routes}</Routes>
          <Go to="/products" /><Go to="/customers" /><Go to="/jobs" />
        </AppShell>
      </MemoryRouter>,
    ));
  }

  const topbarCreate = () => container.querySelector<HTMLButtonElement>('.desktop-shell-new-job button')!;

  it('keeps the Yeni iş menu where the page registers no create action', async () => {
    await render(manager, <Route path="/jobs" element={<RegisteringPage action={null} />} />, '/jobs');
    expect(topbarCreate().textContent).toBe('Yeni iş');
    expect(topbarCreate().getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the page action, runs it with the topbar button, and follows navigation', async () => {
    const runProduct = vi.fn();
    const runCustomer = vi.fn();
    await render(manager, <>
      <Route path="/products" element={<RegisteringPage action={{ label: 'Yeni ürün', run: runProduct }} />} />
      <Route path="/customers" element={<RegisteringPage action={{ label: 'Yeni müşteri', run: runCustomer }} />} />
      <Route path="/jobs" element={<RegisteringPage action={null} />} />
    </>, '/products');

    expect(topbarCreate().textContent).toBe('Yeni ürün');
    // A direct action, not a disclosure.
    expect(topbarCreate().hasAttribute('aria-expanded')).toBe(false);
    await act(async () => topbarCreate().click());
    expect(runProduct).toHaveBeenCalledWith(topbarCreate());

    // Page-to-page: the unmounting page must not erase the newer registration.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-go="/customers"]')!.click());
    expect(topbarCreate().textContent).toBe('Yeni müşteri');
    await act(async () => topbarCreate().click());
    expect(runCustomer).toHaveBeenCalledTimes(1);
    expect(runProduct).toHaveBeenCalledTimes(1);

    await act(async () => container.querySelector<HTMLButtonElement>('[data-go="/jobs"]')!.click());
    expect(topbarCreate().textContent).toBe('Yeni iş');
  });

  it('carries the page disabled state', async () => {
    await render(manager, <Route path="/calendar" element={
      <RegisteringPage action={{ label: 'Yeni plan', disabled: true, run: vi.fn() }} />
    } />, '/calendar');
    expect(topbarCreate().textContent).toBe('Yeni plan');
    expect(topbarCreate().disabled).toBe(true);
  });

  it('leaves the mobile bottom-navigation create unchanged', async () => {
    await render(manager, <Route path="/products" element={
      <RegisteringPage action={{ label: 'Yeni ürün', run: vi.fn() }} />
    } />, '/products', false);
    expect(container.querySelector('.desktop-shell-new-job')).toBeNull();
    expect(container.querySelector('.mobile-bottom-nav-create .new-job-menu-trigger')?.textContent).toContain('Yeni iş');
  });

  it('registers Yeni ürün only for users who may manage the catalog', async () => {
    const products = (user: CurrentUser) => <Route path="/products" element={
      <ProductListView state={{ kind: 'loading' }} user={user} hasFilters={false}
        onFilterChange={() => undefined} onRetry={() => undefined} />
    } />;
    await render(manager, products(manager), '/products');
    expect(topbarCreate().textContent).toBe('Yeni ürün');
    await render(staff, products(staff), '/products');
    expect(topbarCreate().textContent).toBe('Yeni iş');
  });

  it('runs the customer list create flow from the topbar', async () => {
    const onCreate = vi.fn();
    await render(staff, <Route path="/customers" element={
      <CustomerListView state={{ kind: 'loading' }} user={staff} hasFilters={false}
        onRetry={() => undefined} onCreate={onCreate} />
    } />, '/customers');
    expect(topbarCreate().textContent).toBe('Yeni müşteri');
    await act(async () => topbarCreate().click());
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('hides the page-header create on desktop so one primary create shows per viewport', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    const desktopBlock = css.slice(css.indexOf('.desktop-shell-new-job .new-job-menu-trigger'));
    expect(desktopBlock).toMatch(/^[\s\S]*?\.page-create-action\s*\{\s*display:\s*none;/);
    for (const file of ['src/ProductList.tsx', 'src/CustomerList.tsx', 'src/calendar/CalendarPage.tsx']) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source).toContain('useRegisterPageCreateAction(');
      expect(source).toContain('page-create-action');
    }
  });
});
