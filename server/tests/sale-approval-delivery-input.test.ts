import { describe, expect, it } from 'vitest';

import { AppError } from '../src/errors/index.js';
import { parseSaleApprovalDelivery } from '../src/modules/job-cards/sale-approval-delivery-input.js';

/**
 * SALE-002 §5.1/§5.2: the optional `delivery` object of the approve command.
 * It must reuse the plain delivery create parsers (no second implementation) and
 * report every failure on a `delivery.*` field the approval dialog can map.
 */

const PRODUCT = '0b6f8a0e-5c1d-4c5e-9b0a-1a2b3c4d5e6f';
const OTHER_PRODUCT = '1c7f9b1f-6d2e-4d6f-8c1b-2b3c4d5e6f70';
const STAFF = '2d80ac20-7e3f-4e70-9d2c-3c4d5e6f7081';

const valid = {
  assignedTo: STAFF,
  scheduledAt: '2026-10-15T07:00:00.000Z',
  items: [{ productId: PRODUCT, quantity: 2 }],
};

function fieldErrors(run: () => unknown): Record<string, string> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('VALIDATION_ERROR');
    expect(appError.statusCode).toBe(400);
    return (appError.details?.fieldErrors ?? {}) as Record<string, string>;
  }
  throw new Error('expected a validation error');
}

