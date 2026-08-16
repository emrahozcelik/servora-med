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
    const service = new OverviewService(false, repository as never);

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
    const service = new OverviewService(true, repository as never, undefined, () => now);
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

  it('O-R2-9: Manager work-type distribution is requested organization-wide without team scope', async () => {
    const getWorkTypeDistribution = vi.fn().mockResolvedValue([]);
    const reports = { getWorkTypeDistribution } as never;
    const repository = {
      getStaffOverview: vi.fn(),
      getManagementOverview: vi.fn().mockResolvedValue({
        scope: 'management',
        range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
      }),
      getUpcomingWork: vi.fn().mockResolvedValue(null),
    };
    const now = new Date('2026-07-26T08:00:00.000Z');
    const service = new OverviewService(true, repository as never, reports, () => now, true);

    const manager = { ...staff, role: 'MANAGER' as const };
    await service.getOverview(manager, { requestedRange: null });

    expect(getWorkTypeDistribution).toHaveBeenCalledTimes(1);
    expect(getWorkTypeDistribution).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: staff.organizationId,
      staffUserId: null,
    }));
    const managerCall = getWorkTypeDistribution.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(managerCall).sort()).toEqual(['from', 'organizationId', 'staffUserId', 'to']);

    const admin = { ...staff, role: 'ADMIN' as const };
    getWorkTypeDistribution.mockClear();
    await service.getOverview(admin, { requestedRange: null });
    expect(getWorkTypeDistribution).toHaveBeenCalledTimes(1);
    const adminCall = getWorkTypeDistribution.mock.calls[0]![0] as Record<string, unknown>;
    expect(adminCall).toEqual({
      organizationId: staff.organizationId,
      from: '2026-07-01',
      to: '2026-07-31',
      staffUserId: null,
    });
  });
});
