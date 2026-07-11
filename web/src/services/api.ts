export type UserRole = 'ADMIN' | 'MANAGER' | 'STAFF';

export type CurrentUser = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: UserRole;
  mustChangePassword: boolean;
};

type ErrorBody = { error?: string };

async function readError(response: Response) {
  try {
    const body = await response.json() as ErrorBody;
    return body.error || 'İşlem tamamlanamadı. Lütfen tekrar deneyin.';
  } catch {
    return 'İşlem tamamlanamadı. Lütfen tekrar deneyin.';
  }
}

async function authRequest(path: string, init: RequestInit = {}) {
  return fetch(path, { ...init, credentials: 'include' });
}

export async function login(credentials: { email: string; password: string }) {
  const response = await authRequest('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { user: CurrentUser };
  return body.user;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const response = await authRequest('/api/auth/me');
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { user: CurrentUser };
  return body.user;
}

export async function logout(): Promise<void> {
  const response = await authRequest('/api/auth/logout', { method: 'POST' });
  if (!response.ok) throw new Error(await readError(response));
}
