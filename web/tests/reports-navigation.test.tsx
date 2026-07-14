/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';
import { DeliveryReport } from '../src/reports/DeliveryReport';
import { getDeliveryReport } from '../src/reports/reports-api';
import { listStaff } from '../src/services/people-api';
import type { CurrentUser } from '../src/services/api';

vi.mock('../src/reports/reports-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/reports/reports-api')>(),
  getDeliveryReport: vi.fn(),
}));
vi.mock('../src/services/people-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/people-api')>(),
  listStaff: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockReturnValue({
  matches: true, media: '(min-width: 64rem)', addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) });

const manager: CurrentUser = { id: 'manager-1', organizationId: 'org-1',
  name: 'Murat', email: 'manager@example.com', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1 };
const staff: CurrentUser = { ...manager, id: 'staff-1', role: 'STAFF' };
const admin: CurrentUser = { ...manager, id: 'admin-1', role: 'ADMIN' };
const STAFF_ID = '11111111-1111-4111-8111-111111111111';

function render(path: string, user: CurrentUser) {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>
    <App initialUser={user} />
  </MemoryRouter>);
}

describe('Management report navigation', () => {
  it.each([
    ['/reports', 'Rapor özeti yükleniyor'],
    ['/reports/deliveries', 'Teslim raporu yükleniyor'],
    ['/reports/approvals', 'Onay raporu yükleniyor'],
  ])('registers stable management route %s', (path, expected) => {
    expect(render(path, manager)).toContain(expected);
  });

  it('shows report navigation only to management roles', () => {
    const management = render('/jobs', manager);
    expect(management).toContain('href="/reports"');
    expect(management).toContain('Raporlar');
    expect(render('/jobs', staff)).not.toContain('href="/reports"');
  });

  it.each(['/reports', '/reports/deliveries', '/reports/approvals'])
    ('denies Staff direct report route %s', (path) => {
      expect(render(path, staff)).toContain('Bu alana erişim yetkiniz yok');
    });

  it('replaces invalid delivery URL state and writes the echoed default range', async () => {
    vi.mocked(listStaff).mockResolvedValue([]);
    vi.mocked(getDeliveryReport).mockResolvedValue({
      groupBy: 'day', items: [], total: 0, limit: 50, offset: 0,
      range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
    });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    function Location() { return <output data-location>{useLocation().search}</output>; }
    await act(async () => root.render(<MemoryRouter initialEntries={[
      '/reports/deliveries?from=bad&groupBy=bad&offset=-1',
    ]}><DeliveryReport user={manager} /><Location /></MemoryRouter>));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-location]')?.textContent).toBe(
      '?from=2026-07-01&to=2026-07-31&groupBy=day&offset=0',
    );
    expect(getDeliveryReport).toHaveBeenCalledWith(expect.objectContaining({
      groupBy: 'day', staffUserId: null, offset: 0,
    }));
    await act(async () => root.unmount()); container.remove();
  });

  it('keeps the report usable when Staff options fail and clears an unavailable filter', async () => {
    vi.mocked(listStaff).mockRejectedValue(new Error('options failed'));
    vi.mocked(getDeliveryReport).mockResolvedValue({
      groupBy: 'day', items: [], total: 0, limit: 50, offset: 50,
      range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
    });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    function Location() { return <output data-location>{useLocation().search}</output>; }
    await act(async () => root.render(<MemoryRouter initialEntries={[
      `/reports/deliveries?from=2026-07-01&to=2026-07-31&groupBy=day&staffUserId=${STAFF_ID}&offset=50`,
    ]}><DeliveryReport user={manager} /><Location /></MemoryRouter>));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(getDeliveryReport).toHaveBeenCalled();
    expect(listStaff).toHaveBeenCalledWith('active');
    expect(container.textContent).toContain('Seçilen dönemde onaylı teslim bulunmuyor.');
    expect(container.textContent).toContain('Personel seçenekleri yüklenemedi.');
    const select = container.querySelector<HTMLSelectElement>('select[name="staffUserId"]')!;
    expect(select.disabled).toBe(false);
    expect(select.textContent).toContain('Seçili personel (listede yok)');
    select.value = '';
    await act(async () => select.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(container.querySelector('[data-location]')?.textContent).toBe(
      '?from=2026-07-01&to=2026-07-31&groupBy=day&offset=0',
    );
    await act(async () => root.unmount()); container.remove();
  });

  it('loads active and inactive Staff options for Admin with an explicit status label', async () => {
    vi.mocked(listStaff).mockResolvedValue([{ id: 'profile-1', user: {
      id: STAFF_ID, organizationId: 'org-1', name: 'Pasif Ayşe', email: 'ayse@example.com',
      role: 'STAFF', mustChangePassword: false, isActive: false, version: 1,
      lastLoginAt: null, createdAt: '2026-07-01', updatedAt: '2026-07-01',
    }, title: null, phone: null, region: null, managerUserId: null, managerName: null,
    version: 1, counters: { open: 0, waitingApproval: 0, revisionRequested: 0,
      completedThisMonth: 0, overdue: 0 } }]);
    vi.mocked(getDeliveryReport).mockResolvedValue({ groupBy: 'day', items: [], total: 0,
      limit: 50, offset: 0, range: { from: '2026-07-01', to: '2026-07-31',
        timezone: 'Europe/Istanbul' } });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={[
      '/reports/deliveries?from=2026-07-01&to=2026-07-31&groupBy=day&offset=0',
    ]}><DeliveryReport user={admin} /></MemoryRouter>));
    await act(async () => { await Promise.resolve(); });
    expect(listStaff).toHaveBeenCalledWith('all');
    expect(container.querySelector('select[name="staffUserId"]')?.textContent)
      .toContain('Pasif Ayşe (Pasif)');
    await act(async () => root.unmount()); container.remove();
  });
});
