import { describe, expect, it } from 'vitest';

import {
  buildNavigationModel,
  groupNavigationBySection,
  groupNavigationForMenu,
  resolveHomePath,
  resolveIdentityTitle,
} from '../src/shell/navigation-model';
import { MobileTopBar } from '../src/shell/MobileTopBar';
import { getRouteIdentity, resolveParentPath } from '../src/shell/route-identity';
import { paths } from '../src/paths';
import type { CurrentUser } from '../src/services/api';

const staff: CurrentUser = {
  id: 's1', organizationId: 'o1', name: 'A', email: 'a@b.c', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const manager: CurrentUser = { ...staff, role: 'MANAGER' };
const admin: CurrentUser = { ...staff, role: 'ADMIN' };

describe('buildNavigationModel', () => {
  it('resolves the authenticated home from the overview capability', () => {
    expect(resolveHomePath({ ...manager, capabilities: { ...manager.capabilities, overviewDashboard: true } }))
      .toBe(paths.overview);
    expect(resolveHomePath(manager)).toBe(paths.jobs);
  });

  it('keeps one SSOT for staff destinations and bottom tabs', () => {
    const model = buildNavigationModel(staff);
    expect(model.destinations.map((d) => d.label)).toEqual([
      'İşler', 'Müşteriler', 'Ürünler', 'Profilim',
      'Dokümantasyon', 'Yardım Merkezi', 'Ayarlar',
    ]);
    expect(model.destinations.map((d) => d.section)).toEqual([
      'Operasyon', 'Operasyon', 'Operasyon', 'Ekip', 'Destek', 'Destek', 'Hesap',
    ]);
    expect(model.bottom.map((d) => d.label)).toEqual([
      'İşler', 'Müşteriler', 'Yeni iş', 'Ürünler', 'Menü',
    ]);
  });

  it('puts Menü as a non-link action for manager bottom nav', () => {
    const model = buildNavigationModel(manager);
    expect(model.destinations.map((d) => d.label)).toEqual([
      'İşler', 'Müşteriler', 'Ürünler', 'Raporlar', 'Personel',
      'Dokümantasyon', 'Yardım Merkezi', 'Ayarlar',
    ]);
    expect(model.destinations.map((d) => d.section)).toEqual([
      'Operasyon', 'Operasyon', 'Operasyon', 'Analiz', 'Ekip',
      'Destek', 'Destek', 'Hesap',
    ]);
    expect(model.bottom.map((d) => ({ kind: d.kind, label: d.label }))).toEqual([
      { kind: 'link', label: 'İşler' },
      { kind: 'link', label: 'Müşteriler' },
      { kind: 'create', label: 'Yeni iş' },
      { kind: 'link', label: 'Raporlar' },
      { kind: 'menu', label: 'Menü' },
    ]);
  });

  it('keeps the create action in the middle slot of at most five bottom-nav items', () => {
    const model = buildNavigationModel(admin);
    expect(model.bottom).toHaveLength(5);
    expect(model.bottom[2]).toMatchObject({ kind: 'create', id: 'new-job', label: 'Yeni iş' });
    expect(model.bottom.at(-1)).toMatchObject({ kind: 'menu', id: 'menu' });
    expect(model.bottom.filter((item) => item.kind === 'link').length).toBe(3);
  });

  it('includes Kullanıcılar for admin destinations', () => {
    const model = buildNavigationModel(admin);
    expect(model.destinations.map((d) => d.label)).toContain('Kullanıcılar');
    expect(model.destinations.find((d) => d.label === 'Kullanıcılar')?.section).toBe('Ekip');
    expect(model.bottom).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Kullanıcılar' })]),
    );
  });

  it('keeps Veri Yönetimi under Settings instead of adding a top-level destination', () => {
    const model = buildNavigationModel(admin);
    expect(model.destinations.map((item) => item.label)).not.toContain('Veri Yönetimi');
    expect(resolveIdentityTitle(getRouteIdentity('settingsDataManagement'), 'ADMIN')).toBe('Veri Yönetimi');
    expect(resolveIdentityTitle(getRouteIdentity('settingsDemoData'), 'ADMIN')).toBe('Demo verileri');
  });

  it('keeps canonical settings hierarchy in the registry', () => {
    expect(resolveParentPath(getRouteIdentity('settingsDemoData'), {})).toBe(paths.settingsDataManagement);
    expect(resolveParentPath(getRouteIdentity('settingsBackupRecovery'), {})).toBe(paths.settingsDataManagement);
  });

  it('shows Backup & Recovery only for an ADMIN when the backup capability is enabled', () => {
    const enabled = buildNavigationModel({
      ...admin,
      capabilities: { ...admin.capabilities, backup: true },
    });
    expect(enabled.destinations.map((item) => item.label)).toContain('Yedekleme ve Kurtarma');
    expect(enabled.destinations.find((item) => item.label === 'Yedekleme ve Kurtarma')?.to).toBe('/settings/data-management/backup-recovery');
    expect(buildNavigationModel({ ...admin, capabilities: { ...admin.capabilities, backup: false } }).destinations)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Yedekleme ve Kurtarma' })]));
    expect(buildNavigationModel({ ...manager, capabilities: { ...manager.capabilities, backup: true } }).destinations)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Yedekleme ve Kurtarma' })]));
  });

  it('shows overview only when enabled and keeps support/account reachable from the menu model', () => {
    const enabled = buildNavigationModel({
      ...staff,
      capabilities: { ...staff.capabilities, overviewDashboard: true },
    });
    expect(enabled.destinations.map((item) => item.label)).toContain('Genel Bakış');
    expect(enabled.destinations.map((item) => item.label)).toContain('Dokümantasyon');
    expect(enabled.destinations.map((item) => item.label)).toContain('Yardım Merkezi');
    expect(enabled.destinations.map((item) => item.label)).toContain('Ayarlar');
    expect(enabled.bottom).toHaveLength(5);
    expect(enabled.bottom.at(-1)).toMatchObject({ kind: 'menu', label: 'Menü' });
    expect(buildNavigationModel(staff).destinations.map((item) => item.label))
      .not.toContain('Genel Bakış');
  });

  it('shows Takvim only with capability and keeps it in the bottom-nav model', () => {
    const enabled = buildNavigationModel({
      ...staff,
      capabilities: {
        ...staff.capabilities,
        overviewDashboard: true,
        calendar: true,
      },
    });
    expect(enabled.destinations.map((item) => item.label)).toContain('Takvim');
    expect(enabled.bottom.map((item) => item.label))
      .toEqual(['Genel Bakış', 'İşler', 'Yeni iş', 'Takvim', 'Menü']);
    expect(buildNavigationModel(staff).destinations.map((item) => item.label))
      .not.toContain('Takvim');
    expect(resolveIdentityTitle(getRouteIdentity('calendar'), 'STAFF')).toBe('Takvim');
  });
});

