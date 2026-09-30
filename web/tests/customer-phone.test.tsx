/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomerCreateScreen } from '../src/CustomerList';
import { ApiError, type CurrentUser } from '../src/services/api';
import { setCustomerPhone } from './helpers/customer-phone';

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

  it('places one required numeric field after the customer name with an automatic zero', async () => {
    await renderScreen();
    const name = container.querySelector('#customer-name')!;
    const phone = container.querySelector('#customer-phone') as HTMLInputElement;
    const type = container.querySelector('#create-customer-type')!;

    expect(name.compareDocumentPosition(phone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(phone.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(phone.required).toBe(true);
    expect(phone.type).toBe('tel');
    expect(phone.inputMode).toBe('numeric');
    expect(phone.maxLength).toBe(11);
    expect(phone.pattern).toBe('0[1-9][0-9]{9}');
    expect(phone.value).toBe('0');
    expect(container.querySelector('#customer-phone-help')?.textContent)
      .toContain('Ardından 10 rakam yazın.');
  });

  it('accepts ten user digits and submits the automatic zero with them', async () => {
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Basit Telefon Klinik');
    const phone = container.querySelector('#customer-phone') as HTMLInputElement;

    for (const digit of '5321234567') await setCustomerPhone(container, `${phone.value}${digit}`);
    expect(phone.value).toBe('05321234567');

    await submit();
    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createCustomer.mock.calls[0]![0]).toMatchObject({ phone: '05321234567' });
  });

  it('rejects non-digits and an eleventh user digit without changing the value', async () => {
    await renderScreen();
    const phone = container.querySelector('#customer-phone') as HTMLInputElement;

    await setCustomerPhone(container, '0532');
    await setCustomerPhone(container, '0532x');
    expect(phone.value).toBe('0532');

    await setCustomerPhone(container, '05321234567');
    await setCustomerPhone(container, '053212345678');
    expect(phone.value).toBe('05321234567');

    await setCustomerPhone(container, '5321234567');
    expect(phone.value).toBe('05321234567');
  });

  it('blocks missing, incomplete, and double-zero values with an inline error', async () => {
    for (const value of ['0', '0532', '00532123456']) {
      await act(async () => root.unmount());
      container.remove();
      container = document.createElement('div'); document.body.append(container);
      root = createRoot(container);
      await renderScreen();
      change(container.querySelector('#customer-name') as HTMLInputElement, 'Eksik Telefon Klinik');
      await setCustomerPhone(container, value);
      await submit();

      expect(crmApi.createCustomer, value).not.toHaveBeenCalled();
      const phone = container.querySelector('#customer-phone') as HTMLInputElement;
      expect(phone.getAttribute('aria-invalid')).toBe('true');
      expect(phone.getAttribute('aria-describedby')).toContain('customer-phone-error');
      expect(container.querySelector('#customer-phone-error')?.textContent)
        .toContain('Geçerli bir telefon numarası girin.');
    }
  });

  it('surfaces a server phone field error inline', async () => {
    crmApi.createCustomer.mockRejectedValue(new ApiError(
      400, 'VALIDATION_ERROR', 'Geçerli bir telefon numarası girin.', false,
      { fieldErrors: { phone: 'Geçerli bir telefon numarası girin.' } },
    ));
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Sunucu Reddi Klinik');
    await setCustomerPhone(container, '5321234567');
    await submit();

    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(container.querySelector('#customer-phone-error')?.textContent)
      .toContain('Geçerli bir telefon numarası girin.');
    expect((container.querySelector('#customer-phone') as HTMLInputElement).getAttribute('aria-invalid'))
      .toBe('true');
    expect(navigate).not.toHaveBeenCalled();
  });
});