describe('parseSaleApprovalDelivery', () => {
  it('normalizes the minimal body: default purpose, canonical end, null note', () => {
    expect(parseSaleApprovalDelivery(valid)).toEqual({
      assignedTo: STAFF,
      scheduledAt: '2026-10-15T07:00:00.000Z',
      scheduledEndsAt: '2026-10-15T07:30:00.000Z',
      deliveryPurpose: 'SALE',
      note: null,
      items: [{ productId: PRODUCT, quantity: 2 }],
    });
  });

  it('leaves the assignee out when omitted (the sale assignee is resolved under the lock)', () => {
    const { assignedTo: _unused, ...withoutAssignee } = valid;
    void _unused;
    expect(parseSaleApprovalDelivery(withoutAssignee)).not.toHaveProperty('assignedTo');
  });

  it('trims the note and treats a blank note as absent', () => {
    expect(parseSaleApprovalDelivery({ ...valid, note: '  Depodan al  ' }).note).toBe('Depodan al');
    expect(parseSaleApprovalDelivery({ ...valid, note: '   ' }).note).toBeNull();
    expect(parseSaleApprovalDelivery({ ...valid, note: 'x'.repeat(4000) }).note).toHaveLength(4000);
  });

  it('accepts the canonical end, an offset instant and a purpose', () => {
    const parsed = parseSaleApprovalDelivery({
      ...valid,
      scheduledAt: '2026-10-15T10:00:00.000+03:00',
      scheduledEndsAt: '2026-10-15T07:30:00.000Z',
      deliveryPurpose: 'SAMPLE',
    });
    expect(parsed).toMatchObject({
      scheduledAt: '2026-10-15T07:00:00.000Z',
      scheduledEndsAt: '2026-10-15T07:30:00.000Z',
      deliveryPurpose: 'SAMPLE',
    });
  });

  it('carries a valid past-start acknowledgement and ignores none', () => {
    const parsed = parseSaleApprovalDelivery({
      ...valid,
      pastStartAcknowledgement: { code: 'CUSTOMER_WAITING', text: ' Müşteri bekliyor ' },
    });
    expect(parsed.pastStartAcknowledgement).toEqual({ code: 'CUSTOMER_WAITING', text: 'Müşteri bekliyor' });
    expect(parseSaleApprovalDelivery({ ...valid, pastStartAcknowledgement: null }))
      .not.toHaveProperty('pastStartAcknowledgement');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'delivery'],
  ])('rejects %s as the whole delivery', (_label, value) => {
    expect(fieldErrors(() => parseSaleApprovalDelivery(value))).toHaveProperty('delivery');
  });

  it('rejects unknown members (strict allowlist), including deliveryNote', () => {
    for (const extra of [{ deliveryNote: 'x' }, { priority: 'high' }, { customerId: PRODUCT }, { title: 'x' }]) {
      expect(fieldErrors(() => parseSaleApprovalDelivery({ ...valid, ...extra }))).toHaveProperty('delivery');
    }
  });

  it('reports reused-parser failures under delivery.*', () => {
    expect(fieldErrors(() => parseSaleApprovalDelivery({ ...valid, scheduledAt: undefined })))
      .toHaveProperty(['delivery.scheduledAt']);
    expect(fieldErrors(() => parseSaleApprovalDelivery({ ...valid, scheduledAt: 'yarın' })))
      .toHaveProperty(['delivery.scheduledAt']);
    expect(fieldErrors(() => parseSaleApprovalDelivery({ ...valid, scheduledEndsAt: '2026-10-15T09:00:00.000Z' })))
      .toHaveProperty(['delivery.scheduledEndsAt']);
    expect(fieldErrors(() => parseSaleApprovalDelivery({ ...valid, scheduledEndsAt: null })))
      .toHaveProperty(['delivery.scheduledEndsAt']);
    expect(fieldErrors(() => parseSaleApprovalDelivery({ ...valid, assignedTo: 'x' })))
      .toHaveProperty(['delivery.assignedTo']);
    expect(fieldErrors(() => parseSaleApprovalDelivery({ ...valid, deliveryPurpose: 'GIFT' })))
      .toHaveProperty(['delivery.deliveryPurpose']);
    expect(fieldErrors(() => parseSaleApprovalDelivery({ ...valid, note: 5 })))
      .toHaveProperty(['delivery.note']);
    expect(fieldErrors(() => parseSaleApprovalDelivery({ ...valid, note: 'x'.repeat(4001) })))
      .toHaveProperty(['delivery.note']);
    expect(fieldErrors(() => parseSaleApprovalDelivery({
      ...valid, pastStartAcknowledgement: { code: 'NOPE', text: 'x' },
    }))).toHaveProperty(['delivery.pastStartAcknowledgement.code']);
  });

  it('enforces the item batch contract: 1-25 distinct products, whole positive quantities', () => {
    const bad = (items: unknown) => fieldErrors(() => parseSaleApprovalDelivery({ ...valid, items }));
    expect(bad(undefined)).toHaveProperty(['delivery.items']);
    expect(bad([])).toHaveProperty(['delivery.items']);
    expect(bad([{ productId: PRODUCT, quantity: 1 }, { productId: PRODUCT, quantity: 2 }]))
      .toHaveProperty(['delivery.items']);
    expect(bad([{ productId: PRODUCT, quantity: 1, extra: true }])).toHaveProperty(['delivery.items']);
    expect(bad([{ productId: PRODUCT, quantity: 1.5 }])).toHaveProperty(['delivery.items.quantity']);
    expect(bad([{ productId: PRODUCT, quantity: 0 }])).toHaveProperty(['delivery.items.quantity']);
    expect(bad([{ productId: PRODUCT, quantity: '2' }])).toHaveProperty(['delivery.items.quantity']);
    expect(bad([{ productId: PRODUCT, quantity: 1_000_000_000 }])).toHaveProperty(['delivery.items.quantity']);
    expect(bad([{ productId: 'nope', quantity: 1 }])).toHaveProperty(['delivery.items.productId']);
    const many = Array.from({ length: 26 }, (_v, index) => ({
      productId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, quantity: 1,
    }));
    expect(bad(many)).toHaveProperty(['delivery.items']);
    expect(parseSaleApprovalDelivery({ ...valid, items: many.slice(0, 25) }).items).toHaveLength(25);
    expect(parseSaleApprovalDelivery({
      ...valid,
      items: [{ productId: PRODUCT, quantity: 3 }, { productId: OTHER_PRODUCT, quantity: 999_999_999 }],
    }).items).toEqual([
      { productId: PRODUCT, quantity: 3 },
      { productId: OTHER_PRODUCT, quantity: 999_999_999 },
    ]);
  });
});
