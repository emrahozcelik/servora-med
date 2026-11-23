import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/services/api';
import { createStandaloneSale, parseSaleDetails } from '../src/jobs/sale-api';

afterEach(() => vi.unstubAllGlobals());

const details = (source: unknown) => ({
  jobCardId: 'sale-1', jobCardVersion: 3, soldAt: '2026-11-23T09:30:00.000Z',
  saleContact: null, sourceVisit: source, items: [],
});

describe('standalone sale client', () => {
  it('posts the SALE-002 §6.1 body to the static route and reads the receipt', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ jobCardId: 'sale-1', version: 2 }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetch);
    const input = {
      clientActionId: 'standalone-key', title: 'ABC Klinik satış kaydı', description: null,
      customerId: 'customer-1', assignedTo: 'staff-1', soldAt: '2026-11-23T09:30:00.000Z',
      saleContactId: null, items: [{ productId: 'product-1', quantity: 3 }],
    };
    await expect(createStandaloneSale(input)).resolves.toEqual({ jobCardId: 'sale-1', version: 2 });
    expect(fetch.mock.calls.map(([url, init]) => [url, init.method, JSON.parse(init.body)])).toEqual([
      ['/api/job-cards/sales', 'POST', input],
    ]);
  });

  it('rejects a malformed receipt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ jobCardId: 'sale-1' }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )));
    await expect(createStandaloneSale({
      clientActionId: 'key', title: 'Başlık', description: null, customerId: 'c',
      assignedTo: 's', soldAt: '2026-11-23T09:30:00.000Z', saleContactId: null,
      items: [{ productId: 'p', quantity: 1 }],
    })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('sale details origin parser', () => {
  it('reads the standalone origin without an access key', () => {
    expect(parseSaleDetails(details({ kind: 'STANDALONE' })).sourceVisit).toEqual({ kind: 'STANDALONE' });
  });

  it('keeps the visit-origin projections strict', () => {
    expect(parseSaleDetails(details({ access: 'RESTRICTED', kind: 'SALE_FROM_VISIT' })).sourceVisit)
      .toEqual({ access: 'RESTRICTED', kind: 'SALE_FROM_VISIT' });
    expect(parseSaleDetails(details({
      access: 'FULL', kind: 'SALE_FROM_VISIT', id: 'visit-1', title: 'Ziyaret', status: 'IN_PROGRESS',
      versionAtCreation: 2, titleSnapshot: 'Eski ziyaret', customerNameSnapshot: 'ABC Klinik',
      plannedContact: null, metContact: null,
    })).sourceVisit).toEqual({
      access: 'FULL', kind: 'SALE_FROM_VISIT', id: 'visit-1', title: 'Ziyaret', status: 'IN_PROGRESS',
      versionAtCreation: 2, titleSnapshot: 'Eski ziyaret', customerNameSnapshot: 'ABC Klinik',
      plannedContact: null, metContact: null,
    });
  });

  it.each([
    ['an access key on a standalone origin', { kind: 'STANDALONE', access: 'FULL' }],
    ['a source id on a standalone origin', { kind: 'STANDALONE', id: 'visit-1' }],
    ['an unknown kind', { access: 'FULL', kind: 'SALE_FROM_SOMEWHERE' }],
    ['a restricted origin without the visit kind', { access: 'RESTRICTED', kind: 'STANDALONE' }],
  ])('rejects %s', (_label, source) => {
    expect(() => parseSaleDetails(details(source))).toThrow(ApiError);
  });
});
