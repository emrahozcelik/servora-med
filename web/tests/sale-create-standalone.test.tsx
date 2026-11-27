/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SaleCreateScreen } from '../src/SaleCreate';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { CustomerSummary } from '../src/services/crm-api';
import type { Product } from '../src/services/products-api';
import type { StaffProfile } from '../src/services/people-api';
import {
  pickCustomerByName, settle, settleCustomerSearch, stubMatchMedia,
} from './customer-search-select-harness';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sale = vi.hoisted(() => ({ createStandaloneSale: vi.fn(), createSaleFromVisit: vi.fn(), getSaleCreateContext: vi.fn() }));
const crm = vi.hoisted(() => ({ getCustomer: vi.fn(), listCustomers: vi.fn(), listContacts: vi.fn() }));
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));
const productsApi = vi.hoisted(() => ({ listProducts: vi.fn() }));
const scheduling = vi.hoisted(() => ({
  defaultDeliveredAtLocalValue: () => '2026-11-23T12:30',
  localDateTimeToIso: (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
    if (!match) throw new Error(value);
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), 0, 0).toISOString();
  },
}));

vi.mock('../src/jobs/sale-api', () => sale);
vi.mock('../src/services/crm-api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/services/crm-api')>(), ...crm }));
vi.mock('../src/services/people-api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/services/people-api')>(), ...people }));
vi.mock('../src/services/products-api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/services/products-api')>(), ...productsApi }));
vi.mock('../src/jobs/scheduling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/jobs/scheduling')>()),
  ...scheduling,
}));
vi.mock('../src/realtime/RealtimeProvider', () => ({ useRealtimeInvalidation: () => {} }));

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici', email: 'murat@example.com',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const staffUser: CurrentUser = { ...manager, id: 'staff-1', name: 'Ayşe Personel', role: 'STAFF' };
const customers: CustomerSummary[] = [
  { id: 'customer-a', organizationId: 'org-1', name: 'A Klinik', customerType: 'clinic', taxNumber: null,
    phone: null, email: null, city: null, district: null, address: null,
    assignedStaffUserId: 'staff-1', status: 'active', version: 1, assignedStaffName: 'Ayşe', primaryContact: null },
  { id: 'customer-b', organizationId: 'org-1', name: 'B Klinik', customerType: 'clinic', taxNumber: null,
    phone: null, email: null, city: null, district: null, address: null,
    assignedStaffUserId: 'staff-2', status: 'active', version: 1, assignedStaffName: 'Bora', primaryContact: null },
];
const product: Product = {
  id: 'product-1', organizationId: 'org-1', name: 'İmplant', sku: 'I1', brand: 'Dental',
  category: null, model: null, unit: 'adet', referencePrice: null, isActive: true,
  version: 1, createdAt: '', updatedAt: '',
};

function profile(id: string, name: string): StaffProfile {
  return {
    id: `profile-${id}`,
    user: { id, organizationId: 'org-1', name, email: `${id}@example.com`, role: 'STAFF', mustChangePassword: false,
      isActive: true, version: 1, lastLoginAt: null, createdAt: '', updatedAt: '' },
    title: null, phone: null, region: null, managerUserId: null, managerName: null, version: 1,
    counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
  };
}

let root: Root;
let container: HTMLDivElement;
const cancelled = vi.fn();
const created = vi.fn();

function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function button(label: string) {
  return [...container.querySelectorAll('button')].find((node) => node.textContent === label)!;
}

async function render(user: CurrentUser) {
  await act(async () => root.render(<SaleCreateScreen mode={{ kind: 'standalone' }} user={user}
    onCancel={cancelled} onCreated={created} />));
  await settle();
}

async function addProduct(query = 'implant', productId = 'product-1') {
  const search = container.querySelector('.product-select input[type="search"]') as HTMLInputElement;
  await act(async () => changeInput(search, query));
  await act(async () => button('Ürün ara').click());
  await settle();
  await act(async () => (container.querySelector(`[data-product-id="${productId}"]`) as HTMLButtonElement).click());
}

