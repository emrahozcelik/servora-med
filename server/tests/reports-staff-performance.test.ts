import { describe, expect, it, vi } from 'vitest';

import type { SafeUser } from '../src/modules/auth/types.js';
import {
  precedingEqualLengthRange,
  staffExistedDuringPriorRange,
} from '../src/modules/reports/range.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { ReportsService } from '../src/modules/reports/service.js';

const ORGANIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTIVE_STAFF_ID = '11111111-1111-4111-8111-111111111111';
const INACTIVE_STAFF_ID = '22222222-2222-4222-8222-222222222222';
const requestTime = new Date('2026-07-14T12:00:00.000Z');
const range = { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' };
const priorRange = { from: '2026-05-31', to: '2026-06-30', timezone: 'Europe/Istanbul' };
const CREATED_BEFORE_PRIOR = '2025-01-01T00:00:00.000Z';

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
  const summary = (staffUserId: string, prior: boolean) => ({
    staffUserId,
    range: prior ? priorRange : range,
    counters: staffUserId === ACTIVE_STAFF_ID
      ? {
          openJobCards: 4,
          overdueJobCards: 1,
          waitingApproval: 2,
          revisionRequested: 1,
          completedInPeriod: prior ? 4 : 6,
        }
      : {
          openJobCards: 0,
          overdueJobCards: 0,
          waitingApproval: 0,
          revisionRequested: 0,
          completedInPeriod: 0,
        },
  });
  const reports = {
    getStaffPerformanceScope: vi.fn(async ({ includeInactive }) => ({
      range,
      staff: [
        { userId: ACTIVE_STAFF_ID, name: 'Aktif Personel', isActive: true,
          createdAt: CREATED_BEFORE_PRIOR },
        ...(includeInactive
          ? [{ userId: INACTIVE_STAFF_ID, name: 'Eski Personel', isActive: false,
              createdAt: CREATED_BEFORE_PRIOR }]
          : []),
      ],
    })),
    getMany: vi.fn(async ({ staffUserIds, requestedRange }) => new Map(
      staffUserIds.map((staffUserId: string) => [
        staffUserId,
        summary(staffUserId, requestedRange?.from === priorRange.from),
      ]),
    )),
    getStaffCompletionPerformanceMany: vi.fn(async ({ requestedRange }) => new Map([
      [ACTIVE_STAFF_ID, {
        staffUserId: ACTIVE_STAFF_ID,
        completionDays: requestedRange?.from === priorRange.from ? 2 : 3,
        completionWorkTypes: requestedRange?.from === priorRange.from ? [] : [
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
    getStaffCorrectionRequestEventsMany: vi.fn(async ({ requestedRange }) => new Map([
      [ACTIVE_STAFF_ID, requestedRange?.from === priorRange.from ? 1 : 2],
    ])),
    getStaffAuthoredOperationalNotesMany: vi.fn(async ({ requestedRange }) => new Map([
      [ACTIVE_STAFF_ID, requestedRange?.from === priorRange.from ? 2 : 5],
    ])),
    getStaffExecutionMany: vi.fn(async () => new Map([
      [ACTIVE_STAFF_ID, {
        staffUserId: ACTIVE_STAFF_ID,
        staffCompletedJobs: 5,
        staffCompletionDays: 3,
        missingStaffCompletionTimestamp: 1,
      }],
      [INACTIVE_STAFF_ID, {
        staffUserId: INACTIVE_STAFF_ID,
        staffCompletedJobs: 0,
        staffCompletionDays: 0,
        missingStaffCompletionTimestamp: 0,
      }],
    ])),
    getStaffOnTimeMany: vi.fn(async () => new Map([
      [ACTIVE_STAFF_ID, {
        staffUserId: ACTIVE_STAFF_ID,
        eligibleScheduledCompletedJobs: 3,
        onTimeCompletedJobs: 2,
        lateCompletedJobs: 1,
        ineligibleOrNoDeadlineCompletedJobs: 3,
      }],
      [INACTIVE_STAFF_ID, {
        staffUserId: INACTIVE_STAFF_ID,
        eligibleScheduledCompletedJobs: 0,
        onTimeCompletedJobs: 0,
        lateCompletedJobs: 0,
        ineligibleOrNoDeadlineCompletedJobs: 0,
      }],
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
  it('adds a bounded prior, execution and on-time comparison in eleven reads', async () => {
    const ports = servicePorts();
    const service = new ReportsService(ports.reports as never, ports.approvalItems as never,
      () => requestTime);

    await expect(service.getStaffPerformance(actor('MANAGER'), {
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
    })).resolves.toEqual({
      range,
      priorRange,
      items: [{
        staff: { userId: ACTIVE_STAFF_ID, name: 'Aktif Personel', isActive: true },
        performance: {
          completedJobs: 6,
          completionDays: 3,
          jobsPerCompletionDay: 2,
          correctionRequestEvents: 2,
          authoredOperationalNotes: 5,
        },
        priorPerformance: {
          available: true,
          performance: {
            completedJobs: 4,
            completionDays: 2,
            jobsPerCompletionDay: 2,
            correctionRequestEvents: 1,
            authoredOperationalNotes: 2,
          },
        },
        staffExecution: {
          staffCompletedJobs: 5,
          staffCompletionDays: 3,
          jobsPerStaffCompletionDay: 5 / 3,
          missingStaffCompletionTimestamp: 1,
        },
        onTime: {
          eligibleScheduledCompletedJobs: 3,
          onTimeCompletedJobs: 2,
          lateCompletedJobs: 1,
          ineligibleOrNoDeadlineCompletedJobs: 3,
          onTimeRate: 2 / 3,
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
    expect(ports.reports.getMany).toHaveBeenCalledTimes(2);
    expect(ports.reports.getStaffCompletionPerformanceMany).toHaveBeenCalledTimes(2);
    expect(ports.reports.getStaffCorrectionRequestEventsMany).toHaveBeenCalledTimes(2);
    expect(ports.reports.getStaffAuthoredOperationalNotesMany).toHaveBeenCalledTimes(2);
    expect(ports.reports.getStaffExecutionMany).toHaveBeenCalledOnce();
    expect(ports.reports.getStaffOnTimeMany).toHaveBeenCalledOnce();
    expect(ports.reports.getMany).toHaveBeenLastCalledWith(expect.objectContaining({
      staffUserIds: [ACTIVE_STAFF_ID],
      requestedRange: { from: priorRange.from, to: priorRange.to },
    }));
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
      priorPerformance: { available: true, performance: {
        completedJobs: 0,
        jobsPerCompletionDay: 0,
      } },
      onTime: { eligibleScheduledCompletedJobs: 0, onTimeRate: null },
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
      .resolves.toEqual({ range, priorRange, items: [] });
    expect(ports.reports.getMany).not.toHaveBeenCalled();
    expect(ports.reports.getStaffCompletionPerformanceMany).not.toHaveBeenCalled();
    expect(ports.reports.getStaffCorrectionRequestEventsMany).not.toHaveBeenCalled();
    expect(ports.reports.getStaffAuthoredOperationalNotesMany).not.toHaveBeenCalled();
    expect(ports.reports.getStaffExecutionMany).not.toHaveBeenCalled();
    expect(ports.reports.getStaffOnTimeMany).not.toHaveBeenCalled();
  });

  it('keeps a valid prior zero distinct from lifecycle-unavailable comparison', async () => {
    const ports = servicePorts();
    ports.reports.getStaffPerformanceScope.mockResolvedValue({
      range,
      staff: [
        { userId: ACTIVE_STAFF_ID, name: 'Aktif Personel', isActive: true,
          createdAt: CREATED_BEFORE_PRIOR },
        { userId: INACTIVE_STAFF_ID, name: 'Yeni Personel', isActive: false,
          createdAt: '2026-07-01T00:00:00.000Z' },
      ],
    });
    ports.reports.getMany.mockImplementation(async ({ staffUserIds, requestedRange }) =>
      new Map(staffUserIds.map((staffUserId: string) => [staffUserId, {
        staffUserId,
        range: requestedRange?.from === priorRange.from ? priorRange : range,
        counters: {
          openJobCards: 0,
          overdueJobCards: 0,
          waitingApproval: 0,
          revisionRequested: 0,
          completedInPeriod: 0,
        },
      }])));
    ports.reports.getStaffCompletionPerformanceMany.mockImplementation(async ({ staffUserIds }) =>
      new Map(staffUserIds.map((staffUserId: string) => [staffUserId, {
        staffUserId, completionDays: 0, completionWorkTypes: [],
      }])));
    const service = new ReportsService(ports.reports as never, ports.approvalItems as never,
      () => requestTime);

    const result = await service.getStaffPerformance(actor('ADMIN'), { requestedRange: null });

    expect(result.items[0]?.priorPerformance).toEqual({
      available: true,
      performance: {
        completedJobs: 0,
        completionDays: 0,
        jobsPerCompletionDay: 0,
        correctionRequestEvents: 1,
        authoredOperationalNotes: 2,
      },
    });
    expect(result.items[1]?.priorPerformance).toEqual({ available: false, performance: null });
  });

  it('fails closed when the on-time aggregate violates its denominator invariant', async () => {
    const ports = servicePorts();
    ports.reports.getStaffOnTimeMany.mockResolvedValue(new Map([[
      ACTIVE_STAFF_ID,
      {
        staffUserId: ACTIVE_STAFF_ID,
        eligibleScheduledCompletedJobs: 3,
        onTimeCompletedJobs: 2,
        lateCompletedJobs: 2,
        ineligibleOrNoDeadlineCompletedJobs: 2,
      },
    ]]));
    const service = new ReportsService(ports.reports as never, ports.approvalItems as never,
      () => requestTime);

    await expect(service.getStaffPerformance(actor('MANAGER'), { requestedRange: null }))
      .rejects.toThrow('Staff on-time aggregate invariant could not be resolved.');
  });

  it('fails closed when staff execution jobs cannot resolve to completion days', async () => {
    const ports = servicePorts();
    ports.reports.getStaffExecutionMany.mockResolvedValue(new Map([[
      ACTIVE_STAFF_ID,
      {
        staffUserId: ACTIVE_STAFF_ID,
        staffCompletedJobs: 2,
        staffCompletionDays: 0,
        missingStaffCompletionTimestamp: 1,
      },
    ]]));
    const service = new ReportsService(ports.reports as never, ports.approvalItems as never,
      () => requestTime);

    await expect(service.getStaffPerformance(actor('MANAGER'), { requestedRange: null }))
      .rejects.toThrow('Staff execution aggregate invariant could not be resolved.');
  });
});

describe('Staff performance prior range', () => {
  it.each([
    [
      { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
      { from: '2026-05-31', to: '2026-06-30', timezone: 'Europe/Istanbul' },
    ],
    [
      { from: '2026-07-01', to: '2026-07-30', timezone: 'Europe/Istanbul' },
      { from: '2026-06-01', to: '2026-06-30', timezone: 'Europe/Istanbul' },
    ],
    [
      { from: '2026-01-01', to: '2026-01-31', timezone: 'Europe/Istanbul' },
      { from: '2025-12-01', to: '2025-12-31', timezone: 'Europe/Istanbul' },
    ],
    [
      { from: '2026-03-09', to: '2026-03-15', timezone: 'America/New_York' },
      { from: '2026-03-02', to: '2026-03-08', timezone: 'America/New_York' },
    ],
  ])('derives the preceding equal-length local-calendar range', (current, expected) => {
    expect(precedingEqualLengthRange(current)).toEqual(expected);
  });

  it('requires creation on or before the prior range start for full-period availability', () => {
    expect(staffExistedDuringPriorRange('2026-05-30T12:00:00.000Z', priorRange)).toBe(true);
    expect(staffExistedDuringPriorRange('2026-05-31T12:00:00.000Z', priorRange)).toBe(true);
    expect(staffExistedDuringPriorRange('2026-06-15T00:00:00.000Z', priorRange)).toBe(false);
    expect(staffExistedDuringPriorRange('2026-06-30T00:00:00.000Z', priorRange)).toBe(false);
    expect(staffExistedDuringPriorRange('2026-07-01T00:00:00.000Z', priorRange)).toBe(false);
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
        staff: [{ userId: ACTIVE_STAFF_ID, name: 'Aktif Personel', isActive: true,
          createdAt: CREATED_BEFORE_PRIOR }] },
    ]]);
    const repository = new PostgresReportsRepository(pool);

    await expect(repository.getStaffPerformanceScope({
      organizationId: ORGANIZATION_ID,
      requestedRange: null,
      requestTime,
      includeInactive: false,
    })).resolves.toEqual({
      range,
      staff: [{ userId: ACTIVE_STAFF_ID, name: 'Aktif Personel', isActive: true,
        createdAt: CREATED_BEFORE_PRIOR }],
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
    expect(sql).toContain("'createdAt', staff_scope.created_at");
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

  it('selects the staff execution population by staff_completed_at, not manager_approved_at', async () => {
    const { pool, query } = queuedPool([[
      { staff_user_id: ACTIVE_STAFF_ID,
        staff_completed_jobs: '5',
        staff_completion_days: '3', missing_staff_completion_timestamp: '1' },
    ]]);
    const repository = new PostgresReportsRepository(pool);
    const input = {
      organizationId: ORGANIZATION_ID,
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
      requestTime,
      staffUserIds: [ACTIVE_STAFF_ID, INACTIVE_STAFF_ID],
    };

    await expect(repository.getStaffExecutionMany(input)).resolves.toEqual(new Map([[
      ACTIVE_STAFF_ID,
      {
        staffUserId: ACTIVE_STAFF_ID,
        staffCompletedJobs: 5,
        staffCompletionDays: 3,
        missingStaffCompletionTimestamp: 1,
      },
    ]]));
    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain("jc.status = 'COMPLETED'");
    expect(sql).toContain('jc.staff_completed_at IS NOT NULL');
    expect(sql).toContain('COUNT(DISTINCT executed.staff_completion_date)');
    expect(sql).toMatch(/executed AS/);
    expect(sql).not.toContain("'WAITING_APPROVAL'");
    const executedWindow = sql.match(/AND jc\.staff_completed_at <\s*\n\s*\(\(organization_range\.to_date/);
    expect(executedWindow).not.toBeNull();
  });

  it('judges on-time against the interval end and excludes work types without a deadline', async () => {
    const { pool, query } = queuedPool([[
      { staff_user_id: ACTIVE_STAFF_ID,
        eligible_scheduled_completed_jobs: '3',
        on_time_completed_jobs: '2', late_completed_jobs: '1',
        ineligible_or_no_deadline_completed_jobs: '3' },
    ]]);
    const repository = new PostgresReportsRepository(pool);
    const input = {
      organizationId: ORGANIZATION_ID,
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
      requestTime,
      staffUserIds: [ACTIVE_STAFF_ID, INACTIVE_STAFF_ID],
    };

    await expect(repository.getStaffOnTimeMany(input)).resolves.toEqual(new Map([[
      ACTIVE_STAFF_ID,
      {
        staffUserId: ACTIVE_STAFF_ID,
        eligibleScheduledCompletedJobs: 3,
        onTimeCompletedJobs: 2,
        lateCompletedJobs: 1,
        ineligibleOrNoDeadlineCompletedJobs: 3,
      },
    ]]));
    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain("jc.type = 'SALES_MEETING'");
    expect(sql).toContain('completed.staff_completed_at <= completed.effective_deadline_at');
    expect(sql).toContain('completed.staff_completed_at > completed.effective_deadline_at');
    expect(sql).not.toContain('due_date');
    expect(sql).not.toContain('job_card_activity_logs');
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
    await expect(repository.getStaffExecutionMany(input)).resolves.toEqual(new Map());
    await expect(repository.getStaffOnTimeMany(input)).resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });
});
