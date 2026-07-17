import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import {
  CustomerCreateForm,
  CustomerListView,
  createRequestGate,
  createCustomerWithRecovery,
  customerFiltersFromParams,
  customerInputFromFormData,
  customerRequestFilters,
  scheduleCustomerSearch,
  type CustomerListState,
} from '../src/CustomerList';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { CustomerSummary } from '../src/services/crm-api';
import type { StaffProfile } from '../src/services/people-api';

const manager: CurrentUser = { id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com', role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1 };
const staffUser: CurrentUser = { ...manager, id: 'staff-1', name: 'Ayşe', role: 'STAFF' };
const customer: CustomerSummary = {
  id: 'customer-1', organizationId: 'org-1', name: 'Demo Dental Klinik', customerType: 'clinic',
  taxNumber: null, phone: null, email: null, city: 'İstanbul', district: null, address: null,
  assignedStaffUserId: 'staff-1', assignedStaffName: 'Ayşe Personel', status: 'active', version: 1,
  primaryContact: { id: 'contact-1', name: 'Dr. Ayşe Yılmaz', title: 'Doktor' },
};
const profile: StaffProfile = {
  id: 'profile-1', user: { ...staffUser, lastLoginAt: null, createdAt: '2026-07-12', updatedAt: '2026-07-12' },
  title: 'Saha Personeli', phone: null, region: 'Marmara', managerUserId: 'manager-1', managerName: 'Murat', version: 1,
  counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
};

function list(state: CustomerListState, user = manager, hasFilters = false) {
  return renderToStaticMarkup(<MemoryRouter><CustomerListView state={state} user={user} hasFilters={hasFilters}
    onRetry={() => {}} onCreate={() => {}} /></MemoryRouter>);
}

describe('Customer list and creation', () => {
  it('renders distinct loading, initial-empty, filtered-empty, and retry states', () => {
    expect(list({ kind: 'loading' })).toContain('aria-busy="true"');
    expect(list({ kind: 'ready', customers: [] })).toContain('Henüz müşteri kaydı yok');
    expect(list({ kind: 'ready', customers: [] }, manager, true)).toContain('Filtrelere uygun müşteri bulunamadı');
    const error = list({ kind: 'error', message: 'Bağlantı kurulamadı.', retryable: true });
    expect(error).toContain('role="alert"');
    expect(error).toContain('Tekrar dene');
  });

  it('uses a semantic list and shows operational facts without color-only meaning', () => {
    const html = list({ kind: 'ready', customers: [customer] });
    expect(html).toContain('<ul');
    expect(html).toContain('Demo Dental Klinik');
    expect(html).toContain('Aktif');
    expect(html).toContain('Sorumlu personel');
    expect(html).toContain('Ayşe Personel');
    expect(html).toContain('Birincil kişi');
    expect(html).toContain('Dr. Ayşe Yılmaz');
    expect(html).toContain('/customers/customer-1');
    expect(html).toContain('customer-list-card');
    expect(html).toContain('customer-title-link');
    expect(html).not.toContain('Kaydı aç');
  });

  it('keeps Staff read-only while Manager can create, edit, and delete', () => {
    expect(list({ kind: 'ready', customers: [] }, staffUser)).not.toContain('Yeni müşteri');
    expect(list({ kind: 'ready', customers: [] }, manager)).toContain('Yeni müşteri');
    const staffHtml = list({ kind: 'ready', customers: [customer] }, staffUser);
    expect(staffHtml).not.toContain('müşterisini düzenle');
    expect(staffHtml).not.toContain('müşterisini sil');
    const managerHtml = list({ kind: 'ready', customers: [customer] }, manager);
    expect(managerHtml).toContain('aria-label="Demo Dental Klinik müşterisini düzenle"');
    expect(managerHtml).toContain('aria-label="Demo Dental Klinik müşterisini sil"');
    expect(managerHtml).toContain('Düzenle');
    expect(managerHtml).toContain('Sil');
  });

  it('restores all URL filters and defaults status to active', () => {
    expect(customerFiltersFromParams(new URLSearchParams())).toEqual({});
    expect(customerFiltersFromParams(new URLSearchParams(
      'q=Ay%C5%9Fe&status=inactive&customerType=clinic&city=Ankara&assignedStaffUserId=staff-1&unassigned=true',
    ))).toEqual({ q: 'Ayşe', status: 'inactive', customerType: 'clinic', city: 'Ankara', assignedStaffUserId: 'staff-1', unassigned: true });
  });

  it('maps copied/default URL state to the exact backend filter contract', () => {
    expect(customerRequestFilters(customerFiltersFromParams(new URLSearchParams()), '')).toEqual({ q: undefined, status: undefined });
    expect(customerRequestFilters(customerFiltersFromParams(new URLSearchParams('status=inactive&q=Eski')), 'Eski'))
      .toMatchObject({ status: 'inactive', q: 'Eski' });
  });

  it('debounces text search and rejects stale similar-name generations', () => {
    vi.useFakeTimers(); const callback = vi.fn(); scheduleCustomerSearch(callback);
    vi.advanceTimersByTime(249); expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(callback).toHaveBeenCalledOnce(); vi.useRealTimers();
    const gate = createRequestGate(); const older = gate.next(); const latest = gate.next();
    expect(gate.isCurrent(older)).toBe(false); expect(gate.isCurrent(latest)).toBe(true);
  });

  it('renders labeled filters and an accessible creation form with pending state', () => {
    const filters = renderToStaticMarkup(<CustomerListView state={{ kind: 'ready', customers: [] }} user={manager}
      hasFilters={false} onRetry={() => {}} onCreate={() => {}} filters={{ status: 'active' }} staff={[profile]} onFilterChange={() => {}} />);
    expect(filters).toContain('<label for="customer-search">Müşteri ara</label>');
    for (const label of ['Durum', 'Müşteri türü', 'Şehir', 'Sorumlu personel', 'Atanmamış müşteriler']) expect(filters).toContain(label);
    expect(filters).not.toContain('<option value="all">');

    const form = renderToStaticMarkup(<MemoryRouter><CustomerCreateForm staff={[profile]} pending similarCustomers={[customer]}
      fieldErrors={{ name: 'Müşteri adı zorunludur.' }} error="Sunucu alanları kabul etmedi."
      onCancel={() => {}} onSubmit={() => {}} /></MemoryRouter>);
    expect(form).toContain('<label for="customer-name">Müşteri adı</label>');
    expect(form).toContain('Müşteri adı zorunludur.');
    expect(form).toContain('aria-describedby="customer-name-error"');
    expect(form).toContain('Benzer müşteri kayıtları');
    expect(form).toContain('Demo Dental Klinik');
    expect(form).toContain('disabled=""');
    expect(form).toContain('role="alert"'); expect(form).toContain('tabindex="-1"');
  });

  it('refetches after an unknown create result without claiming a same-name Customer identity', async () => {
    const create = vi.fn().mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı koptu.', true));
    const refetch = vi.fn().mockResolvedValue({ items: [customer], total: 1, limit: 25, offset: 0 });
    await expect(createCustomerWithRecovery({ ...customer, status: undefined }, { create, refetch }))
      .resolves.toEqual({ customer: null, resultUnknown: true, matches: [customer] });
    expect(create).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith({ q: 'Demo Dental Klinik' });
  });

  it('builds the exact create payload and finishes no-match recovery before returning ambiguity', async () => {
    const data = new FormData(); data.set('name', '  Yeni Klinik  '); data.set('customerType', 'clinic');
    data.set('taxNumber', ' AB 123 '); data.set('email', ''); data.set('assignedStaffUserId', 'staff-1');
    expect(customerInputFromFormData(data)).toEqual({ name: 'Yeni Klinik', customerType: 'clinic', taxNumber: 'AB 123',
      phone: null, email: null, city: null, district: null, address: null, assignedStaffUserId: 'staff-1', status: 'prospect' });
    const create = vi.fn().mockRejectedValue(new ApiError(0, 'INVALID_RESPONSE', 'Yanıt okunamadı.'));
    const refetch = vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    await expect(createCustomerWithRecovery(customerInputFromFormData(data), { create, refetch }))
      .resolves.toEqual({ customer: null, resultUnknown: true, matches: [] });
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