async function submit() {
  await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia();
  crm.listCustomers.mockResolvedValue({ items: customers, total: customers.length, limit: 20, offset: 0 });
  crm.getCustomer.mockRejectedValue(new Error('bulunamadı'));
  crm.listContacts.mockResolvedValue({
    items: [{ id: 'contact-a', organizationId: 'org-1', customerId: 'customer-a', name: 'Doktor A',
      title: 'Dr.', phone: null, email: null, isPrimary: true, isActive: true, version: 1 }],
    total: 1, limit: 20, offset: 0,
  });
  people.listStaff.mockResolvedValue([profile('staff-1', 'Ayşe Personel'), profile('staff-2', 'Bora Personel')]);
  productsApi.listProducts.mockResolvedValue({ items: [product], total: 1, limit: 6, offset: 0 });
  sale.createStandaloneSale.mockResolvedValue({ jobCardId: 'sale-1', version: 2 });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll('.ant-select-dropdown').forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

describe('standalone Sale create', () => {
  it('fixes the assignee for Staff and sends exactly the §6.1 body without a source version', async () => {
    await render(staffUser);
    expect(sale.getSaleCreateContext).not.toHaveBeenCalled();
    expect(container.querySelector('#sale-assignee')).toBeNull();
    expect(container.textContent).toContain('Ayşe Personel');
    expect((container.querySelector('.product-select input[type="search"]') as HTMLInputElement).disabled).toBe(true);

    await pickCustomerByName(container, 'sale-customer', 'A Klinik');
    await settleCustomerSearch();
    await addProduct();
    await act(async () => changeInput(container.querySelector('[aria-label="İmplant satış adedi"]') as HTMLInputElement, '2'));
    await submit();

    expect(productsApi.listProducts).toHaveBeenCalledWith({
      status: 'active', q: 'implant', limit: 6, offset: 0, dataClass: 'BUSINESS',
    });
    expect(sale.createStandaloneSale).toHaveBeenCalledTimes(1);
    expect(sale.createStandaloneSale).toHaveBeenCalledWith({
      clientActionId: expect.any(String),
      title: 'A Klinik satış kaydı',
      description: null,
      customerId: 'customer-a',
      assignedTo: 'staff-1',
      soldAt: scheduling.localDateTimeToIso('2026-11-23T12:30'),
      saleContactId: null,
      items: [{ productId: 'product-1', quantity: 2 }],
    });
    expect(sale.createStandaloneSale.mock.calls[0]![0]).not.toHaveProperty('expectedSourceVersion');
    expect(created).toHaveBeenCalledWith('sale-1');
  });

  it('requires management to choose an active Staff assignee', async () => {
    await render(manager);
    expect(people.listStaff).toHaveBeenCalledWith('active');
    await pickCustomerByName(container, 'sale-customer', 'A Klinik');
    await settleCustomerSearch();
    const assignee = container.querySelector('#sale-assignee') as HTMLSelectElement;
    expect(assignee).not.toBeNull();
    expect(assignee.value).toBe('');
    expect(button('Satış kaydını oluştur').disabled).toBe(true);
    await act(async () => { assignee.value = 'staff-2'; assignee.dispatchEvent(new Event('change', { bubbles: true })); });
    await addProduct();
    expect(button('Satış kaydını oluştur').disabled).toBe(false);
    await submit();
    expect(sale.createStandaloneSale).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-a', assignedTo: 'staff-2', items: [{ productId: 'product-1', quantity: 1 }],
    }));
  });

  it('filters the optional sale contact to the selected customer and clears it when the customer changes', async () => {
    await render(staffUser);
    await pickCustomerByName(container, 'sale-customer', 'A Klinik');
    await settleCustomerSearch();
    expect(crm.listContacts).toHaveBeenCalledWith('customer-a', expect.objectContaining({ status: 'active' }));
    const contact = container.querySelector('.sale-contact-select') as HTMLSelectElement;
    await act(async () => { contact.value = 'contact-a'; contact.dispatchEvent(new Event('change', { bubbles: true })); });

    await pickCustomerByName(container, 'sale-customer', 'B Klinik');
    await settleCustomerSearch();
    expect(crm.listContacts).toHaveBeenCalledWith('customer-b', expect.objectContaining({ status: 'active' }));
    await addProduct();
    await submit();
    expect(sale.createStandaloneSale).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-b', saleContactId: null,
    }));
  });

  it('freezes an unresolved attempt and retries the identical request', async () => {
    sale.createStandaloneSale.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı koptu.', true))
      .mockResolvedValueOnce({ jobCardId: 'sale-1', version: 2 });
    await render(staffUser);
    await pickCustomerByName(container, 'sale-customer', 'A Klinik');
    await settleCustomerSearch();
    await addProduct();
    await submit();

    const original = structuredClone(sale.createStandaloneSale.mock.calls[0]![0]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Bağlantı koptu.');
    expect(button('Vazgeç').disabled).toBe(true);
    expect((container.querySelector('[aria-label="İmplant satış adedi"]') as HTMLInputElement).matches(':disabled')).toBe(true);
    await submit();
    expect(sale.createStandaloneSale).toHaveBeenCalledTimes(1);

    await act(async () => button('Özgün isteği tekrar dene').click());
    await settle();
    expect(sale.createStandaloneSale.mock.calls[1]![0]).toEqual(original);
    expect(created).toHaveBeenCalledWith('sale-1');
  });

  it('unlocks after a definitive rejection and starts a new intent on the next submit', async () => {
    sale.createStandaloneSale.mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', 'Adet geçersiz.'));
    await render(staffUser);
    await pickCustomerByName(container, 'sale-customer', 'A Klinik');
    await settleCustomerSearch();
    await addProduct();
    await submit();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Adet geçersiz.');
    expect(button('Vazgeç').disabled).toBe(false);
    expect((container.querySelector('[aria-label="İmplant satış adedi"]') as HTMLInputElement).matches(':disabled')).toBe(false);
    await submit();
    expect(sale.createStandaloneSale).toHaveBeenCalledTimes(2);
    expect(sale.createStandaloneSale.mock.calls[1]![0].clientActionId)
      .not.toBe(sale.createStandaloneSale.mock.calls[0]![0].clientActionId);
  });
});
