/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../src/AppShell';
import type { CurrentUser } from '../src/services/api';
import { PageHeader } from '../src/ui/PageHeader';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici', email: 'murat@example.com',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const admin: CurrentUser = { ...manager, id: 'admin-1', name: 'Deniz Admin', role: 'ADMIN' };

const calendarState = { from: { pathname: '/calendar', search: '?month=2026-09', hash: '' } };

function setDesktop(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches, media: '(min-width: 64rem)', onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

describe('single desktop route identity (shell + PageHeader composition)', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });

  async function renderRoute(user: CurrentUser, desktop: boolean, pathname: string, state: unknown = null) {
    setDesktop(desktop);
    await act(async () => root.render(
      <MemoryRouter initialEntries={[{ pathname, search: '', hash: '', state }]}>
        <AppShell user={user} pendingSignOut={false} onSignOut={() => {}}>
          <PageHeader />
        </AppShell>
      </MemoryRouter>,
    ));
  }

  function expectSingleIdentity(expectedH1: string) {
    expect(container.querySelector('.desktop-shell-title')).toBeNull();
    const headings = Array.from(container.querySelectorAll('h1.page-header-title'));
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe(expectedH1);
  }

  it('renders job detail without a shell title duplicate', async () => {
    await renderRoute(manager, true, '/jobs/job-1');
    expectSingleIdentity('İş detayı');
    const crumbs = Array.from(container.querySelectorAll('.route-breadcrumb li')).map((li) => li.textContent);
    expect(crumbs).toEqual(['İşler', 'İş detayı']);
    expect(container.querySelector('.route-breadcrumb a')?.getAttribute('href')).toBe('/jobs');
    expect(container.querySelector('.route-context-control')).toBeNull();
  });

  it('renders calendar context on job detail as the only extra return control', async () => {
    await renderRoute(manager, true, '/jobs/job-1', calendarState);
    expectSingleIdentity('İş detayı');
    expect(container.querySelector('.route-breadcrumb')).not.toBeNull();
    const context = container.querySelector('.route-context-control')!;
    expect(context.textContent).toBe('Takvime dön');
    expect(context.getAttribute('href')).toBe('/calendar?month=2026-09');
    const mobile = container.querySelector('.route-return-link')!;
    expect(mobile.textContent).toBe('‹ Takvim');
  });

  it('renders customer detail without a shell title duplicate', async () => {
    await renderRoute(manager, true, '/customers/c-1');
    expectSingleIdentity('Müşteri');
    const crumbs = Array.from(container.querySelectorAll('.route-breadcrumb li')).map((li) => li.textContent);
    expect(crumbs).toEqual(['Müşteriler', 'Müşteri']);
  });

  it('renders a nested settings route without a shell title duplicate', async () => {
    await renderRoute(admin, true, '/settings/security');
    expectSingleIdentity('Güvenlik');
    const crumbs = Array.from(container.querySelectorAll('.route-breadcrumb li')).map((li) => li.textContent);
    expect(crumbs).toEqual(['Ayarlar', 'Güvenlik']);
    expect(container.querySelector('.route-context-control')).toBeNull();
  });

  it('renders a report subroute without a shell title duplicate', async () => {
    await renderRoute(manager, true, '/reports/staff');
    expectSingleIdentity('Personel Operasyon Analizi');
    expect(container.querySelector('.route-breadcrumb')).not.toBeNull();
    expect(container.querySelector('.route-context-control')).toBeNull();
  });

  it('renders the jobs root with a single H1 and no return chrome', async () => {
    await renderRoute(manager, true, '/jobs');
    expectSingleIdentity('İşler');
    expect(container.querySelector('.route-breadcrumb')).toBeNull();
    expect(container.querySelector('.route-return-link')).toBeNull();
    expect(container.querySelector('.route-context-control')).toBeNull();
  });

  it('ignores calendar context on the jobs root (rendered)', async () => {
    await renderRoute(manager, true, '/jobs', calendarState);
    expectSingleIdentity('İşler');
    expect(container.querySelector('.route-breadcrumb')).toBeNull();
    expect(container.querySelector('.route-return-link')).toBeNull();
    expect(container.querySelector('.route-context-control')).toBeNull();
  });

  it('renders mobile job detail with topbar title and contextual ReturnLink', async () => {
    await renderRoute(manager, false, '/jobs/job-1', calendarState);
    expect(container.querySelector('.desktop-shell-topbar')).toBeNull();
    expect(container.querySelector('.mobile-shell-title')?.textContent).toBe('İş detayı');
    expect(container.querySelector('.route-return-link')?.textContent).toBe('‹ Takvim');
    expect(container.querySelectorAll('h1.page-header-title')).toHaveLength(1);
  });
});
