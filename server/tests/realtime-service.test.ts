import { describe, expect, it } from 'vitest';

import {
  InMemoryRealtimeEventBus,
} from '../src/modules/realtime/event-bus.js';
import {
  RealtimeService,
} from '../src/modules/realtime/service.js';
import type {
  RealtimeEventRecord,
} from '../src/modules/realtime/types.js';

function event(id: bigint): RealtimeEventRecord {
  return {
    id,
    organizationId: 'org-1',
    sourceActivityId: `activity-${id}`,
    type: 'job.started',
    entityType: 'job-card',
    entityId: 'job-1',
    actorUserId: 'staff-1',
    audience: {
      roles: ['ADMIN', 'MANAGER'],
      userIds: ['staff-1'],
    },
    resourceKeys: ['job-board'],
    occurredAt: new Date('2026-07-19T14:30:00.000Z'),
  };
}

describe('RealtimeService', () => {
  it('sends sync.required at visible high-water on first connect', async () => {
    const repository = {
      visibleHighWater: async () => 12n,
      replayVisible: async () => [],
    };
    const sent: unknown[] = [];
    const service = new RealtimeService(
      repository,
      new InMemoryRealtimeEventBus(),
    );

    const subscription = await service.open(
      { organizationId: 'org-1', userId: 'manager-1', role: 'MANAGER' },
      null,
      { send: async (value) => { sent.push(value); } },
    );

    expect(sent).toEqual([{
      id: '12',
      type: 'sync.required',
      resourceKeys: ['workspace'],
      occurredAt: expect.any(String),
    }]);
    subscription.close();
  });

  it('buffers live events while replay is loading without gaps', async () => {
    let releaseReplay!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const bus = new InMemoryRealtimeEventBus();
    const repository = {
      visibleHighWater: async () => 3n,
      replayVisible: async () => {
        await replayGate;
        return [event(2n), event(3n)];
      },
    };
    const sent: string[] = [];
    const service = new RealtimeService(repository, bus);

    const opening = service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      1n,
      { send: async (value) => { sent.push(value.id); } },
    );
    bus.publish(event(4n));
    releaseReplay();

    const subscription = await opening;
    expect(sent).toEqual(['2', '3', '4']);
    subscription.close();
  });

  it('emits sync.required instead of more than 500 replay events', async () => {
    const repository = {
      visibleHighWater: async () => 900n,
      replayVisible: async () =>
        Array.from({ length: 501 }, (_, index) =>
          event(BigInt(index + 1))),
    };
    const sent: unknown[] = [];
    const service = new RealtimeService(
      repository,
      new InMemoryRealtimeEventBus(),
    );

    const subscription = await service.open(
      { organizationId: 'org-1', userId: 'manager-1', role: 'MANAGER' },
      0n,
      { send: async (value) => { sent.push(value); } },
    );

    expect(sent).toEqual([{
      id: '900',
      type: 'sync.required',
      resourceKeys: ['workspace'],
      occurredAt: expect.any(String),
    }]);
    subscription.close();
  });

  it('closes and unsubscribes when replay send fails', async () => {
    const bus = new InMemoryRealtimeEventBus();
    const repository = {
      visibleHighWater: async () => 1n,
      replayVisible: async () => [event(1n)],
    };
    let closed = 0;
    const service = new RealtimeService(repository, bus);

    await expect(service.open(
      { organizationId: 'org-1', userId: 'manager-1', role: 'MANAGER' },
      0n,
      {
        send: async () => { throw new Error('closed socket'); },
        close: () => { closed += 1; },
      },
    )).rejects.toThrow('closed socket');

    expect(closed).toBe(1);
  });
});
