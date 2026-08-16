import { describe, expect, it } from 'vitest';

import { parseAvailableSlotsInput } from '../src/modules/job-cards/create-input.js';

describe('parseAvailableSlotsInput', () => {
  it('normalizes the bounded joint-slot request', () => {
    expect(parseAvailableSlotsInput({
      type: 'PRODUCT_DELIVERY',
      customerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      assignedTo: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      scheduledAt: '2026-08-16T10:00:00.000Z',
      scheduledEndsAt: '2026-08-16T11:00:00.000Z',
      jobCardId: null,
    })).toEqual({
      type: 'PRODUCT_DELIVERY',
      customerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      assignedTo: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      scheduledAt: '2026-08-16T10:00:00.000Z',
      scheduledEndsAt: '2026-08-16T11:00:00.000Z',
      jobCardId: null,
    });
  });

  it('rejects General Task and unsupported request fields', () => {
    const base = {
      customerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      assignedTo: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      scheduledAt: '2026-08-16T10:00:00.000Z',
      scheduledEndsAt: '2026-08-16T11:00:00.000Z',
    };
    expect(() => parseAvailableSlotsInput({ ...base, type: 'GENERAL_TASK' })).toThrow();
    expect(() => parseAvailableSlotsInput({ ...base, type: 'SALES_MEETING', extra: true })).toThrow();
    expect(() => parseAvailableSlotsInput({
      ...base,
      type: 'PRODUCT_DELIVERY',
      scheduledEndsAt: '2026-08-16T09:00:00.000Z',
    })).toThrow();
  });
});
