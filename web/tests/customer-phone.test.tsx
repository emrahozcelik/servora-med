/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomerCreateScreen } from '../src/CustomerList';
import { ApiError, type CurrentUser } from '../src/services/api';
import { editCustomerPhone, setCustomerPhone } from './helpers/customer-phone';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const navigate = vi.hoisted(() => vi.fn());
const searchParams = vi.hoisted(() => new URLSearchParams());
vi.mock('react-router-dom', async (original) => ({
  ...await original<typeof import('react-router-dom')>(),
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, vi.fn()],
}));

const crmApi = vi.hoisted(() => ({ createCustomer: vi.fn(), listCustomers: vi.fn(), createContact: vi.fn() }));
vi.mock('../src/services/crm-api', async (original) => ({
  ...await original<typeof import('../src/services/crm-api')>(), ...crmApi,
}));

const peopleApi = vi.hoisted(() => ({ listStaff: vi.fn() }));
vi.mock('../src/services/people-api', async (original) => ({
  ...await original<typeof import('../src/services/people-api')>(), ...peopleApi,
}));

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici',
  email: 'm@test.local', role: 'MANAGER', mustChangePassword: false,
  isActive: true, version: 1,
};

const createdCustomer = {
  id: 'new-customer-1', version: 1, organizationId: 'org-1', name: 'Test Klinik',
  customerType: 'clinic' as const, status: 'prospect' as const, taxNumber: null,
  phone: '+905321234567', email: null, city: null, district: null, address: null,
  assignedStaffUserId: null, assignedStaffName: null, primaryContact: null,
};

async function settle() { await act(async () => { await Promise.resolve(); }); }
function change(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Customer create phone contract', () => {
  let root: Root; let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    crmApi.createCustomer.mockResolvedValue(createdCustomer);
    crmApi.listCustomers.mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    peopleApi.listStaff.mockResolvedValue([]);
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  async function renderScreen() {
    await act(async () => root.render(<CustomerCreateScreen user={manager} />));
    await settle();
  }

  async function submit() {
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    await settle();
  }

  it('places the required Telefon field immediately after the customer name', async () => {
    await renderScreen();
    const name = container.querySelector('#customer-name')!;
    const phone = container.querySelector('#customer-phone')!;
    const type = container.querySelector('#create-customer-type')!;
    expect(name.compareDocumentPosition(phone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(phone.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((phone as HTMLInputElement).required).toBe(true);
    expect((phone as HTMLInputElement).type).toBe('tel');
    expect((phone as HTMLInputElement).getAttribute('inputmode')).toBe('tel');
    expect(container.querySelector('#customer-phone')?.closest('.field-group')?.textContent)
      .toContain('Telefon');
  });

  it('masks typed digits and submits the masked value for the server to normalize', async () => {
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Maskeli Klinik');
    await setCustomerPhone(container, '05321234567');
    expect((container.querySelector('#customer-phone') as HTMLInputElement).value).toBe('(0532) 123 45 67');

    await submit();
    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createCustomer.mock.calls[0]![0]).toMatchObject({ phone: '(0532) 123 45 67' });
  });

  it('accepts a pasted +90 number and renders it in the display format', async () => {
    await renderScreen();
    await setCustomerPhone(container, '+905321234567');
    expect((container.querySelector('#customer-phone') as HTMLInputElement).value).toBe('(0532) 123 45 67');
  });

  it('blocks a malformed +90 paste instead of repairing it into a valid number', async () => {
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Bozuk Prefix Klinik');
    await setCustomerPhone(container, '+9005321234567');
    // The extra trunk `0` after the explicit `+90` must survive so the server
    // still sees an invalid value; dropping it would make the paste look valid.
    expect((container.querySelector('#customer-phone') as HTMLInputElement).value).toBe('9005321234567');
    await submit();
    expect(crmApi.createCustomer).not.toHaveBeenCalled();
    expect(container.querySelector('#customer-phone-error')?.textContent)
      .toContain('Geçerli bir telefon numarası girin.');
  });

  it('re-masks and keeps the caret on the same digit when a separator is deleted', async () => {
    await renderScreen();
    await setCustomerPhone(container, '05321234567');
    expect((container.querySelector('#customer-phone') as HTMLInputElement).value).toBe('(0532) 123 45 67');

    // Deleting the space after `)` leaves the masked text unchanged, which is
    // exactly the case a value-dependent React effect would miss.
    const result = await editCustomerPhone(container, '(0532)123 45 67', 6);
    expect(result.value).toBe('(0532) 123 45 67');
    expect(result.caret).toBe(5);
  });

  it('blocks the request and shows an inline error when the phone is missing', async () => {
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Telefonsuz Klinik');
    await submit();

    expect(crmApi.createCustomer).not.toHaveBeenCalled();
    const phone = container.querySelector('#customer-phone') as HTMLInputElement;
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(phone.getAttribute('aria-describedby')).toContain('customer-phone-error');
    expect(container.querySelector('#customer-phone-error')?.textContent)
      .toContain('Geçerli bir telefon numarası girin.');
  });

  it('blocks the request for an incomplete or over-long phone', async () => {
    for (const value of ['0', '0532', '0532123456', '053212345678']) {
      await act(async () => root.unmount());
      container.remove();
      container = document.createElement('div'); document.body.append(container);
      root = createRoot(container);
      await renderScreen();
      change(container.querySelector('#customer-name') as HTMLInputElement, 'Eksik Telefon Klinik');
      await setCustomerPhone(container, value);
      await submit();
      expect(crmApi.createCustomer, value).not.toHaveBeenCalled();
      expect(container.querySelector('#customer-phone-error')?.textContent, value)
        .toContain('Geçerli bir telefon numarası girin.');
    }
  });

  it('surfaces the server phone field error inline when the API rejects it', async () => {
    crmApi.createCustomer.mockRejectedValue(new ApiError(
      400, 'VALIDATION_ERROR', 'Geçerli bir telefon numarası girin.', false,
      { fieldErrors: { phone: 'Geçerli bir telefon numarası girin.' } },
    ));
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Sunucu Reddi Klinik');
    await setCustomerPhone(container, '05321234567');
    await submit();

    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(container.querySelector('#customer-phone-error')?.textContent)
      .toContain('Geçerli bir telefon numarası girin.');
    expect((container.querySelector('#customer-phone') as HTMLInputElement).getAttribute('aria-invalid'))
      .toBe('true');
    expect(navigate).not.toHaveBeenCalled();
  });
});
