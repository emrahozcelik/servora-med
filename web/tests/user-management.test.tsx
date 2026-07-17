/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserCreateForm, UserListView, UserDetailView, UserDetailScreen } from '../src/UserManagement';
import type { ManagedUser } from '../src/services/people-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const people = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('../src/services/people-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/people-api')>(),
  getUser: (...args: unknown[]) => people.getUser(...args),
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
    expect(html).toContain('Kullanıcı oluştur'); expect(html).toContain('Geçici parola');
    expect(html).toContain('Unvan'); expect(html).toContain('Bölge'); expect(html).toContain('Yönetici');
  });

  it('keeps security commands separate from the name form without lifecycle actions', () => {
    const html = renderToStaticMarkup(<UserDetailView user={user} onBack={() => {}} onChanged={() => {}} />);
    expect(html).toContain('Temel bilgiler'); expect(html).toContain('Rol ve erişim');
    expect(html).toContain('Geçici parola belirle');
    expect(html).not.toContain('Kullanıcıyı pasifleştir');
    expect(html).not.toContain('Kullanıcıyı aktifleştir');
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
      { path: '/users/:userId', element: <UserDetailScreen /> },
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
});
