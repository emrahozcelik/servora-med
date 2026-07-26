/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';
import { paths } from '../src/AppRouter';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn().mockReturnValue({
    matches: true,
    media: '(min-width: 64rem)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel',
  email: 'staff@example.com', role: 'STAFF', mustChangePassword: false,
  isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'BT Destek', email: 'support@example.com', helpUrl: 'https://support.example.com' },
};
const manager: CurrentUser = { ...staff, id: 'manager-1', name: 'Murat Yönetici', role: 'MANAGER' };
const admin: CurrentUser = { ...manager, id: 'admin-1', name: 'Deniz Admin', role: 'ADMIN' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
});

async function render(path: string, user: CurrentUser = manager) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App initialUser={user} />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  const html = container.innerHTML;
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return html;
}

describe('application routes', () => {
  it.each([
    ['/jobs', 'İşler', manager],
    ['/jobs/new-delivery', 'Ürün teslimi', staff],
    ['/jobs/new-delivery', 'Ürün teslimi', manager],
    ['/jobs/new-task', 'Genel görev', staff],
    ['/jobs/new-task', 'Genel görev', manager],
    ['/jobs/new-meeting', 'Görüşme / ziyaret planla', staff],
    ['/jobs/new-meeting', 'Görüşme / ziyaret planla', manager],
    ['/jobs/job-1', 'İş detayları yükleniyor', staff],
    ['/users', 'Kullanıcılar', admin],
    ['/users/new', 'Kullanıcı formu yükleniyor', admin],
    ['/users/staff-1', 'Kullanıcı yükleniyor', admin],
    ['/staff', 'Personel', manager],
    ['/staff/staff-1', 'Personel profili', manager],
    ['/staff/staff-1/reports', 'Operasyon raporu yükleniyor', manager],
    ['/customers?status=active', 'Müşteriler', manager],
    ['/customers/new', 'Yeni müşteri', staff],
    ['/customers/new', 'Yeni müşteri', manager],

    ['/customers/customer-1', 'Müşteri detayı', manager],
    ['/customers/customer-1/contacts/contact-1', 'İlgili kişi', manager],
    ['/products', 'Ürünler', staff],
    ['/products?q=eski&offset=25', 'Ürünler', manager],
    ['/products/new', 'Yeni ürün', manager],
    ['/products/product-1', 'Ürün detayı yükleniyor', staff],
    ['/docs', 'Dokümantasyon', staff],
    ['/help', 'Yardım Merkezi', manager],
    ['/settings', 'Ayarlar', staff],
    ['/settings/profile', 'Ayşe Personel', staff],
    ['/settings/security', 'Parolanızı değiştirmeniz', staff],
    ['/settings/notifications', 'Bu cihaz', staff],
  ] as const)('renders %s at a stable URL', async (path, expected, user) => {
    expect(await render(path, user)).toContain(expected);
  });

  it.each([
    ['/users', staff],
    ['/products/new', staff],
    ['/staff/staff-1/reports', staff],
  ] as const)('renders the established forbidden state for unauthorized direct route %s', async (path, user) => {
    const html = await render(path, user);
    expect(html).toContain('Bu alana erişim yetkiniz yok');
    expect(html).not.toContain('Kullanıcı oluştur');
  });

  it('renders a safe not-found view for an unknown route', async () => {
    const html = await render('/unknown');
    expect(html).toContain('Sayfa bulunamadı');
    expect(html).toContain('İşlere dön');
  });

  it('redirects an authenticated user away from the sign-in route', async () => {
    const html = await render('/login');
    expect(html).not.toContain('Sayfa bulunamadı');
  });

  it('uses overview as the authenticated landing only when the server capability is enabled', async () => {
    const enabled = { ...manager, capabilities: { ...manager.capabilities, overviewDashboard: true } };
    expect(await render('/', enabled)).toContain('Genel bakış yükleniyor');
    expect(await render('/login', enabled)).toContain('Genel bakış yükleniyor');
    expect(await render('/', manager)).toContain('İşler');
  });

  it('fails closed when overview is opened directly without the capability', async () => {
    const html = await render('/overview', staff);
    expect(html).toContain('İşler');
    expect(html).not.toContain('Genel bakış yükleniyor');
  });

  it('renders configured support links without exposing arbitrary protocols', async () => {
    const html = await render('/help', staff);
    expect(html).toContain('mailto:support@example.com');
    expect(html).toContain('https://support.example.com');
  });

  it('exports encoded route helpers', () => {
    expect(paths.job('job/1')).toBe('/jobs/job%2F1');
    expect(paths.newTask).toBe('/jobs/new-task');
    expect(paths.newMeeting).toBe('/jobs/new-meeting');
    expect(paths.staffProfile('staff 1')).toBe('/staff/staff%201');
    expect(paths.staffReport('staff 1')).toBe('/staff/staff%201/reports');
    expect(paths.reports).toBe('/reports');
    expect(paths.deliveryReports).toBe('/reports/deliveries');
    expect(paths.approvalReports).toBe('/reports/approvals');
    expect(paths.customer('customer/1')).toBe('/customers/customer%2F1');
    expect(paths.contact('customer/1', 'contact 1')).toBe('/customers/customer%2F1/contacts/contact%201');
    expect(paths.products).toBe('/products');
    expect(paths.newProduct).toBe('/products/new');
    expect(paths.product('product/1')).toBe('/products/product%2F1');
    expect(paths.newUser).toBe('/users/new');
    expect(paths.user('user/1')).toBe('/users/user%2F1');
    expect(paths.overview).toBe('/overview');
    expect(paths.docs).toBe('/docs');
    expect(paths.help).toBe('/help');
    expect(paths.settingsNotifications).toBe('/settings/notifications');
  });

  it('shows Product navigation to every role', async () => {
    expect(await render('/jobs', staff)).toContain('href="/products"');
    expect(await render('/jobs', manager)).toContain('href="/products"');
    expect(await render('/jobs', admin)).toContain('href="/products"');
  });

  it('marks the active shell destination without weakening direct-route authorization', async () => {
    const html = await render('/products', staff);
    expect(html).toMatch(/aria-current="page"[^>]*href="\/products"/);
    expect(await render('/users', staff)).toContain('Bu alana erişim yetkiniz yok');
  });
});
