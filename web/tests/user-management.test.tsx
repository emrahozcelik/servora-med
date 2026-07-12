import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { UserCreateForm, UserListView, UserDetailView } from '../src/UserManagement';
import type { ManagedUser } from '../src/services/people-api';

const user: ManagedUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'staff@example.com',
  role: 'STAFF', mustChangePassword: true, isActive: true, version: 1, lastLoginAt: null,
  createdAt: '2026-07-12T08:00:00Z', updatedAt: '2026-07-12T08:00:00Z' };

describe('Admin user management views', () => {
  it('renders a structured user list without credential data', () => {
    const html = renderToStaticMarkup(<UserListView users={[user]} onCreate={() => {}} onOpen={() => {}} />);
    expect(html).toContain('<ul'); expect(html).toContain('Ayşe'); expect(html).toContain('Personel');
    expect(html).toContain('Aktif'); expect(html).not.toMatch(/password|token|session/i);
  });

  it('renders role-conditioned Staff fields and explicit labels', () => {
    const html = renderToStaticMarkup(<UserCreateForm managers={[]} onCancel={() => {}} onCreated={() => {}} />);
    expect(html).toContain('Kullanıcı oluştur'); expect(html).toContain('Geçici parola');
    expect(html).toContain('Unvan'); expect(html).toContain('Bölge'); expect(html).toContain('Yönetici');
  });

  it('keeps security commands separate from the name form', () => {
    const html = renderToStaticMarkup(<UserDetailView user={user} onBack={() => {}} onChanged={() => {}} />);
    expect(html).toContain('Temel bilgiler'); expect(html).toContain('Rol ve erişim');
    expect(html).toContain('Geçici parola belirle'); expect(html).toContain('Kullanıcıyı pasifleştir');
  });
});
