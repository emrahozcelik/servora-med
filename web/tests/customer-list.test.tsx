import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import {
  CustomerCreateForm,
  CustomerListView,
  createCustomerWithRecovery,
  customerFiltersFromParams,
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
  });

  it('keeps Staff read-only while Manager can create', () => {
    expect(list({ kind: 'ready', customers: [] }, staffUser)).not.toContain('Yeni müşteri');
    expect(list({ kind: 'ready', customers: [] }, manager)).toContain('Yeni müşteri');
  });

  it('restores all URL filters and defaults status to active', () => {
    expect(customerFiltersFromParams(new URLSearchParams())).toMatchObject({ status: 'active' });
    expect(customerFiltersFromParams(new URLSearchParams(
      'q=Ay%C5%9Fe&status=inactive&customerType=clinic&city=Ankara&assignedStaffUserId=staff-1&unassigned=true',
    ))).toEqual({ q: 'Ayşe', status: 'inactive', customerType: 'clinic', city: 'Ankara', assignedStaffUserId: 'staff-1', unassigned: true });
  });

  it('renders labeled filters and an accessible creation form with pending state', () => {
    const filters = renderToStaticMarkup(<CustomerListView state={{ kind: 'ready', customers: [] }} user={manager}
      hasFilters={false} onRetry={() => {}} onCreate={() => {}} filters={{ status: 'active' }} staff={[profile]} onFilterChange={() => {}} />);
    expect(filters).toContain('<label for="customer-search">Müşteri ara</label>');
    for (const label of ['Durum', 'Müşteri türü', 'Şehir', 'Sorumlu personel', 'Atanmamış müşteriler']) expect(filters).toContain(label);

    const form = renderToStaticMarkup(<MemoryRouter><CustomerCreateForm staff={[profile]} pending similarCustomers={[customer]}
      fieldErrors={{ name: 'Müşteri adı zorunludur.' }} onCancel={() => {}} onSubmit={() => {}} /></MemoryRouter>);
    expect(form).toContain('<label for="customer-name">Müşteri adı</label>');
    expect(form).toContain('Müşteri adı zorunludur.');
    expect(form).toContain('aria-describedby="customer-name-error"');
    expect(form).toContain('Benzer müşteri kayıtları');
    expect(form).toContain('Demo Dental Klinik');
    expect(form).toContain('disabled=""');
  });

  it('refetches after an unknown create result and returns the matching persisted Customer', async () => {
    const create = vi.fn().mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı koptu.', true));
    const refetch = vi.fn().mockResolvedValue({ items: [customer], total: 1, limit: 25, offset: 0 });
    await expect(createCustomerWithRecovery({ ...customer, status: undefined }, { create, refetch }))
      .resolves.toEqual({ customer, recovered: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith({ q: 'Demo Dental Klinik' });
  });
});
