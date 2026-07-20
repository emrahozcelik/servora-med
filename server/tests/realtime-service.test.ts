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
    let replayCalls = 0;
    const repository = {
      visibleHighWater: async () => 3n,
      replayVisible: async () => {
        replayCalls += 1;
        if (replayCalls === 1) {
          await replayGate;
          return [event(2n), event(3n)];
        }
        return [event(4n)];
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

  it('preserves events that arrive while buffer is being drained', async () => {
    const bus = new InMemoryRealtimeEventBus();
    const repository = {
      visibleHighWater: async () => 2n,
      replayVisible: async (_viewer: unknown, afterId: bigint) =>
        [event(2n), event(3n), event(4n)].filter(
          (value) => value.id > afterId,
        ),
    };
    let releaseSink!: () => void;
    let sinkCalls = 0;
    const sinkGate = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    const sent: string[] = [];
    const service = new RealtimeService(repository, bus);

    const opening = service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      1n,
      {
        send: async (value) => {
          sent.push(value.id);
          sinkCalls += 1;
          if (sinkCalls === 1) await sinkGate;
        },
        close: () => {},
      },
    );
    await new Promise(process.nextTick);

    bus.publish(event(4n));

    releaseSink();
    const subscription = await opening;
    expect(sent).toEqual(['2', '3', '4']);
    subscription.close();
  });

  it('closes subscription when live sink send rejects', async () => {
    const bus = new InMemoryRealtimeEventBus();
    const repository = {
      visibleHighWater: async () => 0n,
      replayVisible: async () => [event(1n)],
    };
    let callCount = 0;
    const closedCalls: string[] = [];
    const service = new RealtimeService(repository, bus);

    const subscription = await service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      null,
      {
        send: async () => {
          callCount += 1;
          if (callCount > 1) throw new Error('socket closed');
        },
        close: () => { closedCalls.push('sink'); },
      },
    );

    bus.publish(event(1n));
    await new Promise(process.nextTick);

    expect(closedCalls).toContain('sink');
    subscription.close();
  });

  it('catches up durable events in order when the bus publishes them out of order', async () => {
    const bus = new InMemoryRealtimeEventBus();
    const durableEvents = [event(5n), event(6n)];
    let opening = true;
    const repository = {
      visibleHighWater: async () => 0n,
      replayVisible: async (_viewer: unknown, afterId: bigint) => {
        if (opening) return [];
        return durableEvents.filter((value) => value.id > afterId);
      },
    };
    const sent: string[] = [];
    const service = new RealtimeService(repository, bus);

    const subscription = await service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      4n,
      { send: async (value) => { sent.push(value.id); } },
    );
    opening = false;

    bus.publish(event(6n));
    bus.publish(event(5n));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sent).toEqual(['5', '6']);
    subscription.close();
  });

  it('close removes all active subscriptions and prevents new ones', async () => {
    const bus = new InMemoryRealtimeEventBus();
    const repository = {
      visibleHighWater: async () => 0n,
      replayVisible: async () => [],
    };
    const closedCalls: string[] = [];
    const service = new RealtimeService(repository, bus);

    const sub1 = await service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      null,
      { send: async () => {}, close: () => { closedCalls.push('sub1'); } },
    );
    const sub2 = await service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      null,
      { send: async () => {}, close: () => { closedCalls.push('sub2'); } },
    );

    service.close();

    expect(closedCalls).toEqual(['sub1', 'sub2']);

    await expect(service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      null,
      { send: async () => {}, close: () => {} },
    )).rejects.toThrow('shutting down');

    sub1.close();
    sub2.close();
  });

  it('coalesces live signals while a durable send is pending', async () => {
    let releaseSend: (() => void) | null = null;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const bus = new InMemoryRealtimeEventBus();
    const durableEvents = Array.from(
      { length: 110 },
      (_, index) => event(BigInt(index + 151)),
    );
    let opening = true;
    const repository = {
      visibleHighWater: async () => 200n,
      replayVisible: async (_viewer: unknown, afterId: bigint) =>
        opening ? [] : durableEvents.filter((value) => value.id > afterId),
    };
    const sent: string[] = [];
    const service = new RealtimeService(repository, bus);

    const subscription = await service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      150n,
      {
        send: async (value) => {
          sent.push(value.id);
          if (sent.length === 1) await sendGate;
        },
      },
    );
    opening = false;

    for (let i = 151; i <= 260; i++) {
      bus.publish(event(BigInt(i)));
    }
    await new Promise(process.nextTick);
    expect(sent).toEqual(['151']);
    releaseSend!();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(durableEvents.map((value) => value.id.toString()));
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
