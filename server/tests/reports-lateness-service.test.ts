/**
 * OVR-7 lateness reports — service composition and fail-closed invariants.
 *
 * Contract: `docs/features/reporting/lateness-reports.md` §5, §6, §7 and
 * `DECISIONS.md` OVR-7. The read model is a double here on purpose: the SQL
 * classification lives in `reports-lateness-postgres.test.ts`. This file owns
 * what only the service decides — the added `trackingStartedOn` /
 * `generatedAt` facts, the shared request instant, authorization, Staff
 * targeting and every aggregate invariant. Each invariant case mutates exactly
 * one reconciled number, so the observed failure can only come from the guard
 * the contract requires.
 */
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { ReportsService } from '../src/modules/reports/service.js';
import type {
  LatenessDurationStats,
  LatenessGroupCounts,
  LatenessOpenStats,
  OrganizationLatenessSummary,
  StaffLatenessIncidentListResponse,
  StaffLatenessSummary,
  StaffOperationalSummaryOneInput,
  StaffOperationalSummaryScope,
} from '../src/modules/reports/types.js';
import { passThroughReportReadSnapshot } from './support/report-read-snapshot.js';

const ORG_ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_ONE = '11111111-1111-4111-8111-111111111111';
const MISSING_STAFF = '33333333-3333-4333-8333-333333333333';
const requestTime = new Date('2026-11-05T09:00:00.000Z');
const range = { from: '2026-10-01', to: '2026-10-31', timezone: 'Europe/Istanbul' };
const priorRange = { from: '2026-08-31', to: '2026-09-30', timezone: 'Europe/Istanbul' };

/** The read model aggregates omit the two request-scoped facts the service owns. */
type StaffLatenessAggregate = Omit<StaffLatenessSummary, 'trackingStartedOn' | 'generatedAt'>;
type OrganizationLatenessAggregate = Omit<
  OrganizationLatenessSummary,
  'trackingStartedOn' | 'generatedAt'
>;

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

function noDurationStats(): LatenessDurationStats {
  return { count: 0, medianSeconds: null, maxSeconds: null };
}

function noOpenStats(): LatenessOpenStats {
  return { count: 0, maxElapsedSeconds: null };
}

function noGroup(): LatenessGroupCounts {
  return { delayedJobCount: 0, incidentCount: 0 };
}

/** A fully reconciled Staff lateness aggregate: 3 incidents, two types. */
function staffLatenessAggregate(): StaffLatenessAggregate {
  return {
    staffResponsibility: {
      delayedJobCount: 2,
      incidentCount: 3,
      byType: [
        {
          delayType: 'LATE_START',
          incidentCount: 1,
          recovered: { count: 1, medianSeconds: 5400, maxSeconds: 5400 },
          extended: noDurationStats(),
          open: noOpenStats(),
        },
        {
          delayType: 'LATE_SUBMISSION',
          incidentCount: 2,
          recovered: noDurationStats(),
          extended: { count: 1, medianSeconds: 7200, maxSeconds: 7200 },
          open: { count: 1, maxElapsedSeconds: 3600 },
        },
      ],
    },
    operational: {
      delayedJobCount: 1,
      incidentCount: 1,
      byReason: [{ reasonCode: 'MISSING_STOCK_OR_EQUIPMENT', incidentCount: 1 }],
    },
  };
}

/** A fully reconciled organization aggregate: 3 + 1 + 1 + 1 = 6 incidents. */
function organizationLatenessAggregate(): OrganizationLatenessAggregate {
  return {
    range,
    totalIncidentCount: 6,
    staffResponsibility: { delayedJobCount: 2, incidentCount: 3 },
    operational: { delayedJobCount: 1, incidentCount: 1 },
    unknownAccountability: { delayedJobCount: 1, incidentCount: 1 },
    managementApprovalWait: {
      delayedJobCount: 1,
      incidentCount: 1,
      recovered: { count: 1, medianSeconds: 900, maxSeconds: 900 },
      open: noOpenStats(),
    },
  };
}

