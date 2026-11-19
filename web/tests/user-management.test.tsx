/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserCreateForm, UserListView, UserDetailView, UserDetailScreen } from '../src/UserManagement';
import type { ManagedUser } from '../src/services/people-api';

import { stubDesktopMatchMedia } from './antd-match-media';

stubDesktopMatchMedia();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const people = vi.hoisted(() => ({
  getUser: vi.fn(), activateUser: vi.fn(), deactivateUser: vi.fn(), permanentlyDeleteUser: vi.fn(), createUser: vi.fn(), resetUserPassword: vi.fn(),
}));
vi.mock('../src/services/people-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/people-api')>(),
  getUser: (...args: unknown[]) => people.getUser(...args),
  activateUser: (...args: unknown[]) => people.activateUser(...args),
  deactivateUser: (...args: unknown[]) => people.deactivateUser(...args),
  permanentlyDeleteUser: (...args: unknown[]) => people.permanentlyDeleteUser(...args),
  createUser: (...args: unknown[]) => people.createUser(...args),
  resetUserPassword: (...args: unknown[]) => people.resetUserPassword(...args),
}));

const user: ManagedUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'staff@example.com',
  role: 'STAFF', mustChangePassword: true, isActive: true, version: 1, lastLoginAt: null,
  createdAt: '2026-07-12T08:00:00Z', updatedAt: '2026-07-12T08:00:00Z' };

describe('Admin user management views', () => {
  it('renders a structured user list without credential data or open/lifecycle controls', () => {
    const html = renderToStaticMarkup(<MemoryRouter><UserListView users={[user]} onCreate={() => {}} onOpen={() => {}} /></MemoryRouter>);
    expect(html).toContain('<ul'); expect(html).toContain('Ayşe'); expect(html).toContain('Personel');
    expect(html).toContain('/users/staff-1');
    expect(html).toContain('people-title-link');
    expect(html).not.toContain('Ayrıntıyı aç');
    expect(html).not.toMatch(/password|token|session/i);
  });

  it('renders role-conditioned Staff fields and explicit labels', () => {
    const html = renderToStaticMarkup(<UserCreateForm managers={[]} onCancel={() => {}} onCreated={() => {}} />);
    expect(html).toContain('Yeni kullanıcı'); expect(html).toContain('Geçici parola');
    expect(html).toContain('Unvan'); expect(html).toContain('Bölge'); expect(html).toContain('Yönetici');
  });

  it('keeps security commands separate and exposes the active Staff lifecycle only to Admin', () => {
    const html = renderToStaticMarkup(<UserDetailView viewer={{ id: 'admin-a', organizationId: 'org-1', role: 'ADMIN' }} user={user} onBack={() => {}} onChanged={() => {}} />);
    expect(html).toContain('Temel bilgiler'); expect(html).toContain('Rol ve erişim');
    expect(html).toContain('Geçici parola belirle');
    expect(html).toContain('Personeli devre dışı bırak');
    expect(html).not.toContain('Kullanıcıyı aktifleştir');

    for (const viewerRole of ['MANAGER', 'STAFF'] as const) {
      const hidden = renderToStaticMarkup(<UserDetailView viewer={{ id: 'viewer', organizationId: 'org-1', role: viewerRole }} user={user} onBack={() => {}} onChanged={() => {}} />);
      expect(hidden).not.toContain('Personeli devre dışı bırak');
    }
    const inactive = renderToStaticMarkup(<UserDetailView viewer={{ id: 'admin-a', organizationId: 'org-1', role: 'ADMIN' }} user={{ ...user, isActive: false }} onBack={() => {}} onChanged={() => {}} />);
    expect(inactive).not.toContain('Personeli devre dışı bırak');
  });

  it('shows permanent deletion only for server-confirmed pristine users', () => {
    const eligible = renderToStaticMarkup(<UserDetailView viewer={{ id: 'admin-a', organizationId: 'org-1', role: 'ADMIN' }}
      user={{ ...user, role: 'MANAGER', canPermanentlyDelete: true, permanentDeleteBlockers: [] }}
      onBack={() => {}} onChanged={() => {}} />);
    expect(eligible).toContain('Kalıcı olarak sil');
    expect(eligible).toContain('Bu işlem geri alınamaz');

    const historyBearing = renderToStaticMarkup(<UserDetailView viewer={{ id: 'admin-a', organizationId: 'org-1', role: 'ADMIN' }}
      user={{ ...user, canPermanentlyDelete: false, permanentDeleteBlockers: ['HAS_BUSINESS_HISTORY'] }}
      onBack={() => {}} onChanged={() => {}} />);
    expect(historyBearing).toContain('Operasyon geçmişi ve atıfları korunur');
    expect(historyBearing).not.toMatch(/<button[^>]*>Kalıcı olarak sil<\/button>/);
  });

  it('user create uses page-header and form-actions with Vazgeç before submit and no heading cancel', () => {
    const html = renderToStaticMarkup(<UserCreateForm managers={[]} onCancel={() => {}} onCreated={() => {}} />);
    expect(html).toContain('page-header');
    expect(html).not.toContain('detail-heading');
    const actions = html.match(/form-actions/g);
    expect(actions).toHaveLength(1);
    const vazgecIndex = html.indexOf('Vazgeç');
    const kullaniciOlusturIndex = html.indexOf('Kullanıcıyı oluştur');
    expect(vazgecIndex).toBeGreaterThan(-1);
    expect(kullaniciOlusturIndex).toBeGreaterThan(vazgecIndex);
    // Vazgeç should appear only once (no duplicate in heading)
    const vazgecMatches = html.match(/Vazgeç/g);
    expect(vazgecMatches).toHaveLength(1);
  });
});

