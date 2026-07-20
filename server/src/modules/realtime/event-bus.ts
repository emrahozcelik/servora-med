import type { RealtimeEventRecord } from './types.js';

export type RealtimeEventListener = (
  event: RealtimeEventRecord,
) => void;

export interface RealtimeEventPublisher {
  publish(event: RealtimeEventRecord): void;
}

export interface RealtimeEventBus extends RealtimeEventPublisher {
  subscribe(listener: RealtimeEventListener): () => void;
}

export const NOOP_REALTIME_EVENT_PUBLISHER: RealtimeEventPublisher = {
  publish() {},
};

export class InMemoryRealtimeEventBus implements RealtimeEventBus {
  private readonly listeners = new Set<RealtimeEventListener>();

  constructor(
    private readonly logError: (error: unknown) => void = () => {},
  ) {}

  subscribe(listener: RealtimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: RealtimeEventRecord): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logError(error);
      }
    }
  }
}
