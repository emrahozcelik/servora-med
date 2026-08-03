import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCurrentUser, login, logout } from '../src/services/api';

const user = {
  id: 'user-1', organizationId: 'org-1', name: 'Emrah Admin',
  email: 'admin@example.com', role: 'ADMIN' as const, mustChangePassword: false,
  isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: false, messaging: false },
  support: { displayLabel: 'Operasyon desteği', email: null, helpUrl: null },
};

afterEach(() => vi.unstubAllGlobals());

describe('auth API client', () => {
  it('logs in with JSON and included credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(login({ email: 'admin@example.com', password: 'secret-password' })).resolves.toEqual(user);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST', credentials: 'include',
      body: JSON.stringify({ email: 'admin@example.com', password: 'secret-password' }),
    }));
  });

  it('returns null when the current session is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it('parses the organization timezone when present and tolerates its absence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      user: { ...user, organizationTimeZone: 'Europe/Istanbul' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(getCurrentUser()).resolves.toMatchObject({ organizationTimeZone: 'Europe/Istanbul' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      user: { ...user, organizationTimeZone: '  ' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(getCurrentUser()).resolves.toMatchObject({ organizationTimeZone: undefined });
  });

  it('handles a legacy missing capability payload fail-closed', async () => {
    const { capabilities: _capabilities, support: _support, ...legacyUser } = user;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      user: legacyUser,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(getCurrentUser()).resolves.toMatchObject({
      capabilities: {
        overviewDashboard: false,
        calendar: false,
        messaging: false,
      },
    });
  });

  it('fails unsafe optional support links and mailto values closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      user: {
        ...user,
        support: {
          displayLabel: '',
          email: 'support?subject=unsafe@example.test',
          helpUrl: 'https://user:secret@support.example.test',
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(getCurrentUser()).resolves.toMatchObject({
      support: {
        displayLabel: 'Sistem yöneticiniz',
        email: null,
        helpUrl: null,
      },
    });
  });

  it('uses included credentials for logout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await logout();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
      method: 'POST', credentials: 'include',
    }));
  });

  it('surfaces the safe server error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'E-posta veya parola hatalı.', code: 'INVALID_CREDENTIALS',
    }), { status: 401, headers: { 'content-type': 'application/json' } })));
    await expect(login({ email: 'a@b.co', password: 'wrong-password' }))
      .rejects.toThrow('E-posta veya parola hatalı.');
  });
});
