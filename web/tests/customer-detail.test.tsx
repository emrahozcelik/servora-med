import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import {
  CustomerDetailView, customerFieldsFromFormData, confirmCustomerLifecycle,
  customerMutationErrorMessage, mergeCustomerDetailUpdate,
} from '../src/CustomerDetail';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { CustomerDetail } from '../src/services/crm-api';

const manager: CurrentUser = { id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com', role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1 };
const staff: CurrentUser = { ...manager, id: 'staff-1', role: 'STAFF' };
const jobs = Array.from({ length: 6 }, (_, index) => ({ id: `job-${index + 1}`, title: `İş ${index + 1}`,
  status: 'IN_PROGRESS' as const, assignedTo: 'staff-1', dueDate: null, createdAt: '2026-07-13T08:00:00Z',
  updatedAt: '2026-07-13T08:00:00Z', managerApprovedAt: null }));
const customer: CustomerDetail = {
  id: 'customer-1', organizationId: 'org-1', name: 'Demo Dental Klinik', customerType: 'clinic', taxNumber: 'AB123',
  phone: '02120000000', email: 'klinik@example.com', city: 'İstanbul', district: 'Şişli', address: 'Örnek Sokak',
  assignedStaffUserId: 'staff-1', assignedStaffName: 'Ayşe Personel', status: 'active', version: 3,
  primaryContact: { id: 'contact-1', name: 'Dr. Ayşe', title: 'Doktor' },
  contacts: [{ id: 'contact-1', organizationId: 'org-1', customerId: 'customer-1', name: 'Dr. Ayşe', title: 'Doktor', phone: null, email: null, isPrimary: true, isActive: true, version: 2 }],
  openJobs: jobs, completedJobs: jobs.map((job) => ({ ...job, id: `completed-${job.id}`, title: `Tamamlanan ${job.title}`, status: 'COMPLETED' as const })),
};

function render(user: CurrentUser) {
  return renderToStaticMarkup(<MemoryRouter><CustomerDetailView customer={customer} user={user} staff={[]}
    pending={false} error="" notice="" onBack={() => {}} onSave={() => {}} onLifecycle={() => {}}
    onCreateContact={() => {}} /></MemoryRouter>);
}

describe('Customer detail', () => {
  it('shows general information, responsible Staff, status, Contacts, and bounded Job summaries', () => {
    const html = render(manager);
    for (const text of ['Demo Dental Klinik', 'Genel bilgiler', 'Ayşe Personel', 'Aktif', 'İlgili kişiler', 'Birincil kişi', 'Açık işler', 'Tamamlanan işler']) expect(html).toContain(text);
    expect(html).toContain('İş 5'); expect(html).not.toContain('İş 6');
    expect(html).toContain('Tamamlanan İş 5'); expect(html).not.toContain('Tamamlanan İş 6');
    expect(html).not.toContain('Tümünü gör');
    expect(html).not.toContain('customer-notes');
    expect(html).not.toContain('Audit');
  });

  it('keeps Staff read-only while management receives separate field and lifecycle controls', () => {
    const staffHtml = render(staff); expect(staffHtml).not.toContain('Bilgileri kaydet'); expect(staffHtml).not.toContain('Müşteriyi pasifleştir');
    const managerHtml = render(manager); expect(managerHtml).toContain('Bilgileri kaydet'); expect(managerHtml).toContain('Müşteriyi pasifleştir');
    expect(managerHtml).not.toMatch(/name="status"/); expect(managerHtml).not.toMatch(/name="version"/);
  });

  it('builds a general PATCH payload without lifecycle fields', () => {
    const data = new FormData(); data.set('name', ' Güncel Klinik '); data.set('customerType', 'clinic');
    data.set('taxNumber', 'AB 123'); data.set('assignedStaffUserId', 'staff-2'); data.set('status', 'inactive');
    expect(customerFieldsFromFormData(data, 4)).toEqual({ expectedVersion: 4, name: 'Güncel Klinik', customerType: 'clinic',
      taxNumber: 'AB 123', phone: null, email: null, city: null, district: null, address: null, assignedStaffUserId: 'staff-2' });
  });

  it('uses record-specific lifecycle confirmation and actionable conflict copy', () => {
    const confirm = vi.fn().mockReturnValue(true);
    expect(confirmCustomerLifecycle(customer, 'deactivate', confirm)).toBe(true);
    expect(confirm.mock.calls[0]![0]).toContain('Demo Dental Klinik');
    expect(confirm.mock.calls[0]![0]).toContain('yeni iş ve ilgili kişi işlemleri');
    expect(customerMutationErrorMessage(new ApiError(409, 'CUSTOMER_HAS_ACTIVE_JOB_CARDS', 'Açık işler var.'))).toContain('açık işleri');
    expect(customerMutationErrorMessage(new ApiError(409, 'VERSION_CONFLICT', 'Güncel değil.', false, { currentVersion: 5 }))).toContain('güncellendi');
  });

  it('updates the assignee display from trusted Staff data after PATCH', () => {
    const next = mergeCustomerDetailUpdate(customer, { ...customer, assignedStaffUserId: 'staff-2', version: 4 }, [
      { id: 'profile-2', user: { ...staff, id: 'staff-2', name: 'Bora Personel', lastLoginAt: null, createdAt: '', updatedAt: '' }, title: null, phone: null, region: null, managerUserId: null, managerName: null, version: 1,
        counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 } },
    ]);
    expect(next.assignedStaffName).toBe('Bora Personel'); expect(next.version).toBe(4);
  });

  it('keeps stale form values blocked behind an explicit current-values action', () => {
    const html = renderToStaticMarkup(<MemoryRouter><CustomerDetailView customer={customer} user={manager} staff={[]}
      pending={false} error="Kayıt güncellendi." notice="" conflict onBack={() => {}} onSave={() => {}}
      onLifecycle={() => {}} onCreateContact={() => {}} onReloadCurrent={() => {}} /></MemoryRouter>);
    expect(html).toContain('value="Demo Dental Klinik"');
    expect(html).toContain('Güncel değerleri yükle');
  });
});
