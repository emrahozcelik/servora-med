import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DeliveryCreateView, createProductDelivery, deliveryDefaultsForCustomer } from '../src/DeliveryCreate';
import { localDateTimeToIso } from '../src/jobs/scheduling';
import type { CurrentUser, ReferenceCustomer } from '../src/services/api';
import type { CustomerDetail } from '../src/services/crm-api';

const user: CurrentUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@example.com', role: 'STAFF', mustChangePassword: false };
const customers: ReferenceCustomer[] = [{ id: 'c1', name: 'ABC Klinik', customerType: 'clinic', status: 'active' }];
describe('Product Delivery creation', () => {
  it('renders explicit accessible fields and 5 canonical purposes', () => {
    const html = renderToStaticMarkup(<DeliveryCreateView user={user} customers={customers} onCancel={() => {}} onCreated={() => {}} />);
    for (const label of ['Müşteri', 'İlgili kişi', 'Ürün', 'Teslim amacı', 'Miktar', 'Planlanan teslim zamanı']) expect(html).toContain(`>${label}</label>`);
    for (const purpose of ['Satış', 'Numune', 'Konsinye', 'İade', 'Diğer']) expect(html).toContain(`>${purpose}</option>`);
    expect(html).toContain('min="0.001"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('id="delivery-scheduled-at"');
  });

  it('creates the JobCard with scheduledAt before adding a planned item with null deliveredAt', async () => {
    const createJob = vi.fn().mockResolvedValue({ id: 'job-1', version: 1 });
    const addItem = vi.fn().mockResolvedValue({ item: { id: 'item-1' }, jobCardVersion: 2 });
    await expect(createProductDelivery(user, {
      customerId: 'c1', customerName: 'ABC Klinik', productId: 'p1', deliveryPurpose: 'SAMPLE',
      contactId: 'contact-1', assignedTo: 'other-staff', quantity: 2, scheduledAt: '2026-07-11T10:30', deliveryNote: 'Doktora bırakıldı',
    }, { createJob, addItem, createActionId: () => 'action-id' })).resolves.toEqual({ jobCardId: 'job-1', version: 2 });
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({
      assignedTo: 'staff-1', contactId: 'contact-1', title: 'ABC Klinik ürün teslimi', clientActionId: 'action-id',
      scheduledAt: localDateTimeToIso('2026-07-11T10:30'),
    }));
    expect(addItem).toHaveBeenCalledWith('job-1', expect.objectContaining({
      expectedVersion: 1, productId: 'p1', deliveryPurpose: 'SAMPLE', quantity: 2, deliveredAt: null,
    }));
    expect(createJob.mock.invocationCallOrder[0]).toBeLessThan(addItem.mock.invocationCallOrder[0]!);
  });

  it('suggests only active primary Contact and active responsible Staff for management', () => {
    const detail = { ...customers[0], organizationId: 'org-1', taxNumber: null, phone: null, email: null, city: null, district: null,
      address: null, assignedStaffUserId: 'staff-2', assignedStaffName: 'Bora', version: 1, primaryContact: null, openJobs: [], completedJobs: [],
      contacts: [
        { id: 'inactive-primary', organizationId: 'org-1', customerId: 'c1', name: 'Eski Doktor', title: null, phone: null, email: null, isPrimary: true, isActive: false, version: 1 },
        { id: 'active-contact', organizationId: 'org-1', customerId: 'c1', name: 'Yeni Doktor', title: null, phone: null, email: null, isPrimary: true, isActive: true, version: 1 },
      ] } as CustomerDetail;
    expect(deliveryDefaultsForCustomer(detail, new Set(['staff-2']))).toEqual({
      contacts: [expect.objectContaining({ id: 'active-contact' })], contactId: 'active-contact', assignedTo: 'staff-2',
    });
    expect(deliveryDefaultsForCustomer(detail, new Set())).toEqual({
      contacts: [expect.objectContaining({ id: 'active-contact' })], contactId: 'active-contact', assignedTo: '',
    });
  });

  it('allows management to replace the suggested assignee while Staff remains assigned to self', async () => {
    const manager = { ...user, id: 'manager-1', role: 'MANAGER' as const };
    const createJob = vi.fn().mockResolvedValue({ id: 'job-1', version: 1 });
    const addItem = vi.fn().mockResolvedValue({ item: {}, jobCardVersion: 2 });
    await createProductDelivery(manager, { customerId: 'c1', customerName: 'ABC Klinik', contactId: null, assignedTo: 'staff-2',
      productId: 'p1', deliveryPurpose: 'SALE', quantity: 1, scheduledAt: '2026-07-11T10:30' }, { createJob, addItem, createActionId: () => 'action-id' });
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ assignedTo: 'staff-2', contactId: null }));
  });
});
