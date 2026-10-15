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
  organizationId: string;
  userId: string;
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

  /**
   * Observability seam: number of currently open SSE subscriptions. Shutdown
   * logs this before closing so a restart is never silent about how many
   * hijacked streams it is tearing down (OVR-3 outage follow-up).
   */
  get openSubscriptionCount(): number {
    return this.activeSubscriptions.size;
  }

  close() {
    this.shuttingDown = true;
    for (const sub of [...this.activeSubscriptions]) {
      try {
        sub.close();
      } catch {
        // A failed sink must not prevent global shutdown from closing others.
      }
    }
    this.activeSubscriptions.clear();
  }

  /**
   * Ends in-memory streams after the caller's durable access transaction commits.
   * This seam does not mutate database state and must not run for rolled-back work.
   */
  disconnectUser(organizationId: string, userId: string): number {
    const matchingSubscriptions = [...this.activeSubscriptions].filter(
      (subscription) => (
        subscription.organizationId === organizationId
        && subscription.userId === userId
      ),
    );

    for (const subscription of matchingSubscriptions) {
      try {
        subscription.close();
      } catch {
        // A failed sink must not prevent other matching streams from closing.
      }
    }

    return matchingSubscriptions.length;
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
    let originProbe: Promise<void> | undefined;
    let originProbeRequested = false;

    const closeConnection = (error?: unknown) => {
      if (closed) return;
      closed = true;
      let cleanupError: unknown;
      try {
        clearListeners();
      } catch (closeError) {
        cleanupError = closeError;
      }
      try {
        sink.close?.();
      } catch (closeError) {
        cleanupError ??= closeError;
      }
      this.activeSubscriptions.delete(internal);
      if (error) throw error;
      if (cleanupError) throw cleanupError;
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

    const requestOriginProbe = () => {
      originProbeRequested = true;
      if (originProbe) return;
      originProbe = (async () => {
        while (!closed && originProbeRequested) {
          originProbeRequested = false;
          // Persisted source audiences cannot enumerate future Sale owners.
          // Admit this wake-up through the same current-access query as replay;
          // coalesce bursts and never expand one query per historical Sale.
          const visible = await this.repository.replayVisible(viewer, lastSent, 1);
          if (!closed && visible.length > 0) await requestCatchUp();
        }
      })().catch(() => closeConnection()).finally(() => {
        originProbe = undefined;
      });
    };

    const handleLiveEvent = (event: RealtimeEventRecord) => {
      if (closed || event.organizationId !== viewer.organizationId) return;
      const directAudience = canViewRealtimeEvent(viewer, event);
      if (!directAudience && !event.resourceKeys.includes('sale-origin-context')) return;
      if (replaying) {
        liveSignalBuffered = true;
        return;
      }
      if (directAudience) requestCatchUp();
      else requestOriginProbe();
    };

    const unsubscribe = this.bus.subscribe(handleLiveEvent);

    const clearListeners = () => {
      unsubscribe();
    };

    const internal: RealtimeSubscriptionInternal = {
      organizationId: viewer.organizationId,
      userId: viewer.userId,
      close: () => {
        closeConnection();
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
