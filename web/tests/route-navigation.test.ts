import { describe, expect, it } from 'vitest';

import { validateContextReturn } from '../src/shell/context-return';
import {
  buildBreadcrumb,
  resolveHierarchyParent,
  resolveReturnTarget,
} from '../src/shell/route-navigation';
import { getRouteIdentity, matchRouteIdentity } from '../src/shell/route-identity';
import type { CurrentUser } from '../src/services/api';

const manager: CurrentUser = {
  id: 'm1', organizationId: 'o1', name: 'M', email: 'm@b.c', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

describe('route navigation model', () => {
  it('returns no breadcrumb for roots', () => {
    const match = matchRouteIdentity('/jobs')!;
    expect(buildBreadcrumb(match, 'İşler', {}, 'MANAGER')).toEqual([]);
    expect(resolveHierarchyParent(match, {}, 'MANAGER')).toBeNull();
    expect(resolveReturnTarget(null, null, 'MANAGER').returnTarget).toBeNull();
  });

  it('builds hierarchy breadcrumb for job detail', () => {
    const match = matchRouteIdentity('/jobs/abc')!;
    const crumbs = buildBreadcrumb(match, 'Acme visit', {}, 'MANAGER');
    expect(crumbs.map((c) => c.label)).toEqual(['İşler', 'Acme visit']);
    expect(crumbs[0]!.to).toBe('/jobs');
    expect(crumbs[1]!.to).toBeNull();
    const hierarchy = resolveHierarchyParent(match, {}, 'MANAGER')!;
    expect(hierarchy.to).toBe('/jobs');
    expect(hierarchy.label).toBe('İşler');
  });

  it('builds settings depth-3 chain', () => {
    const match = matchRouteIdentity('/settings/data-management/demo-data')!;
    const crumbs = buildBreadcrumb(match, 'Demo verileri', {}, 'ADMIN');
    expect(crumbs.map((c) => c.label)).toEqual(['Ayarlar', 'Veri Yönetimi', 'Demo verileri']);
    expect(crumbs[0]!.to).toBe('/settings');
    expect(crumbs[1]!.to).toBe('/settings/data-management');
  });

  it('uses ancestor labels without fetching', () => {
    const match = matchRouteIdentity('/customers/c1/contacts/k1')!;
    const crumbs = buildBreadcrumb(match, 'Ahmet', { customerDetail: 'Acme' }, 'MANAGER');
    expect(crumbs.map((c) => c.label)).toEqual(['Müşteriler', 'Acme', 'Ahmet']);
    expect(crumbs[1]!.to).toBe('/customers/c1');
  });

  it('ignores even valid context on root routes', () => {
    const match = matchRouteIdentity('/jobs')!;
    expect(buildBreadcrumb(match, 'İşler', {}, 'MANAGER')).toEqual([]);
    expect(resolveHierarchyParent(match, {}, 'MANAGER')).toBeNull();
    const context = validateContextReturn(
      { from: { pathname: '/calendar', search: '?month=2026-09', hash: '' } },
      manager,
    )!;
    const resolved = resolveReturnTarget(null, context, 'MANAGER');
    expect(resolved.returnTarget).toBeNull();
    expect(resolved.showContextControl).toBe(false);
    expect(resolved.desktopContextLabel).toBeNull();
  });

  it('ignores valid context on the settings root', () => {
    const match = matchRouteIdentity('/settings')!;
    expect(resolveHierarchyParent(match, {}, 'ADMIN')).toBeNull();
    const context = validateContextReturn(
      { from: { pathname: '/calendar', search: '', hash: '' } },
      { ...manager, role: 'ADMIN' },
    )!;
    const resolved = resolveReturnTarget(null, context, 'ADMIN');
    expect(resolved).toEqual({ returnTarget: null, showContextControl: false, desktopContextLabel: null });
  });

  it('resolves calendar context vs hierarchy fallback', () => {
    const match = matchRouteIdentity('/jobs/abc')!;
    const hierarchy = resolveHierarchyParent(match, {}, 'MANAGER')!;
    const context = validateContextReturn(
      { from: { pathname: '/calendar', search: '?month=2026-09', hash: '' } },
      manager,
    )!;
    const resolved = resolveReturnTarget(hierarchy, context, 'MANAGER');
    expect(resolved.returnTarget).toEqual({ to: '/calendar?month=2026-09', label: 'Takvim' });
    expect(resolved.showContextControl).toBe(true);
    expect(resolved.desktopContextLabel).toBe('Takvime dön');

    const direct = resolveReturnTarget(hierarchy, null, 'MANAGER');
    expect(direct.returnTarget).toEqual({ to: '/jobs', label: 'İşler' });
    expect(direct.showContextControl).toBe(false);
  });

  it('suppresses redundant jobs context on desktop', () => {
    const match = matchRouteIdentity('/jobs/abc')!;
    const hierarchy = resolveHierarchyParent(match, {}, 'MANAGER')!;
    const context = validateContextReturn({ from: { pathname: '/jobs', search: '', hash: '' } }, manager)!;
    const resolved = resolveReturnTarget(hierarchy, context, 'MANAGER');
    expect(resolved.showContextControl).toBe(false);
    expect(resolved.returnTarget?.label).toBe('İşler');
  });

  it('keeps demo hierarchy parent as data management', () => {
    const demo = getRouteIdentity('settingsDemoData');
    expect(demo.parentId).toBe('settingsDataManagement');
    const match = matchRouteIdentity('/settings/data-management/demo-data')!;
    expect(resolveHierarchyParent(match, {}, 'ADMIN')?.to).toBe('/settings/data-management');
    expect(resolveHierarchyParent(match, {}, 'ADMIN')?.label).toBe('Veri Yönetimi');
  });
});
