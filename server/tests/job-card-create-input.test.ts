import { describe, expect, it } from 'vitest';

import { parseJobCardCreateInput } from '../src/modules/job-cards/create-input.js';

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const validationError = expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 });

describe('JobCard create input', () => {
  it('normalizes the exact General Task body', () => {
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
    });
  });

  it('normalizes the exact Product Delivery body without changing its requirements', () => {
    expect(parseJobCardCreateInput({
      clientActionId: 'delivery-create-1',
      type: 'PRODUCT_DELIVERY',
      title: ' Klinik teslimi ',
      description: '   ',
      customerId: CUSTOMER_ID,
      contactId: CONTACT_ID,
      assignedTo: STAFF_ID,
      priority: 'high',
      dueDate: '2026-07-20',
    })).toEqual({
      clientActionId: 'delivery-create-1',
      type: 'PRODUCT_DELIVERY',
      title: 'Klinik teslimi',
      description: null,
      customerId: CUSTOMER_ID,
      contactId: CONTACT_ID,
      assignedTo: STAFF_ID,
      priority: 'high',
      dueDate: '2026-07-20',
    });
  });

  it('normalizes the exact Sales Meeting body and accepts a past planned day', () => {
    expect(parseJobCardCreateInput({
      clientActionId: '  meeting-create-1  ',
      type: 'SALES_MEETING',
      title: '  Kontrol görüşmesi  ',
      customerId: CUSTOMER_ID,
      assignedTo: STAFF_ID,
      dueDate: '2025-12-01',
    })).toEqual({
      clientActionId: 'meeting-create-1',
      type: 'SALES_MEETING',
      title: 'Kontrol görüşmesi',
      description: null,
      customerId: CUSTOMER_ID,
      contactId: null,
      assignedTo: STAFF_ID,
      priority: 'normal',
      dueDate: '2025-12-01',
    });
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

  it('requires Product Delivery customerId', () => {
    expect(() => parseJobCardCreateInput({
      clientActionId: 'a1', type: 'PRODUCT_DELIVERY', title: 'Teslim', assignedTo: STAFF_ID,
    })).toThrowError(validationError);
  });

  it.each(['customerId', 'dueDate'])('requires Sales Meeting %s', (field) => {
    const input: Record<string, unknown> = {
      clientActionId: 'a1', type: 'SALES_MEETING', title: 'Görüşme',
      customerId: CUSTOMER_ID, assignedTo: STAFF_ID, dueDate: '2026-07-15',
    };
    delete input[field];
    expect(() => parseJobCardCreateInput(input)).toThrowError(validationError);
  });

  it.each(['meetingAt', 'outcome', 'meetingSummary', 'nextFollowUpAt'])
    ('rejects result field %s from Sales Meeting create', (field) => {
      expect(() => parseJobCardCreateInput({
        clientActionId: 'a1', type: 'SALES_MEETING', title: 'Görüşme',
        customerId: CUSTOMER_ID, assignedTo: STAFF_ID, dueDate: '2026-07-15',
        [field]: 'unexpected',
      })).toThrowError(validationError);
    });
});
