import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryRealtimeEventBus,
} from '../src/modules/realtime/event-bus.js';
import type {
  RealtimeEventRecord,
} from '../src/modules/realtime/types.js';

const event = {
  id: 1n,
  organizationId: 'org-1',
  sourceActivityId: 'activity-1',
  type: 'job.started',
  entityType: 'job-card',
  entityId: 'job-1',
  actorUserId: 'staff-1',
  audience: { roles: ['ADMIN', 'MANAGER'], userIds: ['staff-1'] },
  resourceKeys: ['job-board'],
  occurredAt: new Date('2026-07-19T14:30:00.000Z'),
} satisfies RealtimeEventRecord;

describe('InMemoryRealtimeEventBus', () => {
  it('isolates subscriber failures and supports unsubscribe', () => {
    const log = vi.fn();
    const bus = new InMemoryRealtimeEventBus(log);
    const broken = vi.fn(() => { throw new Error('broken subscriber'); });
    const healthy = vi.fn();
    const unsubscribe = bus.subscribe(broken);
    bus.subscribe(healthy);

    bus.publish(event);
    unsubscribe();
    bus.publish({ ...event, id: 2n });

    expect(broken).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
