/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DeliveryCreateView, createProductDelivery } from '../src/DeliveryCreate';
import { localDateTimeToIso } from '../src/jobs/scheduling';
import type { CurrentUser } from '../src/services/api';

const user: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@example.com',
  role: 'STAFF', mustChangePassword: false,
};

describe('Product Delivery creation', () => {
  it('uses one atomic request for multiple selected delivery items', async () => {
    const createDelivery = vi.fn().mockResolvedValue({ jobCardId: 'job-1', version: 4 });
    const values = {
      customerId: 'c1', customerName: 'ABC Klinik', assignedTo: 'staff-1',
      deliveryPurpose: 'SALE' as const, scheduledAt: '2026-07-11T10:30',
      items: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1 },
        { productId: 'p3', quantity: 5 },
      ],
      deliveryNote: 'Ortak not',
    };

    await expect(createProductDelivery(user, values, {
      createDelivery,
      createActionId: () => 'action-id',
    })).resolves.toEqual({ jobCardId: 'job-1', version: 4 });
    expect(createDelivery).toHaveBeenCalledTimes(1);
    expect(createDelivery).toHaveBeenCalledWith({
      clientActionId: 'action-id', type: 'PRODUCT_DELIVERY', title: 'ABC Klinik ürün teslimi',
      customerId: 'c1', assignedTo: 'staff-1', priority: 'normal',
      scheduledAt: localDateTimeToIso('2026-07-11T10:30'),
      deliveryPurpose: 'SALE', deliveryNote: 'Ortak not', items: values.items,
    });
  });

  it('renders search-first product selection, per-product quantities, and canonical purposes', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><DeliveryCreateView user={user} onCancel={() => {}} onCreated={() => {}} /></MemoryRouter>,
    );
    for (const label of ['Müşteri', 'Ürünler', 'Teslim amacı', 'Planlanan teslim zamanı']) {
      expect(html).toContain(`>${label}</label>`);
    }
    for (const purpose of ['Satış', 'Numune', 'Konsinye', 'İade', 'Diğer']) {
      expect(html).toContain(`>${purpose}</option>`);
    }
    expect(html).toContain('>Yeni müşteri ekle</button>');
    expect(html).not.toContain('id="delivery-contact"');
    expect(html).not.toContain('id="delivery-quantity"');
    expect(html).not.toContain('id="delivery-scheduled-ends-at"');
    expect(html).toContain('Arama yaparak ürün seçin.');
  });

  it('preserves fractional quantities and does not send a legacy end field', async () => {
    const createDelivery = vi.fn().mockResolvedValue({ jobCardId: 'job-1', version: 2 });
    await expect(createProductDelivery(user, {
      customerId: 'c1', customerName: 'ABC Klinik', assignedTo: 'staff-1',
      deliveryPurpose: 'SAMPLE', items: [{ productId: 'p1', quantity: 0.125 }],
      scheduledAt: '2026-07-11T10:30',
    }, { createDelivery, createActionId: () => 'action-id' })).resolves.toEqual({ jobCardId: 'job-1', version: 2 });
    expect(createDelivery).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ productId: 'p1', quantity: 0.125 }],
    }));
    expect(createDelivery.mock.calls[0]?.[0]).not.toHaveProperty('scheduledEndsAt');
  });

  it('uses the manager-selected assignee while Staff remains assigned to self', async () => {
    const manager = { ...user, id: 'manager-1', role: 'MANAGER' as const };
    const createDelivery = vi.fn().mockResolvedValue({ jobCardId: 'job-1', version: 2 });
    await createProductDelivery(manager, {
      customerId: 'c1', customerName: 'ABC Klinik', assignedTo: 'staff-2',
      deliveryPurpose: 'SALE', items: [{ productId: 'p1', quantity: 1 }],
      scheduledAt: '2026-07-11T10:30',
    }, { createDelivery, createActionId: () => 'action-id' });
    expect(createDelivery).toHaveBeenCalledWith(expect.objectContaining({ assignedTo: 'staff-2' }));
  });
});
