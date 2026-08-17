/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeliveryCreateView } from '../src/DeliveryCreate';
import { localDateTimeToIso } from '../src/jobs/scheduling';
import { ApiError, type CurrentUser, type ReferenceCustomer } from '../src/services/api';
import type { Product } from '../src/services/products-api';
import type { StaffProfile } from '../src/services/people-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const api = vi.hoisted(() => ({
  createJobCard: vi.fn(),
  addDeliveryItem: vi.fn(),
  listReferenceCustomers: vi.fn(),
}));
const crm = vi.hoisted(() => ({ getCustomer: vi.fn() }));
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));
const productsApi = vi.hoisted(() => ({ listProducts: vi.fn() }));
const scheduling = vi.hoisted(() => {
  return {
    defaultScheduledLocalValue: vi.fn(() => '2026-07-17T14:30'),
    isoInstantToLocalDateTime: vi.fn(() => '2026-08-10T09:30'),
    localDateTimeToIso: (value: string) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
      if (!match) throw new Error(value);
      return new Date(
        Number(match[1]), Number(match[2]) - 1, Number(match[3]),
        Number(match[4]), Number(match[5]), 0, 0,
      ).toISOString();
    },
  };
});
const preview = vi.hoisted(() => ({ useCustomerSchedulePreview: vi.fn() }));
const jobs = vi.hoisted(() => ({ findAvailableSlots: vi.fn() }));
vi.mock('../src/services/api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/services/api')>(), ...api }));
vi.mock('../src/services/crm-api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/services/crm-api')>(), ...crm }));
vi.mock('../src/services/people-api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/services/people-api')>(), ...people }));
vi.mock('../src/services/products-api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/services/products-api')>(), ...productsApi }));
vi.mock('../src/jobs/scheduling', () => scheduling);
vi.mock('../src/jobs/useCustomerSchedulePreview', () => preview);
vi.mock('../src/jobs/jobs-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/jobs/jobs-api')>(), ...jobs,
}));

const manager: CurrentUser = { id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com', role: 'MANAGER', mustChangePassword: false };
const staffUser: CurrentUser = { ...manager, id: 'staff-1', role: 'STAFF' };
const customers: ReferenceCustomer[] = [
  { id: 'customer-a', name: 'A Klinik', customerType: 'clinic', status: 'active', assignedStaffUserId: 'staff-1' },
  { id: 'customer-b', name: 'B Klinik', customerType: 'clinic', status: 'active', assignedStaffUserId: 'staff-2' },
  { id: 'customer-inactive', name: 'Pasif Klinik', customerType: 'clinic', status: 'inactive', assignedStaffUserId: null },
];
const product: Product = { id: 'product-1', organizationId: 'org-1', name: 'İmplant', sku: 'I1', brand: null, category: null,
  model: null, unit: 'adet', referencePrice: null, isActive: true, version: 1, createdAt: '', updatedAt: '' };

function profile(id: string, name: string): StaffProfile {
  return { id: `profile-${id}`, user: { id, organizationId: 'org-1', name, email: `${id}@example.com`, role: 'STAFF', mustChangePassword: false,
    isActive: true, version: 1, lastLoginAt: null, createdAt: '', updatedAt: '' }, title: null, phone: null, region: null, managerUserId: null, managerName: null,
    version: 1, counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 } };
}

async function settle() { await act(async () => { await Promise.resolve(); }); }
function change(select: HTMLSelectElement, value: string) { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }
function changeInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function view(user: CurrentUser, initialCustomerId?: string) {
  return <MemoryRouter><DeliveryCreateView user={user} initialCustomerId={initialCustomerId}
    onCancel={() => {}} onCreated={() => {}} /></MemoryRouter>;
}

