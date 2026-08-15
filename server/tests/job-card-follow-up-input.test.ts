import { describe, expect, it } from 'vitest';

import { parseFollowUpCreateInput } from '../src/modules/job-cards/create-input.js';

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_ID = '22222222-2222-4222-8222-222222222222';
const SCHEDULED_AT = '2026-08-03T09:00:00.000Z';
const validationError = expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 });

function general(overrides: Record<string, unknown> = {}) {
  return {
    clientActionId: 'follow-up-1',
    type: 'GENERAL_TASK',
    title: '  Kliniği tekrar ara  ',
    followUpInstructions: '  Satın alma sorumlusundan karar tarihini teyit edin.  ',
    assignedTo: STAFF_ID,
    ...overrides,
  };
}

describe('linked follow-up create input', () => {
  it('normalizes the exact General Task contract', () => {
    expect(parseFollowUpCreateInput(general())).toEqual({
      clientActionId: 'follow-up-1',
      type: 'GENERAL_TASK',
      title: 'Kliniği tekrar ara',
      followUpInstructions: 'Satın alma sorumlusundan karar tarihini teyit edin.',
      scheduledAt: null,
      assignedTo: STAFF_ID,
      priority: 'normal',
      dueDate: null,
      contactId: null,
      engagementKind: null,
      overrideReason: null,
    });
  });

  it('normalizes Product Delivery and all six Sales Meeting engagement kinds', () => {
    expect(parseFollowUpCreateInput(general({
      type: 'PRODUCT_DELIVERY',
      scheduledAt: SCHEDULED_AT,
      priority: 'high',
      dueDate: '2026-08-03',
      contactId: CONTACT_ID,
    }))).toMatchObject({
      type: 'PRODUCT_DELIVERY',
      scheduledAt: SCHEDULED_AT,
      priority: 'high',
      contactId: CONTACT_ID,
      engagementKind: null,
    });

    for (const engagementKind of [
      'SALES_MEETING', 'CUSTOMER_VISIT', 'PRODUCT_DEMO',
      'TRAINING', 'FOLLOW_UP', 'OTHER',
    ]) {
      expect(parseFollowUpCreateInput(general({
        type: 'SALES_MEETING',
        scheduledAt: SCHEDULED_AT,
        engagementKind,
      }))).toMatchObject({ type: 'SALES_MEETING', engagementKind, dueDate: null });
    }
  });

  it('uses the dedicated required-instructions error and enforces the length limit', () => {
    for (const followUpInstructions of [undefined, null, '', '   ']) {
      expect(() => parseFollowUpCreateInput(general({ followUpInstructions })))
        .toThrowError(expect.objectContaining({
          code: 'FOLLOW_UP_INSTRUCTIONS_REQUIRED',
          statusCode: 400,
        }));
    }
    expect(() => parseFollowUpCreateInput(general({
      followUpInstructions: 'a'.repeat(4_001),
    }))).toThrowError(validationError);
  });

  it.each([
    'customerId',
    'scheduledEndsAt',
    'sourceJobCardId',
    'description',
    'instructions',
  ])('rejects client-controlled or aliased field %s', (field) => {
    expect(() => parseFollowUpCreateInput(general({ [field]: 'unexpected' })))
      .toThrowError(validationError);
  });

  it('enforces type-specific scheduling, due date, and engagement fields', () => {
    expect(() => parseFollowUpCreateInput(general({ type: 'PRODUCT_DELIVERY' })))
      .toThrowError(validationError);
    expect(() => parseFollowUpCreateInput(general({
      type: 'SALES_MEETING',
      scheduledAt: SCHEDULED_AT,
    }))).toThrowError(validationError);
    expect(() => parseFollowUpCreateInput(general({
      type: 'SALES_MEETING',
      scheduledAt: SCHEDULED_AT,
      engagementKind: 'CLINIC_VISIT',
    }))).toThrowError(validationError);
    expect(() => parseFollowUpCreateInput(general({
      type: 'SALES_MEETING',
      scheduledAt: SCHEDULED_AT,
      engagementKind: 'FOLLOW_UP',
      dueDate: '2026-08-03',
    }))).toThrowError(validationError);
    expect(() => parseFollowUpCreateInput(general({
      engagementKind: 'FOLLOW_UP',
    }))).toThrowError(validationError);
  });
});
