import { describe, expect, it, vi } from 'vitest';

import type { SafeUser } from '../src/modules/auth/types.js';
import { ReportsService } from '../src/modules/reports/service.js';

const ORG_ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_ONE = '11111111-1111-4111-8111-111111111111';
const INACTIVE_STAFF = '22222222-2222-4222-8222-222222222222';
const MISSING_STAFF = '33333333-3333-4333-8333-333333333333';
const requestTime = new Date('2026-07-14T12:00:00.000Z');
const range = { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' };
const counters = {
  openJobCards: 3,
  waitingApproval: 2,
  revisionRequested: 1,
  overdueJobCards: 1,
  completedInPeriod: 4,
};

function actor(role: SafeUser['role'], id = `${role.toLowerCase()}-1`): SafeUser {
  return {
    id,
    organizationId: ORG_ONE,
    name: role,
    email: `${role.toLowerCase()}@example.com`,
    role,
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

const ADMIN = actor('ADMIN');
const MANAGER = actor('MANAGER');
const STAFF = actor('STAFF', STAFF_ONE);

function ports() {
  const identity = (staffUserId: string) => staffUserId === MISSING_STAFF
    ? null
    : {
        userId: staffUserId,
        name: staffUserId === INACTIVE_STAFF ? 'Eski Personel' : 'Aktif Personel',
        isActive: staffUserId !== INACTIVE_STAFF,
      };
  const reports = {
    getDashboard: vi.fn(async (input) => ({
      range,
      counters: {
        activeJobCards: 7,
        overdueJobCards: 1,
        waitingApproval: 2,
        revisionRequested: 1,
        completedInPeriod: 4,
        cancelledInPeriod: 0,
      },
      completedTrend: [],
      input,
    })),
    getStaffIdentity: vi.fn(async ({ staffUserId }) => identity(staffUserId)),
    getOne: vi.fn(async (input) => input.staffUserId === MISSING_STAFF
      ? null
      : { staffUserId: input.staffUserId, range, counters }),
    getMany: vi.fn(),
    getStaffDeliveriesByPurpose: vi.fn(async () => ([
      { purpose: 'SALE', unit: 'Kutu', quantity: '3.000' },
    ])),
    getDeliveryReport: vi.fn(async (input) => ({
      groupBy: input.groupBy,
      items: [],
      range,
      total: 0,
      limit: input.limit,
      offset: input.offset,
    })),
    getApprovalSummary: vi.fn(async () => ({
      pendingCount: 2,
      oldestWaitingMinutes: 120,
      averageWaitingMinutes: 60,
      under2Hours: 1,
      between2And8Hours: 1,
      between8And24Hours: 0,
      over24Hours: 0,
    })),
  };
  const approvalItems = {
    getApprovalItems: vi.fn(async () => ([
      { id: 'job-1', waitingMinutes: 120 },
    ])),
  };
  return { reports, approvalItems };
}

function createService() {
  const dependencies = ports();
  return {
    ...dependencies,
    service: new ReportsService(
      dependencies.reports as never,
      dependencies.approvalItems as never,
      () => requestTime,
    ),
  };
}

describe('ReportsService authorization and composition', () => {
  it('denies Staff access to every organization report', async () => {
    const { service, reports, approvalItems } = createService();

    await expect(service.dashboard(STAFF, { requestedRange: null }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    await expect(service.getStaffReport(STAFF, STAFF_ONE, { requestedRange: null }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    await expect(service.getDeliveries(STAFF, {
      requestedRange: null,
      groupBy: 'purpose',
      staffUserId: null,
      limit: 50,
      offset: 0,
    })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    await expect(service.getApprovals(STAFF, { limit: 50, offset: 0 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    expect(reports.getDashboard).not.toHaveBeenCalled();
    expect(reports.getDeliveryReport).not.toHaveBeenCalled();
    expect(reports.getApprovalSummary).not.toHaveBeenCalled();
    expect(approvalItems.getApprovalItems).not.toHaveBeenCalled();
  });

  it.each([ADMIN, MANAGER])('allows $role to use every management report', async (management) => {
    const { service } = createService();

    await expect(service.dashboard(management, { requestedRange: null })).resolves.toBeDefined();
    await expect(service.getStaffReport(
      management,
      INACTIVE_STAFF,
      { requestedRange: null },
    )).resolves.toMatchObject({
      staff: { userId: INACTIVE_STAFF, isActive: false },
    });
    await expect(service.getDeliveries(management, {
      requestedRange: null,
      groupBy: 'day',
      staffUserId: null,
      limit: 50,
      offset: 0,
    })).resolves.toBeDefined();
    await expect(service.getApprovals(management, { limit: 50, offset: 0 }))
      .resolves.toMatchObject({ total: 2, limit: 50, offset: 0 });
  });

  it('allows only Staff to load its own report and forces the authenticated Staff ID', async () => {
    const { service, reports } = createService();

    await expect(service.getOwnStaffReport(MANAGER, { requestedRange: null }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    const result = await service.getOwnStaffReport(STAFF, {
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
    });

    expect(result).toEqual({
      staff: { userId: STAFF_ONE, name: 'Aktif Personel', isActive: true },
      range,
      counters,
      deliveriesByPurpose: [{ purpose: 'SALE', unit: 'Kutu', quantity: '3.000' }],
    });
    expect(reports.getStaffIdentity).toHaveBeenCalledWith({
      organizationId: ORG_ONE,
      staffUserId: STAFF_ONE,
    });
    const summaryInput = reports.getOne.mock.calls[0]?.[0];
    const deliveryInput = reports.getStaffDeliveriesByPurpose.mock.calls[0]?.[0];
    expect(summaryInput).toEqual(deliveryInput);
    expect(summaryInput).toMatchObject({
      organizationId: ORG_ONE,
      staffUserId: STAFF_ONE,
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
      requestTime,
    });
  });

  it('conceals missing, cross-organization, and non-Staff report targets', async () => {
    const { service } = createService();

    await expect(service.getStaffReport(
      MANAGER,
      MISSING_STAFF,
      { requestedRange: null },
    )).rejects.toMatchObject({
      code: 'STAFF_PROFILE_NOT_FOUND',
      statusCode: 404,
      message: 'Personel profili bulunamadı.',
    });
  });

  it('validates a delivery Staff target before querying the report', async () => {
    const { service, reports } = createService();
    const query = {
      requestedRange: null,
      groupBy: 'staff' as const,
      staffUserId: MISSING_STAFF,
      limit: 25,
      offset: 0,
    };

    await expect(service.getDeliveries(MANAGER, query)).rejects.toMatchObject({
      code: 'STAFF_PROFILE_NOT_FOUND',
      statusCode: 404,
    });
    expect(reports.getDeliveryReport).not.toHaveBeenCalled();

    await expect(service.getDeliveries(MANAGER, {
      ...query,
      staffUserId: INACTIVE_STAFF,
    })).resolves.toBeDefined();
    expect(reports.getDeliveryReport).toHaveBeenCalledOnce();
  });

  it('shares one authoritative request time across each composed report', async () => {
    const { service, reports, approvalItems } = createService();

    await service.getApprovals(MANAGER, { limit: 10, offset: 20 });
    const summaryTime = reports.getApprovalSummary.mock.calls[0]?.[0].requestTime;
    const itemsTime = approvalItems.getApprovalItems.mock.calls[0]?.[0].requestTime;
    expect(summaryTime).toBe(requestTime);
    expect(itemsTime).toBe(summaryTime);
    expect(approvalItems.getApprovalItems).toHaveBeenCalledWith({
      organizationId: ORG_ONE,
      requestTime,
      limit: 10,
      offset: 20,
    });

    await service.dashboard(MANAGER, { requestedRange: null });
    expect(reports.getDashboard.mock.calls[0]?.[0].requestTime).toBe(requestTime);
  });
});