const incidentList: StaffLatenessIncidentListResponse = {
  range,
  items: [
    {
      incidentId: 'incident-2',
      delayType: 'LATE_SUBMISSION',
      episodeNo: 2,
      scheduleRevisionNo: 1,
      deadlineAt: '2026-10-20T07:00:00.000Z',
      breachedAt: '2026-10-20T08:30:00.000Z',
      outcome: 'OPEN',
      closedAt: null,
      durationSeconds: 3600,
      operationalReason: null,
      job: null,
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

function staffSummary() {
  return {
    staffUserId: STAFF_ONE,
    range,
    weeklyReportWorkload: 0,
    counters: {
      openJobCards: 0,
      waitingApproval: 0,
      revisionRequested: 0,
      overdueJobCards: 0,
      completedInPeriod: 0,
    },
    currentWorkloadByType: [
      { type: 'PRODUCT_DELIVERY', count: 0 },
      { type: 'GENERAL_TASK', count: 0 },
      { type: 'SALES_MEETING', count: 0 },
    ],
  };
}

function ports() {
  const state: {
    staffLateness: StaffLatenessAggregate;
    organizationLateness: OrganizationLatenessAggregate;
    incidents: StaffLatenessIncidentListResponse;
  } = {
    staffLateness: staffLatenessAggregate(),
    organizationLateness: organizationLatenessAggregate(),
    incidents: incidentList,
  };
  const reports = {
    getStaffIdentity: vi.fn(async ({ staffUserId }: { staffUserId: string }) =>
      staffUserId === MISSING_STAFF
        ? null
        : {
            userId: staffUserId,
            name: 'Saha Personeli',
            isActive: true,
            createdAt: '2025-01-01T00:00:00.000Z',
          }),
    getOne: vi.fn(async ({ staffUserId }: { staffUserId: string }) => (
      staffUserId === MISSING_STAFF ? null : staffSummary()
    )),
    getMany: vi.fn(async ({ staffUserIds }: { staffUserIds: readonly string[] }) => (
      new Map(staffUserIds.map((staffUserId) => [staffUserId, staffSummary()]))
    )),
    getStaffCompletionPerformanceMany: vi.fn(async (
      { staffUserIds }: { staffUserIds: readonly string[] },
    ) => new Map(staffUserIds.map((staffUserId) => [staffUserId, {
      staffUserId,
      completionDays: 0,
      completionWorkTypes: [
        { type: 'PRODUCT_DELIVERY', count: 0 },
        { type: 'GENERAL_TASK', count: 0 },
        { type: 'SALES_MEETING', count: 0 },
      ],
    }]))),
    getStaffCorrectionRequestEventsMany: vi.fn(async () => new Map<string, number>()),
    getStaffAuthoredOperationalNotesMany: vi.fn(async () => new Map<string, number>()),
    getStaffExecutionMany: vi.fn(async (
      { staffUserIds }: { staffUserIds: readonly string[] },
    ) => new Map(staffUserIds.map((staffUserId) => [staffUserId, {
      staffUserId,
      staffCompletedJobs: 0,
      staffCompletionDays: 0,
      missingStaffCompletionTimestamp: 0,
      recordedSubmissionCount: 0,
      recordedSubmissionDays: 0,
    }]))),
    getStaffOnTimeMany: vi.fn(async (
      { staffUserIds }: { staffUserIds: readonly string[] },
    ) => new Map(staffUserIds.map((staffUserId) => [staffUserId, {
      staffUserId,
      eligibleScheduledCompletedJobs: 0,
      onTimeCompletedJobs: 0,
      lateCompletedJobs: 0,
      ineligibleOrNoDeadlineCompletedJobs: 0,
    }]))),
    getStaffDailyCompletionTrend: vi.fn(async () => []),
    getStaffDeliveriesByPurpose: vi.fn(async () => []),
    getStaffMeetingsByOutcome: vi.fn(async () => []),
    getStaffLatenessSummary: vi.fn(async (_input: StaffOperationalSummaryOneInput) => (
      state.staffLateness
    )),
    getOrganizationLatenessSummary: vi.fn(async (_input: StaffOperationalSummaryScope) => (
      state.organizationLateness
    )),
    listStaffLatenessIncidents: vi.fn(async () => state.incidents),
  };
  const approvalItems = {
    getApprovalItems: vi.fn(async () => []),
  };
  return { reports, approvalItems, state };
}

function createService() {
  const dependencies = ports();
  return {
    ...dependencies,
    service: new ReportsService(
      dependencies.reports as never,
      passThroughReportReadSnapshot(dependencies.reports, dependencies.approvalItems),
      () => requestTime,
    ),
  };
}

/**
 * The contract requires the same failure style as `onTime()`: an ordinary
 * server fault (plain `Error`, no client status code), never a silent zero or
 * a partially populated response.
 */
async function expectFailClosed(run: () => Promise<unknown>): Promise<void> {
  const error: unknown = await run().then(
    () => {
      throw new Error('expected the read to fail closed, but it resolved');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(AppError);
  expect((error as Error).name).toBe('Error');
  expect((error as { statusCode?: unknown }).statusCode).toBeUndefined();
}

const staffQuery = { requestedRange: range, includeSaleCapability: true };
const incidentQuery = {
  requestedRange: { from: range.from, to: range.to },
  includeSaleCapability: true,
  limit: 20,
  offset: 0,
};

describe('ReportsService lateness summaries', () => {
  it('adds the tracking start and one request instant to the Staff lateness summary', async () => {
    const { service, reports } = createService();

    const report = await service.getStaffReport(MANAGER, STAFF_ONE, staffQuery);

    expect(report.lateness).toEqual({
      trackingStartedOn: '2026-09-21',
      generatedAt: '2026-11-05T09:00:00.000Z',
      ...staffLatenessAggregate(),
    });
    // The lateness read joins the same snapshot inputs as the rest of the report.
    const latenessInput = reports.getStaffLatenessSummary.mock.calls[0]?.[0];
    expect(latenessInput).toEqual({
      organizationId: ORG_ONE,
      staffUserId: STAFF_ONE,
      requestedRange: range,
      includeSaleCapability: true,
      requestTime,
    });
    expect(reports.getOne.mock.calls[0]?.[0]).toEqual(latenessInput);
  });

  it('keeps both delay types in the fixed order when a type has no incidents', async () => {
    const { service, reports, state } = createService();
    state.staffLateness = {
      staffResponsibility: {
        delayedJobCount: 0,
        incidentCount: 0,
        byType: [
          {
            delayType: 'LATE_START',
            incidentCount: 0,
            recovered: noDurationStats(),
            extended: noDurationStats(),
            open: noOpenStats(),
          },
          {
            delayType: 'LATE_SUBMISSION',
            incidentCount: 0,
            recovered: noDurationStats(),
            extended: noDurationStats(),
            open: noOpenStats(),
          },
        ],
      },
      operational: { ...noGroup(), byReason: [] },
    };

    const report = await service.getOwnStaffReport(STAFF, { requestedRange: range });

    expect(report.lateness.staffResponsibility.byType.map(({ delayType }) => delayType))
      .toEqual(['LATE_START', 'LATE_SUBMISSION']);
    expect(report.lateness.operational).toEqual({
      delayedJobCount: 0,
      incidentCount: 0,
      byReason: [],
    });
    expect(reports.getStaffLatenessSummary).toHaveBeenCalledOnce();
  });

  it('fails closed when the type breakdown does not sum to the group incident count', async () => {
    const { service, state } = createService();
    state.staffLateness.staffResponsibility.byType[0]!.incidentCount = 2;

    await expectFailClosed(() => service.getStaffReport(MANAGER, STAFF_ONE, staffQuery));
  });

  it('fails closed when a type does not reconcile its outcomes', async () => {
    const { service, state } = createService();
    state.staffLateness.staffResponsibility.byType[1]!.open.count = 2;

    await expectFailClosed(() => service.getStaffReport(MANAGER, STAFF_ONE, staffQuery));
  });

  it('fails closed when the operational reasons do not sum to the operational count', async () => {
    const { service, state } = createService();
    state.staffLateness.operational.byReason[0]!.incidentCount = 2;

    await expectFailClosed(() => service.getStaffReport(MANAGER, STAFF_ONE, staffQuery));
  });

  it('fails closed when an operational reason row has a zero count', async () => {
    const { service, state } = createService();
    state.staffLateness.operational.byReason.push({ reasonCode: 'OTHER', incidentCount: 0 });

    await expectFailClosed(() => service.getStaffReport(MANAGER, STAFF_ONE, staffQuery));
  });

  it('fails closed when a delayed-job count exceeds its incident count', async () => {
    const staffGroup = createService();
    staffGroup.state.staffLateness.staffResponsibility.delayedJobCount = 4;
    await expectFailClosed(() => staffGroup.service.getStaffReport(
      MANAGER,
      STAFF_ONE,
      staffQuery,
    ));

    const operationalGroup = createService();
    operationalGroup.state.staffLateness.operational.delayedJobCount = 2;
    await expectFailClosed(() => operationalGroup.service.getStaffReport(
      MANAGER,
      STAFF_ONE,
      staffQuery,
    ));
  });

  it('fails closed when a delayed-job count disagrees with an empty incident group', async () => {
    const nonEmptyIncidents = createService();
    // 3 incidents but no delayed job: a job must exist for every incident.
    nonEmptyIncidents.state.staffLateness.staffResponsibility.delayedJobCount = 0;
    await expectFailClosed(() => nonEmptyIncidents.service.getStaffReport(
      MANAGER,
      STAFF_ONE,
      staffQuery,
    ));

    const nonEmptyJobs = createService();
    nonEmptyJobs.state.staffLateness.staffResponsibility.byType = [{
      delayType: 'LATE_START',
      incidentCount: 0,
      recovered: noDurationStats(),
      extended: noDurationStats(),
      open: noOpenStats(),
    }, {
      delayType: 'LATE_SUBMISSION',
      incidentCount: 0,
      recovered: noDurationStats(),
      extended: noDurationStats(),
      open: noOpenStats(),
    }];
    nonEmptyJobs.state.staffLateness.staffResponsibility.incidentCount = 0;
    nonEmptyJobs.state.staffLateness.staffResponsibility.delayedJobCount = 1;
    await expectFailClosed(() => nonEmptyJobs.service.getStaffReport(
      MANAGER,
      STAFF_ONE,
      staffQuery,
    ));
  });

  it('returns the organization card with its range, tracking start and request instant', async () => {
    const { service, reports } = createService();

    const card = await service.getOrganizationLateness(MANAGER, { requestedRange: range });

    expect(card).toEqual({
      ...organizationLatenessAggregate(),
      trackingStartedOn: '2026-09-21',
      generatedAt: '2026-11-05T09:00:00.000Z',
    });
    expect(card.range).toEqual(range);
    expect(reports.getOrganizationLatenessSummary).toHaveBeenCalledWith({
      organizationId: ORG_ONE,
      requestedRange: range,
      requestTime,
    });
  });

  it('fails closed unless the four organization groups reconcile to the total', async () => {
    const overCount = createService();
    overCount.state.organizationLateness.totalIncidentCount = 7;
    await expectFailClosed(() => overCount.service.getOrganizationLateness(
      MANAGER,
      { requestedRange: range },
    ));

    const underCount = createService();
    underCount.state.organizationLateness.managementApprovalWait.incidentCount = 2;
    await expectFailClosed(() => underCount.service.getOrganizationLateness(
      MANAGER,
      { requestedRange: range },
    ));
  });

  it.each([
    'staffResponsibility',
    'operational',
    'unknownAccountability',
    'managementApprovalWait',
  ] as const)(
    'fails closed when the %s group contradicts its own counts',
    async (group) => {
      const exceeded = createService();
      exceeded.state.organizationLateness[group].delayedJobCount =
        exceeded.state.organizationLateness[group].incidentCount + 1;
      await expectFailClosed(() => exceeded.service.getOrganizationLateness(
        MANAGER,
        { requestedRange: range },
      ));

      const zeroJobs = createService();
      zeroJobs.state.organizationLateness[group].delayedJobCount = 0;
      expect(zeroJobs.state.organizationLateness[group].incidentCount).toBeGreaterThan(0);
      await expectFailClosed(() => zeroJobs.service.getOrganizationLateness(
        MANAGER,
        { requestedRange: range },
      ));
    },
  );
});

describe('ReportsService lateness access rules', () => {
  it('fails closed when a management approval wait is neither recovered nor open', async () => {
    const { service, state } = createService();
    // APPROVAL_WAIT cannot be ended by OVR-5; an unaccounted row must not pass.
    state.organizationLateness.managementApprovalWait.recovered = noDurationStats();

    await expectFailClosed(() => service.getOrganizationLateness(MANAGER, { requestedRange: range }));
  });

  it('denies Staff the organization card and the management Staff path', async () => {
    const { service, reports } = createService();

    await expect(service.getOrganizationLateness(STAFF, { requestedRange: range }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    await expect(service.listStaffLatenessIncidents(STAFF, STAFF_ONE, incidentQuery))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(reports.getOrganizationLatenessSummary).not.toHaveBeenCalled();
    expect(reports.listStaffLatenessIncidents).not.toHaveBeenCalled();
  });

  it('denies management the self-only lateness list', async () => {
    const { service, reports } = createService();

    await expect(service.listOwnLatenessIncidents(MANAGER, incidentQuery))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    await expect(service.listOwnLatenessIncidents(ADMIN, incidentQuery))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(reports.listStaffLatenessIncidents).not.toHaveBeenCalled();
  });

  it('conceals an unknown or non-Staff target with the existing 404 before listing', async () => {
    const { service, reports } = createService();

    await expect(service.listStaffLatenessIncidents(MANAGER, MISSING_STAFF, incidentQuery))
      .rejects.toMatchObject({
        code: 'STAFF_PROFILE_NOT_FOUND',
        statusCode: 404,
        message: 'Personel profili bulunamadı.',
      });
    expect(reports.listStaffLatenessIncidents).not.toHaveBeenCalled();
  });

  it('forces the authenticated Staff id and passes the viewer to the read model', async () => {
    const { service, reports } = createService();

    const own = await service.listOwnLatenessIncidents(STAFF, incidentQuery);

    expect(own).toEqual(incidentList);
    expect(reports.listStaffLatenessIncidents).toHaveBeenCalledWith({
      organizationId: ORG_ONE,
      staffUserId: STAFF_ONE,
      requestedRange: incidentQuery.requestedRange,
      includeSaleCapability: true,
      requestTime,
      limit: 20,
      offset: 0,
      viewer: { role: 'STAFF', userId: STAFF_ONE },
    });

    await expect(service.listStaffLatenessIncidents(MANAGER, STAFF_ONE, incidentQuery))
      .resolves.toEqual(incidentList);
    expect(reports.listStaffLatenessIncidents).toHaveBeenLastCalledWith({
      organizationId: ORG_ONE,
      staffUserId: STAFF_ONE,
      requestedRange: incidentQuery.requestedRange,
      includeSaleCapability: true,
      requestTime,
      limit: 20,
      offset: 0,
      viewer: { role: 'MANAGER', userId: MANAGER.id },
    });
  });
});
