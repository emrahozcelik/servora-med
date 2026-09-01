/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomerCreateSideFlow } from '../src/CustomerCreateSideFlow';
import { CustomerCreateForm } from '../src/CustomerList';
import { ResponsiveFormDrawer } from '../src/ui/antd/ResponsiveFormDrawer';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const crm = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  createContact: vi.fn(),
  listCustomers: vi.fn(),
}));

vi.mock('../src/services/crm-api', async (original) => ({
  ...await original<typeof import('../src/services/crm-api')>(),
  ...crm,
}));

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'staff@test.local',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const createdCustomer = {
  id: 'customer-created', organizationId: 'org-1', name: 'Yeni Klinik', customerType: 'clinic' as const,
  taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
  assignedStaffUserId: null, status: 'prospect' as const, version: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function changeName(host: HTMLElement, value: string) {
  const input = host.querySelector('#customer-name') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CustomerCreateSideFlow dismiss and stale-attempt protection', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    crm.listCustomers.mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    crm.createContact.mockResolvedValue({});
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  function render(open: boolean, onCancel = vi.fn(), onCreated = vi.fn()) {
    act(() => {
      root.render(<MemoryRouter><CustomerCreateSideFlow
        open={open}
        user={staff}
        onCancel={onCancel}
        onCreated={onCreated}
      /></MemoryRouter>);
    });
    return { onCancel, onCreated };
  }

  it('locks Escape, backdrop, and close/X while a Customer POST is pending', async () => {
    const request = deferred<typeof createdCustomer>();
    crm.createCustomer.mockReturnValue(request.promise);
    const { onCancel, onCreated } = render(true);
    await settle();
    changeName(host, 'Yeni Klinik');
    await act(async () => (host.querySelector('.customer-form') as HTMLFormElement).requestSubmit());

    const drawer = host.querySelector<HTMLElement>('[data-servora-form-drawer="true"]')!;
    const panel = drawer.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      (drawer.querySelector('.form-drawer-backdrop') as HTMLButtonElement).click();
      (drawer.querySelector('.form-drawer-header button') as HTMLButtonElement).click();
    });

    expect(onCancel).not.toHaveBeenCalled();
    expect((drawer.querySelector('.form-drawer-backdrop') as HTMLButtonElement).disabled).toBe(true);
    expect((drawer.querySelector('.form-drawer-header button') as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('[data-servora-form-drawer="true"]')).not.toBeNull();
    expect(crm.createCustomer).toHaveBeenCalledTimes(1);

    await act(async () => request.resolve(createdCustomer));
    await settle();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(createdCustomer);
  });

  it('drops a late result from an obsolete flow and permits one intentional submit after reopen', async () => {
    const oldRequest = deferred<typeof createdCustomer>();
    crm.createCustomer.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce(createdCustomer);
    const onCancel = vi.fn();
    const onCreated = vi.fn();

    render(true, onCancel, onCreated);
    await settle();
    changeName(host, 'Eski deneme');
    await act(async () => (host.querySelector('.customer-form') as HTMLFormElement).requestSubmit());
    expect(crm.createCustomer).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<MemoryRouter><CustomerCreateSideFlow
      open={false} user={staff} onCancel={onCancel} onCreated={onCreated}
    /></MemoryRouter>));
    await act(async () => oldRequest.resolve(createdCustomer));
    await settle();
    expect(onCreated).not.toHaveBeenCalled();

    await act(async () => root.render(<MemoryRouter><CustomerCreateSideFlow
      open user={staff} onCancel={onCancel} onCreated={onCreated}
    /></MemoryRouter>));
    await settle();
    changeName(host, 'Yeni deneme');
    await act(async () => (host.querySelector('.customer-form') as HTMLFormElement).requestSubmit());
    await settle();

    expect(crm.createCustomer).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(createdCustomer);
  });

  it('uses an embedded selection action for partial Contact success', async () => {
    const onCreated = vi.fn();
    await act(async () => root.render(<MemoryRouter><CustomerCreateForm
      staff={[]}
      pending={false}
      similarCustomers={[]}
      contactNotice="Müşteri oluşturuldu ancak iletişim kişisi eklenemedi."
      contactNoticeCustomerId={createdCustomer.id}
      onOpenCreatedCustomer={onCreated}
      onCancel={() => {}}
      onSubmit={() => {}}
      embedded
    /></MemoryRouter>));

    const action = Array.from(host.querySelectorAll('button')).find((button) => (
      button.textContent === 'Müşteriyi seç'
    )) as HTMLButtonElement | undefined;
    expect(action).toBeTruthy();
    expect(host.textContent).not.toContain('Müşteri detayına git');
    await act(async () => action?.click());
    expect(onCreated).toHaveBeenCalledWith(createdCustomer.id);
  });
});

describe('ResponsiveFormDrawer dismiss contract', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('keeps default dismiss behavior for existing consumers', async () => {
    const onDismiss = vi.fn();
    await act(async () => root.render(<ResponsiveFormDrawer open title="Filtre" onDismiss={onDismiss}>
      <button type="button">İçerik</button>
    </ResponsiveFormDrawer>));
    const panel = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('blocks all dismiss paths when dismiss protection is enabled', async () => {
    const onDismiss = vi.fn();
    await act(async () => root.render(<ResponsiveFormDrawer open title="Müşteri" onDismiss={onDismiss} dismissDisabled>
      <button type="button">İçerik</button>
    </ResponsiveFormDrawer>));
    const drawer = host.querySelector<HTMLElement>('[data-servora-form-drawer="true"]')!;
    const panel = drawer.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      (drawer.querySelector('.form-drawer-backdrop') as HTMLButtonElement).click();
      (drawer.querySelector('.form-drawer-header button') as HTMLButtonElement).click();
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect((drawer.querySelector('.form-drawer-backdrop') as HTMLButtonElement).disabled).toBe(true);
    expect((drawer.querySelector('.form-drawer-header button') as HTMLButtonElement).disabled).toBe(true);
  });
});
