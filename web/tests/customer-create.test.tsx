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

const crmApi = vi.hoisted(() => ({ createCustomer: vi.fn(), listCustomers: vi.fn(), createContact: vi.fn() }));
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

  it('redirects to new-delivery with customerId when source=delivery', async () => {
    searchParams.set('source', 'delivery');
    await renderAndSubmit();
    expect(navigate).toHaveBeenCalledWith('/jobs/new-delivery?customerId=new-customer-1');
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

  it('navigates back to new-delivery on cancel when source=delivery', async () => {
    searchParams.set('source', 'delivery');
    await act(async () => root.render(<CustomerCreateScreen user={staff} />));
    await settle();
    await act(async () => Array.from(container.querySelectorAll('button')).find((btn) => btn.textContent === 'Vazgeç')!.click());
    expect(navigate).toHaveBeenCalledWith('/jobs/new-delivery');
  });
});

describe('CustomerCreateScreen contact orchestration', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    searchParams.delete('source');
    crmApi.createCustomer.mockResolvedValue({
      id: 'new-customer-1', version: 1, organizationId: 'org-1', name: 'Evaden',
      customerType: 'clinic', status: 'prospect', taxNumber: null, phone: null, email: null,
      city: null, district: null, address: null, assignedStaffUserId: null,
      assignedStaffName: null, primaryContact: null,
    });
    crmApi.createContact.mockResolvedValue({
      id: 'contact-1', organizationId: 'org-1', customerId: 'new-customer-1',
      name: 'Ayşe Demir', title: 'Satın Alma', phone: '555', email: 'a@b.com',
      isPrimary: true, isActive: true, version: 1,
    });
    crmApi.listCustomers.mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    peopleApi.listStaff.mockResolvedValue([]);
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  async function renderScreen(user: typeof manager) {
    await act(async () => root.render(<CustomerCreateScreen user={user} />));
    await settle();
  }

  it('CUX-1: labels the Customer field as organization/account oriented', async () => {
    await renderScreen(manager);
    expect(container.querySelector('#customer-name')?.closest('.field-group')?.textContent)
      .toContain('Müşteri / kurum adı');
    expect(container.textContent).toContain('Klinik, poliklinik, şirket veya kişi adı yazabilirsiniz.');
    expect(container.textContent).toContain('Müşteri kaydını oluşturun. İletişim kişisi eklemek isteğe bağlıdır.');
    expect(container.textContent).not.toContain('İlgili kişiler müşteri kaydından sonra eklenir.');
  });

  it('CUX-3: shows a collapsed optional Contact section for MANAGER and creates a real Contact', async () => {
    await renderScreen(manager);
    const details = Array.from(container.querySelectorAll('details'))
      .find((item) => item.textContent?.includes('İletişim kişisi ekle'));
    expect(details).toBeDefined();
    expect((details as HTMLDetailsElement).open).toBe(false);
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Evaden Ağız ve Diş Sağlığı');
    change(container.querySelector('#customer-contact-name') as HTMLInputElement, 'Ayşe Demir');
    change(container.querySelector('#customer-contact-title') as HTMLInputElement, 'Satın Alma');
    change(container.querySelector('#customer-contact-phone') as HTMLInputElement, '555');
    change(container.querySelector('#customer-contact-email') as HTMLInputElement, 'a@b.com');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createContact).toHaveBeenCalledWith('new-customer-1', {
      name: 'Ayşe Demir', title: 'Satın Alma', phone: '555', email: 'a@b.com',
    });
    expect(navigate).toHaveBeenCalledWith('/customers/new-customer-1');
  });

  it('CUX-3 empty: creates the Customer only when the Contact section stays empty', async () => {
    await renderScreen(manager);
    change(container.querySelector('#customer-name') as HTMLInputElement, 'ABC Dental Polikliniği');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createContact).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/customers/new-customer-1');
  });

  it('CUX-3B: hides the optional Contact section from STAFF and never calls createContact', async () => {
    await renderScreen(staff);
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('#customer-contact-name')).toBeNull();
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Mehmet Yılmaz');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createContact).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/customers/new-customer-1');
  });

  it('CUX-3C: keeps the created Customer and communicates partial success when Contact creation fails', async () => {
    crmApi.createContact.mockRejectedValue(new Error('Kişi eklenemedi'));
    await renderScreen(manager);
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Özel Dünya Ağız ve Diş Sağlığı Polikliniği');
    change(container.querySelector('#customer-contact-name') as HTMLInputElement, 'Ayşe Demir');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createContact).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Müşteri oluşturuldu ancak iletişim kişisi eklenemedi.');
    expect(container.textContent).toContain('İletişim kişisini müşteri detayından tekrar ekleyebilirsiniz.');
  });

  it('CUX-3D: rejects incomplete optional Contact before creating the Customer', async () => {
    await renderScreen(manager);
    change(container.querySelector('#customer-name') as HTMLInputElement, 'Evaden');
    change(container.querySelector('#customer-contact-phone') as HTMLInputElement, '0555 123 45 67');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(crmApi.createCustomer).not.toHaveBeenCalled();
    expect(crmApi.createContact).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('İletişim kişisi bilgileri girildiğinde ad soyad zorunludur.');
    const contactName = container.querySelector('#customer-contact-name') as HTMLInputElement;
    expect(contactName.getAttribute('aria-invalid')).toBe('true');
    expect(contactName.getAttribute('aria-describedby')).toContain('customer-contact-name-error');
    expect(container.querySelector('#customer-contact-name-error')?.textContent)
      .toContain('İletişim kişisi bilgileri girildiğinde ad soyad zorunludur.');
  });

  it('CUX-3D whitespace: treats whitespace-only Contact fields as empty', async () => {
    await renderScreen(manager);
    change(container.querySelector('#customer-name') as HTMLInputElement, 'ABC Dental');
    change(container.querySelector('#customer-contact-phone') as HTMLInputElement, '   ');
    change(container.querySelector('#customer-contact-email') as HTMLInputElement, '  ');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(crmApi.createCustomer).toHaveBeenCalledTimes(1);
    expect(crmApi.createContact).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/customers/new-customer-1');
  });
});
