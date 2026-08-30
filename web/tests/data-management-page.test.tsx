/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataManagementPage } from '../src/settings/DataManagementPage';
import { SettingsLandingPage } from '../src/settings/SettingsPages';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const admin: CurrentUser = {
  id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'admin@example.com',
  role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const adminWithBackup: CurrentUser = {
  ...admin,
  capabilities: { ...admin.capabilities, backup: true },
};
const summary = {
  customers: { total: 3, prospect: 1, active: 1, inactive: 1 },
  contacts: { total: 2, active: 1, inactive: 1 },
  products: { total: 2, active: 1, inactive: 1 },
  staff: { total: 2, active: 1, inactive: 1 },
  demoDataset: { total: 0, active: 0 },
};
const emptySummary = {
  customers: { total: 0, prospect: 0, active: 0, inactive: 0 },
  contacts: { total: 0, active: 0, inactive: 0 },
  products: { total: 0, active: 0, inactive: 0 },
  staff: { total: 0, active: 0, inactive: 0 },
  demoDataset: { total: 0, active: 0 },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function renderPage(user = admin, load = vi.fn().mockResolvedValue(summary)) {
  await act(async () => {
    root.render(<MemoryRouter><DataManagementPage user={user} load={load} /></MemoryRouter>);
  });
  await settle();
}

describe('DataManagementPage', () => {
  it('renders an accessible loading state before the summary is available', async () => {
    await act(async () => {
      root.render(<MemoryRouter><DataManagementPage user={admin} load={() => new Promise(() => {})} /></MemoryRouter>);
    });

    expect(host.textContent).toContain('Veri Yönetimi yükleniyor');
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('renders bounded summaries and canonical non-destructive links', async () => {
    await renderPage();

    expect(host.querySelector('h1')?.textContent).toBe('Veri Yönetimi');
    expect(host.textContent).toContain('Kuruluşunuzdaki iş kayıtlarını ve demo verilerini güvenli yaşam döngüsü kurallarıyla yönetin.');
    expect(host.textContent).toContain('Müşteriler');
    expect(host.textContent).toContain('İlgili kişiler');
    expect(host.textContent).toContain('Ürünler');
    expect(host.textContent).toContain('Personel');
    expect(host.textContent).toContain('Demo verileri');
    expect(host.textContent).toContain('Aktif demo veri kümesi yok.');
    expect(host.querySelector('a[href="/customers"]')?.textContent).toBe('Müşterileri yönet');
    expect(host.querySelector('a[href="/products"]')?.textContent).toBe('Ürünleri yönet');
    expect(host.querySelector('a[href="/staff"]')?.textContent).toBe('Personeli yönet');
    expect(host.querySelector('a[href="/settings/data-management/demo-data"]')?.textContent).toBe('Demo verilerini yönet');
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.textContent).not.toContain('Toplu sil');
    expect(host.textContent).not.toContain('Temizle');
  });

  it('shows Backup & Recovery only as a separate capability-gated infrastructure link', async () => {
    await renderPage(adminWithBackup);

    const backupLink = host.querySelector('a[href="/settings/data-management/backup-recovery"]');
    expect(backupLink?.textContent).toBe('Yedekleme durumunu görüntüle');
    expect(host.textContent).toContain('installation-level altyapı yedekleme durumu');

    await act(async () => root.unmount());
    root = createRoot(host);
    await renderPage(admin);
    expect(host.querySelector('a[href="/settings/data-management/backup-recovery"]')).toBeNull();
  });

  it('exposes the Settings entry only to Admin without adding a new role or capability', () => {
    const manager = { ...admin, role: 'MANAGER' as const };
    const staff = { ...admin, role: 'STAFF' as const };
    const adminHtml = renderToStaticMarkup(<MemoryRouter><SettingsLandingPage user={admin} /></MemoryRouter>);
    const managerHtml = renderToStaticMarkup(<MemoryRouter><SettingsLandingPage user={manager} /></MemoryRouter>);
    const staffHtml = renderToStaticMarkup(<MemoryRouter><SettingsLandingPage user={staff} /></MemoryRouter>);

    expect(adminHtml).toContain('/settings/data-management');
    expect(adminHtml).toContain('Veri Yönetimi');
    expect(managerHtml).not.toContain('/settings/data-management');
    expect(staffHtml).not.toContain('/settings/data-management');
  });

  it('renders an accessible retry state when the summary request fails', async () => {
    await renderPage(admin, vi.fn().mockRejectedValue(new Error('Özet alınamadı.')));

    expect(host.textContent).toContain('Veri özeti yüklenemedi');
    expect(host.textContent).toContain('Özet alınamadı.');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector('button')?.textContent).toBe('Tekrar dene');
  });

  it('renders zero counts and an empty Demo state as valid data', async () => {
    await renderPage(admin, vi.fn().mockResolvedValue(emptySummary));

    expect(host.textContent).toContain('Aktif demo veri kümesi yok.');
    expect(host.textContent).not.toContain('Veri özeti yüklenemedi');
    expect(host.querySelectorAll('.data-management-counts dd')).toHaveLength(15);
    expect(Array.from(host.querySelectorAll('.data-management-counts dd')).every((item) => item.textContent === '0')).toBe(true);
  });
});