describe('temporary password policy', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    people.createUser.mockReset();
    people.resetUserPassword.mockReset();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function fill(input: HTMLInputElement | null, value: string) {
    expect(input).not.toBeNull();
    input!.value = value;
  }

  it('shows the composition hint with 6..128 bounds on both password inputs', () => {
    const create = renderToStaticMarkup(<UserCreateForm managers={[]} onCancel={() => {}} onCreated={() => {}} />);
    expect(create).toContain('6–128 karakter; en az bir büyük harf, bir rakam ve bir sembol.');
    expect(create).toContain('minLength="6"');
    expect(create).toContain('maxLength="128"');
    expect(create).toContain('aria-describedby="temporary-password-hint"');
    const detail = renderToStaticMarkup(<UserDetailView viewer={{ id: 'admin-a', organizationId: 'org-1', role: 'ADMIN' }} user={user} onBack={() => {}} onChanged={() => {}} />);
    expect(detail).toContain('6–128 karakter; en az bir büyük harf, bir rakam ve bir sembol.');
    expect(detail).toContain('aria-describedby="reset-password-hint"');
  });

  it('rejects a non-compliant temporary password before creating the user', async () => {
    const onCreated = vi.fn();
    await act(async () => root.render(<MemoryRouter><UserCreateForm managers={[]} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    fill(container.querySelector('#user-name'), 'Yeni Personel');
    fill(container.querySelector('#user-email'), 'yeni@example.com');
    fill(container.querySelector('#temporary-password'), 'Server1');
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('en az bir sembol');
    expect(people.createUser).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('creates the user with a compliant temporary password', async () => {
    const onCreated = vi.fn();
    people.createUser.mockResolvedValue({ ...user, name: 'Yeni Personel' });
    await act(async () => root.render(<MemoryRouter><UserCreateForm managers={[]} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    fill(container.querySelector('#user-name'), 'Yeni Personel');
    fill(container.querySelector('#user-email'), 'yeni@example.com');
    fill(container.querySelector('#temporary-password'), 'Serv1!');
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(people.createUser).toHaveBeenCalledWith(expect.objectContaining({ temporaryPassword: 'Serv1!' }));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-compliant reset password without calling the API', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => root.render(<MemoryRouter><UserDetailView viewer={{ id: 'admin-a', organizationId: 'org-1', role: 'ADMIN' }} user={user}
      onBack={() => {}} onChanged={() => {}} /></MemoryRouter>));
    fill(container.querySelector('#reset-password'), 'Server1');
    const forms = Array.from(container.querySelectorAll('form'));
    const resetForm = forms.find((form) => form.querySelector('#reset-password'))!;
    await act(async () => {
      resetForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('en az bir sembol');
    expect(people.resetUserPassword).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe('User list card interaction', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('opens detail from empty card area and keeps title link as the only keyboard target', async () => {
    const onOpen = vi.fn();
    await act(async () => root.render(
      <MemoryRouter>
        <UserListView users={[user]} onCreate={() => {}} onOpen={onOpen} />
      </MemoryRouter>,
    ));
    const card = container.querySelector('.people-list-card') as HTMLElement;
    const title = container.querySelector('.people-title-link') as HTMLAnchorElement;
    expect(title.getAttribute('href')).toBe('/users/staff-1');
    expect(card.getAttribute('tabindex')).toBeNull();
    expect(card.getAttribute('role')).toBeNull();

    await act(async () => card.click());
    expect(onOpen).toHaveBeenCalledWith('staff-1');

    onOpen.mockClear();
    await act(async () => title.click());
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('User detail route race protection', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    people.getUser.mockReset();
    people.permanentlyDeleteUser.mockReset();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('ignores a late response for a previous user id', async () => {
    let resolveFirst!: (value: ManagedUser) => void;
    let resolveSecond!: (value: ManagedUser) => void;
    people.getUser
      .mockImplementationOnce(() => new Promise<ManagedUser>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<ManagedUser>((resolve) => { resolveSecond = resolve; }));

    const router = createMemoryRouter([
      { path: '/users/:userId', element: <UserDetailScreen viewer={{ id: 'admin-a', organizationId: 'org-1', role: 'ADMIN' }} /> },
    ], { initialEntries: ['/users/user-a'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => { await router.navigate('/users/user-b'); });
    await act(async () => {
      resolveSecond({ ...user, id: 'user-b', name: 'Bora' });
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Bora');
    await act(async () => {
      resolveFirst({ ...user, id: 'user-a', name: 'Ayşe' });
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Bora');
    expect(container.textContent).not.toContain('Ayşe');
  });

  it('confirms and completes a pristine-user permanent deletion', async () => {
    const onDeleted = vi.fn();
    people.permanentlyDeleteUser.mockResolvedValue(undefined);
    const eligible = { ...user, role: 'MANAGER' as const, canPermanentlyDelete: true as const, permanentDeleteBlockers: [] as const };
    await act(async () => root.render(<MemoryRouter><UserDetailView viewer={{ id: 'admin-a', organizationId: 'org-1', role: 'ADMIN' }} user={eligible}
      onBack={() => {}} onChanged={() => {}} onDeleted={onDeleted} /></MemoryRouter>));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('Kalıcı olarak sil')) as HTMLButtonElement;
    expect(button).toBeDefined();
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('geri alınamaz'));
    expect(people.permanentlyDeleteUser).toHaveBeenCalledWith('staff-1', 1);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });
});

describe('User status filter and activation commands', () => {
  let container: HTMLDivElement;
  let root: Root;
  const admin = { id: 'admin-a', organizationId: 'org-1', role: 'ADMIN' } as const;
  const manager: ManagedUser = { ...user, id: 'manager-1', name: 'Murat', email: 'manager@example.com', role: 'MANAGER' };
  const inactiveStaff: ManagedUser = { ...user, id: 'staff-2', name: 'Bora Ayrılan', isActive: false };
  const inactiveManager: ManagedUser = { ...manager, id: 'manager-2', name: 'Pasif Yönetici', isActive: false };
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    people.activateUser.mockReset(); people.deactivateUser.mockReset();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    container.remove();
  });
  const tab = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((el) => el.textContent === label)!;
  const button = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((el) => el.textContent === label);
  const names = () => Array.from(container.querySelectorAll('.people-title-link')).map((el) => el.textContent);
  const renderDetail = (target: ManagedUser, viewer: { id: string; organizationId: string; role: 'ADMIN' | 'MANAGER' | 'STAFF' } = admin) =>
    act(async () => root.render(<MemoryRouter><UserDetailView key={target.id + viewer.role} viewer={viewer} user={target} onChanged={() => {}} /></MemoryRouter>));

  it('defaults to active users and reveals inactive users through Pasif and Tümü', async () => {
    await act(async () => root.render(<MemoryRouter><UserListView users={[user, manager, inactiveStaff, inactiveManager]} onCreate={() => {}} onOpen={() => {}} /></MemoryRouter>));
    expect(tab('Aktif').getAttribute('aria-selected')).toBe('true');
    expect(names()).toEqual(['Ayşe', 'Murat']);
    await act(async () => tab('Pasif').click());
    expect(tab('Pasif').getAttribute('aria-selected')).toBe('true');
    expect(names()).toEqual(['Bora Ayrılan', 'Pasif Yönetici']);
    expect(container.textContent).toContain('· Pasif');
    expect(container.textContent).not.toContain('Devre dışı');
    await act(async () => tab('Tümü').click());
    expect(names()).toHaveLength(4);
  });

  it('uses empty-state copy that matches the selected filter', async () => {
    await act(async () => root.render(<MemoryRouter><UserListView users={[user]} onCreate={() => {}} onOpen={() => {}} /></MemoryRouter>));
    await act(async () => tab('Pasif').click());
    expect(container.textContent).toContain('Pasif kullanıcı yok');
    await act(async () => root.render(<MemoryRouter><UserListView users={[inactiveStaff]} onCreate={() => {}} onOpen={() => {}} /></MemoryRouter>));
    await act(async () => tab('Aktif').click());
    expect(container.textContent).toContain('Aktif kullanıcı yok');
  });

  it('deactivates an active Manager only after owned confirmation using the expected version', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    people.deactivateUser.mockResolvedValue({ ...manager, isActive: false, version: 4 });
    await renderDetail({ ...manager, version: 3 });
    await act(async () => button('Devre dışı bırak')!.click());
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(people.deactivateUser).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[role="dialog"] .destructive-button')!.click());
    expect(people.deactivateUser).toHaveBeenCalledWith('manager-1', 3);
    expect(container.textContent).toContain('Kullanıcı devre dışı bırakıldı.');
    expect(button('Yeniden etkinleştir')).toBeDefined();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('cancels deactivation without writing and hides self-deactivation', async () => {
    await renderDetail(manager);
    await act(async () => button('Devre dışı bırak')!.click());
    expect(people.deactivateUser).not.toHaveBeenCalled();
    await act(async () => button('Vazgeç')!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(people.deactivateUser).not.toHaveBeenCalled();
    await renderDetail({ ...manager, id: admin.id, role: 'ADMIN' });
    expect(button('Devre dışı bırak')).toBeUndefined();
  });

  it('prevents duplicate pending deactivations and restores focus', async () => {
    let finish!: (value: ManagedUser) => void;
    people.deactivateUser.mockImplementation(() => new Promise<ManagedUser>((resolve) => { finish = resolve; }));
    await renderDetail({ ...manager, version: 3 });
    await act(async () => button('Devre dışı bırak')!.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => dialog.querySelector<HTMLButtonElement>('.destructive-button')!.click());
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(dialog.querySelector<HTMLButtonElement>('.destructive-button')!.disabled).toBe(true);
    await act(async () => dialog.querySelector<HTMLButtonElement>('.destructive-button')!.click());
    expect(people.deactivateUser).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ...manager, isActive: false, version: 4 }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(container.querySelector('#detail-name'));
  });

  it('reactivates an inactive Manager and surfaces backend errors', async () => {
    people.activateUser.mockRejectedValueOnce(new Error('Sürüm çakışması'));
    await renderDetail({ ...inactiveManager, version: 4 });
    expect(button('Devre dışı bırak')).toBeUndefined();
    await act(async () => button('Yeniden etkinleştir')!.click());
    expect(people.activateUser).toHaveBeenCalledWith('manager-2', 4);
    expect(container.textContent).toContain('Sürüm çakışması');
    people.activateUser.mockResolvedValueOnce({ ...inactiveManager, isActive: true, version: 5 });
    await act(async () => button('Yeniden etkinleştir')!.click());
    expect(container.textContent).toContain('Kullanıcı yeniden etkinleştirildi.');
  });

  it('shows a notice and no reactivate command for an inactive Staff user', async () => {
    await renderDetail(inactiveStaff);
    expect(container.querySelector('.lifecycle-notice')?.textContent).toContain('yeniden etkinleştirilemez');
    expect(button('Yeniden etkinleştir')).toBeUndefined();
    expect(button('Devre dışı bırak')).toBeUndefined();
  });

  it('offers no activation commands to non-Admin viewers', async () => {
    await renderDetail(manager, { id: 'm-viewer', organizationId: 'org-1', role: 'MANAGER' });
    expect(button('Devre dışı bırak')).toBeUndefined();
    await renderDetail(inactiveManager, { id: 'm-viewer', organizationId: 'org-1', role: 'MANAGER' });
    expect(button('Yeniden etkinleştir')).toBeUndefined();
  });

  it('uses six-row pagination and resets to page one when the status filter changes', async () => {
    const manyActive = Array.from({ length: 8 }, (_, index) => ({
      ...user, id: `active-${index}`, name: `Aktif ${index}`,
    }));
    await act(async () => root.render(<MemoryRouter><UserListView users={[...manyActive, inactiveManager]} onCreate={() => {}} onOpen={() => {}} /></MemoryRouter>));
    expect(names()).toHaveLength(6);
    expect(container.textContent).toContain('Sayfa 1 / 2');
    // Ant 6.7 moved activation to the nested full-size button.
    await act(async () => container.querySelector<HTMLElement>('[class*="pagination-next"] button')!.click());
    expect(names()).toHaveLength(2);
    expect(container.textContent).toContain('Sayfa 2 / 2');
    await act(async () => tab('Pasif').click());
    expect(names()).toEqual(['Pasif Yönetici']);
    expect(container.querySelector('.servora-list-pagination')).toBeNull();
    await act(async () => tab('Aktif').click());
    expect(names()).toHaveLength(6);
    expect(names()[0]).toBe('Aktif 0');
  });

  it('locks repeated reactivation clicks until the first request completes', async () => {
    let complete!: (value: ManagedUser) => void;
    people.activateUser.mockImplementation(() => new Promise<ManagedUser>((resolve) => { complete = resolve; }));
    await renderDetail({ ...inactiveManager, version: 4 });
    await act(async () => button('Yeniden etkinleştir')!.click());
    const pending = button('Yeniden etkinleştir')!;
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute('aria-busy')).toBe('true');
    await act(async () => pending.click());
    expect(people.activateUser).toHaveBeenCalledTimes(1);
    await act(async () => complete({ ...inactiveManager, isActive: true, version: 5 }));
    expect(button('Devre dışı bırak')).toBeDefined();
  });

});
