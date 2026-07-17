/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeliveryCreateView } from '../src/DeliveryCreate';
import { localDateTimeToIso } from '../src/jobs/scheduling';
import type { CurrentUser, ReferenceCustomer } from '../src/services/api';
import type { Product } from '../src/services/products-api';
import type { CustomerDetail } from '../src/services/crm-api';
import type { StaffProfile } from '../src/services/people-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const api = vi.hoisted(() => ({ createJobCard: vi.fn(), addDeliveryItem: vi.fn() }));
const crm = vi.hoisted(() => ({ getCustomer: vi.fn() }));
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));
const productsApi = vi.hoisted(() => ({ listProducts: vi.fn() }));
const scheduling = vi.hoisted(() => ({
  defaultScheduledLocalValue: vi.fn(() => '2026-07-17T14:30'),
  localDateTimeToIso: (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
    if (!match) throw new Error(value);
    return new Date(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), 0, 0,
    ).toISOString();
  },
}));
vi.mock('../src/services/api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/services/api')>(), ...api }));
vi.mock('../src/services/crm-api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/services/crm-api')>(), ...crm }));
vi.mock('../src/services/people-api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/services/people-api')>(), ...people }));
vi.mock('../src/services/products-api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/services/products-api')>(), ...productsApi }));
vi.mock('../src/jobs/scheduling', () => scheduling);

const manager: CurrentUser = { id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com', role: 'MANAGER', mustChangePassword: false };
const staffUser: CurrentUser = { ...manager, id: 'staff-1', role: 'STAFF' };
const customers: ReferenceCustomer[] = [
  { id: 'customer-a', name: 'A Klinik', customerType: 'clinic', status: 'active' },
  { id: 'customer-b', name: 'B Klinik', customerType: 'clinic', status: 'active' },
  { id: 'customer-inactive', name: 'Pasif Klinik', customerType: 'clinic', status: 'inactive' },
];
const product: Product = { id: 'product-1', organizationId: 'org-1', name: 'İmplant', sku: 'I1', brand: null, category: null,
  model: null, unit: 'adet', referencePrice: null, isActive: true, version: 1, createdAt: '', updatedAt: '' };

function profile(id: string, name: string): StaffProfile {
  return { id: `profile-${id}`, user: { id, organizationId: 'org-1', name, email: `${id}@example.com`, role: 'STAFF', mustChangePassword: false,
    isActive: true, version: 1, lastLoginAt: null, createdAt: '', updatedAt: '' }, title: null, phone: null, region: null, managerUserId: null, managerName: null,
    version: 1, counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 } };
}

