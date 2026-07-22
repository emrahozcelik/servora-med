/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomerCreateScreen } from '../src/CustomerList';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const navigate = vi.hoisted(() => vi.fn());
const searchParams = vi.hoisted(() => new URLSearchParams());
vi.mock('react-router-dom', async (original) => ({
  ...await original<typeof import('react-router-dom')>(),
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, vi.fn()],
}));

const crmApi = vi.hoisted(() => ({ createCustomer: vi.fn(), listCustomers: vi.fn() }));
vi.mock('../src/services/crm-api', async (original) => ({
  ...await original<typeof import('../src/services/crm-api')>(), ...crmApi,
}));

const peopleApi = vi.hoisted(() => ({ listStaff: vi.fn() }));
vi.mock('../src/services/people-api', async (original) => ({
  ...await original<typeof import('../src/services/people-api')>(), ...peopleApi,
}));

const manager = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici',
  email: 'm@test.local', role: 'MANAGER' as const, mustChangePassword: false,
  isActive: true, version: 1,
};
const staff = { ...manager, id: 'staff-1', name: 'Ayşe Personel', role: 'STAFF' as const };

async function settle() { await act(async () => { await Promise.resolve(); }); }
function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('CustomerCreateScreen redirect', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    searchParams.delete('source');
    crmApi.createCustomer.mockResolvedValue({
      id: 'new-customer-1', version: 1, organizationId: 'org-1', name: 'Test Klinik',
      customerType: 'clinic', status: 'prospect', taxNumber: null, phone: null, email: null,
      city: null, district: null, address: null, assignedStaffUserId: null,
      assignedStaffName: null, primaryContact: null,
    });
    crmApi.listCustomers.mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    peopleApi.listStaff.mockResolvedValue([]);
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  async function renderAndSubmit() {
    await act(async () => root.render(<CustomerCreateScreen user={staff} />));
    await settle();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Test Klinik');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    await settle();
  }

  it('redirects to new-meeting with customerId when source=meeting', async () => {
    searchParams.set('source', 'meeting');
    await renderAndSubmit();
    expect(navigate).toHaveBeenCalledWith('/jobs/new-meeting?customerId=new-customer-1');
  });

  it('redirects to new-task with customerId when source=task', async () => {
    searchParams.set('source', 'task');
    await renderAndSubmit();
    expect(navigate).toHaveBeenCalledWith('/jobs/new-task?customerId=new-customer-1');
  });

  it('redirects to customer detail when no source param', async () => {
    await renderAndSubmit();
    expect(navigate).toHaveBeenCalledWith('/customers/new-customer-1');
  });

  it('navigates back to new-meeting on cancel when source=meeting', async () => {
    searchParams.set('source', 'meeting');
    await act(async () => root.render(<CustomerCreateScreen user={staff} />));
    await settle();
    const cancel = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Vazgeç',
    )!;
    await act(async () => cancel.click());
    expect(navigate).toHaveBeenCalledWith('/jobs/new-meeting');
  });

  it('navigates back to new-task on cancel when source=task', async () => {
    searchParams.set('source', 'task');
    await act(async () => root.render(<CustomerCreateScreen user={staff} />));
    await settle();
    await act(async () => Array.from(container.querySelectorAll('button')).find((btn) => btn.textContent === 'Vazgeç')!.click());
    expect(navigate).toHaveBeenCalledWith('/jobs/new-task');
  });
});
