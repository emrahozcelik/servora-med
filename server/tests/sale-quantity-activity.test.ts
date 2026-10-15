import { describe, expect, it } from 'vitest';
import { presentActivity } from '../src/modules/job-cards/activity-presenter.js';
import type { ActivityRecord } from '../src/modules/job-cards/repository.js';

const activity: ActivityRecord = {
  id: 'audit', jobCardId: 'sale', eventType: 'SALE_ITEM_UPDATED', actorId: null,
  actorName: null, createdAt: new Date('2026-10-15T08:00:00Z'),
  oldValue: { quantity: '1.000' },
  newValue: { id: 'line', productNameSnapshot: 'Bonding liquid', quantity: '2.000', unitSnapshot: 'ml' },
  metadata: null, clientActionId: null, startLocation: null,
};

describe('Sale activity counts', () => {
  it('presents v1 integer audit quantities as counts without changing durable payloads', () => {
    expect(presentActivity(activity, { includeSaleCapability: true }).details).toEqual({
      kind: 'SALE_ITEM', operation: 'UPDATED', itemId: 'line', productName: 'Bonding liquid',
      quantity: '2', previousQuantity: '1',
    });
    for (const eventType of ['SALE_ITEM_ADDED', 'SALE_ITEM_REMOVED'] as const) {
      const item = activity.newValue;
      expect(presentActivity({ ...activity, eventType, oldValue: eventType === 'SALE_ITEM_REMOVED' ? item : null },
        { includeSaleCapability: true }).details).toMatchObject({ quantity: '2', previousQuantity: eventType === 'SALE_ITEM_REMOVED' ? '2' : null });
    }
    for (const quantity of ['0.000', '0.500', '1.500', '-1.000', 'NaN', '1000000000.000']) {
      expect(presentActivity({ ...activity, newValue: { id: 'line', productNameSnapshot: 'Bonding liquid', quantity } },
        { includeSaleCapability: true }).details).toEqual({ kind: 'NONE' });
    }
    expect(activity.newValue).toMatchObject({ quantity: '2.000', unitSnapshot: 'ml' });
    expect(presentActivity(activity).details).toEqual({ kind: 'NONE' });
  });
});
