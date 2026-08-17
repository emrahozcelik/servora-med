import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DeliveryCreateView, createProductDelivery } from '../src/DeliveryCreate';
import { localDateTimeToIso } from '../src/jobs/scheduling';
import type { CurrentUser } from '../src/services/api';

const user: CurrentUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@example.com', role: 'STAFF', mustChangePassword: false };
describe('Product Delivery creation', () => {
  it('renders explicit accessible fields and 5 canonical purposes', () => {
    const html = renderToStaticMarkup(<MemoryRouter><DeliveryCreateView user={user} onCancel={() => {}} onCreated={() => {}} /></MemoryRouter>);
    for (const label of ['Müşteri', 'Ürün', 'Teslim amacı', 'Miktar', 'Planlanan teslim zamanı']) expect(html).toContain(`>${label}</label>`);
    for (const purpose of ['Satış', 'Numune', 'Konsinye', 'İade', 'Diğer']) expect(html).toContain(`>${purpose}</option>`);
    expect(html).toContain('href="/customers/new?source=delivery"');
    expect(html).not.toContain('id="delivery-contact"');
    expect(html).toContain('min="0.001"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('id="delivery-scheduled-at"');
    expect(html).not.toContain('id="delivery-scheduled-ends-at"');
  });

  it('creates the JobCard with only scheduledAt before adding a planned item with null deliveredAt', async () => {
    const createJob = vi.fn().mockResolvedValue({ id: 'job-1', version: 1 });
    const addItem = vi.fn().mockResolvedValue({ item: { id: 'item-1' }, jobCardVersion: 2 });
    await expect(createProductDelivery(user, {
      customerId: 'c1', customerName: 'ABC Klinik', productId: 'p1', deliveryPurpose: 'SAMPLE',
      assignedTo: 'other-staff', quantity: 2, scheduledAt: '2026-07-11T10:30', deliveryNote: 'Doktora bırakıldı',
    }, { createJob, addItem, createActionId: () => 'action-id' })).resolves.toEqual({ jobCardId: 'job-1', version: 2 });
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({
      assignedTo: 'staff-1', title: 'ABC Klinik ürün teslimi', clientActionId: 'action-id',
      scheduledAt: localDateTimeToIso('2026-07-11T10:30'),
    }));
    expect(createJob.mock.calls[0]?.[0]).not.toHaveProperty('contactId');
    expect(addItem).toHaveBeenCalledWith('job-1', expect.objectContaining({
      expectedVersion: 1, productId: 'p1', deliveryPurpose: 'SAMPLE', quantity: 2, deliveredAt: null,
    }));
    expect(createJob.mock.invocationCallOrder[0]).toBeLessThan(addItem.mock.invocationCallOrder[0]!);
  });

  it('accepts a delivery with start-only scheduling and omits the legacy end field', async () => {
    const createJob = vi.fn().mockResolvedValue({ id: 'job-1', version: 1 });
    const addItem = vi.fn().mockResolvedValue({ item: {}, jobCardVersion: 2 });
    await expect(createProductDelivery(user, {
      customerId: 'c1', customerName: 'ABC Klinik', productId: 'p1', deliveryPurpose: 'SALE',
      assignedTo: 'staff-1', quantity: 1, scheduledAt: '2026-07-11T10:30',
    }, { createJob, addItem, createActionId: () => 'action-id' })).resolves.toEqual({ jobCardId: 'job-1', version: 2 });
    expect(createJob).toHaveBeenCalledWith(expect.not.objectContaining({ scheduledEndsAt: expect.anything() }));
  });

  it('allows management to replace the suggested assignee while Staff remains assigned to self', async () => {
    const manager = { ...user, id: 'manager-1', role: 'MANAGER' as const };
    const createJob = vi.fn().mockResolvedValue({ id: 'job-1', version: 1 });
    const addItem = vi.fn().mockResolvedValue({ item: {}, jobCardVersion: 2 });
    await createProductDelivery(manager, { customerId: 'c1', customerName: 'ABC Klinik', assignedTo: 'staff-2',
      productId: 'p1', deliveryPurpose: 'SALE', quantity: 1, scheduledAt: '2026-07-11T10:30' }, { createJob, addItem, createActionId: () => 'action-id' });
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ assignedTo: 'staff-2' }));
    expect(createJob.mock.calls[0]?.[0]).not.toHaveProperty('contactId');
  });
});
