import { describe, expect, it } from 'vitest';
import { parseSaleFromVisitCreateInput, parseSaleAddition, parseSaleQuantityPatch, parseSaleStandaloneCreateInput, saleQuantity } from '../src/modules/job-cards/sale-input.js';

const productA = '00000000-0000-4000-8000-000000000001';
const productB = '00000000-0000-4000-8000-000000000002';
const input = {
  clientActionId: 'sale-create-test', expectedSourceVersion: 1,
  title: 'Dental product agreement', soldAt: '2026-10-14T11:00:00Z',
  items: [{ productId: productA, quantity: 1 }, { productId: productB, quantity: 15 }],
};

describe('Sale input contract', () => {
  it('rejects fractional product counts under SALE-QTY-001', () => {
    for (const quantity of [0.001, 0.5, 1.5, 2.75, 999_999_999.999]) {
      for (const parse of [
        () => saleQuantity(quantity),
        () => parseSaleAddition({ clientActionId: 'add', expectedVersion: 1, productId: productA, quantity }),
        () => parseSaleQuantityPatch({ clientActionId: 'correct', expectedVersion: 1, quantity }),
      ]) expect(parse).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
  });
  it('normalizes empty optional description consistently with omitted and null values', () => {
    for (const description of [undefined, null, '', '  \t']) {
      expect(parseSaleFromVisitCreateInput({ ...input, description }).description).toBeNull();
    }
  });
  it('preserves v1 hash normalization and distinct integer product counts', () => {
    expect(parseSaleFromVisitCreateInput(input)).toMatchObject({
      soldAt: '2026-10-14T11:00:00.000Z', description: null, saleContactId: null,
      items: [{ productId: productA, quantity: '1.000' }, { productId: productB, quantity: '15.000' }],
    });
  });
  it('rejects invalid or silently rounded quantities before persistence', () => {
    for (const quantity of [1.2345, 0.0001, 0, -1, Infinity, -Infinity, NaN, 1_000_000_000, Number.MAX_SAFE_INTEGER, '1', null, undefined, true, {}, [], 1n]) {
      expect(() => parseSaleFromVisitCreateInput({
        ...input, items: [{ productId: productA, quantity }],
      })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    }
  });
  it('rejects malformed shape, versions and server-owned overrides', () => {
    for (const value of [null, [], {},
      ...['type', 'customerId', 'assignedTo', 'saleSourceVisitId', 'deliveryPurpose', 'price'].map((key) => ({ ...input, [key]: productA })),
      ...[0, -1, 1.5, '1', undefined].map((version) => ({ ...input, expectedSourceVersion: version })),
    ]) {
      expect(() => parseSaleFromVisitCreateInput(value)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
  });
  it('accepts integer counts at both boundaries without rounding', () => {
    for (const quantity of [1, 2, 15, 100, 999_999_999]) {
      expect(saleQuantity(quantity)).toBe(quantity.toFixed(3));
    }
  });
  it('requires a bounded nonempty set of distinct products', () => {
    for (const items of [[], [input.items[0], input.items[0]],
      Array.from({ length: 26 }, (_, index) => ({
        productId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, quantity: 1,
      })),
    ]) {
      expect(() => parseSaleFromVisitCreateInput({ ...input, items })).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
  });
});

const standaloneInput = {
  clientActionId: 'standalone-create-test',
  title: '  Telefon siparişi  ',
  description: 'Klinik aradı',
  customerId: '00000000-0000-4000-8000-0000000000c1',
  assignedTo: '00000000-0000-4000-8000-0000000000a1',
  soldAt: '2026-11-23T09:30:00+03:00',
  saleContactId: null,
  items: [{ productId: productA, quantity: 3 }],
};

describe('Standalone sale input contract (SALE-002 §6.1)', () => {
  it('normalizes the standalone body and keeps the v1 quantity representation', () => {
    const parsed = parseSaleStandaloneCreateInput(standaloneInput);
    expect(parsed).toEqual({
      clientActionId: 'standalone-create-test',
      title: 'Telefon siparişi',
      description: 'Klinik aradı',
      customerId: standaloneInput.customerId,
      assignedTo: standaloneInput.assignedTo,
      soldAt: '2026-11-23T06:30:00.000Z',
      saleContactId: null,
      items: [{ productId: productA, quantity: '3.000' }],
    });
  });
  it('treats an omitted optional description/contact as null', () => {
    const { description: _description, saleContactId: _contact, ...minimal } = standaloneInput;
    expect(parseSaleStandaloneCreateInput(minimal)).toMatchObject({
      description: null, saleContactId: null,
    });
  });
  it('rejects every server-owned or unknown request key', () => {
    for (const key of ['type', 'status', 'expectedSourceVersion', 'saleSourceVisitId', 'sourceVisitId',
      'deliverySourceSaleId', 'price', 'acceptedAt', 'customerNameSnapshot']) {
      expect(() => parseSaleStandaloneCreateInput({ ...standaloneInput, [key]: 'forged' }))
        .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    }
  });
  it('requires a bounded title, a customer, an assignee and 1–25 distinct integer lines', () => {
    for (const value of [null, [], {},
      { ...standaloneInput, title: '' },
      { ...standaloneInput, title: 'x'.repeat(256) },
      { ...standaloneInput, customerId: undefined },
      { ...standaloneInput, assignedTo: undefined },
      { ...standaloneInput, items: [] },
      { ...standaloneInput, items: [{ productId: productA, quantity: 0 }] },
      { ...standaloneInput, items: [{ productId: productA, quantity: 1.5 }] },
      { ...standaloneInput, items: [{ productId: productA, quantity: 1_000_000_000 }] },
    ]) {
      expect(() => parseSaleStandaloneCreateInput(value)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
    expect(() => parseSaleStandaloneCreateInput({ ...standaloneInput,
      items: [standaloneInput.items[0], standaloneInput.items[0]] }))
      .toThrowError(expect.objectContaining({ code: 'SALE_PRODUCT_DUPLICATE', statusCode: 409 }));
    expect(() => parseSaleStandaloneCreateInput({ ...standaloneInput,
      items: Array.from({ length: 26 }, (_, index) => ({
        productId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, quantity: 1,
      })) }))
      .toThrowError(expect.objectContaining({ code: 'SALE_ITEM_LIMIT', statusCode: 409 }));
  });
  it('rejects a description over the 4000 code-point bound and malformed instants', () => {
    expect(() => parseSaleStandaloneCreateInput({ ...standaloneInput, description: 'x'.repeat(4001) }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => parseSaleStandaloneCreateInput({ ...standaloneInput, soldAt: '2026-11-23 09:30' }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});
