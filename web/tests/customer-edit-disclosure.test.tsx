/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CustomerDetailView } from '../src/CustomerDetail';
import type { CurrentUser } from '../src/services/api';
import type { CustomerDetail } from '../src/services/crm-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};
const staff: CurrentUser = { ...manager, id: 'staff-1', role: 'STAFF' };

const customer: CustomerDetail = {
  id: 'customer-1', organizationId: 'org-1', name: 'Demo Dental Klinik', customerType: 'clinic',
  taxNumber: 'AB123', phone: '+905321234567', email: 'klinik@example.com', city: 'İstanbul',
  district: 'Şişli', address: 'Örnek Sokak', assignedStaffUserId: null, assignedStaffName: null,
  status: 'active', version: 3, primaryContact: null, contacts: [], hasOperationHistory: false,
  openJobCount: 0, completedJobCount: 0,
};

describe('Customer edit disclosure', () => {
  let root: Root; let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  function Harness({ initialOpen = false, record = customer }: { initialOpen?: boolean; record?: CustomerDetail }) {
    const [open, setOpen] = useState(initialOpen);
    return <CustomerDetailView customer={record} user={manager} staff={[]} pending={false}
      error="" notice="" editOpen={open} onEditOpenChange={setOpen} onSave={() => {}}
      onCreateContact={() => {}} historyStatus="all" historyPage={{ items: [], total: 0, limit: 20, offset: 0 }}
      historyLoading={false} historyError="" />;
  }

  const summary = () => {
    const element = container.querySelector('.customer-edit-disclosure > summary');
    if (!(element instanceof HTMLElement)) throw new Error('Düzenleme özeti bulunamadı.');
    return element;
  };
  const nameField = () => {
    const element = container.querySelector<HTMLInputElement>('#detail-customer-name');
    if (!element) throw new Error('Müşteri adı alanı bulunamadı.');
    return element;
  };
  const type = async (value: string) => {
    const element = nameField();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const click = async (element: Element) => { await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); };

  it('starts read-only for management and opens the editor from the native disclosure summary', async () => {
    await act(async () => root.render(<MemoryRouter><Harness /></MemoryRouter>));
    expect(container.querySelector('.customer-edit-disclosure')).not.toBeNull();
    expect(summary().closest('details')?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('.record-form')).toBeNull();

    await click(summary());
    expect(summary().closest('details')?.hasAttribute('open')).toBe(true);
    expect(nameField().value).toBe('Demo Dental Klinik');
  });

  it('discards the unsaved draft when Cancel is used and reopens with authoritative values', async () => {
    await act(async () => root.render(<MemoryRouter><Harness initialOpen /></MemoryRouter>));
    await type('Kaydedilmemiş taslak');
    expect(nameField().value).toBe('Kaydedilmemiş taslak');

    const cancel = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Vazgeç');
    if (!cancel) throw new Error('Vazgeç düğmesi bulunamadı.');
    await click(cancel);

    expect(container.querySelector('.record-form')).toBeNull();
    expect(summary().closest('details')?.hasAttribute('open')).toBe(false);

    await click(summary());
    expect(nameField().value).toBe('Demo Dental Klinik');
  });

  it('keeps an open draft across unrelated re-renders', async () => {
    await act(async () => root.render(<MemoryRouter><Harness initialOpen /></MemoryRouter>));
    const field = nameField();
    await type('Sürüyor');
    await act(async () => root.render(<MemoryRouter><Harness initialOpen record={{ ...customer, openJobCount: 5 }} /></MemoryRouter>));
    expect(nameField()).toBe(field);
    expect(field.value).toBe('Sürüyor');
    expect(summary().closest('details')?.hasAttribute('open')).toBe(true);
  });

  it('never exposes the management editor to STAFF while keeping enrichment available', async () => {
    await act(async () => root.render(<MemoryRouter><CustomerDetailView customer={customer} user={staff} staff={[]}
      pending={false} error="" notice="" enrichmentScope={{ canEnrich: true, canCreateContact: true }}
      onSave={() => {}} onCreateContact={() => {}} historyStatus="all"
      historyPage={{ items: [], total: 0, limit: 20, offset: 0 }} historyLoading={false} historyError="" /></MemoryRouter>));
    expect(container.querySelector('.customer-edit-disclosure')).toBeNull();
    expect(container.querySelector('#detail-customer-name')).toBeNull();
    expect(container.textContent).toContain('Bilgileri tamamla');
  });
});
