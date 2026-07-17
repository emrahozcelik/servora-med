import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getApprovalReport,
  getDashboardReport,
  getDeliveryReport,
  getOwnStaffReport,
  getStaffReport,
  parseApprovalReport,
  parseDashboardReport,
  parseDeliveryReport,
  parseStaffReport,
} from '../src/reports/reports-api';

afterEach(() => vi.unstubAllGlobals());

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const range = { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' };
const counters = {
  openJobCards: 3, waitingApproval: 2, revisionRequested: 1,
  overdueJobCards: 1, completedInPeriod: 4,
};
const listItem = {
  id: 'job-1', type: 'GENERAL_TASK', status: 'WAITING_APPROVAL', version: 7,
  title: 'Klinik ziyareti', priority: 'urgent', dueDate: '2026-07-20',
  scheduledAt: '2026-07-20T09:00:00.000Z',
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
    };
    expect(parseDashboardReport(dashboard)).toEqual(dashboard);
    expect(() => parseDashboardReport({ ...dashboard, unexpected: true }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));

    const staff = {
      staff: { userId: STAFF_ID, name: 'Emrah Demir', isActive: false },
      range,
      counters,
      deliveriesByPurpose: [{ purpose: 'SALE', unit: null, quantity: '12.500' }],
      meetingsByOutcome: [
        { outcome: 'POSITIVE', count: 1 },
        { outcome: 'FOLLOW_UP_REQUIRED', count: 2 },
        { outcome: 'NO_DECISION', count: 0 },
        { outcome: 'NOT_INTERESTED', count: 0 },
      ],
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

  it('builds each request with one encoded scalar and preserves API errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ range, counters: { activeJobCards: 0,
        overdueJobCards: 0, waitingApproval: 0, revisionRequested: 0,
        completedInPeriod: 0, cancelledInPeriod: 0 }, completedTrend: [] }))
      .mockResolvedValueOnce(response({ staff: { userId: STAFF_ID, name: 'Emrah', isActive: true },
        range, counters, deliveriesByPurpose: [], meetingsByOutcome: [
          { outcome: 'POSITIVE', count: 0 }, { outcome: 'FOLLOW_UP_REQUIRED', count: 0 },
          { outcome: 'NO_DECISION', count: 0 }, { outcome: 'NOT_INTERESTED', count: 0 },
        ] }))
      .mockResolvedValueOnce(response({ staff: { userId: STAFF_ID, name: 'Emrah', isActive: true },
        range, counters, deliveriesByPurpose: [], meetingsByOutcome: [
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
