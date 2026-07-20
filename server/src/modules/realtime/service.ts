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
    let liveSignalBuffered = false;
    let catchUpRequested = false;
    let liveDrain: Promise<void> | undefined;

    const closeConnection = (error?: unknown) => {
      if (closed) return;
      closed = true;
      clearListeners();
      sink.close?.();
      this.activeSubscriptions.delete(internal);
      if (error) throw error;
    };

    const send = (event: RealtimeEventEnvelope) => {
      const promise = writeChain.then(async () => {
        if (!closed) await sink.send(event);
      });
      writeChain = promise;
      return promise;
    };

    const sendCatchUp = async () => {
      const replay = await this.repository.replayVisible(
        viewer,
        lastSent,
        MAX_REPLAY + 1,
      );
      if (replay.length > MAX_REPLAY) {
        const highWater = await this.repository.visibleHighWater(viewer);
        await send({
          id: highWater.toString(),
          type: 'sync.required',
          resourceKeys: ['workspace'],
          occurredAt: this.now().toISOString(),
        });
        lastSent = highWater;
        return;
      }
      for (const event of replay) {
        if (event.id <= lastSent) continue;
        await send(presentRealtimeEvent(event));
        lastSent = event.id;
      }
    };

    const requestCatchUp = (): Promise<void> | undefined => {
      catchUpRequested = true;
      if (closed || replaying || liveDrain) return liveDrain;
      liveDrain = (async () => {
        while (!closed && catchUpRequested) {
          catchUpRequested = false;
          await sendCatchUp();
        }
      })().catch(() => {
        closeConnection();
      }).finally(() => {
        liveDrain = undefined;
        if (!closed && catchUpRequested) requestCatchUp();
      });
      return liveDrain;
    };

    const handleLiveEvent = (event: RealtimeEventRecord) => {
      if (closed || !canViewRealtimeEvent(viewer, event)) return;
      if (replaying) {
        liveSignalBuffered = true;
        return;
      }
      requestCatchUp();
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
            await send(presentRealtimeEvent(event));
            lastSent = event.id;
          }
        }
      }

      replaying = false;
      if (liveSignalBuffered) await requestCatchUp();
    } catch (error) {
      closeConnection(error);
      throw error;
    }

    return internal;
  }
}
