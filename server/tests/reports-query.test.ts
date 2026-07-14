import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ApprovalQueueItemPort,
  ReportsReadModel,
  StaffOperationalSummaryPort,
} from '../src/modules/reports/ports.js';
import {
  parseApprovalReportQuery,
  parseDashboardReportQuery,
  parseDeliveryReportQuery,
  parseStaffReportPathId,
  parseStaffReportQuery,
} from '../src/modules/reports/query.js';
import type {
  ApprovalItem,
  DeliveryPurposeItem,
  DeliveryReportResponse,
  StaffOperationalSummary,
} from '../src/modules/reports/types.js';

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const validation = expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 });
const concealed = expect.objectContaining({
  code: 'STAFF_PROFILE_NOT_FOUND',
  statusCode: 404,
});

describe('Reports range queries', () => {
  it('uses a null requested range when both date parameters are omitted', () => {
    expect(parseDashboardReportQuery({})).toEqual({ requestedRange: null });
    expect(parseStaffReportQuery({})).toEqual({ requestedRange: null });
  });

  it('accepts strict paired dates and an inclusive 366-date range', () => {
    expect(parseDashboardReportQuery({ from: '2024-02-29', to: '2025-02-28' }))
      .toEqual({ requestedRange: { from: '2024-02-29', to: '2025-02-28' } });
    expect(parseStaffReportQuery({ from: '2026-07-14', to: '2026-07-14' }))
      .toEqual({ requestedRange: { from: '2026-07-14', to: '2026-07-14' } });
  });

  it.each([
    { from: '2026-07-01' },
    { to: '2026-07-31' },
    { from: '2025-02-29', to: '2025-03-01' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-7-01', to: '2026-07-31' },
    { from: '2026-07-01T00:00:00Z', to: '2026-07-31' },
    { from: '2026-07-31', to: '2026-07-01' },
    { from: '2024-02-29', to: '2025-03-01' },
  ])('rejects invalid range %j', (raw) => {
    expect(() => parseDashboardReportQuery(raw)).toThrowError(validation);
  });

  it.each([null, [], 'from=2026-07-01', 12])('rejects non-record query %j', (raw) => {
    expect(() => parseDashboardReportQuery(raw)).toThrowError(validation);
  });
});

describe('Reports exact scalar allowlists', () => {
  const endpoints = [
    {
      name: 'dashboard',
      parse: parseDashboardReportQuery,
      fields: ['from', 'to'],
    },
    {
      name: 'staff',
      parse: parseStaffReportQuery,
      fields: ['from', 'to'],
    },
    {
      name: 'deliveries',
      parse: parseDeliveryReportQuery,
      fields: ['from', 'to', 'groupBy', 'staffUserId', 'limit', 'offset'],
    },
    {
      name: 'approvals',
      parse: parseApprovalReportQuery,
      fields: ['limit', 'offset'],
    },
  ] as const;

  for (const endpoint of endpoints) {
    it(`rejects unknown keys for ${endpoint.name}`, () => {
      expect(() => endpoint.parse({ unexpected: 'value' })).toThrowError(validation);
    });

    it(`rejects every repeated scalar before coercion for ${endpoint.name}`, () => {
      for (const field of endpoint.fields) {
        expect(() => endpoint.parse({ [field]: ['same', 'same'] }))
          .toThrowError(validation);
      }
    });
  }
});

describe('Delivery report query', () => {
  it.each(['day', 'purpose', 'product', 'staff'] as const)
    ('accepts group %s with exact defaults', (groupBy) => {
      expect(parseDeliveryReportQuery({ groupBy })).toEqual({
        requestedRange: null,
        groupBy,
        staffUserId: null,
        limit: 50,
        offset: 0,
      });
    });

  it('accepts an inactive-capable Staff UUID filter as a syntactic value', () => {
    expect(parseDeliveryReportQuery({
      groupBy: 'purpose',
      staffUserId: STAFF_ID,
      from: '2026-07-01',
      to: '2026-07-31',
      limit: '200',
      offset: '12',
    })).toEqual({
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
      groupBy: 'purpose',
      staffUserId: STAFF_ID,
      limit: 200,
      offset: 12,
    });
  });

  it.each([{}, { groupBy: '' }, { groupBy: 'week' }])
    ('rejects missing or invalid grouping %j', (raw) => {
      expect(() => parseDeliveryReportQuery(raw)).toThrowError(validation);
    });

  it.each(['', 'bad', '11111111-1111-4111-8111'])
    ('rejects invalid Staff query UUID %j', (staffUserId) => {
      expect(() => parseDeliveryReportQuery({ groupBy: 'day', staffUserId }))
        .toThrowError(validation);
    });

  it.each([['1', 1], ['200', 200]])('accepts limit %s', (limit, expected) => {
    expect(parseDeliveryReportQuery({ groupBy: 'day', limit }).limit).toBe(expected);
  });

  it.each(['0', '201', '-1', '1.5', '9007199254740992'])
    ('rejects limit %s', (limit) => {
      expect(() => parseDeliveryReportQuery({ groupBy: 'day', limit }))
        .toThrowError(validation);
    });

  it.each([['0', 0], ['42', 42]])('accepts offset %s', (offset, expected) => {
    expect(parseDeliveryReportQuery({ groupBy: 'day', offset }).offset).toBe(expected);
  });

  it.each(['-1', '1.5', '9007199254740992'])('rejects offset %s', (offset) => {
    expect(() => parseDeliveryReportQuery({ groupBy: 'day', offset }))
      .toThrowError(validation);
  });
});

describe('Approval report query', () => {
  it('uses canonical pagination defaults', () => {
    expect(parseApprovalReportQuery({})).toEqual({ limit: 50, offset: 0 });
  });

  it('enforces the same pagination boundaries as deliveries', () => {
    expect(parseApprovalReportQuery({ limit: '1', offset: '0' }))
      .toEqual({ limit: 1, offset: 0 });
    expect(parseApprovalReportQuery({ limit: '200', offset: '42' }))
      .toEqual({ limit: 200, offset: 42 });
    expect(() => parseApprovalReportQuery({ limit: '0' })).toThrowError(validation);
    expect(() => parseApprovalReportQuery({ limit: '201' })).toThrowError(validation);
    expect(() => parseApprovalReportQuery({ offset: '-1' })).toThrowError(validation);
  });
});

describe('Staff report path concealment', () => {
  it('returns a valid path UUID unchanged', () => {
    expect(parseStaffReportPathId(STAFF_ID)).toBe(STAFF_ID);
  });

  it.each(['', 'bad', '11111111-1111-4111-8111', null, undefined, [STAFF_ID]])
    ('conceals malformed path value %j as not found', (value) => {
      expect(() => parseStaffReportPathId(value)).toThrowError(concealed);
    });
});

describe('Canonical Reports type contracts', () => {
  it('keeps delivery quantity text and the exact discriminated shapes', () => {
    const purpose: DeliveryPurposeItem = { purpose: 'SALE', unit: null, quantity: '3.000' };
    const responses: DeliveryReportResponse[] = [
      { groupBy: 'day', items: [], range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' }, total: 0, limit: 50, offset: 0 },
      { groupBy: 'purpose', items: [purpose], range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' }, total: 1, limit: 50, offset: 0 },
      { groupBy: 'product', items: [], range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' }, total: 0, limit: 50, offset: 0 },
      { groupBy: 'staff', items: [], range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' }, total: 0, limit: 50, offset: 0 },
    ];

    expect(purpose.quantity).toBe('3.000');
    expect(responses.map(({ groupBy }) => groupBy))
      .toEqual(['day', 'purpose', 'product', 'staff']);
  });

  it('exposes the exact read ports without a runtime dependency', () => {
    expectTypeOf<ReportsReadModel>().toMatchTypeOf<StaffOperationalSummaryPort>();
    expectTypeOf<ApprovalQueueItemPort['getApprovalItems']>()
      .returns.resolves.toEqualTypeOf<ApprovalItem[]>();
    expectTypeOf<StaffOperationalSummaryPort['getOne']>()
      .returns.resolves.toEqualTypeOf<StaffOperationalSummary | null>();
  });
});
