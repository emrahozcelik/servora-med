/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryRouter } from 'react-router-dom';
import { ResolvedIdentityProvider } from '../src/shell/resolved-identity';
import { RouteNavigationProvider } from '../src/shell/route-navigation-provider';
import { matchRouteIdentity } from '../src/shell/route-identity';
import type { CurrentUser } from '../src/services/api';
import { PageHeader } from '../src/ui/PageHeader';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'm1', organizationId: 'o1', name: 'M', email: 'm@b.c', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

describe('PageHeader contract', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
  });

  async function render(path: string, header: React.ReactNode, state?: unknown) {
    const pathname = path.split(/[?#]/)[0] ?? path;
    const match = matchRouteIdentity(pathname);
    if (!match) throw new Error(`expected identity for ${path}`);
    await act(async () => root.render(
      <MemoryRouter initialEntries={[{ pathname, search: '', hash: '', state: state ?? null }]}>
        <ResolvedIdentityProvider match={match} role="MANAGER">
          <RouteNavigationProvider user={manager}>{header}</RouteNavigationProvider>
        </ResolvedIdentityProvider>
      </MemoryRouter>,
    ));
  }

  it('renders the resolved effective title as the single H1', async () => {
    await render('/settings/security', <PageHeader />);
    const headings = container.querySelectorAll('.page-header h1');
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe('Güvenlik');
    expect(container.querySelector('.page-header-eyebrow')?.textContent).toBe('Hesap');
  });

  it('renders description and page-owned actions as supplied', async () => {
    await render('/jobs', <PageHeader description="Açıklama" actions={<button type="button">Eylem</button>} />);
    expect(container.querySelector('.page-header-description')?.textContent).toBe('Açıklama');
    expect(container.querySelector('.page-header-actions button')?.textContent).toBe('Eylem');
    expect(container.querySelector('.page-header h1')?.textContent).toBe('İşler');
  });

  it('preserves a page eyebrow override without touching the registry title', async () => {
    await render('/jobs', <PageHeader eyebrow="Çalışma alanı" />);
    expect(container.querySelector('.page-header-eyebrow')?.textContent).toBe('Çalışma alanı');
    expect(container.querySelector('.page-header h1')?.textContent).toBe('İşler');
  });

  it('renders no breadcrumb or ReturnLink on roots', async () => {
    await render('/jobs', <PageHeader />);
    expect(container.querySelector('.route-breadcrumb')).toBeNull();
    expect(container.querySelector('.route-return-link')).toBeNull();
    expect(container.querySelector('.route-context-control')).toBeNull();
  });

  it('renders hierarchy breadcrumb and fallback ReturnLink on nested routes', async () => {
    await render('/settings/security', <PageHeader />);
    expect(container.querySelector('.route-breadcrumb')?.textContent).toContain('Ayarlar');
    expect(container.querySelector('.route-breadcrumb')?.textContent).toContain('Güvenlik');
    expect(container.querySelector('.route-return-link')?.textContent).toContain('Ayarlar');
    expect(container.querySelector('.route-context-control')).toBeNull();
  });

  it('renders calendar context return without polluting breadcrumb', async () => {
    await render('/jobs/job-1', <PageHeader />, { from: { pathname: '/calendar', search: '?month=2026-09', hash: '' } });
    expect(container.querySelector('.route-breadcrumb')?.textContent).toContain('İşler');
    expect(container.querySelector('.route-breadcrumb')?.textContent).not.toContain('Takvim');
    expect(container.querySelector('.route-return-link')?.textContent).toContain('Takvim');
    expect(container.querySelector('.route-context-control')?.textContent).toBe('Takvime dön');
  });

  it('suppresses desktop context control for redundant jobs context', async () => {
    await render('/jobs/job-1', <PageHeader />, { from: { pathname: '/jobs', search: '', hash: '' } });
    expect(container.querySelector('.route-return-link')?.textContent).toContain('İşler');
    expect(container.querySelector('.route-context-control')).toBeNull();
  });

  it('computes no title fallback inside PageHeader', async () => {
    await render('/jobs/job-1', <PageHeader />);
    // Generic fallback comes from the resolution layer, not the component.
    expect(container.querySelector('.page-header h1')?.textContent).toBe('İş detayı');
  });
});
