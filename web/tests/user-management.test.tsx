/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserCreateForm, UserListView, UserDetailView, UserDetailScreen } from '../src/UserManagement';
import type { ManagedUser } from '../src/services/people-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const people = vi.hoisted(() => ({
  getUser: vi.fn(), permanentlyDeleteUser: vi.fn(), createUser: vi.fn(), resetUserPassword: vi.fn(),
}));
vi.mock('../src/services/people-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/people-api')>(),
  getUser: (...args: unknown[]) => people.getUser(...args),
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
    expect(html).not.toContain('Aktif'); expect(html).not.toContain('Pasif');
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
