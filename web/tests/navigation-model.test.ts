import { describe, expect, it } from 'vitest';

import {
  buildNavigationModel,
  isJobsListPath,
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
  it('keeps one SSOT for staff destinations and bottom tabs', () => {
    const model = buildNavigationModel(staff);
    expect(model.destinations.map((d) => d.label)).toEqual([
      'İşler', 'Müşteriler', 'Ürünler', 'Profilim',
      'Dokümantasyon', 'Yardım Merkezi', 'Ayarlar',
    ]);
    expect(model.destinations.map((d) => d.section)).toEqual([
      'Operasyon', 'Operasyon', 'Operasyon', 'Ekip', 'Destek', 'Destek', 'Hesap',
    ]);
    expect(model.bottom.map((d) => d.label)).toEqual(['İşler', 'Müşteriler', 'Ürünler', 'Menü']);
    expect(model.overflow.map((d) => d.label)).toContain('Profilim');
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
      { kind: 'link', label: 'Raporlar' },
      { kind: 'menu', label: 'Menü' },
    ]);
    expect(model.overflow.map((d) => d.label)).toContain('Personel');
    expect(model.overflow.map((d) => d.label)).toContain('Ürünler');
  });

  it('includes Kullanıcılar for admin destinations and overflow', () => {
    const model = buildNavigationModel(admin);
    expect(model.destinations.map((d) => d.label)).toContain('Kullanıcılar');
    expect(model.overflow.map((d) => d.label)).toContain('Kullanıcılar');
    expect(model.destinations.find((d) => d.label === 'Kullanıcılar')?.section).toBe('Ekip');
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

  it('shows overview only when enabled and keeps support/account in a four-item mobile model', () => {
    const enabled = buildNavigationModel({
      ...staff,
      capabilities: { ...staff.capabilities, overviewDashboard: true },
    });
    expect(enabled.destinations.map((item) => item.label)).toContain('Genel Bakış');
    expect(enabled.destinations.map((item) => item.label)).toContain('Dokümantasyon');
    expect(enabled.destinations.map((item) => item.label)).toContain('Yardım Merkezi');
    expect(enabled.destinations.map((item) => item.label)).toContain('Ayarlar');
    expect(enabled.bottom).toHaveLength(4);
    expect(enabled.bottom.at(-1)).toMatchObject({ kind: 'menu', label: 'Menü' });
    expect(buildNavigationModel(staff).destinations.map((item) => item.label))
      .not.toContain('Genel Bakış');
  });

  it('shows Takvim only with capability and keeps it in the four-control mobile model', () => {
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
      .toEqual(['Genel Bakış', 'İşler', 'Takvim', 'Menü']);
    expect(buildNavigationModel(staff).destinations.map((item) => item.label))
      .not.toContain('Takvim');
    expect(resolveIdentityTitle(getRouteIdentity('calendar'), 'STAFF')).toBe('Takvim');
  });
});

describe('legacy shell-back removal (Slice 3B)', () => {
  it('removes MobileTopBar back plumbing', () => {
    // Props are runtime args; assert the component no longer declares backTo
    // by inspecting its source (fail-closed if plumbing returns).
    expect(MobileTopBar.toString()).not.toContain('backTo');
    expect(MobileTopBar.toString()).not.toContain('Geri');
  });

  it('keeps jobs list path helper', () => {
    expect(isJobsListPath('/jobs')).toBe(true);
    expect(isJobsListPath('/jobs/abc')).toBe(false);
  });
});