describe('navigation grouping (DECISIONS.md UI-004)', () => {
  it('keeps the five sidebar sections in model order', () => {
    const groups = groupNavigationBySection(buildNavigationModel(manager).destinations);
    expect(groups.map((group) => group.label)).toEqual([
      'Operasyon', 'Analiz', 'Ekip', 'Destek', 'Hesap',
    ]);
    expect(groups.flatMap((group) => group.items).map((item) => item.label)).toEqual(
      buildNavigationModel(manager).destinations.map((item) => item.label),
    );
  });

  it('groups the mobile menu as Çalışma then Hesap ve destek', () => {
    const groups = groupNavigationForMenu(buildNavigationModel(manager).destinations);
    expect(groups.map((group) => group.label)).toEqual(['Çalışma', 'Hesap ve destek']);
    expect(groups[0].items.map((item) => item.label)).toEqual([
      'İşler', 'Müşteriler', 'Ürünler', 'Raporlar', 'Personel',
    ]);
    expect(groups[1].items.map((item) => item.label)).toEqual([
      'Dokümantasyon', 'Yardım Merkezi', 'Ayarlar',
    ]);
    expect(groups.flatMap((group) => group.items)).toHaveLength(
      buildNavigationModel(manager).destinations.length,
    );
  });

  it('keeps backup inside Hesap ve destek for an enabled admin', () => {
    const groups = groupNavigationForMenu(buildNavigationModel({
      ...admin,
      capabilities: { ...admin.capabilities, backup: true },
    }).destinations);
    expect(groups.map((group) => group.label)).toEqual(['Çalışma', 'Hesap ve destek']);
    expect(groups[1].items.map((item) => item.label)).toEqual([
      'Dokümantasyon', 'Yardım Merkezi', 'Ayarlar', 'Yedekleme ve Kurtarma',
    ]);
  });
});

describe('legacy shell-back removal (Slice 3B)', () => {
  it('removes MobileTopBar back plumbing', () => {
    // Props are runtime args; assert the component no longer declares backTo
    // by inspecting its source (fail-closed if plumbing returns).
    expect(MobileTopBar.toString()).not.toContain('backTo');
    expect(MobileTopBar.toString()).not.toContain('Geri');
  });

  it('removes the top-bar menu affordance (DECISIONS.md UI-004)', () => {
    expect(MobileTopBar.toString()).not.toContain('onOpenMenu');
    expect(MobileTopBar.toString()).not.toContain('menuExpanded');
    expect(MobileTopBar.toString()).not.toContain('Menü');
  });
});