describe('Delivery create CRM defaults', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    scheduling.isoInstantToLocalDateTime.mockImplementation(() => '2026-08-10T09:30');
    jobs.findAvailableSlots.mockResolvedValue({ slots: [] });
    scheduling.defaultScheduledLocalValue.mockReturnValue('2026-07-17T14:30');
    api.listReferenceCustomers.mockResolvedValue(customers);
    people.listStaff.mockResolvedValue([profile('staff-1', 'Ayşe'), profile('staff-2', 'Bora')]);
    productsApi.listProducts.mockResolvedValue({ items: [product], total: 1, limit: 25, offset: 0 });
    api.createJobCard.mockResolvedValue({ id: 'job-1', version: 1 }); api.addDeliveryItem.mockResolvedValue({ jobCardVersion: 2 });
    preview.useCustomerSchedulePreview.mockReturnValue({ evaluation: null, previewing: false });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('loads active Customers, suggests responsible Staff, and submits without a Contact', async () => {
    await act(async () => root.render(view(manager))); await settle();
    expect(api.listReferenceCustomers).toHaveBeenCalled();
    expect(productsApi.listProducts).toHaveBeenCalledWith({ status: 'active', q: '', limit: 25, offset: 0 });
    const customer = container.querySelector('#delivery-customer') as HTMLSelectElement;
    expect(Array.from(customer.options).map((option) => option.text)).not.toContain('Pasif Klinik');
    await act(async () => change(customer, 'customer-a')); await settle();
    expect(container.querySelector('#delivery-contact')).toBeNull();
    expect(crm.getCustomer).not.toHaveBeenCalled();
    const assignee = container.querySelector('#delivery-assignee') as HTMLSelectElement; expect(assignee.value).toBe('staff-1');
    await act(async () => change(assignee, 'staff-2'));
    await act(async () => (container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement).click());
    (container.querySelector('#delivery-quantity') as HTMLInputElement).value = '2';
    await act(async () => (container.querySelector('.delivery-form') as HTMLFormElement).requestSubmit()); await settle();
    expect(api.createJobCard).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-a', assignedTo: 'staff-2',
      scheduledAt: localDateTimeToIso('2026-07-17T14:30'),
    }));
    expect(api.createJobCard.mock.calls[0]?.[0]).not.toHaveProperty('contactId');
    expect(api.addDeliveryItem).toHaveBeenCalledWith('job-1', expect.objectContaining({
      productId: 'product-1', deliveredAt: null,
    }));
  });

  it('offers and applies a joint slot for the delivery interval', async () => {
    const calendarManager: CurrentUser = {
      ...manager,
      capabilities: { overviewDashboard: true, calendar: true, messaging: true },
    };
    jobs.findAvailableSlots.mockResolvedValue({ slots: [{
      startsAt: '2026-08-10T06:30:00.000Z',
      endsAt: '2026-08-10T07:30:00.000Z',
    }] });
    scheduling.isoInstantToLocalDateTime.mockImplementation((value: string) => (
      value.endsWith('06:30:00.000Z') ? '2026-08-10T09:30' : '2026-08-10T10:30'
    ));
    await act(async () => root.render(view(calendarManager)));
    await settle();
    await act(async () => change(container.querySelector('#delivery-customer') as HTMLSelectElement, 'customer-a'));
    await settle();
    await act(async () => change(container.querySelector('#delivery-assignee') as HTMLSelectElement, 'staff-2'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    await settle();

    const slotButton = container.querySelector('button[data-available-slot]') as HTMLButtonElement;
    expect(slotButton).toBeTruthy();
    await act(async () => slotButton.click());
    expect((container.querySelector('#delivery-scheduled-at') as HTMLInputElement).value).toBe('2026-08-10T09:30');
    expect(container.querySelector('#delivery-scheduled-ends-at')).toBeNull();
  });

  it('pre-fills planned delivery time once and preserves a user edit across reference reloads', async () => {
    await act(async () => root.render(view(manager)));
    await settle();
    expect(scheduling.defaultScheduledLocalValue).toHaveBeenCalledTimes(1);
    const scheduled = container.querySelector('#delivery-scheduled-at') as HTMLInputElement;
    expect(scheduled.value).toBe('2026-07-17T14:30');
    expect(container.textContent).toContain('Planlanan teslim zamanı');
    await act(async () => changeInput(scheduled, '2026-08-01T09:00'));
    await act(async () => change(container.querySelector('#delivery-customer') as HTMLSelectElement, 'customer-a'));
    await settle();
    expect((container.querySelector('#delivery-scheduled-at') as HTMLInputElement).value).toBe('2026-08-01T09:00');
    expect(scheduling.defaultScheduledLocalValue).toHaveBeenCalledTimes(1);
  });

  it('sends scheduledAt on the JobCard and null deliveredAt on the planned item', async () => {
    await act(async () => root.render(view(staffUser)));
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

  it('switches the responsible Staff from the reference projection without loading Contacts', async () => {
    await act(async () => root.render(view(manager))); await settle();
    const customer = container.querySelector('#delivery-customer') as HTMLSelectElement;
    await act(async () => change(customer, 'customer-a'));
    expect((container.querySelector('#delivery-assignee') as HTMLSelectElement).value).toBe('staff-1');
    await act(async () => change(customer, 'customer-b'));
    expect((container.querySelector('#delivery-assignee') as HTMLSelectElement).value).toBe('staff-2');
    expect(container.querySelector('#delivery-contact')).toBeNull();
    expect(crm.getCustomer).not.toHaveBeenCalled();
  });

  it('does not overwrite a management assignee after the Customer default is applied', async () => {
    await act(async () => root.render(view(manager))); await settle();
    await act(async () => change(container.querySelector('#delivery-customer') as HTMLSelectElement, 'customer-a'));
    const assignee = container.querySelector('#delivery-assignee') as HTMLSelectElement;
    await act(async () => change(assignee, 'staff-2'));
    expect(assignee.value).toBe('staff-2');
  });

  it('does not expose an assignee selector for Staff and always submits the signed-in user', async () => {
    await act(async () => root.render(view(staffUser))); await settle();
    expect(container.querySelector('#delivery-assignee')).toBeNull();
    await act(async () => change(container.querySelector('#delivery-customer') as HTMLSelectElement, 'customer-a')); await settle();
    await act(async () => (container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement).click());
    (container.querySelector('#delivery-quantity') as HTMLInputElement).value = '1';
    await act(async () => (container.querySelector('.delivery-form') as HTMLFormElement).requestSubmit()); await settle();
    expect(api.createJobCard).toHaveBeenCalledWith(expect.objectContaining({ assignedTo: 'staff-1' }));
  });

  it('preserves the planned time after a submit error and retry', async () => {
    api.createJobCard.mockRejectedValueOnce(new Error('Sunucu hatası'));
    await act(async () => root.render(view(staffUser)));
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

  it('uses the shared create-heading and form-actions contract (T4A)', async () => {
    await act(async () => root.render(view(staffUser)));
    await settle();
    expect(container.querySelector('.create-heading')).toBeTruthy();
    expect(container.querySelector('.delivery-heading')).toBeNull();
    const actions = container.querySelector('.form-actions');
    expect(actions).toBeTruthy();
    // Heading must not contain the cancel button.
    expect(container.querySelector('.create-heading .secondary-button')).toBeNull();
    // Action footer contains both buttons.
    expect(actions!.querySelectorAll('.secondary-button').length).toBe(1);
    expect(actions!.querySelectorAll('.primary-button').length).toBe(1);
    // First actionable button is secondary cancel (Vazgeç).
    const buttons = actions!.querySelectorAll('button');
    expect(buttons[0]?.textContent).toBe('Vazgeç');
    expect(buttons[0]?.getAttribute('type')).toBe('button');
    expect(buttons[0]?.classList.contains('secondary-button')).toBe(true);
    // Second button is primary submit.
    expect(buttons[1]?.getAttribute('type')).toBe('submit');
    expect(buttons[1]?.classList.contains('primary-button')).toBe(true);
  });

  it('advisory suggested alternative CTA moves the whole delivery interval', async () => {
    preview.useCustomerSchedulePreview.mockReturnValue({
      evaluation: {
        level: 'CONFLICT',
        safeMessage: 'Aynı müşteriye aynı gün başka bir saha işi planlanmış.',
        conflicts: [], recentVisit: null,
        suggestedAlternativeAt: '2026-08-10T09:30:00.000Z',
      },
      previewing: false,
    });
    await act(async () => root.render(view(staffUser)));
    await settle();
    await act(async () => change(container.querySelector('#delivery-customer') as HTMLSelectElement, 'customer-a'));
    await settle();
    await act(async () => (container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement).click());
    (container.querySelector('#delivery-quantity') as HTMLInputElement).value = '2';
    await act(async () => changeInput(container.querySelector('#delivery-scheduled-at') as HTMLInputElement, '2026-08-01T12:30'));
    const cta = container.querySelector('button.compact-button') as HTMLButtonElement;
    expect(cta).toBeTruthy();
    await act(async () => cta.click());
    expect((container.querySelector('#delivery-scheduled-at') as HTMLInputElement).value).toBe('2026-08-10T09:30');
    expect(container.querySelector('#delivery-scheduled-ends-at')).toBeNull();
    await act(async () => (container.querySelector('.delivery-form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(api.createJobCard).toHaveBeenCalledWith(expect.objectContaining({
      scheduledAt: localDateTimeToIso('2026-08-10T09:30'),
    }));
  });

  it('authoritative CUSTOMER_SCHEDULE_CONFLICT alternative moves the whole delivery interval', async () => {
    api.createJobCard.mockRejectedValueOnce(new ApiError(
      409, 'CUSTOMER_SCHEDULE_CONFLICT', 'Aynı müşteriye aynı gün başka bir saha işi planlanmış.',
      false, { conflicts: [], suggestedAlternativeAt: '2026-08-10T09:30:00.000Z' },
    ));
    await act(async () => root.render(view(staffUser)));
    await settle();
    await act(async () => change(container.querySelector('#delivery-customer') as HTMLSelectElement, 'customer-a'));
    await settle();
    await act(async () => (container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement).click());
    (container.querySelector('#delivery-quantity') as HTMLInputElement).value = '2';
    await act(async () => changeInput(container.querySelector('#delivery-scheduled-at') as HTMLInputElement, '2026-08-01T12:30'));
    await act(async () => (container.querySelector('.delivery-form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(container.querySelector('.form-error')?.textContent).toContain('Aynı müşteriye aynı gün başka bir saha işi planlanmış.');
    const cta = container.querySelector('button.compact-button') as HTMLButtonElement;
    expect(cta).toBeTruthy();
    await act(async () => cta.click());
    expect((container.querySelector('#delivery-scheduled-at') as HTMLInputElement).value).toBe('2026-08-10T09:30');
    expect(container.querySelector('#delivery-scheduled-ends-at')).toBeNull();
    await act(async () => (container.querySelector('.delivery-form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(api.createJobCard).toHaveBeenLastCalledWith(expect.objectContaining({
      scheduledAt: localDateTimeToIso('2026-08-10T09:30'),
    }));
  });
});
