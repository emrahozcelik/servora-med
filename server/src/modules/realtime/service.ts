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
const MAX_PENDING_WRITES = 100;

export interface RealtimeStreamSink {
  send(event: RealtimeEventEnvelope): Promise<void>;
  close?(): void;
}

export interface RealtimeSubscription {
  close(): void;
}

interface RealtimeSubscriptionInternal extends RealtimeSubscription {
  close(): void;
}

export class RealtimeService {
  constructor(
    private readonly repository: RealtimeEventRepository,
    private readonly bus: RealtimeEventBus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private readonly activeSubscriptions = new Set<RealtimeSubscriptionInternal>();
  private shuttingDown = false;

  close() {
    this.shuttingDown = true;
    for (const sub of this.activeSubscriptions) {
      sub.close();
    }
    this.activeSubscriptions.clear();
  }

  async open(
    viewer: RealtimeViewer,
    cursor: bigint | null,
    sink: RealtimeStreamSink,
  ): Promise<RealtimeSubscription> {
    if (this.shuttingDown) {
      sink.close?.();
      throw new Error('RealtimeService is shutting down');
    }

    let closed = false;
    let replaying = true;
    let writeChain = Promise.resolve();
    let lastSent = cursor ?? 0n;
    let pendingWrites = 0;
    const buffered = new Map<bigint, RealtimeEventRecord>();

    const closeConnection = (error?: unknown) => {
      if (closed) return;
      closed = true;
      clearListeners();
      sink.close?.();
      this.activeSubscriptions.delete(internal);
      if (error) throw error;
    };

    const send = (event: RealtimeEventEnvelope) => {
      pendingWrites += 1;
      const promise = writeChain.then(async () => {
        try {
          if (!closed) await sink.send(event);
        } finally {
          pendingWrites -= 1;
        }
      });
      writeChain = promise;
      return promise;
    };

    const handleLiveEvent = (event: RealtimeEventRecord) => {
      if (closed || !canViewRealtimeEvent(viewer, event)) return;
      if (event.id <= lastSent) return;
      if (replaying) {
        buffered.set(event.id, event);
        return;
      }
      if (pendingWrites >= MAX_PENDING_WRITES) {
        closeConnection();
        return;
      }
      lastSent = event.id;
      void send(presentRealtimeEvent(event)).catch(() => {
        closeConnection();
      });
    };

    const unsubscribe = this.bus.subscribe(handleLiveEvent);

    const clearListeners = () => {
      unsubscribe();
    };

    const internal: RealtimeSubscriptionInternal = {
      close: () => {
        if (closed) return;
        closed = true;
        clearListeners();
        sink.close?.();
        this.activeSubscriptions.delete(internal);
      },
    };
    this.activeSubscriptions.add(internal);

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

      while (buffered.size > 0) {
        const batch = [...buffered.values()].sort(
          (left, right) => left.id < right.id ? -1 : 1,
        );
        buffered.clear();
        for (const event of batch) {
          if (event.id <= lastSent) continue;
          lastSent = event.id;
          await send(presentRealtimeEvent(event));
        }
      }

      replaying = false;
    } catch (error) {
      closeConnection(error);
      throw error;
    }

    return internal;
  }
}
