/** @vitest-environment jsdom */
/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DeliveryCreateView, buildProductDeliveryRequest, createProductDelivery } from '../src/DeliveryCreate';
import { localDateTimeToIso } from '../src/jobs/scheduling';
import type { CurrentUser } from '../src/services/api';

const user: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@example.com',
  role: 'STAFF', mustChangePassword: false,
};

describe('Product Delivery creation', () => {
  it('uses the compact wheel trigger and commits the planned delivery time', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(
        <MemoryRouter><DeliveryCreateView user={user} onCancel={() => {}} onCreated={() => {}} /></MemoryRouter>,
      ));
      const trigger = container.querySelector<HTMLButtonElement>('#delivery-scheduled-at')!;
      expect(trigger.tagName).toBe('BUTTON');
      expect(trigger.hasAttribute('name')).toBe(false);
      const before = trigger.textContent;
      await act(async () => trigger.click());
      const hour = document.querySelector<HTMLElement>('[role="spinbutton"][aria-label="Saat"]')!;
      await act(async () => {
        hour.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      });
      const ok = [...document.querySelectorAll<HTMLButtonElement>('.wheel-sheet-actions button')]
        .find((button) => button.textContent === 'Tamam')!;
      await act(async () => ok.click());
      expect(trigger.textContent).not.toBe(before);
      expect(document.body.style.overflow).toBe('');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
    }
  });

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

  it('JOB-010 2b: sends the past-start acknowledgement only when the user filled it', () => {
    const values = {
      customerId: 'c1', customerName: 'ABC Klinik', assignedTo: 'staff-1',
      deliveryPurpose: 'SALE' as const, scheduledAt: '2026-07-11T10:30',
      items: [{ productId: 'p1', quantity: 2 }],
    };
    expect(buildProductDeliveryRequest(user, values, () => 'action-id'))
      .not.toHaveProperty('pastStartAcknowledgement');
    expect(buildProductDeliveryRequest(user, {
      ...values,
      pastStartAcknowledgement: { code: 'CUSTOMER_CONFIRMED_LATER_TIME', text: '  Klinik 15:00 dedi.  ' },
    }, () => 'action-id')).toMatchObject({
      pastStartAcknowledgement: {
        code: 'CUSTOMER_CONFIRMED_LATER_TIME',
        text: 'Klinik 15:00 dedi.',
      },
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
