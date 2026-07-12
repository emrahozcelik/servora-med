import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DeliveryCreateView, createProductDelivery } from '../src/DeliveryCreate';
import type { CurrentUser, ReferenceCustomer, ReferenceProduct } from '../src/services/api';

const user: CurrentUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@example.com', role: 'STAFF', mustChangePassword: false };
const customers: ReferenceCustomer[] = [{ id: 'c1', name: 'ABC Klinik', customerType: 'clinic', status: 'active' }];
const products: ReferenceProduct[] = [{ id: 'p1', name: 'İmplant Seti', sku: 'S1', model: null, unit: 'adet' }];

describe('Product Delivery creation', () => {
  it('renders explicit accessible fields and 5 canonical purposes', () => {
    const html = renderToStaticMarkup(<DeliveryCreateView user={user} customers={customers} products={products} onCancel={() => {}} onCreated={() => {}} />);
    for (const label of ['Müşteri', 'Ürün', 'Teslim amacı', 'Miktar', 'Teslim zamanı']) expect(html).toContain(`>${label}</label>`);
    for (const purpose of ['Satış', 'Numune', 'Konsinye', 'İade', 'Diğer']) expect(html).toContain(`>${purpose}</option>`);
    expect(html).toContain('min="0.001"');
    expect(html).toContain('type="datetime-local"');
  });

  it('creates the JobCard before adding the item with the returned version', async () => {
    const createJob = vi.fn().mockResolvedValue({ id: 'job-1', version: 1 });
    const addItem = vi.fn().mockResolvedValue({ item: { id: 'item-1' }, jobCardVersion: 2 });
    await expect(createProductDelivery(user, {
      customerId: 'c1', customerName: 'ABC Klinik', productId: 'p1', deliveryPurpose: 'SAMPLE',
      quantity: 2, deliveredAt: '2026-07-11T10:30', deliveryNote: 'Doktora bırakıldı',
    }, { createJob, addItem, createActionId: () => 'action-id' })).resolves.toEqual({ jobCardId: 'job-1', version: 2 });
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ assignedTo: 'staff-1', title: 'ABC Klinik ürün teslimi', clientActionId: 'action-id' }));
    expect(addItem).toHaveBeenCalledWith('job-1', expect.objectContaining({ expectedVersion: 1, productId: 'p1', deliveryPurpose: 'SAMPLE', quantity: 2 }));
    expect(createJob.mock.invocationCallOrder[0]).toBeLessThan(addItem.mock.invocationCallOrder[0]!);
  });
});
