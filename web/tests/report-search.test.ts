import { describe, expect, it } from 'vitest';

import {
  approvalSearch,
  customerSearch,
  dashboardSearch,
  deliverySearch,
  readApprovalSearch,
  readCustomerSearch,
  readDashboardSearch,
  readDeliverySearch,
  validateRequestedRange,
} from '../src/reports/report-search';

const STAFF_ID = '11111111-1111-4111-8111-111111111111';

describe('Report URL state', () => {
  it('round-trips canonical dashboard, delivery, approval, and customer state', () => {
    const dashboard = { from: '2026-07-01', to: '2026-07-31', canonical: true } as const;
    expect(readDashboardSearch(dashboardSearch(dashboard))).toEqual(dashboard);
    const delivery = { from: null, to: null, groupBy: 'staff' as const,
      staffUserId: STAFF_ID, offset: 50, canonical: true };
    expect(readDeliverySearch(deliverySearch(delivery))).toEqual(delivery);
    expect(readApprovalSearch(approvalSearch({ offset: 25, canonical: true })))
      .toEqual({ offset: 25, canonical: true });
    const customer = { from: '2026-07-01', to: '2026-07-31', search: 'Klinik',
      status: 'active' as const, customerType: 'clinic' as const, offset: 50, canonical: true };
    expect(readCustomerSearch(customerSearch(customer))).toEqual(customer);
  });

  it('round-trips a customer state with only the meaningful filters present', () => {
    const bare = { from: null, to: null, search: '', status: null, customerType: null,
      offset: 0, canonical: true };
    expect(readCustomerSearch(customerSearch(bare))).toEqual(bare);
    const typeOnly = { from: '2026-07-01', to: '2026-07-31', search: '',
      status: null, customerType: 'company' as const, offset: 0, canonical: true };
    expect(readCustomerSearch(customerSearch(typeOnly))).toEqual(typeOnly);
  });

  it.each([
    ['partial dates', 'from=2026-07-01'],
    ['invalid day', 'from=2026-02-30&to=2026-03-01'],
    ['reversed range', 'from=2026-07-31&to=2026-07-01'],
    ['overlong range', 'from=2025-01-01&to=2026-07-01'],
    ['repeated scalar', 'from=2026-07-01&from=2026-07-02&to=2026-07-31'],
  ])('canonicalizes invalid dashboard %s', (_name, raw) => {
    expect(readDashboardSearch(new URLSearchParams(raw))).toEqual({
      from: null, to: null, canonical: false,
    });
  });

  it.each([
    'groupBy=unknown',
    'groupBy=day&offset=-1',
    'groupBy=day&staffUserId=',
    'groupBy=day&staffUserId=bad',
    'groupBy=day&offset=1&offset=2',
  ])('canonicalizes invalid delivery search %s', (raw) => {
    const result = readDeliverySearch(new URLSearchParams(raw));
    expect(result.canonical).toBe(false);
  });

  it.each([
    'status=active&status=inactive',
    'customerType=clinic&customerType=hospital',
    'status=archived',
    'customerType=lab',
    'offset=-1',
    'offset=1&offset=2',
  ])('canonicalizes invalid customer search %s', (raw) => {
    const result = readCustomerSearch(new URLSearchParams(raw));
    expect(result.canonical).toBe(false);
  });

  it('keeps a free-text customer search without validating availability', () => {
    const result = readCustomerSearch(new URLSearchParams('search=Klinik&offset=0'));
    expect(result).toMatchObject({ search: 'Klinik', canonical: true });
  });

  it('preserves a syntactically valid Staff UUID without checking availability', () => {
    expect(readDeliverySearch(new URLSearchParams(
      `groupBy=staff&staffUserId=${STAFF_ID}&offset=0`,
    ))).toMatchObject({ staffUserId: STAFF_ID, canonical: true });
  });

  it('validates exact calendar dates and the inclusive 366-day maximum', () => {
    expect(validateRequestedRange('2024-01-01', '2024-12-31')).toEqual({
      ok: true, value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(validateRequestedRange('2024-01-01', '2025-01-01')).toMatchObject({ ok: false });
    expect(validateRequestedRange('2026-02-30', '2026-03-01')).toMatchObject({ ok: false });
  });
});
