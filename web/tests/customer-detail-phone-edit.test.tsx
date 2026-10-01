/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CustomerDetailView, customerFieldsFromFormData } from '../src/CustomerDetail';
import type { CurrentUser } from '../src/services/api';
import type { CustomerDetail } from '../src/services/crm-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};

const customer: CustomerDetail = {
  id: 'customer-1', organizationId: 'org-1', name: 'Demo Dental Klinik', customerType: 'clinic',
  taxNumber: 'AB123', phone: '+905321234567', email: 'klinik@example.com', city: 'İstanbul',
  district: 'Şişli', address: 'Örnek Sokak', assignedStaffUserId: null, assignedStaffName: null,
  status: 'active', version: 3, primaryContact: null, contacts: [], hasOperationHistory: false,
  openJobCount: 0, completedJobCount: 0,
};

/**
 * The edit form is the place where a stored phone is loaded into a field the
 * user then modifies. The create-time mask belongs to NEW customers only: this
 * form has to keep a historical value such as `santral 555` intact, because the
 * edit contract on the server preserves a non-canonical phone verbatim. These
 * tests drive the real DOM so the difference between a plain field and the
 * masked create input is observable at all.
 */
describe('Customer detail phone editing', () => {
  let root: Root; let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  async function render(record: CustomerDetail) {
    const saves: FormData[] = [];
    await act(async () => root.render(<MemoryRouter><CustomerDetailView
      customer={record} user={manager} staff={[]} pending={false} error="" notice=""
      onBack={() => {}} onSave={(event) => { event.preventDefault(); saves.push(new FormData(event.currentTarget)); }}
      onCreateContact={() => {}} historyStatus="all" historyPage={{ items: [], total: 0, limit: 20, offset: 0 }}
      historyLoading={false} historyError="" onHistoryStatusChange={() => {}} onHistoryPageChange={() => {}} /></MemoryRouter>));
    return saves;
  }

  function phoneField() {
    const element = container.querySelector('#detail-customer-phone');
    if (!(element instanceof HTMLInputElement)) throw new Error('#detail-customer-phone bulunamadı.');
    return element;
  }

  /** Types `value` into the phone field the way a keystroke or paste would. */
  async function type(value: string) {
    const element = phoneField();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
      element.setSelectionRange(value.length, value.length);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return element.value;
  }

  async function save() {
    const form = phoneField().closest('form');
    if (!(form instanceof HTMLFormElement)) throw new Error('Düzenleme formu bulunamadı.');
    await act(async () => form.requestSubmit());
  }

  it('keeps a historical free-text phone intact while editing and saving', async () => {
    for (const stored of ['santral 555', '+49 151 12345678', '555', 'Merkez 0212']) {
      await act(async () => root.unmount());
      container.remove();
      container = document.createElement('div'); document.body.append(container);
      root = createRoot(container);

      const saves = await render({ ...customer, phone: stored });
      // Opening the edit form must not rewrite the stored value.
      expect(phoneField().value, stored).toBe(stored);
      // Typing must not funnel the legacy value through the create-time mask.
      const edited = `${stored} / 12`;
      expect(await type(edited), stored).toBe(edited);
      // Saving submits exactly what the user left in the field.
      await save();
      expect(saves.at(-1)?.get('phone'), stored).toBe(edited);
    }
  });

  it('shows a canonical phone in the display format and saves it back for re-canonicalization', async () => {
    const saves = await render({ ...customer, phone: '+905321234567' });
    expect(phoneField().value).toBe('(0532) 123 45 67');
    await save();
    expect(saves.at(-1)?.get('phone')).toBe('(0532) 123 45 67');
  });

  it('leaves a phone-less customer editable and saves an empty phone as null', async () => {
    const saves = await render({ ...customer, phone: null });
    expect(phoneField().value).toBe('');
    // An unrelated edit still saves; the untouched phone stays null.
    await act(async () => {
      const name = container.querySelector('#detail-customer-name');
      if (!(name instanceof HTMLInputElement)) throw new Error('#detail-customer-name bulunamadı.');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Demo Dental Klinik A.Ş.');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await save();
    expect(customerFieldsFromFormData(saves.at(-1)!, customer.version).phone).toBeNull();
  });

  it('shows a historical trunk-zero phone verbatim and preserves it through an unrelated edit', async () => {
    const stored = '+900532123456';
    const saves = await render({ ...customer, phone: stored });
    // The server never accepted this value, so it must not be rendered as a mask.
    expect(phoneField().value).toBe(stored);

    // Change ONLY the customer name; the phone is never touched.
    await act(async () => {
      const name = container.querySelector('#detail-customer-name');
      if (!(name instanceof HTMLInputElement)) throw new Error('#detail-customer-name bulunamadı.');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Adı Değişen Klinik');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await save();
    expect(saves.at(-1)?.get('phone')).toBe(stored);
  });

  it('keeps every other historical shape verbatim through an unrelated edit', async () => {
    for (const stored of ['+900312123456', '+900850123456', '+495551234567', 'santral 555']) {
      await act(async () => root.unmount());
      container.remove();
      container = document.createElement('div'); document.body.append(container);
      root = createRoot(container);
      const saves = await render({ ...customer, phone: stored });
      expect(phoneField().value, stored).toBe(stored);
      await save();
      expect(saves.at(-1)?.get('phone'), stored).toBe(stored);
    }
  });
});
