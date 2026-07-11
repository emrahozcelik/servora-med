import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCurrentUser, login, logout } from '../src/services/api';

const user = {
  id: 'user-1', organizationId: 'org-1', name: 'Emrah Admin',
  email: 'admin@example.com', role: 'ADMIN' as const, mustChangePassword: false,
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
