import { describe, expect, it } from 'vitest';

import {
  buildNavigationModel,
  isJobsListPath,
  resolveShellBackTo,
  resolveShellTitle,
} from '../src/shell/navigation-model';
import type { CurrentUser } from '../src/services/api';

const staff: CurrentUser = {
  id: 's1', organizationId: 'o1', name: 'A', email: 'a@b.c', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
};
const manager: CurrentUser = { ...staff, role: 'MANAGER' };
const admin: CurrentUser = { ...staff, role: 'ADMIN' };

describe('buildNavigationModel', () => {
  it('keeps one SSOT for staff destinations and bottom tabs', () => {
    const model = buildNavigationModel(staff);
    expect(model.destinations.map((d) => d.label)).toEqual(['İşler', 'Müşteriler', 'Ürünler', 'Profilim']);
    expect(model.destinations.map((d) => d.section)).toEqual([
      'Operasyon', 'Operasyon', 'Operasyon', 'Ekip',
    ]);
    expect(model.bottom.map((d) => d.label)).toEqual(['İşler', 'Müşteriler', 'Ürünler', 'Profilim']);
    expect(model.bottom.every((d) => d.kind === 'link')).toBe(true);
  });

  it('puts Menü as a non-link action for manager bottom nav', () => {
    const model = buildNavigationModel(manager);
    expect(model.destinations.map((d) => d.label)).toEqual(['İşler', 'Müşteriler', 'Ürünler', 'Raporlar', 'Personel']);
    expect(model.destinations.map((d) => d.section)).toEqual([
      'Operasyon', 'Operasyon', 'Operasyon', 'Analiz', 'Ekip',
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
});

describe('shell title and back helpers', () => {
  it('resolves section titles and nested back targets', () => {
    expect(resolveShellTitle('/jobs', 'STAFF')).toBe('İşlerim');
    expect(resolveShellTitle('/jobs', 'MANAGER')).toBe('İşler');
    expect(resolveShellTitle('/jobs/abc', 'MANAGER')).toBe('İş detayı');
    expect(resolveShellBackTo('/jobs/abc')).toBe('/jobs');
    expect(resolveShellBackTo('/jobs')).toBeNull();
    expect(resolveShellBackTo('/customers/c1/contacts/x')).toBe('/customers/c1');
    expect(resolveShellBackTo('/staff/s1/reports')).toBe('/staff/s1');
    expect(isJobsListPath('/jobs')).toBe(true);
    expect(isJobsListPath('/jobs/abc')).toBe(false);
  });
});
