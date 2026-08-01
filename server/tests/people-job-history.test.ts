import { describe, expect, it, vi } from 'vitest';

import { PeopleService } from '../src/modules/people/service.js';
import type { PaginatedJobHistory } from '../src/modules/job-cards/history-port.js';

const manager = {
  id: 'manager-1', organizationId: 'org-1', name: 'Manager', email: 'manager@example.test',
  role: 'MANAGER' as const, mustChangePassword: false, isActive: true, version: 1,
};
const staff = { ...manager, id: 'staff-1', name: 'Staff', email: 'staff@example.test', role: 'STAFF' as const };
const page = (total: number): PaginatedJobHistory => ({ items: [], total, limit: 20, offset: 0 });

const repository = {
  getStaffProfile: vi.fn().mockResolvedValue({ id: 'profile-1' }),
};
const credentials = { validatePassword: vi.fn(), hashPassword: vi.fn() };
const summaries = { getOne: vi.fn(), getMany: vi.fn() };

describe('PeopleService JobCard history integration', () => {
  it('delegates /me history to the authenticated Staff scope', async () => {
    const history = { listCustomerJobHistory: vi.fn(), listStaffJobHistory: vi.fn().mockResolvedValue(page(2)) };
    const service = new PeopleService(repository as never, credentials, summaries, history);
    await expect(service.listOwnStaffJobHistory(staff, {
      status: 'open', type: 'GENERAL_TASK', limit: 10, offset: 20,
    })).resolves.toMatchObject({ total: 2 });
    expect(history.listStaffJobHistory).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({ id: staff.id, organizationId: staff.organizationId, role: staff.role }),
      targetUserId: 'staff-1', status: 'open', type: 'GENERAL_TASK', limit: 10, offset: 20,
    }));
  });

  it('conceals parameterized Staff history targets and allows management targets', async () => {
    const history = { listCustomerJobHistory: vi.fn(), listStaffJobHistory: vi.fn().mockResolvedValue(page(3)) };
    const service = new PeopleService(repository as never, credentials, summaries, history);
    await expect(service.listStaffJobHistory(staff, 'staff-2', {
      status: 'all', type: undefined, limit: 20, offset: 0,
    })).rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });
    await expect(service.listStaffJobHistory(staff, 'missing', {
      status: 'all', type: undefined, limit: 20, offset: 0,
    })).rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });
    await expect(service.listStaffJobHistory(manager, 'staff-2', {
      status: 'completed', type: undefined, limit: 20, offset: 0,
    })).resolves.toMatchObject({ total: 3 });
    expect(repository.getStaffProfile).toHaveBeenCalledWith('org-1', 'staff-2');
  });

  it('conceals missing profiles and keeps the optional port unavailable without wiring', async () => {
    const history = { listCustomerJobHistory: vi.fn(), listStaffJobHistory: vi.fn() };
    const service = new PeopleService(repository as never, credentials, summaries, history);
    repository.getStaffProfile.mockResolvedValueOnce(null);
    await expect(service.listStaffJobHistory(manager, 'missing', {
      status: 'all', type: undefined, limit: 20, offset: 0,
    })).rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });
    const withoutPort = new PeopleService(repository as never, credentials, summaries);
    await expect(withoutPort.listOwnStaffJobHistory(staff, {
      status: 'all', type: undefined, limit: 20, offset: 0,
    })).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE', statusCode: 404 });
  });
});
