import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getLatenessSummary,
  listOwnLatenessIncidents,
  listStaffLatenessIncidents,
  parseOrganizationLatenessSummary,
  parseStaffLatenessIncidentList,
  parseStaffLatenessSummary,
  parseStaffReport,
} from '../src/reports/reports-api';

afterEach(() => vi.unstubAllGlobals());

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const range = { from: '2026-10-01', to: '2026-10-31', timezone: 'Europe/Istanbul' };

const staffLateness = {
  trackingStartedOn: '2026-09-21',
  generatedAt: '2026-11-02T09:15:00.000Z',
  staffResponsibility: {
    delayedJobCount: 2,
    incidentCount: 3,
    byType: [
      {
        delayType: 'LATE_START',
        incidentCount: 2,
        recovered: { count: 1, medianSeconds: 8_100, maxSeconds: 8_100 },
        extended: { count: 1, medianSeconds: 90_000, maxSeconds: 90_000 },
        open: { count: 0, maxElapsedSeconds: null },
      },
      {
        delayType: 'LATE_SUBMISSION',
        incidentCount: 1,
        recovered: { count: 0, medianSeconds: null, maxSeconds: null },
        extended: { count: 0, medianSeconds: null, maxSeconds: null },
        open: { count: 1, maxElapsedSeconds: 7_200 },
      },
    ],
  },
  operational: {
    delayedJobCount: 2,
    incidentCount: 2,
    byReason: [
      { reasonCode: 'CUSTOMER_ABSENT', incidentCount: 1 },
      { reasonCode: 'MISSING_STOCK_OR_EQUIPMENT', incidentCount: 1 },
    ],
  },
} as const;

const organizationLateness = {
  range,
  trackingStartedOn: '2026-09-21',
  generatedAt: '2026-11-02T09:15:00.000Z',
  totalIncidentCount: 6,
  staffResponsibility: { delayedJobCount: 2, incidentCount: 3 },
  operational: { delayedJobCount: 1, incidentCount: 1 },
  unknownAccountability: { delayedJobCount: 1, incidentCount: 1 },
  managementApprovalWait: {
    delayedJobCount: 1,
    incidentCount: 1,
    recovered: { count: 1, medianSeconds: 3_600, maxSeconds: 3_600 },
    open: { count: 0, maxElapsedSeconds: null },
  },
} as const;

const incident = {
  incidentId: '44444444-4444-4444-8444-444444444444',
  delayType: 'LATE_START',
  episodeNo: 2,
  scheduleRevisionNo: 3,
  deadlineAt: '2026-10-20T06:00:00.000Z',
  breachedAt: '2026-10-20T06:05:00.000Z',
  outcome: 'RECOVERED',
  closedAt: '2026-10-20T07:00:00.000Z',
  durationSeconds: 3_300,
  operationalReason: {
    reasonCode: 'CUSTOMER_ABSENT',
    resolution: 'RESCHEDULED',
    resolvedAt: '2026-10-20T08:00:00.000Z',
  },
  job: {
    id: JOB_ID,
    title: 'Klinik ziyareti',
    type: 'SALES_MEETING',
    jobPath: `/jobs/${JOB_ID}`,
  },
} as const;

const incidentList = {
  range,
  items: [incident],
  total: 21,
  limit: 20,
  offset: 0,
} as const;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Staff lateness summary parser', () => {
  it('accepts the documented shape and keeps the fixed type order', () => {
    expect(parseStaffLatenessSummary(staffLateness)).toEqual(staffLateness);
  });

  it('rejects a wrong type order, unknown fields and broken group sums', () => {
    const byType = staffLateness.staffResponsibility.byType;
    for (const lateness of [
      { ...staffLateness, unexpected: true },
      {
        ...staffLateness,
        staffResponsibility: {
          ...staffLateness.staffResponsibility,
          byType: [byType[1], byType[0]],
        },
      },
      {
        ...staffLateness,
        staffResponsibility: { ...staffLateness.staffResponsibility, byType: [byType[0]] },
      },
      {
        ...staffLateness,
        staffResponsibility: { ...staffLateness.staffResponsibility, incidentCount: 4 },
      },
      {
        ...staffLateness,
        operational: { ...staffLateness.operational, incidentCount: 3 },
      },
      {
        ...staffLateness,
        staffResponsibility: {
          ...staffLateness.staffResponsibility,
          delayedJobCount: 4,
        },
      },
      {
        ...staffLateness,
        staffResponsibility: {
          ...staffLateness.staffResponsibility,
          byType: [
            { ...byType[0], open: { count: 0, maxElapsedSeconds: 60 } },
            byType[1],
          ],
        },
      },
      {
        ...staffLateness,
        operational: {
          ...staffLateness.operational,
          byReason: [{ reasonCode: 'FUTURE_REASON', incidentCount: 2 }],
        },
      },
    ]) {
      expect(() => parseStaffLatenessSummary(lateness))
        .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    }
  });
});

