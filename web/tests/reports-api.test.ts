import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getApprovalReport,
  getCustomerReport,
  getDashboardReport,
  getDeliveryReport,
  getOwnStaffReport,
  getStaffPerformance,
  getStaffReport,
  parseApprovalReport,
  parseCustomerReport,
  parseDashboardReport,
  parseDeliveryReport,
  parseStaffPerformance,
  parseStaffReport,
} from '../src/reports/reports-api';

afterEach(() => vi.unstubAllGlobals());

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const range = { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' };
const priorRange = { from: '2026-05-31', to: '2026-06-30', timezone: 'Europe/Istanbul' };
const performance = {
  completedJobs: 4, completionDays: 2, jobsPerCompletionDay: 2,
  correctionRequestEvents: 1, authoredOperationalNotes: 3,
};
const priorPerformance = {
  available: true,
  performance: { completedJobs: 0, completionDays: 0, jobsPerCompletionDay: 0,
    correctionRequestEvents: 0, authoredOperationalNotes: 0 },
};
const staffExecution = { staffCompletedJobs: 3,
  staffCompletionDays: 2, jobsPerStaffCompletionDay: 1.5,
  missingStaffCompletionTimestamp: 1 };
const staffSubmissionAttribution = { recordedSubmissionCount: 2, recordedSubmissionDays: 2 };
const onTime = { eligibleScheduledCompletedJobs: 3, onTimeCompletedJobs: 2,
  lateCompletedJobs: 1, ineligibleOrNoDeadlineCompletedJobs: 1, onTimeRate: 2 / 3 };
const currentWorkload = { openJobCards: 3, waitingApproval: 2, revisionRequested: 1,
  overdueJobCards: 1 };
const completionWorkTypes = [
  { type: 'PRODUCT_DELIVERY', count: 2 },
  { type: 'GENERAL_TASK', count: 2 },
  { type: 'SALES_MEETING', count: 0 },
] as const;
const currentWorkloadByType = [
  { type: 'PRODUCT_DELIVERY', count: 2 },
  { type: 'GENERAL_TASK', count: 2 },
  { type: 'SALES_MEETING', count: 2 },
] as const;
const completedTrend = [{ date: '2026-07-01', count: 0 },
  { date: '2026-07-02', count: 4 }];
const dailyCreatedTrend = [{ date: '2026-07-01', count: 2 },
  { date: '2026-07-02', count: 0 }];
const activeStatusDistribution = [
  { status: 'NEW', count: 1 },
  { status: 'ACCEPTED', count: 0 },
  { status: 'IN_PROGRESS', count: 2 },
  { status: 'WAITING_APPROVAL', count: 1 },
  { status: 'REVISION_REQUESTED', count: 0 },
] as const;
const createdWorkTypeDistribution = [
  { type: 'PRODUCT_DELIVERY', count: 2 },
  { type: 'GENERAL_TASK', count: 0 },
  { type: 'SALES_MEETING', count: 1 },
] as const;
const listItem = {
  id: 'job-1', type: 'GENERAL_TASK', status: 'WAITING_APPROVAL', version: 7,
  title: 'Klinik ziyareti', priority: 'urgent', dueDate: '2026-07-20',
  scheduledAt: '2026-07-20T09:00:00.000Z',
  scheduledEndsAt: null,
  engagementKind: null,
  createdAt: '2026-07-10T10:00:00.000Z', updatedAt: '2026-07-13T10:00:00.000Z',
  staffCompletedAt: '2026-07-12T10:00:00.000Z', customer: null, contact: null,
  assignee: { id: STAFF_ID, name: 'Emrah Demir' }, deliveryItemCount: 0,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Reports runtime contract', () => {
  it('strictly parses dashboard and Staff report DTOs', () => {
    const dashboard = {
      range,
      counters: { activeJobCards: 8, overdueJobCards: 2, waitingApproval: 3,
        revisionRequested: 1, completedInPeriod: 5, cancelledInPeriod: 1 },
      completedTrend: [{ date: '2026-07-14', count: 2 }],
      dailyCreatedTrend,
      activeStatusDistribution,
      createdWorkTypeDistribution,
    };
    expect(parseDashboardReport(dashboard)).toEqual(dashboard);
    expect(() => parseDashboardReport({ ...dashboard, unexpected: true }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));

    const staff = {
      staff: { userId: STAFF_ID, name: 'Emrah Demir', isActive: false },
      range,
      priorRange,
      performance,
      priorPerformance,
      staffExecution,
      staffSubmissionAttribution,
      onTime,
      completionWorkTypes,
      currentWorkloadByType,
      completedTrend,
      deliveriesByPurpose: [{ purpose: 'SALE', unit: null, quantity: '12.500' }],
      meetingsByOutcome: [
        { outcome: 'POSITIVE', count: 1 },
        { outcome: 'FOLLOW_UP_REQUIRED', count: 2 },
        { outcome: 'NO_DECISION', count: 0 },
        { outcome: 'NOT_INTERESTED', count: 0 },
      ],
      currentWorkload,
    };
    expect(parseStaffReport(staff)).toEqual(staff);
    expect(() => parseStaffReport({ ...staff, staff: { ...staff.staff, role: 'STAFF' } }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));

    for (const meetingsByOutcome of [
      staff.meetingsByOutcome.slice(0, 3),
      [...staff.meetingsByOutcome, { outcome: 'FUTURE', count: 0 }],
      staff.meetingsByOutcome.map((item, index) => index === 3
        ? { outcome: 'NO_DECISION', count: 0 } : item),
      staff.meetingsByOutcome.map((item, index) => index === 0
        ? { ...item, count: -1 } : item),
    ]) {
      expect(() => parseStaffReport({ ...staff, meetingsByOutcome }))
        .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    }

    const managerWide = {
      range,
      priorRange,
      items: [{
        staff: staff.staff,
        performance,
        priorPerformance,
        staffExecution,
        staffSubmissionAttribution,
        onTime,
        completionWorkTypes,
        currentWorkloadByType,
        currentWorkload,
      }],
    };
    expect(parseStaffPerformance(managerWide)).toEqual(managerWide);
    expect(() => parseStaffPerformance({ ...managerWide, items: [{
      ...managerWide.items[0],
      performance: { ...performance, jobsPerCompletionDay: -1 },
    }] })).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));

    expect(() => parseStaffPerformance({ ...managerWide, items: [{
      ...managerWide.items[0],
      priorPerformance: { available: true, performance: null },
    }] })).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => parseStaffPerformance({ ...managerWide, items: [{
      ...managerWide.items[0],
      priorPerformance: { available: false, performance: priorPerformance.performance },
    }] })).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => parseStaffPerformance({ ...managerWide, items: [{
      ...managerWide.items[0],
      onTime: { ...onTime, eligibleScheduledCompletedJobs: 4 },
    }] })).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => parseStaffPerformance({ ...managerWide, items: [{
      ...managerWide.items[0],
      onTime: { eligibleScheduledCompletedJobs: 0, onTimeCompletedJobs: 0,
        lateCompletedJobs: 0, ineligibleOrNoDeadlineCompletedJobs: 4, onTimeRate: 0 },
    }] })).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => parseStaffPerformance({ ...managerWide, items: [{
      ...managerWide.items[0],
      onTime: { ...onTime, onTimeRate: 0.5 },
    }] })).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => parseStaffPerformance({ ...managerWide, items: [{
      ...managerWide.items[0],
      staffExecution: { ...staffExecution, jobsPerStaffCompletionDay: 2 },
    }] })).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  it.each([
    ['day', [{ date: '2026-07-14', unit: null, quantity: '0.500' }]],
    ['purpose', [{ purpose: 'SALE', unit: 'Kutu', quantity: '3.000' }]],
    ['product', [{ productId: PRODUCT_ID, productNameSnapshot: 'İmplant Seti',
      productSkuSnapshot: null, productModelSnapshot: null, unit: 'Kutu', quantity: '12.500' }]],
    ['staff', [{ staff: { userId: STAFF_ID, name: 'Emrah Demir', isActive: true },
      unit: 'Kutu', quantity: '3.000' }]],
  ] as const)('parses only the exact %s delivery shape', (groupBy, items) => {
    const value = { groupBy, items, range, total: 1, limit: 50, offset: 0 };
    expect(parseDeliveryReport(value)).toEqual(value);
    expect(() => parseDeliveryReport({ ...value, unexpected: true }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => parseDeliveryReport({ ...value,
      items: [{ ...items[0], unexpected: true }] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  it('rejects cross-shape, non-decimal quantity, and invalid page fields', () => {
    const base = { range, total: 1, limit: 50, offset: 0 };
    expect(() => parseDeliveryReport({ ...base, groupBy: 'day',
      items: [{ purpose: 'SALE', unit: null, quantity: '3.000' }] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => parseDeliveryReport({ ...base, groupBy: 'purpose',
      items: [{ purpose: 'SALE', unit: null, quantity: 3 }] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => parseDeliveryReport({ ...base, groupBy: 'purpose', limit: 0, items: [] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => parseDeliveryReport({ ...base, groupBy: 'purpose', limit: 201, items: [] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => parseDeliveryReport({ ...base, groupBy: 'unknown', items: [] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  it('parses approval rows through the all-type JobCard list projection', () => {
    const value = {
      summary: { pendingCount: 1, oldestWaitingMinutes: 120,
        averageWaitingMinutes: 120, under2Hours: 0, between2And8Hours: 1,
        between8And24Hours: 0, over24Hours: 0 },
      items: [{ ...listItem, waitingMinutes: 120 }], total: 1, limit: 50, offset: 0,
    };
    expect(parseApprovalReport(value)).toEqual(value);
    expect(() => parseApprovalReport({ ...value,
      items: [{ ...listItem, waitingMinutes: 1.5 }] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  it('parses canonical approval items with a scheduled end timestamp', () => {
    const item = {
      ...listItem,
      scheduledEndsAt: '2026-07-20T11:00:00.000Z',
      waitingMinutes: 120,
    };
    const value = {
      summary: { pendingCount: 1, oldestWaitingMinutes: 120,
        averageWaitingMinutes: 120, under2Hours: 0, between2And8Hours: 1,
        between8And24Hours: 0, over24Hours: 0 },
      items: [item], total: 1, limit: 50, offset: 0,
    };
    expect(parseApprovalReport(value)).toEqual(value);
    expect(parseApprovalReport(value).items[0]!.scheduledEndsAt)
      .toBe('2026-07-20T11:00:00.000Z');
  });

  it('builds each request with one encoded scalar and preserves API errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ range, counters: { activeJobCards: 0,
        overdueJobCards: 0, waitingApproval: 0, revisionRequested: 0,
        completedInPeriod: 0, cancelledInPeriod: 0 }, completedTrend: [],
        dailyCreatedTrend: [], activeStatusDistribution: [
          { status: 'NEW', count: 0 }, { status: 'ACCEPTED', count: 0 },
          { status: 'IN_PROGRESS', count: 0 }, { status: 'WAITING_APPROVAL', count: 0 },
          { status: 'REVISION_REQUESTED', count: 0 },
        ], createdWorkTypeDistribution: [
          { type: 'PRODUCT_DELIVERY', count: 0 }, { type: 'GENERAL_TASK', count: 0 },
          { type: 'SALES_MEETING', count: 0 },
        ] }))
      .mockResolvedValueOnce(response({ range, items: [{
        staff: { userId: STAFF_ID, name: 'Emrah', isActive: true },
        performance, priorPerformance, staffExecution, staffSubmissionAttribution, onTime,
        completionWorkTypes, currentWorkloadByType, currentWorkload,
      }], priorRange }))
      .mockResolvedValueOnce(response({ staff: { userId: STAFF_ID, name: 'Emrah', isActive: true },
        range, priorRange, performance, priorPerformance, staffExecution,
        staffSubmissionAttribution, onTime, completionWorkTypes, currentWorkloadByType,
        completedTrend, currentWorkload,
        deliveriesByPurpose: [], meetingsByOutcome: [
          { outcome: 'POSITIVE', count: 0 }, { outcome: 'FOLLOW_UP_REQUIRED', count: 0 },
          { outcome: 'NO_DECISION', count: 0 }, { outcome: 'NOT_INTERESTED', count: 0 },
        ] }))
      .mockResolvedValueOnce(response({ staff: { userId: STAFF_ID, name: 'Emrah', isActive: true },
        range, priorRange, performance, priorPerformance, staffExecution,
        staffSubmissionAttribution, onTime, completionWorkTypes, currentWorkloadByType,
        completedTrend, currentWorkload,
        deliveriesByPurpose: [], meetingsByOutcome: [
          { outcome: 'POSITIVE', count: 0 }, { outcome: 'FOLLOW_UP_REQUIRED', count: 0 },
          { outcome: 'NO_DECISION', count: 0 }, { outcome: 'NOT_INTERESTED', count: 0 },
        ] }))
      .mockResolvedValueOnce(response({ groupBy: 'staff', items: [], range,
        total: 0, limit: 25, offset: 10 }))
      .mockResolvedValueOnce(response({ summary: { pendingCount: 0,
        oldestWaitingMinutes: null, averageWaitingMinutes: null, under2Hours: 0,
        between2And8Hours: 0, between8And24Hours: 0, over24Hours: 0 },
      items: [], total: 0, limit: 25, offset: 10 }))
      .mockResolvedValueOnce(response({ error: 'Personel profili bulunamadı.',
        code: 'STAFF_PROFILE_NOT_FOUND' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await getDashboardReport({ from: '2026-07-01', to: '2026-07-31' });
    await getStaffPerformance({ from: '2026-07-01', to: '2026-07-31' });
    await getOwnStaffReport(null);
    await getStaffReport(STAFF_ID, null);
    await getDeliveryReport({ groupBy: 'staff', staffUserId: STAFF_ID,
      requestedRange: null, limit: 25, offset: 10 });
    await getApprovalReport({ limit: 25, offset: 10 });
    await expect(getStaffReport('missing', null)).rejects.toMatchObject({
      status: 404, code: 'STAFF_PROFILE_NOT_FOUND',
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/reports/dashboard?from=2026-07-01&to=2026-07-31',
      '/api/reports/staff?from=2026-07-01&to=2026-07-31',
      '/api/reports/staff/me',
      `/api/reports/staff/${STAFF_ID}`,
      `/api/reports/deliveries?groupBy=staff&staffUserId=${STAFF_ID}&limit=25&offset=10`,
      '/api/reports/approvals?limit=25&offset=10',
      '/api/reports/staff/missing',
    ]);
  });

  it('never converts or recomputes report quantities in the client parser', async () => {
    const source = await readFile(
      new URL('../src/reports/reports-api.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/(?:Number|parseFloat)\s*\([^)]*quantity/i);
  });
});

describe('Customer report runtime contract', () => {
  const customerSnapshot = { active: 4, actionable: 2, waitingApproval: 1,
    revisionRequested: 0, overdue: 1 };
  const customerPeriod = { created: 3,
    createdWorkTypes: { PRODUCT_DELIVERY: 2, GENERAL_TASK: 1, SALES_MEETING: 0 },
    managerApproved: 2, followUpChildren: 1 };
  const customerItem = { customer: { id: 'customer-1', name: 'Klinik A',
    customerType: 'clinic', status: 'active' },
  activity: { snapshot: customerSnapshot, period: customerPeriod } };
  const base = () => ({ range, total: 2, limit: 50, offset: 0,
    items: [customerItem], unassigned: { snapshot: customerSnapshot,
      period: customerPeriod } });

  it('strictly parses a canonical customer report with reconciliation', () => {
    expect(parseCustomerReport(base())).toEqual(base());
  });

  it('accepts an empty customer page with valid totals', () => {
    const value = { range, total: 2, limit: 1, offset: 2, items: [],
      unassigned: { snapshot: customerSnapshot, period: customerPeriod } };
    expect(parseCustomerReport(value)).toEqual(value);
  });

  it('rejects malformed customer rows, snapshots, and page fields', () => {
    const cases: Array<[string, unknown]> = [
      ['unknown top-level key', { ...base(), surprise: 1 }],
      ['unknown item key', { ...base(), items: [{ ...customerItem, extra: 1 }] }],
      ['invalid status', { ...base(), items: [{ ...customerItem,
        customer: { ...customerItem.customer, status: 'archived' } }] }],
      ['invalid customerType', { ...base(), items: [{ ...customerItem,
        customer: { ...customerItem.customer, customerType: 'lab' } }] }],
      ['unknown snapshot key', { ...base(), items: [{ ...customerItem,
        activity: { ...customerItem.activity, snapshot: { ...customerSnapshot,
          surprise: 0 } } }] }],
      ['fractional snapshot count', { ...base(), items: [{ ...customerItem,
        activity: { ...customerItem.activity, snapshot: { ...customerSnapshot,
          active: 1.5 } } }] }],
      ['negative snapshot count', { ...base(), items: [{ ...customerItem,
        activity: { ...customerItem.activity, snapshot: { ...customerSnapshot,
          overdue: -1 } } }] }],
      ['unknown work type key', { ...base(), items: [{ ...customerItem,
        activity: { ...customerItem.activity, period: { ...customerPeriod,
          createdWorkTypes: { ...customerPeriod.createdWorkTypes, LAB: 0 } } } }] }],
      ['missing work type key', { ...base(), items: [{ ...customerItem,
        activity: { ...customerItem.activity, period: { ...customerPeriod,
          createdWorkTypes: { PRODUCT_DELIVERY: 0, GENERAL_TASK: 0 } } } }] }],
      ['negative period count', { ...base(), items: [{ ...customerItem,
        activity: { ...customerItem.activity, period: { ...customerPeriod,
          managerApproved: -1 } } }] }],
      ['missing unassigned', { ...base(), unassigned: undefined }],
      ['unknown unassigned key', { ...base(), unassigned: { snapshot: customerSnapshot,
        period: customerPeriod, surprise: 0 } }],
      ['negative unassigned count', { ...base(), unassigned: { snapshot: {
        ...customerSnapshot, active: -1 }, period: customerPeriod } }],
      ['limit over 200', { ...base(), limit: 201 }],
      ['fractional offset', { ...base(), offset: 0.5 }],
    ];
    for (const [name, value] of cases) {
      expect(() => parseCustomerReport(value))
        .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    }
  });

  it('builds one encoded customer request with every meaningful filter', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(base()));
    vi.stubGlobal('fetch', fetchMock);
    await getCustomerReport({ search: 'Klinik', status: 'active', customerType: 'clinic',
      requestedRange: null, limit: 25, offset: 10 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/reports/customers?search=Klinik&status=active&type=clinic&limit=25&offset=10',
    ]);
  });
});
