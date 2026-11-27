import { describe, expect, it, vi } from 'vitest';

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
  it('coalesces same-org origin hints into bounded current-access probes and sends nothing to unrelated viewers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const replayVisible = vi.fn(async () => { await gate; return []; });
    const bus = new InMemoryRealtimeEventBus();
    const service = new RealtimeService({ visibleHighWater: async () => 0n, replayVisible }, bus);
    const sent: unknown[] = [];
    const subscription = await service.open({ organizationId: 'org-1', userId: 'unrelated', role: 'STAFF' }, null,
      { send: async (value) => { sent.push(value); } });
    const hint = { ...event(1n), resourceKeys: ['sale-origin-context'] };
    try {
      bus.publish({ ...hint, organizationId: 'foreign-org' });
      bus.publish(event(1n));
      expect(replayVisible).not.toHaveBeenCalled();
      for (let index = 0; index < 100; index += 1) bus.publish(hint);
      expect(replayVisible).toHaveBeenCalledTimes(1);
      release();
      await expect.poll(() => replayVisible.mock.calls.length).toBe(2);
      for (const call of replayVisible.mock.calls) expect(call).toEqual([
        { organizationId: 'org-1', userId: 'unrelated', role: 'STAFF' }, 0n, 1,
      ]);
      expect(sent).toHaveLength(1); // Initial sync only: no hidden source or Sale envelope.
    } finally { release(); subscription.close(); }
  });
  it('disconnects only the exact organization and user subscription', async () => {
    const repository = {
      visibleHighWater: async () => 0n,
      replayVisible: async () => [],
    };
    const closed: string[] = [];
    const service = new RealtimeService(
      repository,
      new InMemoryRealtimeEventBus(),
    );

    await service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      null,
      { send: async () => {}, close: () => { closed.push('target'); } },
    );
    await service.open(
      { organizationId: 'org-1', userId: 'staff-2', role: 'STAFF' },
      null,
      { send: async () => {}, close: () => { closed.push('same-org'); } },
    );
    await service.open(
      { organizationId: 'org-2', userId: 'staff-1', role: 'STAFF' },
      null,
      { send: async () => {}, close: () => { closed.push('other-org'); } },
    );

    expect(service.disconnectUser('org-1', 'staff-1')).toBe(1);
    expect(closed).toEqual(['target']);
  });

  it('closes every matching stream once and removes it from future delivery', async () => {
    const bus = new InMemoryRealtimeEventBus();
    const repository = {
      visibleHighWater: async () => 0n,
      replayVisible: async () => [],
    };
    const closed: string[] = [];
    const sent: string[] = [];
    const service = new RealtimeService(repository, bus);

    for (const stream of ['one', 'two', 'three']) {
      await service.open(
        { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
        null,
        {
          send: async (value) => { sent.push(`${stream}:${value.id}`); },
          close: () => { closed.push(stream); },
        },
      );
    }

    expect(service.disconnectUser('org-1', 'staff-1')).toBe(3);
    expect(closed).toEqual(['one', 'two', 'three']);
    bus.publish(event(1n));
    await new Promise(process.nextTick);
    expect(sent).toEqual(['one:0', 'two:0', 'three:0']);
    expect(service.disconnectUser('org-1', 'staff-1')).toBe(0);
  });

  it('continues closing matching subscriptions when one sink close fails', async () => {
    const repository = {
      visibleHighWater: async () => 0n,
      replayVisible: async () => [],
    };
    const closed: string[] = [];
    const service = new RealtimeService(
      repository,
      new InMemoryRealtimeEventBus(),
    );

    await service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      null,
      {
        send: async () => {},
        close: () => { throw new Error('socket already closed'); },
      },
    );
    await service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      null,
      { send: async () => {}, close: () => { closed.push('second'); } },
    );

    expect(service.disconnectUser('org-1', 'staff-1')).toBe(2);
    expect(closed).toEqual(['second']);
    expect(service.disconnectUser('org-1', 'staff-1')).toBe(0);
  });

  it('keeps global shutdown closing subscriptions after one sink close fails', async () => {
    const repository = {
      visibleHighWater: async () => 0n,
      replayVisible: async () => [],
    };
    const closed: string[] = [];
    const service = new RealtimeService(
      repository,
      new InMemoryRealtimeEventBus(),
    );

    await service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      null,
      { send: async () => {}, close: () => { throw new Error('socket already closed'); } },
    );
    await service.open(
      { organizationId: 'org-1', userId: 'staff-2', role: 'STAFF' },
      null,
      { send: async () => {}, close: () => { closed.push('second'); } },
    );

    expect(() => service.close()).not.toThrow();
    expect(closed).toEqual(['second']);
  });

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

  it('skips messaging events in replay and live catchup while advancing the cursor when messagingVisible is false', async () => {
    const bus = new InMemoryRealtimeEventBus();
    const convEvent = (
      id: bigint,
      type: RealtimeEventRecord['type'],
      entityType: RealtimeEventRecord['entityType'] = 'conversation',
    ): RealtimeEventRecord => ({
      ...event(id),
      type,
      entityType,
      entityId: `conv-${id}`,
      resourceKeys: ['messaging'],
    });

    const durable: RealtimeEventRecord[] = [
      convEvent(2n, 'conversation.created'),
      event(3n),
      convEvent(4n, 'message.sent'),
      convEvent(5n, 'conversation.participants_changed'),
    ];
    const replayCalls: bigint[] = [];
    const repository = {
      visibleHighWater: async () => 5n,
      replayVisible: async (_viewer: unknown, afterId: bigint) => {
        replayCalls.push(afterId);
        return durable.filter((item) => item.id > afterId);
      },
    };
    let visible = false;
    const visibilityChecks = vi.fn(async () => visible);
    const sent: string[] = [];
    const service = new RealtimeService(repository, bus, undefined, visibilityChecks);

    const sub = await service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      1n,
      { send: async (value) => { sent.push(`${value.id}:${value.type}`); } },
    );

    // Initial replay read visibility once for the batch, skipped 2/4/5, delivered 3, and advanced lastSent to 5.
    expect(sent).toEqual(['3:job.started']);
    expect(visibilityChecks).toHaveBeenCalledTimes(1);

    // Live batch while still disabled: skips 6, advances lastSent to 6 (replayVisible receives 5n -> 6n).
    const liveMsg = convEvent(6n, 'message.sent');
    durable.push(liveMsg);
    bus.publish(liveMsg);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual(['3:job.started']);
    expect(replayCalls).toEqual([1n, 5n]);

    // Turn messaging back on and emit a new job event: cursor starts after 6n (skipped rows are not re-sent).
    visible = true;
    const nextJob = event(7n);
    durable.push(nextJob);
    bus.publish(nextJob);
    await new Promise((r) => setTimeout(r, 10));
    expect(replayCalls).toEqual([1n, 5n, 6n]);
    expect(sent).toEqual(['3:job.started', '7:job.started']);
    sub.close();
  });
});