describe('Organization lateness summary parser', () => {
  it('accepts the documented shape', () => {
    expect(parseOrganizationLatenessSummary(organizationLateness)).toEqual(organizationLateness);
  });

  it('fails closed when the class counts do not reconcile or a group is impossible', () => {
    for (const summary of [
      { ...organizationLateness, unexpected: true },
      { ...organizationLateness, totalIncidentCount: 7 },
      {
        ...organizationLateness,
        unknownAccountability: { delayedJobCount: 2, incidentCount: 1 },
      },
      {
        ...organizationLateness,
        operational: { delayedJobCount: 1, incidentCount: 0 },
      },
      {
        ...organizationLateness,
        managementApprovalWait: {
          ...organizationLateness.managementApprovalWait,
          recovered: { count: 0, medianSeconds: 60, maxSeconds: null },
        },
      },
      {
        ...organizationLateness,
        range: { from: range.from, to: range.to },
      },
    ]) {
      expect(() => parseOrganizationLatenessSummary(summary))
        .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    }
  });
});

describe('Staff lateness incident list parser', () => {
  it('accepts closed rows, an open row and a transferred job', () => {
    const open = {
      ...incident,
      incidentId: '55555555-5555-4555-8555-555555555555',
      outcome: 'OPEN',
      closedAt: null,
      operationalReason: null,
      job: null,
    };
    expect(parseStaffLatenessIncidentList({ ...incidentList, items: [incident, open] }))
      .toEqual({ ...incidentList, items: [incident, open] });
  });

  it('rejects inconsistent outcome/closure, foreign job paths and unknown values', () => {
    for (const list of [
      { ...incidentList, unexpected: true },
      { ...incidentList, items: [{ ...incident, closedAt: null }] },
      { ...incidentList, items: [{ ...incident, outcome: 'OPEN' }] },
      {
        ...incidentList,
        items: [{ ...incident, job: { ...incident.job, jobPath: 'https://example.test/x' } }],
      },
      {
        ...incidentList,
        items: [{ ...incident, operationalReason: { ...incident.operationalReason, resolution: 'REJECTED' } }],
      },
      { ...incidentList, items: [{ ...incident, episodeNo: 0 }] },
      { ...incidentList, items: [{ ...incident, durationSeconds: -1 }] },
      { ...incidentList, items: [incident, { ...incident }], limit: 1 },
      { ...incidentList, limit: 0 },
      { ...incidentList, limit: 201 },
    ]) {
      expect(() => parseStaffLatenessIncidentList(list))
        .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    }
  });
});

describe('Lateness transport', () => {
  it('requests the organization card with the range and the Sale capability flag', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(organizationLateness));
    vi.stubGlobal('fetch', fetchMock);

    await getLatenessSummary({ from: '2026-10-01', to: '2026-10-31' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/reports/lateness?from=2026-10-01&to=2026-10-31&includeSaleCapability=true',
    ]);
  });

  it('requests management and Staff self pages of 20 with the selected range', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(incidentList))
      .mockResolvedValueOnce(response({ ...incidentList, items: [], offset: 20 }));
    vi.stubGlobal('fetch', fetchMock);

    await listStaffLatenessIncidents(STAFF_ID, { from: '2026-10-01', to: '2026-10-31' },
      { limit: 20, offset: 0 });
    await listOwnLatenessIncidents(null, { limit: 20, offset: 20 });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/reports/staff/${STAFF_ID}/lateness-incidents?from=2026-10-01&to=2026-10-31&limit=20&offset=0&includeSaleCapability=true`,
      '/api/reports/staff/me/lateness-incidents?limit=20&offset=20&includeSaleCapability=true',
    ]);
  });
});

describe('Staff report lateness requirement', () => {
  it('requires the lateness field on the Staff report', () => {
    const base = {
      staff: { userId: STAFF_ID, name: 'Emrah Demir', isActive: true },
      range,
      priorRange: { from: '2026-08-31', to: '2026-09-30', timezone: range.timezone },
      performance: {
        completedJobs: 0, completionDays: 0, jobsPerCompletionDay: 0,
        correctionRequestEvents: 0, authoredOperationalNotes: 0,
      },
      priorPerformance: { available: false, performance: null },
      staffExecution: {
        staffCompletedJobs: 0, staffCompletionDays: 0,
        jobsPerStaffCompletionDay: 0, missingStaffCompletionTimestamp: 0,
      },
      staffSubmissionAttribution: { recordedSubmissionCount: 0, recordedSubmissionDays: 0 },
      onTime: {
        eligibleScheduledCompletedJobs: 0, onTimeCompletedJobs: 0, lateCompletedJobs: 0,
        ineligibleOrNoDeadlineCompletedJobs: 0, onTimeRate: null,
      },
      completionWorkTypes: [
        { type: 'PRODUCT_DELIVERY', count: 0 },
        { type: 'GENERAL_TASK', count: 0 },
        { type: 'SALES_MEETING', count: 0 },
        { type: 'SALE', count: 0 },
      ],
      currentWorkloadByType: [
        { type: 'PRODUCT_DELIVERY', count: 0 },
        { type: 'GENERAL_TASK', count: 0 },
        { type: 'SALES_MEETING', count: 0 },
        { type: 'SALE', count: 0 },
      ],
      completedTrend: [],
      deliveriesByPurpose: [],
      meetingsByOutcome: [
        { outcome: 'POSITIVE', count: 0 },
        { outcome: 'FOLLOW_UP_REQUIRED', count: 0 },
        { outcome: 'NO_DECISION', count: 0 },
        { outcome: 'NOT_INTERESTED', count: 0 },
      ],
      currentWorkload: {
        openJobCards: 0, overdueJobCards: 0, waitingApproval: 0, revisionRequested: 0,
      },
    };

    expect(() => parseStaffReport(base))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(parseStaffReport({ ...base, lateness: staffLateness }).lateness)
      .toEqual(staffLateness);
  });
});
