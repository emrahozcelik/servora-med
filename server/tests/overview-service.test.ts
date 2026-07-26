import { describe, expect, it, vi } from 'vitest';

import { OverviewService } from '../src/modules/overview/service.js';

const staff = {
  id: 'staff-1',
  organizationId: 'org-1',
  name: 'Ayşe Personel',
  email: 'ayse@example.test',
  role: 'STAFF' as const,
  mustChangePassword: false,
  isActive: true,
  version: 1,
};

describe('OverviewService', () => {
  it('fails closed without reading overview data when the capability is disabled', async () => {
    const repository = {
      getStaffOverview: vi.fn(),
      getManagementOverview: vi.fn(),
    };
    const service = new OverviewService(false, repository);

    await expect(service.getOverview(staff, { requestedRange: null }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(repository.getStaffOverview).not.toHaveBeenCalled();
    expect(repository.getManagementOverview).not.toHaveBeenCalled();
  });

  it('selects only the Staff read model for Staff', async () => {
    const repository = {
      getStaffOverview: vi.fn().mockResolvedValue({ scope: 'staff' }),
      getManagementOverview: vi.fn(),
    };
    const now = new Date('2026-07-26T08:00:00.000Z');
    const service = new OverviewService(true, repository as never, () => now);
    await expect(service.getOverview(staff, { requestedRange: null }))
      .resolves.toMatchObject({ scope: 'staff' });
    expect(repository.getStaffOverview).toHaveBeenCalledWith(
      staff,
      { requestedRange: null },
      now,
    );
    expect(repository.getManagementOverview).not.toHaveBeenCalled();
  });

  it.each(['MANAGER', 'ADMIN'] as const)(
    'selects the organization-scoped management read model for %s',
    async (role) => {
      const actor = { ...staff, role };
      const repository = {
        getStaffOverview: vi.fn(),
        getManagementOverview: vi.fn().mockResolvedValue({ scope: 'management' }),
      };
      const service = new OverviewService(true, repository as never);
      await expect(service.getOverview(actor, { requestedRange: null }))
        .resolves.toMatchObject({ scope: 'management' });
      expect(repository.getManagementOverview).toHaveBeenCalledWith(
        actor,
        { requestedRange: null },
        expect.any(Date),
      );
      expect(repository.getStaffOverview).not.toHaveBeenCalled();
    },
  );
});
