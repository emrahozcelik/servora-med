import { describe, expect, it, vi } from 'vitest';

import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { ReportsService } from '../src/modules/reports/service.js';

const ORGANIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTIVE_STAFF_ID = '11111111-1111-4111-8111-111111111111';
const INACTIVE_STAFF_ID = '22222222-2222-4222-8222-222222222222';
const requestTime = new Date('2026-07-14T12:00:00.000Z');
const range = { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' };

function actor(role: SafeUser['role']): SafeUser {
  return {
    id: `${role.toLowerCase()}-1`,
    organizationId: ORGANIZATION_ID,
    name: role,
    email: `${role.toLowerCase()}@example.com`,
    role,
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

function servicePorts() {
  const summaries = new Map([
    [ACTIVE_STAFF_ID, {
      staffUserId: ACTIVE_STAFF_ID,
      range,
      counters: {
        openJobCards: 4,
        overdueJobCards: 1,
        waitingApproval: 2,
        revisionRequested: 1,
        completedInPeriod: 6,
      },
    }],
    [INACTIVE_STAFF_ID, {
      staffUserId: INACTIVE_STAFF_ID,
      range,
      counters: {
        openJobCards: 0,
        overdueJobCards: 0,
        waitingApproval: 0,
        revisionRequested: 0,
        completedInPeriod: 0,
      },
    }],
  ]);
  const reports = {
    getStaffPerformanceScope: vi.fn(async ({ includeInactive }) => ({
      range,
      staff: [
        { userId: ACTIVE_STAFF_ID, name: 'Aktif Personel', isActive: true },
        ...(includeInactive
          ? [{ userId: INACTIVE_STAFF_ID, name: 'Eski Personel', isActive: false }]
          : []),
      ],
    })),
    getMany: vi.fn(async ({ staffUserIds }) => new Map(
      staffUserIds.map((staffUserId: string) => [staffUserId, summaries.get(staffUserId)!]),
    )),
    getStaffCompletionPerformanceMany: vi.fn(async () => new Map([
      [ACTIVE_STAFF_ID, {
        staffUserId: ACTIVE_STAFF_ID,
        completionDays: 3,
        completionWorkTypes: [
          { type: 'PRODUCT_DELIVERY', count: 4 },
          { type: 'GENERAL_TASK', count: 2 },
        ],
      }],
      [INACTIVE_STAFF_ID, {
        staffUserId: INACTIVE_STAFF_ID,
        completionDays: 0,
        completionWorkTypes: [],
      }],
    ])),
    getStaffCorrectionRequestEventsMany: vi.fn(async () => new Map([
      [ACTIVE_STAFF_ID, 2],
    ])),
    getStaffAuthoredOperationalNotesMany: vi.fn(async () => new Map([
      [ACTIVE_STAFF_ID, 5],
    ])),
    getStaffIdentity: vi.fn(),
    getOne: vi.fn(),
    getStaffDailyCompletionTrend: vi.fn(),
    getStaffDeliveriesByPurpose: vi.fn(),
    getStaffMeetingsByOutcome: vi.fn(),
    getDashboard: vi.fn(),
    getDeliveryReport: vi.fn(),
    getApprovalSummary: vi.fn(),
    getWorkTypeDistribution: vi.fn(),
  };
  const approvalItems = { getApprovalItems: vi.fn() };
  return { reports, approvalItems };
}

describe('ReportsService manager-wide Staff performance', () => {
  it('returns historical performance separately from the current snapshot in five reads', async () => {
    const ports = servicePorts();
    const service = new ReportsService(ports.reports as never, ports.approvalItems as never,
      () => requestTime);

    await expect(service.getStaffPerformance(actor('MANAGER'), {
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
    })).resolves.toEqual({
      range,
      items: [{
        staff: { userId: ACTIVE_STAFF_ID, name: 'Aktif Personel', isActive: true },
        performance: {
          completedJobs: 6,
          completionDays: 3,
          jobsPerCompletionDay: 2,
          correctionRequestEvents: 2,
          authoredOperationalNotes: 5,
        },
        completionWorkTypes: [
          { type: 'PRODUCT_DELIVERY', count: 4 },
          { type: 'GENERAL_TASK', count: 2 },
        ],
        currentWorkload: {
          openJobCards: 4,
          overdueJobCards: 1,
          waitingApproval: 2,
          revisionRequested: 1,
        },
      }],
    });

    expect(ports.reports.getStaffPerformanceScope).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
      requestTime,
      includeInactive: false,
    });
    expect(ports.reports.getMany).toHaveBeenCalledOnce();
    expect(ports.reports.getStaffCompletionPerformanceMany).toHaveBeenCalledOnce();
    expect(ports.reports.getStaffCorrectionRequestEventsMany).toHaveBeenCalledOnce();
    expect(ports.reports.getStaffAuthoredOperationalNotesMany).toHaveBeenCalledOnce();
  });

  it('includes inactive Staff for Admin and returns neutral zero ratios', async () => {
    const ports = servicePorts();
    const service = new ReportsService(ports.reports as never, ports.approvalItems as never,
      () => requestTime);

    const result = await service.getStaffPerformance(actor('ADMIN'), { requestedRange: null });

    expect(result.items).toHaveLength(2);
    expect(result.items[1]).toMatchObject({
      staff: { userId: INACTIVE_STAFF_ID, isActive: false },
      performance: {
        completedJobs: 0,
        completionDays: 0,
        jobsPerCompletionDay: 0,
        correctionRequestEvents: 0,
        authoredOperationalNotes: 0,
      },
    });
    expect(ports.reports.getStaffPerformanceScope)
      .toHaveBeenCalledWith(expect.objectContaining({ includeInactive: true }));
  });

  it('denies Staff before any manager-wide report read', async () => {
    const ports = servicePorts();
    const service = new ReportsService(ports.reports as never, ports.approvalItems as never,
      () => requestTime);

    await expect(service.getStaffPerformance(actor('STAFF'), { requestedRange: null }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(ports.reports.getStaffPerformanceScope).not.toHaveBeenCalled();
  });

  it('returns an empty organization after the scope read without aggregate queries', async () => {
    const ports = servicePorts();
    ports.reports.getStaffPerformanceScope.mockResolvedValue({ range, staff: [] });
    const service = new ReportsService(ports.reports as never, ports.approvalItems as never,
      () => requestTime);

    await expect(service.getStaffPerformance(actor('MANAGER'), { requestedRange: null }))
      .resolves.toEqual({ range, items: [] });
    expect(ports.reports.getMany).not.toHaveBeenCalled();
    expect(ports.reports.getStaffCompletionPerformanceMany).not.toHaveBeenCalled();
    expect(ports.reports.getStaffCorrectionRequestEventsMany).not.toHaveBeenCalled();
    expect(ports.reports.getStaffAuthoredOperationalNotesMany).not.toHaveBeenCalled();
  });
});

function queuedPool(rowsByCall: unknown[][]) {
  const query = vi.fn(async () => {
    const rows = rowsByCall.shift();
    if (!rows) throw new Error('Unexpected query');
    return { rows, rowCount: rows.length };
  });
  return { query, pool: { query } as never };
}

describe('PostgresReportsRepository bulk Staff performance reads', () => {
  it('resolves ordered same-organization Staff scope with the inactive policy in one query', async () => {
    const { pool, query } = queuedPool([[
      // JSON is parsed by pg before it reaches the repository.
      { from_date: '2026-07-01', to_date: '2026-07-31', timezone: 'Europe/Istanbul',
        staff: [{ userId: ACTIVE_STAFF_ID, name: 'Aktif Personel', isActive: true }] },
    ]]);
    const repository = new PostgresReportsRepository(pool);

    await expect(repository.getStaffPerformanceScope({
      organizationId: ORGANIZATION_ID,
      requestedRange: null,
      requestTime,
      includeInactive: false,
    })).resolves.toEqual({
      range,
      staff: [{ userId: ACTIVE_STAFF_ID, name: 'Aktif Personel', isActive: true }],
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      ORGANIZATION_ID, null, null, requestTime, false,
    ]);
    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain('u.organization_id = $1');
    expect(sql).toContain("u.role = 'STAFF'");
    expect(sql).toContain('($5::boolean OR u.is_active)');
    expect(sql).toMatch(/JOIN staff_profiles sp/i);
  });

  it('aggregates completion days and completion-time work types for all requested Staff once', async () => {
    const { pool, query } = queuedPool([[
      { staff_user_id: ACTIVE_STAFF_ID, completion_days: '2', completion_work_types: [
        { type: 'PRODUCT_DELIVERY', count: 3 },
      ] },
      { staff_user_id: INACTIVE_STAFF_ID, completion_days: '0', completion_work_types: [] },
    ]]);
    const repository = new PostgresReportsRepository(pool);

    const result = await repository.getStaffCompletionPerformanceMany({
      organizationId: ORGANIZATION_ID,
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
      requestTime,
      staffUserIds: [ACTIVE_STAFF_ID, INACTIVE_STAFF_ID, ACTIVE_STAFF_ID],
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      ORGANIZATION_ID, '2026-07-01', '2026-07-31', requestTime,
      [ACTIVE_STAFF_ID, INACTIVE_STAFF_ID],
    ]);
    expect(result.get(ACTIVE_STAFF_ID)).toEqual({
      staffUserId: ACTIVE_STAFF_ID,
      completionDays: 2,
      completionWorkTypes: [{ type: 'PRODUCT_DELIVERY', count: 3 }],
    });
    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain('jc.manager_approved_at');
    expect(sql).toContain('COUNT(DISTINCT completion_date)');
    expect(sql).toContain('GROUP BY staff_user_id, type');
    expect(sql).not.toMatch(/jc\.created_at\s*(?:>=|<)/i);
  });

  it('counts repeated correction events and qualifying authored notes in grouped queries', async () => {
    const { pool, query } = queuedPool([
      [{ staff_user_id: ACTIVE_STAFF_ID, count: '2' }],
      [{ staff_user_id: ACTIVE_STAFF_ID, count: '5' }],
    ]);
    const repository = new PostgresReportsRepository(pool);
    const input = {
      organizationId: ORGANIZATION_ID,
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
      requestTime,
      staffUserIds: [ACTIVE_STAFF_ID, INACTIVE_STAFF_ID],
    };

    await expect(repository.getStaffCorrectionRequestEventsMany(input))
      .resolves.toEqual(new Map([[ACTIVE_STAFF_ID, 2]]));
    await expect(repository.getStaffAuthoredOperationalNotesMany(input))
      .resolves.toEqual(new Map([[ACTIVE_STAFF_ID, 5]]));

    expect(query).toHaveBeenCalledTimes(2);
    const correctionSql = query.mock.calls[0]?.[0] ?? '';
    expect(correctionSql).toContain("event_type = 'JOB_REVISION_REQUESTED'");
    expect(correctionSql).toContain('jc.assigned_to = requested.staff_user_id');
    expect(correctionSql).toContain('GROUP BY requested.staff_user_id');
    const noteSql = query.mock.calls[1]?.[0] ?? '';
    expect(noteSql).toContain('n.author_id = requested.staff_user_id');
    expect(noteSql).toContain("n.record_version = 0 OR n.context = 'GENERAL'");
    expect(noteSql).toContain('n.organization_id = $1');
    expect(noteSql).toContain('GROUP BY requested.staff_user_id');
  });

  it('short-circuits every grouped aggregate for an empty Staff list', async () => {
    const { pool, query } = queuedPool([]);
    const repository = new PostgresReportsRepository(pool);
    const input = {
      organizationId: ORGANIZATION_ID,
      requestedRange: null,
      requestTime,
      staffUserIds: [],
    };

    await expect(repository.getStaffCompletionPerformanceMany(input)).resolves.toEqual(new Map());
    await expect(repository.getStaffCorrectionRequestEventsMany(input)).resolves.toEqual(new Map());
    await expect(repository.getStaffAuthoredOperationalNotesMany(input)).resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });
});
