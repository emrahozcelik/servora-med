/** @vitest-environment jsdom */
import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RealtimeProvider } from '../src/realtime/RealtimeProvider';
import { ContactRoute, CustomerRoute } from '../src/AppRouter';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { Contact, CustomerDetail } from '../src/services/crm-api';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: TestResizeObserver,
});

const crm = vi.hoisted(() => ({
  getCustomerEnrichmentScope: vi.fn(), enrichCustomer: vi.fn(), createEnrichmentContact: vi.fn(),
  getCustomer: vi.fn(), getContact: vi.fn(), updateCustomer: vi.fn(), updateContact: vi.fn(),
  activateCustomer: vi.fn(), deactivateCustomer: vi.fn(), activateContact: vi.fn(), deactivateContact: vi.fn(),
  makePrimaryContact: vi.fn(), createContact: vi.fn(), deleteCustomer: vi.fn(),
}));
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));

vi.mock('../src/services/crm-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/crm-api')>(), ...crm,
}));
vi.mock('../src/services/people-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/people-api')>(), ...people,
}));

const manager: CurrentUser = { id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com', role: 'MANAGER', mustChangePassword: false };
const admin: CurrentUser = { ...manager, id: 'admin-1', role: 'ADMIN' };

function customer(id: string, name: string, version = 1): CustomerDetail {
  return { id, organizationId: 'org-1', name, customerType: 'clinic', taxNumber: null, phone: null, email: null,
    city: null, district: null, address: null, assignedStaffUserId: null, assignedStaffName: null, status: 'active', version,
    primaryContact: null, contacts: [], hasOperationHistory: false, openJobCount: 0, completedJobCount: 0 };
}

function contact(id: string, name: string, isPrimary = false, version = 1): Contact {
  return { id, organizationId: 'org-1', customerId: 'customer-1', name, title: null, phone: null, email: null, isPrimary, isActive: true, version };
}

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() {
  await act(async () => {
    await vi.dynamicImportSettled();
    await Promise.resolve();
  });
}

describe('CRM detail screen concurrency', () => {
  let root: Root; let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks(); people.listStaff.mockResolvedValue([]); crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:false,canCreateContact:false});
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });

  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

  async function render(router: any) {
    await act(async () => {
      root.render(<Suspense fallback={null}><RouterProvider router={router} /></Suspense>);
      await vi.dynamicImportSettled();
    });
  }

  it('remounts on route identity and rejects the late response from the previous Customer', async () => {
    const first = deferred<CustomerDetail>(); const second = deferred<CustomerDetail>();
    crm.getCustomer.mockImplementation((id: string) => id === 'customer-a' ? first.promise : second.promise);
    const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerRoute user={manager} /> }], { initialEntries: ['/customers/customer-a'] });
    await render(router);
    await act(async () => { await router.navigate('/customers/customer-b'); });
    await settle();
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
    await render(router);
    await act(async () => (container.querySelector('.record-form') as HTMLFormElement).requestSubmit());
    await act(async () => { await router.navigate('/customers/customer-b'); }); await settle();
    await act(async () => update.resolve(customer('customer-a', 'A Kliniği güncel', 2)));
    expect(container.textContent).toContain('B Kliniği'); expect(container.textContent).not.toContain('Müşteri bilgileri güncellendi.');
  });

  it('preserves and blocks stale Customer input until current values are explicitly loaded', async () => {
    crm.getCustomer.mockResolvedValueOnce(customer('customer-1', 'Eski Klinik', 1)).mockResolvedValueOnce(customer('customer-1', 'Güncel Klinik', 2));
    crm.updateCustomer.mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Güncel değil.'));
    const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerRoute user={manager} /> }], { initialEntries: ['/customers/customer-1'] });
    await render(router);
    const name = container.querySelector('#detail-customer-name') as HTMLInputElement; name.value = 'Benim değişikliğim';
    await act(async () => (container.querySelector('.record-form') as HTMLFormElement).requestSubmit()); await settle();
    expect(name.value).toBe('Benim değişikliğim');
    expect((container.querySelector('.record-form .primary-button') as HTMLButtonElement).disabled).toBe(true);
    const reload = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Güncel değerleri yükle')!;
    await act(async () => reload.click()); await settle();
    expect((container.querySelector('#detail-customer-name') as HTMLInputElement).value).toBe('Güncel Klinik');
  });

  it('does not render customer lifecycle commands on the detail screen', async () => {
    crm.getCustomer.mockResolvedValue(customer('customer-1', 'Demo Klinik', 1));
    const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerRoute user={manager} /> }], { initialEntries: ['/customers/customer-1'] });
    await render(router);
    expect(container.textContent).not.toContain('Müşteriyi pasifleştir');
    expect(container.textContent).not.toContain('Müşteriyi aktifleştir');
    expect(container.textContent).not.toContain('Müşteri durumu');
  });

  it('lets an Admin cancel pristine Customer deletion without sending a request', async () => {
    crm.getCustomer.mockResolvedValue(customer('customer-1', 'Demo Klinik', 4));
    const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerRoute user={admin} /> }], { initialEntries: ['/customers/customer-1'] });
    await render(router);
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Kalıcı olarak sil' && !button.closest('[role="dialog"]'))!;
    await act(async () => trigger.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Bu müşteri için operasyon geçmişi bulunmuyor.');
    const cancel = Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll('button'))
      .find((button) => button.textContent === 'Vazgeç')!;
    await act(async () => cancel.click());
    expect(crm.deleteCustomer).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('confirms one permanent-delete request with the current Customer version', async () => {
    crm.getCustomer.mockResolvedValue(customer('customer-1', 'Demo Klinik', 7));
    crm.deleteCustomer.mockResolvedValue(undefined);
    const router = createMemoryRouter([
      { path: '/customers/:customerId', element: <CustomerRoute user={admin} /> },
      { path: '/customers', element: <div>Müşteri listesi</div> },
    ], { initialEntries: ['/customers/customer-1'] });
    await render(router);
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Kalıcı olarak sil' && !button.closest('[role="dialog"]'))!;
    await act(async () => trigger.click());
    const confirm = Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kalıcı olarak sil')!;
    await act(async () => confirm.click()); await settle();
    expect(crm.deleteCustomer).toHaveBeenCalledTimes(1);
    expect(crm.deleteCustomer).toHaveBeenCalledWith('customer-1', 7);
    expect(router.state.location.pathname).toBe('/customers');
    expect(router.state.location.state).toEqual({ customerNotice: 'Demo Klinik kalıcı olarak silindi.' });
  });

  it('prevents duplicate permanent-delete requests while confirmation is pending', async () => {
    const deletion = deferred<void>();
    crm.getCustomer.mockResolvedValue(customer('customer-1', 'Demo Klinik', 3));
    crm.deleteCustomer.mockReturnValue(deletion.promise);
    const router = createMemoryRouter([
      { path: '/customers/:customerId', element: <CustomerRoute user={admin} /> },
      { path: '/customers', element: <div>Müşteri listesi</div> },
    ], { initialEntries: ['/customers/customer-1'] });
    await render(router);
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Kalıcı olarak sil' && !button.closest('[role="dialog"]'))!;
    await act(async () => trigger.click());
    const confirm = Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kalıcı olarak sil')!;
    await act(async () => { confirm.click(); confirm.click(); });
    expect(crm.deleteCustomer).toHaveBeenCalledTimes(1);
    expect((container.querySelector('[role="dialog"]')?.querySelector('.destructive-button') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => deletion.resolve());
  });

  it('refreshes and removes the delete action after an operation-history race', async () => {
    crm.getCustomer
      .mockResolvedValueOnce(customer('customer-1', 'Demo Klinik', 3))
      .mockResolvedValueOnce({ ...customer('customer-1', 'Demo Klinik', 3), hasOperationHistory: true });
    crm.deleteCustomer.mockRejectedValue(new ApiError(
      409, 'CUSTOMER_HAS_OPERATION_HISTORY',
      'Bu müşteri geçmiş iş veya teslimat kayıtlarında kullanıldığı için silinemez.',
    ));
    const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerRoute user={admin} /> }], { initialEntries: ['/customers/customer-1'] });
    await render(router);
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Kalıcı olarak sil' && !button.closest('[role="dialog"]'))!;
    await act(async () => trigger.click());
    const confirm = Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kalıcı olarak sil')!;
    await act(async () => confirm.click()); await settle();
    expect(crm.deleteCustomer).toHaveBeenCalledTimes(1);
    expect(crm.getCustomer).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Bu müşteri operasyon geçmişinde kullanıldığı için kalıcı olarak silinemez.');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Kalıcı olarak sil')).toBe(false);
  });

  it('refreshes current values without retrying after a Customer version conflict', async () => {
    const initial = { ...customer('customer-1', 'Eski Klinik', 3), contacts: [contact('contact-1', 'Dr. Ayşe')] };
    const current = { ...customer('customer-1', 'Güncel Klinik', 4), contacts: [contact('contact-1', 'Dr. Ayşe')] };
    crm.getCustomer.mockResolvedValueOnce(initial).mockResolvedValueOnce(current);
    crm.deleteCustomer.mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Kayıt başka bir kullanıcı tarafından güncellendi.', false, { currentVersion: 4 }));
    const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerRoute user={admin} /> }], { initialEntries: ['/customers/customer-1'] });
    await render(router);
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Kalıcı olarak sil' && !button.closest('[role="dialog"]'))!;
    await act(async () => trigger.click());
    const confirm = Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kalıcı olarak sil')!;
    await act(async () => confirm.click()); await settle();
    expect(crm.deleteCustomer).toHaveBeenCalledTimes(1);
    expect(crm.getCustomer).toHaveBeenCalledTimes(2);
    expect((container.querySelector('#detail-customer-name') as HTMLInputElement).value).toBe('Güncel Klinik');
    expect(container.textContent).toContain('Dr. Ayşe');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Müşteri başka bir kullanıcı tarafından güncellendi');
  });

  it('returns focus to the Contact create trigger after a successful inline create', async () => {
    vi.useFakeTimers(); crm.getCustomer.mockResolvedValue(customer('customer-1', 'Demo Klinik'));
    crm.createContact.mockResolvedValue(contact('contact-3', 'Dr. Deniz'));
    const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerRoute user={manager} /> }], { initialEntries: ['/customers/customer-1'] });
    await render(router);
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'İlgili kişi ekle')!;
    await act(async () => trigger.click());
    const name = container.querySelector('#new-contact-name') as HTMLInputElement; name.value = 'Dr. Deniz';
    await act(async () => (container.querySelector('.inline-record-form form') as HTMLFormElement).requestSubmit()); await settle();
    await act(async () => vi.runAllTimers());
    expect(document.activeElement).toBe(trigger); expect(container.textContent).toContain('İlgili kişi eklendi.');
  });

  it('moves focus to the permanent command region after make-primary removes its trigger', async () => {
    vi.useFakeTimers();
    const secondary = contact('contact-2', 'Selin Ak');
    crm.getContact.mockResolvedValue(secondary); crm.getCustomer.mockResolvedValue(customer('customer-1', 'Demo Klinik'));
    crm.makePrimaryContact.mockResolvedValue({ contact: { ...secondary, isPrimary: true, version: 2 }, previousPrimaryContactId: 'contact-1' });
    const router = createMemoryRouter([{ path: '/customers/:customerId/contacts/:contactId', element: <ContactRoute user={manager} /> }], { initialEntries: ['/customers/customer-1/contacts/contact-2'] });
    await render(router);
    (container.querySelector('#contact-name') as HTMLInputElement).value = 'Kaydedilmemiş kişi adı';
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Birincil kişi yap')!;
    await act(async () => trigger.click());
    expect(crm.makePrimaryContact).not.toHaveBeenCalled();
    const confirm = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button !== trigger && button.textContent === 'Birincil kişi yap')!;
    expect(confirm).toBeTruthy();
    await act(async () => confirm.click()); await settle();
    expect(crm.makePrimaryContact).toHaveBeenCalledTimes(1);
    await act(async () => vi.runAllTimers());
    expect(document.activeElement).toBe(container.querySelector('.record-commands'));
    expect((container.querySelector('#contact-name') as HTMLInputElement).value).toBe('Kaydedilmemiş kişi adı');
    expect(container.textContent).not.toContain('Birincil kişi yap');
  });

  it('prevents duplicate make-primary commands while confirmation is pending', async () => {
    const command = deferred<{ contact: Contact; previousPrimaryContactId: string | null }>();
    const secondary = contact('contact-2', 'Selin Ak');
    crm.getContact.mockResolvedValue(secondary);
    crm.getCustomer.mockResolvedValue(customer('customer-1', 'Demo Klinik'));
    crm.makePrimaryContact.mockReturnValue(command.promise);
    const router = createMemoryRouter(
      [{ path: '/customers/:customerId/contacts/:contactId', element: <ContactRoute user={manager} /> }],
      { initialEntries: ['/customers/customer-1/contacts/contact-2'] },
    );
    await render(router);

    const trigger = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Birincil kişi yap')!;
    await act(async () => trigger.click());
    expect(crm.makePrimaryContact).not.toHaveBeenCalled();

    const confirm = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button !== trigger && button.textContent === 'Birincil kişi yap')!;
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(crm.makePrimaryContact).toHaveBeenCalledTimes(1);

    await act(async () => command.resolve({
      contact: { ...secondary, isPrimary: true, version: 2 },
      previousPrimaryContactId: 'contact-1',
    }));
  });
  it('uses the server scope and dedicated action for STAFF rather than generic PATCH and restores opener focus', async()=>{
    const staff={...manager,id:'staff-1',role:'STAFF' as const};const current=customer('customer-1','Synthetic clinic');
    crm.getCustomer.mockResolvedValue(current);crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true});
    crm.enrichCustomer.mockResolvedValue({...current,city:'İzmir',version:2});
    const router=createMemoryRouter([{path:'/customers/:customerId',element:<CustomerRoute user={staff}/>}],{initialEntries:['/customers/customer-1']});
    await render(router);await settle();
    const opener=Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Bilgileri tamamla');expect(opener).toBeTruthy();
    await act(async()=>opener!.click());
    (container.querySelector('[name="city"]') as HTMLInputElement).value='İzmir';
    await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();
    expect(crm.enrichCustomer).toHaveBeenCalledWith('customer-1',{expectedVersion:1,phone:null,email:null,city:'İzmir',district:null,address:null});
    expect(crm.updateCustomer).not.toHaveBeenCalled();
    expect(container.textContent).toContain('İletişim bilgileri güncellendi.');
    await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
    expect(document.activeElement).toBe(Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Bilgileri tamamla'));
  });

  const staffUser={...manager,id:'staff-1',role:'STAFF' as const};
  function staffRouter(){return createMemoryRouter([{path:'/customers/:customerId',element:<CustomerRoute user={staffUser}/>}],{initialEntries:['/customers/customer-1']});}
  const button=(text:string)=>Array.from(container.querySelectorAll('button')).find(b=>b.textContent===text)!;
  it('keeps a visible customer read-only when server scope denies permission, despite assignment projection',async()=>{
    crm.getCustomer.mockResolvedValue({...customer('customer-1','Visible clinic'),assignedStaffUserId:staffUser.id});
    await render(staffRouter());await settle();
    expect(container.querySelector('form')).toBeNull();expect(container.textContent).not.toContain('Bilgileri tamamla');expect(container.textContent).not.toContain('İlgili kişi ekle');
  });
  it('focuses the phone field on open, cancels without mutation and restores focus',async()=>{
    crm.getCustomer.mockResolvedValue(customer('customer-1','Synthetic'));crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true});
    await render(staffRouter());await settle();await act(async()=>button('Bilgileri tamamla').click());
    expect(document.activeElement).toBe(container.querySelector('[name="phone"]'));
    await act(async()=>button('Vazgeç').click());await act(async()=>new Promise(r=>setTimeout(r,10)));
    expect(crm.enrichCustomer).not.toHaveBeenCalled();expect(document.activeElement).toBe(button('Bilgileri tamamla'));
  });
  it('freezes one expected-version request and disables all enrichment controls while pending',async()=>{
    const response=deferred<CustomerDetail>();const current=customer('customer-1','Synthetic');
    crm.getCustomer.mockResolvedValue(current);crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true});crm.enrichCustomer.mockReturnValue(response.promise);
    await render(staffRouter());await settle();await act(async()=>button('Bilgileri tamamla').click());
    const form=container.querySelector('form')!;
    await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(crm.enrichCustomer).toHaveBeenCalledTimes(1);
    expect(button('İlgili kişi ekle').disabled).toBe(true);
    expect(Array.from(form.querySelectorAll<HTMLInputElement>('input,textarea,button')).every(e=>e.disabled)).toBe(true);
    await act(async()=>response.resolve({...current,version:2}));
  });
  it('preserves the mounted enrichment draft and focus across background reconciliation', async () => {
    crm.getCustomer.mockResolvedValue(customer('customer-1', 'Synthetic'));
    crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true});
    const router = staffRouter();
    await act(async () => { root.render(<RealtimeProvider eventSourceFactory={() => null}><Suspense fallback={null}><RouterProvider router={router} /></Suspense></RealtimeProvider>); });
    await settle(); await act(async () => button('Bilgileri tamamla').click());
    const address = container.querySelector('[name="address"]') as HTMLTextAreaElement;
    address.value = 'Unsaved address'; address.focus();
    await act(async () => window.dispatchEvent(new Event('focus'))); await settle();
    expect(crm.getCustomer).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[name="address"]')).toBe(address);
    expect(address.value).toBe('Unsaved address'); expect(document.activeElement).toBe(address);
    expect(button('İletişim bilgilerini kaydet').disabled).toBe(false);
    expect(crm.enrichCustomer).not.toHaveBeenCalled();
  });
  it('preserves drafts on reconnect and fallback, blocking changed server versions until explicit reload', async () => {
    const events = new EventTarget();
    const source = {addEventListener:events.addEventListener.bind(events), removeEventListener:events.removeEventListener.bind(events), close:() => {}};
    const current = customer('customer-1', 'Synthetic'); crm.getCustomer.mockResolvedValue(current);
    crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true});
    await act(async () => root.render(<RealtimeProvider eventSourceFactory={() => source}><Suspense fallback={null}><RouterProvider router={staffRouter()} /></Suspense></RealtimeProvider>));
    await settle(); await act(async () => button('Bilgileri tamamla').click());
    const city = container.querySelector('[name="city"]') as HTMLInputElement; city.value = 'My draft';
    await act(async () => events.dispatchEvent(new Event('open'))); await settle();
    expect(container.querySelector('[name="city"]')).toBe(city); expect(city.value).toBe('My draft');
    vi.useFakeTimers(); await act(async () => events.dispatchEvent(new Event('error')));
    await act(async () => vi.advanceTimersByTimeAsync(60_000)); await settle();
    expect(container.querySelector('[name="city"]')).toBe(city); expect(city.value).toBe('My draft');
    crm.getCustomer.mockResolvedValue({...current, city:'Server value', version:2});
    await act(async () => window.dispatchEvent(new Event('focus'))); await settle();
    expect(city.value).toBe('My draft'); expect(button('İletişim bilgilerini kaydet').disabled).toBe(true);
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})));
    expect(crm.enrichCustomer).not.toHaveBeenCalled();
    await act(async () => button('Güncel değerleri yükle').click()); await settle();
    await act(async () => button('Bilgileri tamamla').click());
    expect((container.querySelector('[name="city"]') as HTMLInputElement).value).toBe('Server value');
  });
  it('retains a disabled draft on background capability failure and restores it after scope retry', async () => {
    crm.getCustomer.mockResolvedValue(customer('customer-1', 'Synthetic'));
    crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true});
    await act(async () => root.render(<RealtimeProvider eventSourceFactory={() => null}><Suspense fallback={null}><RouterProvider router={staffRouter()} /></Suspense></RealtimeProvider>));
    await settle(); await act(async () => button('Bilgileri tamamla').click());
    const address = container.querySelector('[name="address"]') as HTMLTextAreaElement; address.value = 'Draft';
    crm.getCustomerEnrichmentScope.mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', 'Busy'));
    await act(async () => window.dispatchEvent(new Event('focus'))); await settle();
    expect(container.querySelector('[name="address"]')).toBe(address); expect(address.value).toBe('Draft'); expect(address.disabled).toBe(true);
    expect(button('İletişim bilgilerini kaydet').disabled).toBe(true);
    await act(async () => button('Yetki kontrolünü tekrar dene').click()); await settle();
    expect(address.value).toBe('Draft'); expect(address.disabled).toBe(false);
  });
  it('does not advance draft version when the editor opens during an in-flight background read', async () => {
    const refresh = deferred<CustomerDetail>(); const current = customer('customer-1', 'Synthetic');
    crm.getCustomer.mockResolvedValueOnce(current).mockReturnValueOnce(refresh.promise);
    crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true});
    await act(async () => root.render(<RealtimeProvider eventSourceFactory={() => null}><Suspense fallback={null}><RouterProvider router={staffRouter()} /></Suspense></RealtimeProvider>));
    await settle(); await act(async () => window.dispatchEvent(new Event('focus'))); await settle();
    await act(async () => button('Bilgileri tamamla').click());
    const city = container.querySelector('[name="city"]') as HTMLInputElement; city.value = 'Draft';
    await act(async () => refresh.resolve({...current, city:'Concurrent update', version:2})); await settle();
    expect(city.value).toBe('Draft'); expect(button('İletişim bilgilerini kaydet').disabled).toBe(true);
    expect(container.textContent).toContain('Sürüm 1');
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})));
    expect(crm.enrichCustomer).not.toHaveBeenCalled();
  });
  it('ignores focus reconciliation during a pending save and rejects an older background response', async () => {
    const current = customer('customer-1', 'Synthetic'); const refresh = deferred<CustomerDetail>(); const save = deferred<CustomerDetail>();
    crm.getCustomer.mockResolvedValueOnce(current).mockReturnValueOnce(refresh.promise);
    crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true}); crm.enrichCustomer.mockReturnValue(save.promise);
    await act(async () => root.render(<RealtimeProvider eventSourceFactory={() => null}><Suspense fallback={null}><RouterProvider router={staffRouter()} /></Suspense></RealtimeProvider>));
    await settle(); await act(async () => button('Bilgileri tamamla').click());
    await act(async () => window.dispatchEvent(new Event('focus'))); await settle();
    (container.querySelector('[name="city"]') as HTMLInputElement).value = 'Saved';
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})));
    await act(async () => window.dispatchEvent(new Event('focus'))); await settle();
    expect(crm.getCustomer).toHaveBeenCalledTimes(2); expect(crm.enrichCustomer).toHaveBeenCalledTimes(1);
    await act(async () => save.resolve({...current,city:'Saved',version:2})); await settle();
    await act(async () => refresh.resolve(current)); await settle();
    expect(container.textContent).toContain('Sürüm 2'); expect(container.textContent).toContain('Saved');
  });
  it('preserves a read-only contact draft on scope failure without enabling a contact mutation', async () => {
    crm.getCustomer.mockResolvedValue(customer('customer-1', 'Synthetic'));
    crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true});
    await act(async () => root.render(<RealtimeProvider eventSourceFactory={() => null}><Suspense fallback={null}><RouterProvider router={staffRouter()} /></Suspense></RealtimeProvider>));
    await settle(); await act(async () => button('İlgili kişi ekle').click());
    const name = container.querySelector('[name="name"]') as HTMLInputElement; name.value = 'Contact draft';
    crm.getCustomerEnrichmentScope.mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', 'Busy'));
    await act(async () => window.dispatchEvent(new Event('focus'))); await settle();
    expect(container.querySelector('[name="name"]')).toBe(name); expect(name.value).toBe('Contact draft'); expect(name.disabled).toBe(true);
    expect(button('İlgili kişiyi ekle').disabled).toBe(true);
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})));
    expect(crm.createEnrichmentContact).not.toHaveBeenCalled();
  });
  it('keeps readable customer details when scope fails and retries only the capability', async () => {
    crm.getCustomer.mockResolvedValue(customer('customer-1', 'Readable clinic'));
    crm.getCustomerEnrichmentScope.mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', 'Busy witness'))
      .mockResolvedValue({canEnrich:true,canCreateContact:true});
    await render(staffRouter()); await settle();
    expect(container.textContent).toContain('Readable clinic');
    expect(container.textContent).not.toContain('Müşteri yüklenemedi');
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).not.toContain('Bilgileri tamamla');
    await act(async () => button('Yetki kontrolünü tekrar dene').click()); await settle();
    expect(button('Bilgileri tamamla')).toBeTruthy();
    expect(crm.getCustomer).toHaveBeenCalledTimes(1);
    expect(crm.getCustomerEnrichmentScope).toHaveBeenCalledTimes(2);
  });
  it('retains the stale enrichment draft, blocks retry and reloads current scope/version explicitly',async()=>{
    const current=customer('customer-1','Synthetic');crm.getCustomer.mockResolvedValueOnce(current).mockResolvedValueOnce({...current,city:'Latest',version:2});
    crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true});crm.enrichCustomer.mockRejectedValue(new ApiError(409,'VERSION_CONFLICT','Changed'));
    await render(staffRouter());await settle();await act(async()=>button('Bilgileri tamamla').click());
    const city=container.querySelector('[name="city"]') as HTMLInputElement;city.value='My draft';
    await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();
    expect(city.value).toBe('My draft');expect(button('İletişim bilgilerini kaydet').disabled).toBe(true);
    await act(async()=>button('Güncel değerleri yükle').click());await settle();await act(async()=>button('Bilgileri tamamla').click());
    expect((container.querySelector('[name="city"]') as HTMLInputElement).value).toBe('Latest');expect(crm.enrichCustomer).toHaveBeenCalledTimes(1);
  });
  it('removes stale mutation affordances after server revokes authorization',async()=>{
    crm.getCustomer.mockResolvedValue(customer('customer-1','Synthetic'));crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true});crm.enrichCustomer.mockRejectedValue(new ApiError(403,'FORBIDDEN','Denied'));
    await render(staffRouter());await settle();await act(async()=>button('Bilgileri tamamla').click());
    await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();
    expect(container.querySelector('form')).toBeNull();expect(container.textContent).not.toContain('Bilgileri tamamla');expect(container.textContent).not.toContain('İlgili kişi ekle');expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });
  it('uses scoped contact creation, preserves primary and binds the next enrichment to the returned version',async()=>{
    const primary=contact('primary','Original primary',true),current={...customer('customer-1','Synthetic'),contacts:[primary],primaryContact:{id:primary.id,name:primary.name,title:primary.title}};
    crm.getCustomer.mockResolvedValue(current);crm.getCustomerEnrichmentScope.mockResolvedValue({canEnrich:true,canCreateContact:true});
    crm.createEnrichmentContact.mockResolvedValue({customer:{...current,version:2},contact:contact('new','New secondary')});crm.enrichCustomer.mockResolvedValue({...current,version:3});
    await render(staffRouter());await settle();await act(async()=>button('İlgili kişi ekle').click());
    (container.querySelector('#new-contact-name') as HTMLInputElement).value='New secondary';
    await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();
    expect(crm.createEnrichmentContact).toHaveBeenCalledWith('customer-1',{expectedVersion:1,name:'New secondary',title:null,phone:null,email:null});expect(crm.createContact).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Original primary');await act(async()=>button('Bilgileri tamamla').click());
    await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();
    expect(crm.enrichCustomer).toHaveBeenCalledWith('customer-1',expect.objectContaining({expectedVersion:2}));
  });

});
