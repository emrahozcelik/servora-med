import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  changeUserRole, createUser, getOwnStaffProfile, listStaff, listUsers,
  resetUserPassword, updateStaffProfile,
} from '../src/services/people-api';

afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'staff@example.com',
  role: 'STAFF', mustChangePassword: true, isActive: true, version: 1, lastLoginAt: null,
  createdAt: '2026-07-12T08:00:00Z', updatedAt: '2026-07-12T08:00:00Z' };
const profile = { id: 'profile-1', user, title: null, phone: null, region: null, managerUserId: null,
  managerName: null, version: 1, counters: { open: 1, waitingApproval: 2, revisionRequested: 3, completedThisMonth: 4, overdue: 5 } };

describe('People API client', () => {
  it('parses user and Staff responses with included credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json([user])).mockResolvedValueOnce(json([profile])).mockResolvedValueOnce(json(profile));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listUsers()).resolves.toEqual([user]);
    await expect(listStaff('active')).resolves.toEqual([profile]);
    await expect(getOwnStaffProfile()).resolves.toEqual(profile);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/staff?status=active', expect.objectContaining({ credentials: 'include' }));
  });

  it('uses named command endpoints and exact request bodies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ...user, version: 2 }))
      .mockResolvedValueOnce(json({ ...user, version: 3 }));
    vi.stubGlobal('fetch', fetchMock);
    await changeUserRole('staff-1', { expectedVersion: 1, role: 'MANAGER' });
    await resetUserPassword('staff-1', { expectedVersion: 2, temporaryPassword: 'temporary-password' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/users/staff-1/change-role', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/users/staff-1/reset-password', expect.objectContaining({ body: JSON.stringify({ expectedVersion: 2, temporaryPassword: 'temporary-password' }) }));
  });

  it('sends Staff creation and versioned profile update', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(user, 201)).mockResolvedValueOnce(json({ ...profile, version: 2 })); vi.stubGlobal('fetch', fetchMock);
    const input = { name: 'Ayşe', email: 'staff@example.com', role: 'STAFF' as const, temporaryPassword: 'temporary-password',
      staffProfile: { title: null, phone: null, region: null, managerUserId: null } };
    await createUser(input);
    await updateStaffProfile('staff-1', { expectedVersion: 1, title: 'Uzman', phone: null, region: null, managerUserId: null });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/users', expect.objectContaining({ body: JSON.stringify(input) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/staff/staff-1', expect.objectContaining({ method: 'PATCH' }));
  });

  it('rejects malformed People responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([{ id: 'broken' }])));
    await expect(listUsers()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
