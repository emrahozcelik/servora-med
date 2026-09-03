/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeliveryCreateView } from '../src/DeliveryCreate';
import type { CurrentUser } from '../src/services/api';
import type { StaffProfile } from '../src/services/people-api';
import type { Product } from '../src/services/products-api';
import { stubMatchMedia } from './customer-search-select-harness';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const api = vi.hoisted(() => ({
  createProductDelivery: vi.fn(),
}));
const crm = vi.hoisted(() => ({ listCustomers: vi.fn(), getCustomer: vi.fn() }));
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));
const products = vi.hoisted(() => ({ listProducts: vi.fn() }));
const preview = vi.hoisted(() => ({ useCustomerSchedulePreview: vi.fn() }));
const slots = vi.hoisted(() => ({ findAvailableSlots: vi.fn() }));

vi.mock('../src/services/api', async (original) => ({
  ...await original<typeof import('../src/services/api')>(), ...api,
}));
vi.mock('../src/services/crm-api', async (original) => ({
  ...await original<typeof import('../src/services/crm-api')>(), ...crm,
}));
vi.mock('../src/services/people-api', async (original) => ({
  ...await original<typeof import('../src/services/people-api')>(), ...people,
}));
vi.mock('../src/services/products-api', async (original) => ({
  ...await original<typeof import('../src/services/products-api')>(), ...products,
}));
vi.mock('../src/jobs/useCustomerSchedulePreview', () => preview);
vi.mock('../src/jobs/jobs-api', async (original) => ({
  ...await original<typeof import('../src/jobs/jobs-api')>(), ...slots,
}));

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com',
  role: 'MANAGER', mustChangePassword: false,
};
const customer = {
  id: 'customer-new', organizationId: 'org-1', name: 'Yeni Klinik', customerType: 'clinic',
  taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
  assignedStaffUserId: 'staff-1', assignedStaffName: null, status: 'prospect',
  version: 1, primaryContact: null,
};
const product: Product = {
  id: 'product-1', organizationId: 'org-1', name: 'İmplant', sku: 'I1', brand: null,
  category: null, model: null, unit: 'adet', referencePrice: null, isActive: true,
  version: 1, createdAt: '', updatedAt: '',
};
const profile: StaffProfile = {
  id: 'profile-1',
  user: {
    id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'ayse@example.com',
    role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
    lastLoginAt: null, createdAt: '', updatedAt: '',
  },
  title: null, phone: null, region: null, managerUserId: null, managerName: null,
  version: 1,
  counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
};

function changeInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function selectProduct(host: HTMLElement) {
  const search = host.querySelector('#delivery-product-search') as HTMLInputElement;
  await act(async () => changeInput(search, 'implant'));
  await act(async () => (Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent === 'Ürün ara') as HTMLButtonElement).click());
  await settle();
  await act(async () => (host.querySelector('[data-product-id="product-1"]') as HTMLButtonElement).click());
}

async function settle() {
  await act(async () => { await Promise.resolve(); });
}

describe('D5 Product Delivery create parity', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia();
    crm.listCustomers.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    crm.getCustomer.mockResolvedValue(customer);
    api.createProductDelivery.mockResolvedValue({ jobCardId: 'job-1', version: 2 });
    people.listStaff.mockResolvedValue([profile]);
    products.listProducts.mockResolvedValue({ items: [product], total: 1, limit: 8, offset: 0 });
    preview.useCustomerSchedulePreview.mockReturnValue({ evaluation: null, previewing: false });
    slots.findAvailableSlots.mockResolvedValue({ slots: [] });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.querySelectorAll('.ant-select-dropdown').forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  it('returns from shared Customer create with a usable selection and no Contact write path', async () => {
    await act(async () => root.render(
      <MemoryRouter>
        <DeliveryCreateView
          user={manager}
          initialCustomerId="customer-new"
          onCancel={() => {}}
          onCreated={() => {}}
        />
      </MemoryRouter>,
    ));
    await settle();

    expect(host.querySelector('button')?.textContent)
      .toBe('Yeni müşteri ekle');
    const customerSelect = host.querySelector('#delivery-customer')?.closest('.ant-select');
    expect(customerSelect?.querySelector('.ant-select-content')?.textContent ?? '').toContain('Yeni Klinik');
    expect(crm.getCustomer).toHaveBeenCalledWith('customer-new');
    // The bounded first page is still the only catalog request.
    expect(crm.listCustomers.mock.calls.every((call) => ((call[0] as { limit?: number }).limit ?? 0) <= 20))
      .toBe(true);
    expect((host.querySelector('#delivery-assignee') as HTMLSelectElement).value)
      .toBe('staff-1');
    expect(host.querySelector('#delivery-contact')).toBeNull();
    expect(host.textContent).not.toContain('İlgili kişiler yükleniyor');

    await selectProduct(host);
    await act(async () => {
      (host.querySelector('.delivery-form') as HTMLFormElement).requestSubmit();
    });
    await settle();

    expect(api.createProductDelivery).toHaveBeenCalledWith(expect.objectContaining({
      type: 'PRODUCT_DELIVERY', customerId: 'customer-new', assignedTo: 'staff-1',
      items: [{ productId: 'product-1', quantity: 1 }],
    }));
    expect(api.createProductDelivery.mock.calls[0]?.[0]).not.toHaveProperty('contactId');
    expect(api.createProductDelivery.mock.calls[0]?.[0]).not.toHaveProperty('scheduledEndsAt');
  });
});
