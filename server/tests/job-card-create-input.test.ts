import { describe, expect, it } from 'vitest';

import {
  parseJobCardCreateInput,
  parseProductDeliveryCreateInput,
} from '../src/modules/job-cards/create-input.js';

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const SCHEDULED_AT = '2026-07-20T10:30:00.000Z';
const SCHEDULED_ENDS_AT = '2026-07-20T11:30:00.000Z';
const validationError = expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 });
const productId = (index: number) => `44444444-4444-4444-8444-${index.toString(16).padStart(12, '0')}`;

function productDeliveryBody(items: unknown[] = [{ productId: productId(1), quantity: 1 }]) {
  return {
    clientActionId: 'delivery-batch-validation', type: 'PRODUCT_DELIVERY', title: 'Klinik teslimi',
    customerId: CUSTOMER_ID, assignedTo: STAFF_ID, scheduledAt: SCHEDULED_AT,
    deliveryPurpose: 'SALE', items,
  };
}

describe('JobCard create input', () => {
  it('normalizes an atomic Product Delivery create with bounded initial items', () => {
    expect(parseProductDeliveryCreateInput({
      clientActionId: 'delivery-batch-1', type: 'PRODUCT_DELIVERY', title: 'Klinik teslimi',
      customerId: CUSTOMER_ID, assignedTo: STAFF_ID, scheduledAt: SCHEDULED_AT,
      deliveryPurpose: 'SALE', deliveryNote: '  Aynı teslimat  ',
      items: [
        { productId: '44444444-4444-4444-8444-444444444444', quantity: 2 },
        { productId: '55555555-5555-4555-8555-555555555555', quantity: 0.001 },
      ],
    })).toMatchObject({
      type: 'PRODUCT_DELIVERY', scheduledAt: SCHEDULED_AT,
      scheduledEndsAt: '2026-07-20T11:00:00.000Z',
      deliveryPurpose: 'SALE', deliveryNote: 'Aynı teslimat',
      items: [
        { productId: '44444444-4444-4444-8444-444444444444', quantity: 2 },
        { productId: '55555555-5555-4555-8555-555555555555', quantity: 0.001 },
      ],
    });
  });

  it('rejects an empty, duplicate, malformed, non-positive, or over-bound item collection', () => {
    expect(() => parseProductDeliveryCreateInput(productDeliveryBody([]))).toThrowError(validationError);
    expect(() => parseProductDeliveryCreateInput(productDeliveryBody([
      { productId: productId(1), quantity: 1 }, { productId: productId(1), quantity: 2 },
    ]))).toThrowError(validationError);
    expect(() => parseProductDeliveryCreateInput(productDeliveryBody([
      { productId: 'not-a-uuid', quantity: 1 },
    ]))).toThrowError(validationError);
    expect(() => parseProductDeliveryCreateInput(productDeliveryBody([
      { productId: productId(1), quantity: 0.0 },
    ]))).toThrowError(validationError);
    expect(() => parseProductDeliveryCreateInput(productDeliveryBody(
      Array.from({ length: 26 }, (_, index) => ({ productId: productId(index + 1), quantity: 1 })),
    ))).toThrowError(validationError);
  });

  it('normalizes the exact General Task body with optional scheduledAt', () => {
    expect(parseJobCardCreateInput({
      clientActionId: '  task-create-1  ',
      type: 'GENERAL_TASK',
      title: '  Doktoru ara  ',
      assignedTo: STAFF_ID,
    })).toEqual({
      clientActionId: 'task-create-1',
      type: 'GENERAL_TASK',
      title: 'Doktoru ara',
      description: null,
      customerId: null,
      contactId: null,
      assignedTo: STAFF_ID,
      priority: 'normal',
      dueDate: null,
      scheduledAt: null,
    });
  });

  it('normalizes General Task scheduledAt null when explicitly cleared', () => {
    expect(parseJobCardCreateInput({
      clientActionId: 'task-create-clear-schedule',
      type: 'GENERAL_TASK',
      title: 'Doktoru ara',
      assignedTo: STAFF_ID,
      scheduledAt: null,
    })).toMatchObject({ scheduledAt: null });
  });

  it('normalizes the exact Product Delivery body without a Contact association', () => {
    expect(parseJobCardCreateInput({
      clientActionId: 'delivery-create-1',
      type: 'PRODUCT_DELIVERY',
      title: ' Klinik teslimi ',
      description: '   ',
      customerId: CUSTOMER_ID,
      contactId: null,
      assignedTo: STAFF_ID,
      priority: 'high',
      dueDate: '2026-07-20',
      scheduledAt: '2026-07-20T13:30:00+03:00',
      scheduledEndsAt: '2026-07-20T14:00:00+03:00',
    })).toEqual({
      clientActionId: 'delivery-create-1',
      type: 'PRODUCT_DELIVERY',
      title: 'Klinik teslimi',
      description: null,
      customerId: CUSTOMER_ID,
      contactId: null,
      assignedTo: STAFF_ID,
      priority: 'high',
      dueDate: '2026-07-20',
      scheduledAt: '2026-07-20T10:30:00.000Z',
      scheduledEndsAt: '2026-07-20T11:00:00.000Z',
      overrideReason: null,
    });
  });

  it('rejects a new Product Delivery with a non-null contactId', () => {
    expect(() => parseJobCardCreateInput({
      clientActionId: 'delivery-contact-rejected',
      type: 'PRODUCT_DELIVERY',
      title: 'Klinik teslimi',
      customerId: CUSTOMER_ID,
      contactId: CONTACT_ID,
      assignedTo: STAFF_ID,
      scheduledAt: SCHEDULED_AT,
    })).toThrowError(validationError);
  });

  it('derives the canonical Product Delivery end when omitted', () => {
    expect(parseJobCardCreateInput({
      clientActionId: 'delivery-create-default-duration',
      type: 'PRODUCT_DELIVERY',
      title: 'Klinik teslimi',
      customerId: CUSTOMER_ID,
      assignedTo: STAFF_ID,
      scheduledAt: '2026-07-20T10:30:00.000Z',
    })).toMatchObject({
      scheduledAt: '2026-07-20T10:30:00.000Z',
      scheduledEndsAt: '2026-07-20T11:00:00.000Z',
    });
  });

  it('normalizes Sales Meeting with canonical scheduledAt/scheduledEndsAt and ignores dueDate', () => {
    expect(parseJobCardCreateInput({
      clientActionId: '  meeting-create-1  ',
      type: 'SALES_MEETING',
      title: '  Kontrol görüşmesi  ',
      customerId: CUSTOMER_ID,
      assignedTo: STAFF_ID,
      dueDate: '2025-12-01',
      scheduledAt: SCHEDULED_AT,
      scheduledEndsAt: SCHEDULED_ENDS_AT,
    })).toEqual({
      clientActionId: 'meeting-create-1',
      type: 'SALES_MEETING',
      title: 'Kontrol görüşmesi',
      description: null,
      customerId: CUSTOMER_ID,
      contactId: null,
      assignedTo: STAFF_ID,
      priority: 'normal',
      dueDate: null,
      scheduledAt: SCHEDULED_AT,
      scheduledEndsAt: SCHEDULED_ENDS_AT,
      engagementKind: 'SALES_MEETING',
      overrideReason: null,
    });
    expect(parseJobCardCreateInput({
      clientActionId: 'meeting-create-2',
      type: 'SALES_MEETING',
      title: 'Kontrol görüşmesi',
      customerId: CUSTOMER_ID,
      assignedTo: STAFF_ID,
      scheduledAt: SCHEDULED_AT,
      scheduledEndsAt: SCHEDULED_ENDS_AT,
    })).toMatchObject({
      dueDate: null, scheduledAt: SCHEDULED_AT, scheduledEndsAt: SCHEDULED_ENDS_AT,
      engagementKind: 'SALES_MEETING',
    });
  });

  it('accepts explicit engagement kinds for Sales Meeting and defaults omitted values', () => {
    expect(parseJobCardCreateInput({
      clientActionId: 'meeting-visit-1',
      type: 'SALES_MEETING',
      title: 'Kurum ziyareti',
      customerId: CUSTOMER_ID,
      assignedTo: STAFF_ID,
      scheduledAt: SCHEDULED_AT,
      scheduledEndsAt: SCHEDULED_ENDS_AT,
      engagementKind: 'CUSTOMER_VISIT',
    })).toMatchObject({ engagementKind: 'CUSTOMER_VISIT' });
    expect(parseJobCardCreateInput({
      clientActionId: 'meeting-default-1',
      type: 'SALES_MEETING',
      title: 'Varsayılan görüşme',
      customerId: CUSTOMER_ID,
      assignedTo: STAFF_ID,
      scheduledAt: SCHEDULED_AT,
      scheduledEndsAt: SCHEDULED_ENDS_AT,
    })).toMatchObject({ engagementKind: 'SALES_MEETING' });
  });

  it('rejects engagementKind on non-meeting creates and invalid enums', () => {
    expect(() => parseJobCardCreateInput({
      clientActionId: 'task-1',
      type: 'GENERAL_TASK',
      title: 'Görev',
      assignedTo: STAFF_ID,
      engagementKind: 'CUSTOMER_VISIT',
    })).toThrowError(validationError);
    expect(() => parseJobCardCreateInput({
      clientActionId: 'delivery-1',
      type: 'PRODUCT_DELIVERY',
      title: 'Teslim',
      customerId: CUSTOMER_ID,
      assignedTo: STAFF_ID,
      scheduledAt: SCHEDULED_AT,
      scheduledEndsAt: SCHEDULED_ENDS_AT,
      engagementKind: 'SALES_MEETING',
    })).toThrowError(validationError);
    expect(() => parseJobCardCreateInput({
      clientActionId: 'meeting-bad',
      type: 'SALES_MEETING',
      title: 'Görüşme',
      customerId: CUSTOMER_ID,
      assignedTo: STAFF_ID,
      scheduledAt: SCHEDULED_AT,
      scheduledEndsAt: SCHEDULED_ENDS_AT,
      engagementKind: 'CLINIC_VISIT',
    })).toThrowError(validationError);
  });

  it.each([
    undefined,
    null,
    [],
    'GENERAL_TASK',
    { clientActionId: 'a1', title: 'Görev', assignedTo: STAFF_ID },
    { clientActionId: 'a1', type: 'UNKNOWN', title: 'Görev', assignedTo: STAFF_ID },
  ])('rejects a non-object or invalid discriminant %#', (input) => {
    expect(() => parseJobCardCreateInput(input)).toThrowError(validationError);
  });

  it.each(['productId', 'deliveryItems', 'deliveryPurpose', 'quantity', 'deliveredAt', 'unit'])
    ('rejects delivery or unknown field %s', (field) => {
      expect(() => parseJobCardCreateInput({
        clientActionId: 'a1', type: 'GENERAL_TASK', title: 'Görev', assignedTo: STAFF_ID,
        [field]: field === 'quantity' ? 1 : 'unexpected',
      })).toThrowError(validationError);
    });

  it.each([
    ['', 'title'],
    ['\u00a0\u2028', 'title'],
    ['😀'.repeat(256), 'title'],
    ['not-a-uuid', 'assignedTo'],
    ['not-a-uuid', 'customerId'],
    ['not-a-uuid', 'contactId'],
    ['medium', 'priority'],
    ['2026-02-30', 'dueDate'],
  ])('rejects invalid %s value for %s', (value, field) => {
    expect(() => parseJobCardCreateInput({
      clientActionId: 'a1', type: 'GENERAL_TASK', title: 'Görev', assignedTo: STAFF_ID,
      [field]: value,
    })).toThrowError(validationError);
  });

  it.each([
    '2026-07-20T10:30:00',
    '2026-07-20 10:30:00Z',
    '2026-07-20T10:30:00.000',
    'not-an-instant',
  ])('rejects scheduledAt without Z or explicit offset: %s', (scheduledAt) => {
    expect(() => parseJobCardCreateInput({
      clientActionId: 'a1', type: 'GENERAL_TASK', title: 'Görev', assignedTo: STAFF_ID,
      scheduledAt,
    })).toThrowError(validationError);
  });

  it('requires Product Delivery customerId and scheduledAt', () => {
    expect(() => parseJobCardCreateInput({
      clientActionId: 'a1', type: 'PRODUCT_DELIVERY', title: 'Teslim', assignedTo: STAFF_ID,
      scheduledAt: SCHEDULED_AT, scheduledEndsAt: SCHEDULED_ENDS_AT,
    })).toThrowError(validationError);
    expect(() => parseJobCardCreateInput({
      clientActionId: 'a1', type: 'PRODUCT_DELIVERY', title: 'Teslim', assignedTo: STAFF_ID,
      customerId: CUSTOMER_ID, scheduledEndsAt: SCHEDULED_ENDS_AT,
    })).toThrowError(validationError);
    expect(parseJobCardCreateInput({
      clientActionId: 'a1', type: 'PRODUCT_DELIVERY', title: 'Teslim', assignedTo: STAFF_ID,
      customerId: CUSTOMER_ID, scheduledAt: SCHEDULED_AT,
    })).toMatchObject({ scheduledEndsAt: '2026-07-20T11:00:00.000Z' });
  });

  it.each(['customerId', 'scheduledAt'])('requires Sales Meeting %s', (field) => {
    const input: Record<string, unknown> = {
      clientActionId: 'a1', type: 'SALES_MEETING', title: 'Görüşme',
      customerId: CUSTOMER_ID, assignedTo: STAFF_ID,
      scheduledAt: SCHEDULED_AT, scheduledEndsAt: SCHEDULED_ENDS_AT,
    };
    delete input[field];
    expect(() => parseJobCardCreateInput(input)).toThrowError(validationError);
  });

  it('rejects scheduledEndsAt on GENERAL_TASK create (contract unchanged)', () => {
    expect(() => parseJobCardCreateInput({
      clientActionId: 'a1', type: 'GENERAL_TASK', title: 'Görev', assignedTo: STAFF_ID,
      scheduledEndsAt: SCHEDULED_ENDS_AT,
    })).toThrowError(validationError);
  });

  it.each([
    '2026-07-20T11:30:00',
    '2026-07-20 11:30:00Z',
    '2026-07-20T11:30:00.000',
    'not-an-instant',
  ])('rejects scheduledEndsAt without Z or explicit offset: %s', (scheduledEndsAt) => {
    expect(() => parseJobCardCreateInput({
      clientActionId: 'a1', type: 'SALES_MEETING', title: 'Görüşme',
      customerId: CUSTOMER_ID, assignedTo: STAFF_ID,
      scheduledAt: SCHEDULED_AT, scheduledEndsAt,
    })).toThrowError(validationError);
  });

  it('rejects scheduledEndsAt that is noncanonical or not later than scheduledAt', () => {
    for (const scheduledEndsAt of [SCHEDULED_AT, '2026-07-20T10:00:00.000Z', '2026-07-20T11:30:00.000Z']) {
      expect(() => parseJobCardCreateInput({
        clientActionId: 'a1', type: 'PRODUCT_DELIVERY', title: 'Teslim',
        customerId: CUSTOMER_ID, assignedTo: STAFF_ID,
        scheduledAt: SCHEDULED_AT, scheduledEndsAt,
      })).toThrowError(validationError);
    }
  });

  it('rejects an explicit null or noncanonical end for both interval types', () => {
    for (const [type, scheduledEndsAt] of [
      ['SALES_MEETING', '2026-07-20T12:30:00.000Z'],
      ['PRODUCT_DELIVERY', '2026-07-20T11:30:00.000Z'],
    ] as const) {
      expect(() => parseJobCardCreateInput({
        clientActionId: `noncanonical-${type}`,
        type,
        title: 'Plan',
        customerId: CUSTOMER_ID,
        assignedTo: STAFF_ID,
        scheduledAt: SCHEDULED_AT,
        scheduledEndsAt,
      })).toThrowError(validationError);
      expect(() => parseJobCardCreateInput({
        clientActionId: `null-end-${type}`,
        type,
        title: 'Plan',
        customerId: CUSTOMER_ID,
        assignedTo: STAFF_ID,
        scheduledAt: SCHEDULED_AT,
        scheduledEndsAt: null,
      })).toThrowError(validationError);
    }
  });

  it.each(['meetingAt', 'outcome', 'meetingSummary', 'nextFollowUpAt'])
    ('rejects result field %s from Sales Meeting create', (field) => {
      expect(() => parseJobCardCreateInput({
        clientActionId: 'a1', type: 'SALES_MEETING', title: 'Görüşme',
        customerId: CUSTOMER_ID, assignedTo: STAFF_ID, dueDate: '2026-07-15',
        scheduledAt: SCHEDULED_AT, scheduledEndsAt: SCHEDULED_ENDS_AT,
        [field]: 'unexpected',
      })).toThrowError(validationError);
    });
});
