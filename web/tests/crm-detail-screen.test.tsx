/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContactRoute, CustomerRoute } from '../src/AppRouter';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { Contact, CustomerDetail } from '../src/services/crm-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const crm = vi.hoisted(() => ({
  getCustomer: vi.fn(), getContact: vi.fn(), updateCustomer: vi.fn(), updateContact: vi.fn(),
  activateCustomer: vi.fn(), deactivateCustomer: vi.fn(), activateContact: vi.fn(), deactivateContact: vi.fn(),
  makePrimaryContact: vi.fn(), createContact: vi.fn(),
}));
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));

vi.mock('../src/services/crm-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/crm-api')>(), ...crm,
}));
vi.mock('../src/services/people-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/people-api')>(), ...people,
}));

const manager: CurrentUser = { id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com', role: 'MANAGER', mustChangePassword: false };

function customer(id: string, name: string, version = 1): CustomerDetail {
  return { id, organizationId: 'org-1', name, customerType: 'clinic', taxNumber: null, phone: null, email: null,
    city: null, district: null, address: null, assignedStaffUserId: null, assignedStaffName: null, status: 'active', version,
    primaryContact: null, contacts: [], openJobs: [], completedJobs: [] };
}

function contact(id: string, name: string, isPrimary = false, version = 1): Contact {
  return { id, organizationId: 'org-1', customerId: 'customer-1', name, title: null, phone: null, email: null, isPrimary, isActive: true, version };
}

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() { await act(async () => { await Promise.resolve(); }); }

describe('CRM detail screen concurrency', () => {
  let root: Root; let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks(); people.listStaff.mockResolvedValue([]);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });

  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('remounts on route identity and rejects the late response from the previous Customer', async () => {
    const first = deferred<CustomerDetail>(); const second = deferred<CustomerDetail>();
    crm.getCustomer.mockImplementation((id: string) => id === 'customer-a' ? first.promise : second.promise);
    const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerRoute user={manager} /> }], { initialEntries: ['/customers/customer-a'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => { await router.navigate('/customers/customer-b'); });
    expect(container.textContent).toContain('Müşteri detayı yükleniyor'); expect(container.textContent).not.toContain('A Kliniği');
    await act(async () => second.resolve(customer('customer-b', 'B Kliniği')));
    expect(container.textContent).toContain('B Kliniği');
    await act(async () => first.resolve(customer('customer-a', 'A Kliniği')));
    expect(container.textContent).toContain('B Kliniği'); expect(container.textContent).not.toContain('A Kliniği');
  });

  it('ignores a mutation result after navigation to another Customer', async () => {
    const update = deferred<CustomerDetail>();
    crm.getCustomer.mockImplementation((id: string) => Promise.resolve(customer(id, id === 'customer-a' ? 'A Kliniği' : 'B Kliniği')));
    crm.updateCustomer.mockReturnValue(update.promise);
    const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerRoute user={manager} /> }], { initialEntries: ['/customers/customer-a'] });
    await act(async () => root.render(<RouterProvider router={router} />)); await settle();
    await act(async () => (container.querySelector('.record-form') as HTMLFormElement).requestSubmit());
    await act(async () => { await router.navigate('/customers/customer-b'); }); await settle();
    await act(async () => update.resolve(customer('customer-a', 'A Kliniği güncel', 2)));
    expect(container.textContent).toContain('B Kliniği'); expect(container.textContent).not.toContain('Müşteri bilgileri güncellendi.');
  });

  it('preserves and blocks stale Customer input until current values are explicitly loaded', async () => {
    crm.getCustomer.mockResolvedValueOnce(customer('customer-1', 'Eski Klinik', 1)).mockResolvedValueOnce(customer('customer-1', 'Güncel Klinik', 2));
    crm.updateCustomer.mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Güncel değil.'));
    const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerRoute user={manager} /> }], { initialEntries: ['/customers/customer-1'] });
    await act(async () => root.render(<RouterProvider router={router} />)); await settle();
    const name = container.querySelector('#detail-customer-name') as HTMLInputElement; name.value = 'Benim değişikliğim';
    await act(async () => (container.querySelector('.record-form') as HTMLFormElement).requestSubmit()); await settle();
    expect(name.value).toBe('Benim değişikliğim');
    expect((container.querySelector('.record-form button') as HTMLButtonElement).disabled).toBe(true);
    const reload = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Güncel değerleri yükle')!;
    await act(async () => reload.click()); await settle();
    expect((container.querySelector('#detail-customer-name') as HTMLInputElement).value).toBe('Güncel Klinik');
  });

  it('keeps unsaved Customer fields across a lifecycle-only version change', async () => {
    const current = customer('customer-1', 'Demo Klinik', 1);
    crm.getCustomer.mockResolvedValue(current); crm.deactivateCustomer.mockResolvedValue({ ...current, status: 'inactive', version: 2 });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerRoute user={manager} /> }], { initialEntries: ['/customers/customer-1'] });
    await act(async () => root.render(<RouterProvider router={router} />)); await settle();
    const name = container.querySelector('#detail-customer-name') as HTMLInputElement; name.value = 'Kaydedilmemiş ad';
    const lifecycle = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Müşteriyi pasifleştir')!;
    await act(async () => lifecycle.click()); await settle();
    expect((container.querySelector('#detail-customer-name') as HTMLInputElement).value).toBe('Kaydedilmemiş ad');
    expect(container.textContent).toContain('Müşteri pasifleştirildi.');
  });

  it('moves focus to the permanent command region after make-primary removes its trigger', async () => {
    vi.useFakeTimers();
    const secondary = contact('contact-2', 'Selin Ak');
    crm.getContact.mockResolvedValue(secondary); crm.getCustomer.mockResolvedValue(customer('customer-1', 'Demo Klinik'));
    crm.makePrimaryContact.mockResolvedValue({ contact: { ...secondary, isPrimary: true, version: 2 }, previousPrimaryContactId: 'contact-1' });
    const router = createMemoryRouter([{ path: '/customers/:customerId/contacts/:contactId', element: <ContactRoute user={manager} /> }], { initialEntries: ['/customers/customer-1/contacts/contact-2'] });
    await act(async () => root.render(<RouterProvider router={router} />)); await settle();
    (container.querySelector('#contact-name') as HTMLInputElement).value = 'Kaydedilmemiş kişi adı';
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Birincil kişi yap')!;
    await act(async () => trigger.click()); await settle();
    await act(async () => vi.runAllTimers());
    expect(document.activeElement).toBe(container.querySelector('.record-commands'));
    expect((container.querySelector('#contact-name') as HTMLInputElement).value).toBe('Kaydedilmemiş kişi adı');
    expect(container.textContent).not.toContain('Birincil kişi yap');
  });
});
