/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomerCreateScreen } from '../src/CustomerList';
import { ApiError, type CurrentUser } from '../src/services/api';
import { isTrPhoneMaskComplete } from '../src/ui/phone';
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

  it('marks the Telefon field optional immediately after the customer name', async () => {
    await renderScreen();
    const name = container.querySelector('#customer-name')!;
    const phone = container.querySelector('#customer-phone')!;
    const type = container.querySelector('#create-customer-type')!;
    expect(name.compareDocumentPosition(phone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(phone.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((phone as HTMLInputElement).required).toBe(false);
    expect((phone as HTMLInputElement).type).toBe('tel');
    expect((phone as HTMLInputElement).getAttribute('inputmode')).toBe('tel');
    expect(container.querySelector('#customer-phone')?.closest('.field-group')?.textContent)
      .toContain('Telefon (isteğe bağlı)');
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

  it('lets 905321234567 be typed digit by digit into the real field and submits it', async () => {
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Kademeli Klinik');

    // Feed every keystroke back through the real input, exactly as the browser
    // does. Asserting the pasted value alone missed the bug: the early `9` was
    // rewritten to `(09…`, so the `90` country code could never be completed and
    // `905321234567` was impossible to type from an empty field.
    let value = '';
    let caret = 0;
    const seen: { value: string; complete: boolean; caret: number }[] = [];
    for (const char of '905321234567') {
      const raw = `${value.slice(0, caret)}${char}${value.slice(caret)}`;
      const next = await editCustomerPhone(container, raw, caret + 1);
      value = next.value;
      caret = next.caret;
      seen.push({ value, complete: isTrPhoneMaskComplete(value), caret });
    }

    expect(seen.map(({ value }) => value)).toEqual([
      '9', '90', '905', '9053', '90532', '905321', '9053212', '90532123',
      '905321234', '9053212345', '90532123456', '(0532) 123 45 67',
    ]);
    expect(seen.slice(9)).toEqual([
      { value: '9053212345', complete: true, caret: 10 },
      { value: '90532123456', complete: false, caret: 11 },
      { value: '(0532) 123 45 67', complete: true, caret: 16 },
    ]);

    await submit();
    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createCustomer.mock.calls[0]![0]).toMatchObject({ phone: '(0532) 123 45 67' });
  });

  it('submits a ten-digit bare 90 national number typed into the real field', async () => {
    crmApi.createCustomer.mockResolvedValue({ ...createdCustomer, phone: '+909012345678' });
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'On Haneli Ulusal Klinik');

    let value = '';
    let caret = 0;
    for (const char of '9012345678') {
      const next = await editCustomerPhone(container, `${value.slice(0, caret)}${char}${value.slice(caret)}`, caret + 1);
      value = next.value;
      caret = next.caret;
    }

    expect(value).toBe('9012345678');
    expect(isTrPhoneMaskComplete(value)).toBe(true);
    await submit();

    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createCustomer.mock.calls[0]![0]).toMatchObject({ phone: '9012345678' });
  });

  it('keeps the same field editable after the 11-digit checkpoint blocks submission', async () => {
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'On Bir Haneli Ara Değer Klinik');

    let value = '';
    let caret = 0;
    for (const char of '90532123456') {
      const next = await editCustomerPhone(container, `${value.slice(0, caret)}${char}${value.slice(caret)}`, caret + 1);
      value = next.value;
      caret = next.caret;
    }

    expect(value).toBe('90532123456');
    expect(isTrPhoneMaskComplete(value)).toBe(false);
    await submit();
    expect(crmApi.createCustomer).not.toHaveBeenCalled();

    const next = await editCustomerPhone(container, `${value.slice(0, caret)}7${value.slice(caret)}`, caret + 1);
    value = next.value;
    expect(value).toBe('(0532) 123 45 67');
    expect(isTrPhoneMaskComplete(value)).toBe(true);
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
    // The explicit `+` must survive so the paste stays a visible country-code
    // claim, and the extra trunk `0` must survive so it cannot be repaired into
    // a valid Turkish number; the server then still sees an invalid value.
    expect((container.querySelector('#customer-phone') as HTMLInputElement).value).toBe('+9005321234567');
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

  it('keeps edits after the restored opening prefix without consuming the next digit', async () => {
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Prefix Edit Clinic');
    await setCustomerPhone(container, '05321234567');
    const restored = await editCustomerPhone(container, '0532) 123 45 67', 0);
    expect(restored).toEqual({ value: '(0532) 123 45 67', caret: 2 });
    const raw = `${restored.value.slice(0, restored.caret)}9${restored.value.slice(restored.caret)}`;
    const next = await editCustomerPhone(container, raw, restored.caret + 1);
    expect(next.value).toBe('095321234567');
    await submit();
    expect(crmApi.createCustomer).not.toHaveBeenCalled();
    expect(container.querySelector('#customer-phone-error')?.textContent)
      .toContain('Geçerli bir telefon numarası girin.');
  });

  it('submits successfully with a blank phone and sends phone null', async () => {
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Telefonsuz Klinik');
    await submit();

    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createCustomer.mock.calls[0]![0]).toMatchObject({ phone: null });
    expect(container.querySelector('#customer-phone-error')).toBeNull();
  });

  it('applies the same optional-phone rule for a Staff creator', async () => {
    const staffUser: CurrentUser = { ...manager, id: 'staff-1', name: 'Saha Personeli', role: 'STAFF' };
    await act(async () => root.render(<CustomerCreateScreen user={staffUser} />));
    await settle();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Personel Telefonsuz Klinik');
    await submit();

    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createCustomer.mock.calls[0]![0]).toMatchObject({
      phone: null, assignedStaffUserId: null,
    });
    expect(container.querySelector('#customer-phone-error')).toBeNull();
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

  it('blocks a foreign +country paste instead of rewriting it into a Turkish number', async () => {
    const cases: [string, string][] = [
      ['+15551234567', '+15551234567'],
      ['+1 202 555 0147', '+12025550147'],
      ['+3572212345', '+3572212345'],
      ['+495551234567', '+495551234567'],
      ['+9005321234567', '+9005321234567'],
    ];
    for (const [input, shown] of cases) {
      await act(async () => root.unmount());
      container.remove();
      container = document.createElement('div'); document.body.append(container);
      root = createRoot(container);
      await renderScreen();
      change(container.querySelector('#customer-name') as HTMLInputElement, 'Yabancı Telefon Klinik');
      await setCustomerPhone(container, input);

      const field = container.querySelector('#customer-phone') as HTMLInputElement;
      // The prefix survives and the value is not a Turkish national buffer: no
      // trunk `0` was added and no foreign digit was dropped.
      expect(field.value, input).toBe(shown);
      expect(isTrPhoneMaskComplete(field.value), input).toBe(false);

      await submit();
      expect(crmApi.createCustomer, input).not.toHaveBeenCalled();
      expect(container.querySelector('#customer-phone-error')?.textContent, input)
        .toContain('Geçerli bir telefon numarası girin.');
    }
  });

  it('accepts bare national shorthand and submits the masked value', async () => {
    await renderScreen();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Kısa Yol Klinik');
    await setCustomerPhone(container, '5321234567');
    expect((container.querySelector('#customer-phone') as HTMLInputElement).value).toBe('(0532) 123 45 67');

    await submit();
    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createCustomer.mock.calls[0]![0]).toMatchObject({ phone: '(0532) 123 45 67' });
  });

  it('blocks an explicit +90 with a repeated trunk zero and creates nothing', async () => {
    const cases = ['+900532123456', '+900312123456', '+900850123456'];
    for (const input of cases) {
      await act(async () => root.unmount());
      container.remove();
      container = document.createElement('div'); document.body.append(container);
      root = createRoot(container);
      await renderScreen();
      change(container.querySelector('#customer-name') as HTMLInputElement, 'Trunk Sıfır Klinik');
      await setCustomerPhone(container, input);

      const field = container.querySelector('#customer-phone') as HTMLInputElement;
      // `+900532123456` must not become `(0053) 212 34 56` / `00532123456`.
      expect(field.value, input).toBe(input);
      expect(isTrPhoneMaskComplete(field.value), input).toBe(false);

      await submit();
      expect(crmApi.createCustomer, input).not.toHaveBeenCalled();
      expect(container.querySelector('#customer-phone-error')?.textContent, input)
        .toContain('Geçerli bir telefon numarası girin.');
    }
  });

  it('blocks text with an unsupported character instead of stripping it', async () => {
    for (const input of ['0532x1234567', '90+5321234567', '05_321234567']) {
      await act(async () => root.unmount());
      container.remove();
      container = document.createElement('div'); document.body.append(container);
      root = createRoot(container);
      await renderScreen();
      change(container.querySelector('#customer-name') as HTMLInputElement, 'Desteklenmeyen Klinik');
      await setCustomerPhone(container, input);

      const field = container.querySelector('#customer-phone') as HTMLInputElement;
      // Nothing is deleted: the letter / misplaced `+` / underscore stays on screen.
      expect(field.value, input).toBe(input);
      expect(isTrPhoneMaskComplete(field.value), input).toBe(false);

      await submit();
      expect(crmApi.createCustomer, input).not.toHaveBeenCalled();
      expect(container.querySelector('#customer-phone-error')?.textContent, input)
        .toContain('Geçerli bir telefon numarası girin.');
    }
  });
});
