/** @vitest-environment jsdom */
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { ResolvedIdentityProvider } from '../src/shell/resolved-identity';
import { RouteNavigationProvider } from '../src/shell/route-navigation-provider';
import { matchRouteIdentity } from '../src/shell/route-identity';
import type { CurrentUser } from '../src/services/api';

export const routeTestManager: CurrentUser = {
  id: 'm1', organizationId: 'o1', name: 'M', email: 'm@b.c', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

export const routeTestAdmin: CurrentUser = { ...routeTestManager, role: 'ADMIN', id: 'a1' };

export const routeTestStaff: CurrentUser = {
  ...routeTestManager, role: 'STAFF', id: 's1',
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
};

/**
 * Wraps UI in MemoryRouter + resolved identity + route navigation so
 * PageHeader breadcrumb/ReturnLink render in tests. State is attached to the
 * single initial entry (context-return cases).
 */
export function withRoute(
  pathname: string,
  ui: React.ReactNode,
  options?: { role?: CurrentUser['role']; user?: CurrentUser; state?: unknown },
) {
  const cleanPathname = pathname.split(/[?#]/)[0] ?? pathname;
  const match = matchRouteIdentity(cleanPathname);
  if (!match) throw new Error(`expected identity for ${pathname}`);
  const user = options?.user ?? (options?.role === 'STAFF'
    ? routeTestStaff
    : options?.role === 'ADMIN'
      ? routeTestAdmin
      : routeTestManager);
  const role = options?.role ?? user.role;
  return (
    <MemoryRouter initialEntries={[{ pathname: cleanPathname, search: '', hash: '', state: options?.state ?? null }]}>
      <ResolvedIdentityProvider match={match} role={role}>
        <RouteNavigationProvider user={user}>{ui}</RouteNavigationProvider>
      </ResolvedIdentityProvider>
    </MemoryRouter>
  );
}

export async function renderWithRoute(
  root: { render: (node: React.ReactNode) => void },
  pathname: string,
  ui: React.ReactNode,
  options?: { role?: CurrentUser['role']; user?: CurrentUser; state?: unknown },
) {
  await act(async () => root.render(withRoute(pathname, ui, options)));
}
