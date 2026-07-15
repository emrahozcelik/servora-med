import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { App } from '../src/App';
import { paths } from '../src/AppRouter';
import type { CurrentUser } from '../src/services/api';

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel',
  email: 'staff@example.com', role: 'STAFF', mustChangePassword: false,
};
const manager: CurrentUser = { ...staff, id: 'manager-1', name: 'Murat Yönetici', role: 'MANAGER' };
const admin: CurrentUser = { ...manager, id: 'admin-1', name: 'Deniz Admin', role: 'ADMIN' };

function render(path: string, user: CurrentUser = manager) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App initialUser={user} />
    </MemoryRouter>,
  );
}

describe('application routes', () => {
  it.each([
    ['/jobs', 'İşler', manager],
    ['/jobs/new-delivery', 'Ürün teslimi', staff],
    ['/jobs/new-delivery', 'Ürün teslimi', manager],
    ['/jobs/new-task', 'Genel görev', staff],
    ['/jobs/new-task', 'Genel görev', manager],
    ['/jobs/new-meeting', 'Satış görüşmesi planla', staff],
    ['/jobs/new-meeting', 'Satış görüşmesi planla', manager],
    ['/jobs/job-1', 'İş detayları yükleniyor', staff],
    ['/users', 'Kullanıcılar', admin],
    ['/staff', 'Personel', manager],
    ['/staff/staff-1', 'Personel profili', manager],
    ['/staff/staff-1/reports', 'Operasyon raporu yükleniyor', manager],
    ['/customers?status=inactive', 'Müşteriler', manager],
    ['/customers/new', 'Yeni müşteri', manager],
    ['/customers/customer-1', 'Müşteri detayı', manager],
    ['/customers/customer-1/contacts/contact-1', 'İlgili kişi', manager],
    ['/products', 'Ürünler', staff],
    ['/products?status=inactive&q=eski&offset=25', 'Ürünler', manager],
    ['/products/new', 'Yeni ürün', manager],
    ['/products/product-1', 'Ürün detayı yükleniyor', staff],
  ] as const)('renders %s at a stable URL', (path, expected, user) => {
    expect(render(path, user)).toContain(expected);
  });

  it.each([
    ['/users', staff],
    ['/customers/new', staff],
    ['/products/new', staff],
    ['/staff/staff-1/reports', staff],
  ] as const)('renders the established forbidden state for unauthorized direct route %s', (path, user) => {
    const html = render(path, user);
    expect(html).toContain('Bu alana erişim yetkiniz yok');
    expect(html).not.toContain('Kullanıcı oluştur');
  });

  it('renders a safe not-found view for an unknown route', () => {
    const html = render('/unknown');
    expect(html).toContain('Sayfa bulunamadı');
    expect(html).toContain('İşlere dön');
  });

  it('redirects an authenticated user away from the sign-in route', () => {
    const html = render('/login');
    expect(html).not.toContain('Sayfa bulunamadı');
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
  });

  it('shows Product navigation to every role', () => {
    expect(render('/jobs', staff)).toContain('href="/products"');
    expect(render('/jobs', manager)).toContain('href="/products"');
    expect(render('/jobs', admin)).toContain('href="/products"');
  });

  it('marks the active shell destination without weakening direct-route authorization', () => {
    const html = render('/products', staff);
    expect(html).toMatch(/aria-current="page"[^>]*href="\/products"/);
    expect(render('/users', staff)).toContain('Bu alana erişim yetkiniz yok');
  });
});
