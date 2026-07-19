import { canViewRealtimeEvent } from './audience.js';
import type { RealtimeEventBus } from './event-bus.js';
import type {
  RealtimeEventRepository,
} from './repository.js';
import {
  presentRealtimeEvent,
  type RealtimeEventEnvelope,
  type RealtimeEventRecord,
  type RealtimeViewer,
} from './types.js';

const MAX_REPLAY = 500;

export interface RealtimeStreamSink {
  send(event: RealtimeEventEnvelope): Promise<void>;
  close?(): void;
}

export interface RealtimeSubscription {
  close(): void;
}

export class RealtimeService {
  constructor(
    private readonly repository: RealtimeEventRepository,
    private readonly bus: RealtimeEventBus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async open(
    viewer: RealtimeViewer,
    cursor: bigint | null,
    sink: RealtimeStreamSink,
  ): Promise<RealtimeSubscription> {
    let closed = false;
    let replaying = true;
    let writeChain = Promise.resolve();
    let lastSent = cursor ?? 0n;
    const buffered = new Map<bigint, RealtimeEventRecord>();

    const send = (event: RealtimeEventEnvelope) => {
      writeChain = writeChain.then(async () => {
        if (!closed) await sink.send(event);
      });
      return writeChain;
    };

    const unsubscribe = this.bus.subscribe((event) => {
      if (closed || !canViewRealtimeEvent(viewer, event)) return;
      if (event.id <= lastSent) return;
      if (replaying) {
        buffered.set(event.id, event);
        return;
      }
      lastSent = event.id;
      void send(presentRealtimeEvent(event));
    });

    try {
      if (cursor === null) {
        const highWater = await this.repository.visibleHighWater(viewer);
        lastSent = highWater;
        await send({
          id: highWater.toString(),
          type: 'sync.required',
          resourceKeys: ['workspace'],
          occurredAt: this.now().toISOString(),
        });
      } else {
        const replay = await this.repository.replayVisible(
          viewer,
          cursor,
          MAX_REPLAY + 1,
        );
        if (replay.length > MAX_REPLAY) {
          const highWater = await this.repository.visibleHighWater(viewer);
          lastSent = highWater;
          await send({
            id: highWater.toString(),
            type: 'sync.required',
            resourceKeys: ['workspace'],
            occurredAt: this.now().toISOString(),
          });
        } else {
          for (const event of replay) {
            if (event.id <= lastSent) continue;
            lastSent = event.id;
            await send(presentRealtimeEvent(event));
          }
        }
      }

      for (const event of [...buffered.values()].sort(
        (left, right) => left.id < right.id ? -1 : 1,
      )) {
        if (event.id <= lastSent) continue;
        lastSent = event.id;
        await send(presentRealtimeEvent(event));
      }
      buffered.clear();
      replaying = false;
    } catch (error) {
      closed = true;
      unsubscribe();
      sink.close?.();
      throw error;
    }

    return {
      close() {
        if (closed) return;
        closed = true;
        unsubscribe();
        sink.close?.();
      },
    };
  }
}