function detail(id: string, assignedStaffUserId: string | null, primaryName = 'Dr. Ayşe'): CustomerDetail {
  return { id, organizationId: 'org-1', name: `${id} Klinik`, customerType: 'clinic', taxNumber: null, phone: null, email: null, city: null, district: null,
    address: null, assignedStaffUserId, assignedStaffName: null, status: 'active', version: 1, primaryContact: null,
    contacts: [
      { id: `${id}-primary`, organizationId: 'org-1', customerId: id, name: primaryName, title: 'Doktor', phone: null, email: null, isPrimary: true, isActive: true, version: 1 },
      { id: `${id}-inactive`, organizationId: 'org-1', customerId: id, name: 'Pasif Kişi', title: null, phone: null, email: null, isPrimary: false, isActive: false, version: 1 },
    ], openJobs: [], completedJobs: [] };
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((next) => { resolve = next; }); return { promise, resolve }; }
async function settle() { await act(async () => { await Promise.resolve(); }); }
function change(select: HTMLSelectElement, value: string) { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }
function changeInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Delivery create CRM defaults', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    scheduling.defaultScheduledLocalValue.mockReturnValue('2026-07-17T14:30');
    people.listStaff.mockResolvedValue([profile('staff-1', 'Ayşe'), profile('staff-2', 'Bora')]);
    productsApi.listProducts.mockResolvedValue({ items: [product], total: 1, limit: 25, offset: 0 });
    api.createJobCard.mockResolvedValue({ id: 'job-1', version: 1 }); api.addDeliveryItem.mockResolvedValue({ jobCardVersion: 2 });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('loads active Contacts, suggests primary and responsible Staff, and submits management overrides', async () => {
    crm.getCustomer.mockResolvedValue(detail('customer-a', 'staff-1'));
    await act(async () => root.render(<DeliveryCreateView user={manager} customers={customers} onCancel={() => {}} onCreated={() => {}} />)); await settle();
    expect(productsApi.listProducts).toHaveBeenCalledWith({ status: 'active', q: '', limit: 25, offset: 0 });
    const customer = container.querySelector('#delivery-customer') as HTMLSelectElement;
    expect(Array.from(customer.options).map((option) => option.text)).not.toContain('Pasif Klinik');
    await act(async () => change(customer, 'customer-a')); await settle();
    const contact = container.querySelector('#delivery-contact') as HTMLSelectElement;
    expect(contact.value).toBe('customer-a-primary'); expect(contact.textContent).toContain('Dr. Ayşe'); expect(contact.textContent).not.toContain('Pasif Kişi');
    const assignee = container.querySelector('#delivery-assignee') as HTMLSelectElement; expect(assignee.value).toBe('staff-1');
    await act(async () => change(assignee, 'staff-2'));
    await act(async () => (container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement).click());
    (container.querySelector('#delivery-quantity') as HTMLInputElement).value = '2';
    await act(async () => (container.querySelector('.delivery-form') as HTMLFormElement).requestSubmit()); await settle();
    expect(api.createJobCard).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-a', contactId: 'customer-a-primary', assignedTo: 'staff-2',
      scheduledAt: localDateTimeToIso('2026-07-17T14:30'),
    }));
    expect(api.addDeliveryItem).toHaveBeenCalledWith('job-1', expect.objectContaining({
      productId: 'product-1', deliveredAt: null,
    }));
  });

  it('pre-fills planned delivery time once and preserves a user edit across reference reloads', async () => {
    const pendingCustomer = deferred<CustomerDetail>();
    crm.getCustomer.mockReturnValue(pendingCustomer.promise);
    await act(async () => root.render(<DeliveryCreateView user={manager} customers={customers} onCancel={() => {}} onCreated={() => {}} />));
    await settle();
    expect(scheduling.defaultScheduledLocalValue).toHaveBeenCalledTimes(1);
    const scheduled = container.querySelector('#delivery-scheduled-at') as HTMLInputElement;
    expect(scheduled.value).toBe('2026-07-17T14:30');
    expect(container.textContent).toContain('Planlanan teslim zamanı');
    await act(async () => changeInput(scheduled, '2026-08-01T09:00'));
    await act(async () => change(container.querySelector('#delivery-customer') as HTMLSelectElement, 'customer-a'));
    await act(async () => pendingCustomer.resolve(detail('customer-a', 'staff-1')));
    await settle();
    expect((container.querySelector('#delivery-scheduled-at') as HTMLInputElement).value).toBe('2026-08-01T09:00');
    expect(scheduling.defaultScheduledLocalValue).toHaveBeenCalledTimes(1);
  });

  it('sends scheduledAt on the JobCard and null deliveredAt on the planned item', async () => {
    crm.getCustomer.mockResolvedValue(detail('customer-a', 'staff-1'));
    await act(async () => root.render(<DeliveryCreateView user={staffUser} customers={customers} onCancel={() => {}} onCreated={() => {}} />));
    await settle();
    await act(async () => change(container.querySelector('#delivery-customer') as HTMLSelectElement, 'customer-a'));
    await settle();
    await act(async () => (container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement).click());
    (container.querySelector('#delivery-quantity') as HTMLInputElement).value = '1';
    await act(async () => changeInput(container.querySelector('#delivery-scheduled-at') as HTMLInputElement, '2026-07-20T11:00'));
    await act(async () => (container.querySelector('.delivery-form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(api.createJobCard).toHaveBeenCalledWith(expect.objectContaining({
      type: 'PRODUCT_DELIVERY',
      scheduledAt: localDateTimeToIso('2026-07-20T11:00'),
    }));
    expect(api.addDeliveryItem).toHaveBeenCalledWith('job-1', expect.objectContaining({ deliveredAt: null }));
  });

  it('clears incompatible Contact immediately and ignores a late Customer response', async () => {
    const first = deferred<CustomerDetail>(); const second = deferred<CustomerDetail>();
    crm.getCustomer.mockImplementation((id: string) => id === 'customer-a' ? first.promise : second.promise);
    await act(async () => root.render(<DeliveryCreateView user={manager} customers={customers} onCancel={() => {}} onCreated={() => {}} />)); await settle();
    const customer = container.querySelector('#delivery-customer') as HTMLSelectElement;
    await act(async () => change(customer, 'customer-a'));
    await act(async () => change(customer, 'customer-b'));
    expect((container.querySelector('#delivery-contact') as HTMLSelectElement).value).toBe(''); expect(container.textContent).toContain('İlgili kişiler yükleniyor');
    await act(async () => second.resolve(detail('customer-b', 'staff-2', 'Dr. Bora')));
    await act(async () => first.resolve(detail('customer-a', 'staff-1', 'Dr. Eski')));
    const contact = container.querySelector('#delivery-contact') as HTMLSelectElement;
    expect(contact.value).toBe('customer-b-primary'); expect(contact.textContent).toContain('Dr. Bora'); expect(contact.textContent).not.toContain('Dr. Eski');
  });

  it('does not overwrite a management assignee changed while Customer defaults are loading', async () => {
    const pendingCustomer = deferred<CustomerDetail>(); crm.getCustomer.mockReturnValue(pendingCustomer.promise);
    await act(async () => root.render(<DeliveryCreateView user={manager} customers={customers} onCancel={() => {}} onCreated={() => {}} />)); await settle();
    await act(async () => change(container.querySelector('#delivery-customer') as HTMLSelectElement, 'customer-a'));
    const assignee = container.querySelector('#delivery-assignee') as HTMLSelectElement;
    await act(async () => change(assignee, 'staff-2'));
    await act(async () => pendingCustomer.resolve(detail('customer-a', 'staff-1')));
    expect(assignee.value).toBe('staff-2');
  });

  it('does not expose an assignee selector for Staff and always submits the signed-in user', async () => {
    crm.getCustomer.mockResolvedValue(detail('customer-a', 'staff-2'));
    await act(async () => root.render(<DeliveryCreateView user={staffUser} customers={customers} onCancel={() => {}} onCreated={() => {}} />)); await settle();
    expect(container.querySelector('#delivery-assignee')).toBeNull();
    await act(async () => change(container.querySelector('#delivery-customer') as HTMLSelectElement, 'customer-a')); await settle();
    await act(async () => (container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement).click());
    (container.querySelector('#delivery-quantity') as HTMLInputElement).value = '1';
    await act(async () => (container.querySelector('.delivery-form') as HTMLFormElement).requestSubmit()); await settle();
    expect(api.createJobCard).toHaveBeenCalledWith(expect.objectContaining({ assignedTo: 'staff-1' }));
  });

  it('preserves the planned time after a submit error and retry', async () => {
    crm.getCustomer.mockResolvedValue(detail('customer-a', 'staff-1'));
    api.createJobCard.mockRejectedValueOnce(new Error('Sunucu hatası'));
    await act(async () => root.render(<DeliveryCreateView user={staffUser} customers={customers} onCancel={() => {}} onCreated={() => {}} />));
    await settle();
    await act(async () => changeInput(container.querySelector('#delivery-scheduled-at') as HTMLInputElement, '2026-09-01T16:00'));
    await act(async () => change(container.querySelector('#delivery-customer') as HTMLSelectElement, 'customer-a'));
    await settle();
    await act(async () => (container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement).click());
    (container.querySelector('#delivery-quantity') as HTMLInputElement).value = '1';
    await act(async () => (container.querySelector('.delivery-form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(container.querySelector('.form-error')?.textContent).toContain('Sunucu hatası');
    expect((container.querySelector('#delivery-scheduled-at') as HTMLInputElement).value).toBe('2026-09-01T16:00');
    await act(async () => (container.querySelector('.delivery-form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(api.createJobCard).toHaveBeenLastCalledWith(expect.objectContaining({
      scheduledAt: localDateTimeToIso('2026-09-01T16:00'),
    }));
    expect((container.querySelector('#delivery-scheduled-at') as HTMLInputElement).value).toBe('2026-09-01T16:00');
  });
});
