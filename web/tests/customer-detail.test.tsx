import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import {
  CustomerDetailView, customerFieldsFromFormData,
  customerMutationErrorMessage, mergeCustomerDetailUpdate,
} from '../src/CustomerDetail';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { CustomerDetail, JobHistoryItem } from '../src/services/crm-api';

const manager: CurrentUser = { id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com', role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1 };
const admin: CurrentUser = { ...manager, id: 'admin-1', role: 'ADMIN' };
const staff: CurrentUser = { ...manager, id: 'staff-1', role: 'STAFF' };
const jobs: JobHistoryItem[] = Array.from({ length: 6 }, (_, index) => ({
  id: `job-${index + 1}`, title: `İş ${index + 1}`, type: 'GENERAL_TASK', status: 'IN_PROGRESS', priority: 'normal',
  scheduledAt: null, dueDate: null, createdAt: '2026-07-13T08:00:00Z', updatedAt: '2026-07-13T08:00:00Z',
  completedAt: null, assignee: { id: 'staff-1', name: 'Ayşe Personel' },
  customer: { id: 'customer-1', name: 'Demo Dental Klinik' }, contact: null, followUp: null, childCount: null,
}));
const completedJobs: JobHistoryItem[] = jobs.map((job) => ({ ...job, id: `completed-${job.id}`, title: `Tamamlanan ${job.title}`, status: 'COMPLETED', completedAt: '2026-07-14T08:00:00Z' }));
const customer: CustomerDetail = {
  id: 'customer-1', organizationId: 'org-1', name: 'Demo Dental Klinik', customerType: 'clinic', taxNumber: 'AB123',
  phone: '02120000000', email: 'klinik@example.com', city: 'İstanbul', district: 'Şişli', address: 'Örnek Sokak',
  assignedStaffUserId: 'staff-1', assignedStaffName: 'Ayşe Personel', status: 'active', version: 3,
  primaryContact: { id: 'contact-1', name: 'Dr. Ayşe', title: 'Doktor' },
  contacts: [{ id: 'contact-1', organizationId: 'org-1', customerId: 'customer-1', name: 'Dr. Ayşe', title: 'Doktor', phone: null, email: null, isPrimary: true, isActive: true, version: 2 }],
  hasOperationHistory: false,
  openJobCount: jobs.length, completedJobCount: completedJobs.length,
};

function render(user: CurrentUser, record: CustomerDetail = customer) {
  return renderToStaticMarkup(<MemoryRouter><CustomerDetailView customer={record} user={user} staff={[]}
    pending={false} error="" notice="" onBack={() => {}} onSave={() => {}}
    onCreateContact={() => {}} historyStatus="all" historyPage={{ items: [...jobs.slice(0, 5), ...completedJobs.slice(0, 5)], total: 12, limit: 20, offset: 0 }}
    historyLoading={false} historyError="" onHistoryStatusChange={() => {}} onHistoryPageChange={() => {}} /></MemoryRouter>);
}

describe('Customer detail', () => {
  it('shows general information, responsible Staff, status, Contacts, and bounded Job summaries', () => {
    const html = render(manager);
    for (const text of ['Demo Dental Klinik', 'Genel bilgiler', 'Ayşe Personel', 'Aktif', 'İlgili kişiler', 'Birincil kişi', 'İş geçmişi', 'Açık (6)', 'Tamamlanan (6)']) expect(html).toContain(text);
    expect(html).toContain('İş 5'); expect(html).not.toContain('İş 6');
    expect(html).toContain('Tamamlanan İş 5'); expect(html).not.toContain('Tamamlanan İş 6');
    expect(html).not.toContain('Tümünü gör');
    expect(html).not.toContain('customer-notes');
    expect(html).not.toContain('Audit');
    expect(html).not.toContain('Müşteri durumu');
    expect(html).not.toContain('Müşteriyi pasifleştir');
  });

  it('keeps Staff read-only while management can edit without lifecycle controls', () => {
    const staffHtml = render(staff); expect(staffHtml).not.toContain('Bilgileri kaydet'); expect(staffHtml).not.toContain('Müşteriyi pasifleştir');
    const managerHtml = render(manager); expect(managerHtml).toContain('Bilgileri kaydet');
    expect(managerHtml).not.toContain('Müşteriyi pasifleştir'); expect(managerHtml).not.toContain('Müşteriyi aktifleştir');
    expect(managerHtml).not.toMatch(/name="status"/); expect(managerHtml).not.toMatch(/name="version"/);
  });

  it('shows permanent Customer deletion only to an Admin for a pristine record', () => {
    expect(render(admin)).toContain('Kalıcı olarak sil');
    expect(render(manager)).not.toContain('Kalıcı olarak sil');
    expect(render(staff)).not.toContain('Kalıcı olarak sil');
  });

  it('keeps permanent deletion unavailable when history exists despite zero visible counts', () => {
    const referenced = { ...customer, hasOperationHistory: true, openJobCount: 0, completedJobCount: 0 };
    const html = render(admin, referenced);
    expect(html).not.toContain('>Kalıcı olarak sil</button>');
    expect(html).toContain('Bu müşteri operasyon geçmişinde kullanıldığı için kalıcı olarak silinemez.');
  });

  it('explains linked Contact removal in the permanent-delete confirmation', () => {
    const html = renderToStaticMarkup(<MemoryRouter><CustomerDetailView customer={customer} user={admin} staff={[]}
      pending={false} error="" notice="" deleteConfirmOpen deleteTriggerRef={{ current: null }}
      onBack={() => {}} onSave={() => {}} onCreateContact={() => {}} /></MemoryRouter>);
    expect(html).toContain('Bu işlem geri alınamaz. Bu müşteri için operasyon geçmişi bulunmuyor. Bağlı 1 ilgili kişi de kalıcı olarak silinecek.');
  });

  it('builds a general PATCH payload without lifecycle fields', () => {
    const data = new FormData(); data.set('name', ' Güncel Klinik '); data.set('customerType', 'clinic');
    data.set('taxNumber', 'AB 123'); data.set('assignedStaffUserId', 'staff-2'); data.set('status', 'inactive');
    expect(customerFieldsFromFormData(data, 4)).toEqual({ expectedVersion: 4, name: 'Güncel Klinik', customerType: 'clinic',
      taxNumber: 'AB 123', phone: null, email: null, city: null, district: null, address: null, assignedStaffUserId: 'staff-2' });
  });

  it('maps version conflicts to actionable copy', () => {
    expect(customerMutationErrorMessage(new ApiError(409, 'VERSION_CONFLICT', 'Güncel değil.', false, { currentVersion: 5 }))).toContain('güncellendi');
  });

  it('updates the assignee display from trusted Staff data after PATCH', () => {
    const next = mergeCustomerDetailUpdate(customer, { ...customer, assignedStaffUserId: 'staff-2', version: 4 }, [
      { id: 'profile-2', user: { ...staff, id: 'staff-2', name: 'Bora Personel', lastLoginAt: null, createdAt: '', updatedAt: '' }, title: null, phone: null, region: null, managerUserId: null, managerName: null, version: 1,
        counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 } },
    ]);
    expect(next.assignedStaffName).toBe('Bora Personel'); expect(next.version).toBe(4);
  });

  it('uses form-actions with Cancel-before-Save DOM order in CustomerEditForm', () => {
    const html = renderToStaticMarkup(<MemoryRouter><CustomerDetailView customer={customer} user={manager} staff={[]}
      pending={false} error="" notice="" onBack={() => {}} onSave={() => {}}
      onCreateContact={() => {}} /></MemoryRouter>);
    expect(html).toContain('class="form-actions"');
    const cancelIdx = html.indexOf('secondary-button');
    const saveIdx = html.indexOf('primary-button');
    expect(cancelIdx).toBeGreaterThan(0);
    expect(saveIdx).toBeGreaterThan(cancelIdx);
    const cancelTag = html.slice(cancelIdx - 10, cancelIdx + 60);
    expect(cancelTag).toContain('type="button"');
    const saveTag = html.slice(saveIdx - 10, saveIdx + 60);
    expect(saveTag).toContain('type="submit"');
  });

  it('keeps stale form values blocked behind an explicit current-values action', () => {
    const html = renderToStaticMarkup(<MemoryRouter><CustomerDetailView customer={customer} user={manager} staff={[]}
      pending={false} error="Kayıt güncellendi." notice="" conflict onBack={() => {}} onSave={() => {}}
      onCreateContact={() => {}} onReloadCurrent={() => {}} /></MemoryRouter>);
    expect(html).toContain('value="Demo Dental Klinik"');
    expect(html).toContain('Güncel değerleri yükle');
  });
});
