import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  changeUserRole, createUser, executeStaffOffboarding, getOwnStaffProfile, listOwnStaffJobs, listStaff, listStaffJobs, listUsers,
  previewStaffOffboarding, resetUserPassword, updateStaffProfile,
} from '../src/services/people-api';

afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'staff@example.com',
  role: 'STAFF', mustChangePassword: true, isActive: true, version: 1, lastLoginAt: null,
  createdAt: '2026-07-12T08:00:00Z', updatedAt: '2026-07-12T08:00:00Z' };
const profile = { id: 'profile-1', user, title: null, phone: null, region: null, managerUserId: null,
  managerName: null, version: 1, counters: { open: 1, waitingApproval: 2, revisionRequested: 3, completedThisMonth: 4, overdue: 5 } };

describe('People API client', () => {
  it('parses the exact Staff offboarding preview and execute contracts', async () => {
    const preview = {
      target: { id: 'staff/1', organizationId: 'org-1', role: 'STAFF', isActive: true, version: 4 },
      jobs: [{ id: 'job-1', status: 'IN_PROGRESS', version: 2, assignedTo: 'staff/1' }],
      customers: [{ id: 'customer-1', assignedStaffUserId: 'staff/1', version: 3 }],
      calendar: [{ id: 'event-1', assignedUserId: 'staff/1', status: 'ACTIVE', version: 2,
        startsAt: '2026-09-01T08:00:00.000Z', endsAt: '2026-09-01T09:00:00.000Z' }],
      followUps: [{ jobCardId: 'job-2', proposedAssignee: 'staff/1', proposedAt: '2026-09-02T08:00:00.000Z', version: 5 }],
      reminders: [{ id: 'reminder-1', recipientUserId: 'staff/1', state: 'PENDING',
        remindAt: '2026-09-01T07:45:00.000Z', nextAttemptAt: '2026-09-01T07:45:00.000Z' }],
      jobConversations: [{ jobCardId: 'job-1', conversationId: 'conversation-1' }],
      sessions: { activeCount: 2 },
      planHash: 'a'.repeat(64),
    };
    const request = {
      clientActionId: 'r4b-action-1', planHash: preview.planHash, reasonCode: 'ACCESS_ENDED' as const,
      jobDecisions: [{ jobCardId: 'job-1', replacementUserId: 'staff-2' }],
      calendarDecisions: [{ calendarEventId: 'event-1', replacementUserId: 'staff-2' }],
      followUpDecisions: [{ jobCardId: 'job-2', replacementUserId: 'staff-2' }],
      customerDecisions: [{ customerId: 'customer-1', action: 'UNASSIGN' as const }],
      reminderDecisions: [{ reminderId: 'reminder-1', action: 'CANCEL' as const }],
    };
    const response = { status: 'OFFBOARDED', targetUserId: 'staff/1', planHash: preview.planHash,
      summary: { jobCardsTransferred: 1, customersReassigned: 0, customersUnassigned: 1,
        calendarAssignmentsTransferred: 1, followUpAssignmentsTransferred: 1, remindersHandled: 1 } };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(json(response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(previewStaffOffboarding('staff/1')).resolves.toEqual(preview);
    await expect(executeStaffOffboarding('staff/1', request)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/users/staff%2F1/offboarding/preview', expect.objectContaining({
      method: 'POST', body: JSON.stringify({}), credentials: 'include',
      headers: { 'content-type': 'application/json' },
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/users/staff%2F1/offboarding/execute', expect.objectContaining({
      method: 'POST', body: JSON.stringify(request), credentials: 'include',
    }));
  });

  it('rejects semantically malformed Staff offboarding success responses', async () => {
    const malformed = { status: 'OFFBOARDED', targetUserId: 'another-staff', planHash: 'b'.repeat(64),
      summary: { jobCardsTransferred: -1, customersReassigned: 0, customersUnassigned: 0,
        calendarAssignmentsTransferred: 0, followUpAssignmentsTransferred: 0, remindersHandled: 0 } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(malformed)));

    await expect(executeStaffOffboarding('staff-1', {
      clientActionId: 'r4b-action-2', planHash: 'a'.repeat(64), reasonCode: 'ACCESS_ENDED',
      jobDecisions: [], calendarDecisions: [], followUpDecisions: [], customerDecisions: [], reminderDecisions: [],
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('fetches own and managed Staff history through the role-scoped routes', async () => {
    const history = { items: [], total: 0, limit: 20, offset: 0 };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(history)));
    vi.stubGlobal('fetch', fetchMock);
    await listOwnStaffJobs({ status: 'open', limit: 20, offset: 0 });
    await listStaffJobs('staff/1', { status: 'all' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/staff/me/jobs?status=open&limit=20&offset=0',
      '/api/staff/staff%2F1/jobs?status=all',
    ]);
  });
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
