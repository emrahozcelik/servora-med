import { describe, expect, it } from 'vitest';
import { parseSaleFromVisitCreateInput } from '../src/modules/job-cards/sale-input.js';

const productA = '00000000-0000-4000-8000-000000000001';
const productB = '00000000-0000-4000-8000-000000000002';
const input = {
  clientActionId: 'sale-create-test', expectedSourceVersion: 1,
  title: 'Dental product agreement', soldAt: '2026-10-14T11:00:00Z',
  items: [{ productId: productA, quantity: 0.5 }, { productId: productB, quantity: 0.001 }],
};

describe('Sale input contract', () => {
  it('normalizes empty optional description consistently with omitted and null values', () => {
    for (const description of [undefined, null, '', '  \t']) {
      expect(parseSaleFromVisitCreateInput({ ...input, description }).description).toBeNull();
    }
  });
  it('normalizes fractional quantities without losing their product identity', () => {
    expect(parseSaleFromVisitCreateInput(input)).toMatchObject({
      soldAt: '2026-10-14T11:00:00.000Z', description: null, saleContactId: null,
      items: [{ productId: productA, quantity: '0.500' }, { productId: productB, quantity: '0.001' }],
    });
  });
  it('rejects invalid or silently rounded quantities before persistence', () => {
    for (const quantity of [1.2345, 0.0001, 0, -1, Infinity, -Infinity, NaN, 1_000_000_000]) {
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
