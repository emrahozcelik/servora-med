import type { PushPayloadV1 } from './payload.js';
import type { WebPushSender, WebPushSendResult } from './sender.js';
import type {
  ClaimDueWebPushDeliveriesInput,
  ClaimedWebPushDelivery,
  RecordAbandonedInput,
  RecordDeliveredInput,
  RecordProviderStaleInput,
  RecordRetryInput,
} from './repository.js';
import type { PublicNotification } from '../notifications/presenter.js';
import { NOTIFICATION_MESSAGES } from '../notifications/presenter.js';

export type DispatcherConfig = Readonly<{
  pollIntervalMs: number;
  batchSize: number;
  gracePeriodMs: number;
}>;

export type DispatcherDeps = Readonly<{
  repository: {
    cleanupDueDeliveries(at: Date): Promise<number>;
    claimDueDeliveries(input: ClaimDueWebPushDeliveriesInput): Promise<readonly ClaimedWebPushDelivery[]>;
    recordDelivered(input: RecordDeliveredInput): Promise<boolean>;
    recordRetry(input: RecordRetryInput): Promise<boolean>;
    recordAbandoned(input: RecordAbandonedInput): Promise<boolean>;
    recordProviderStale(input: RecordProviderStaleInput): Promise<boolean>;
  };
  sender: WebPushSender;
  buildPayload: (notification: PublicNotification) => PushPayloadV1;
  topicBuilder: (notificationId: string) => string;
}>;

export interface WebPushDispatcher {
  start(): void;
  stop(): Promise<void>;
}

const DEFAULT_CONFIG: DispatcherConfig = {
  pollIntervalMs: 5_000,
  batchSize: 4,
  gracePeriodMs: 30_000,
};

function min(a: number, b: number): number {
  return a < b ? a : b;
}

function computeBackoff(attemptCount: number): number {
  const baseDelayMs = min(Math.pow(2, attemptCount - 1) * 10_000, 300_000);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(baseDelayMs * jitter);
}

export function createDispatcher(
  config: Partial<DispatcherConfig>,
  deps: DispatcherDeps,
): WebPushDispatcher {
  const cfg: DispatcherConfig = {
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_CONFIG.pollIntervalMs,
    batchSize: config.batchSize ?? DEFAULT_CONFIG.batchSize,
    gracePeriodMs: config.gracePeriodMs ?? DEFAULT_CONFIG.gracePeriodMs,
  };

  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let shutdownRequested = false;
  let inFlight = new Set<Promise<void>>();
  let abortController: AbortController | null = null;

  function toPublicNotification(
    n: ClaimedWebPushDelivery['notification'],
  ): PublicNotification {
    const message = NOTIFICATION_MESSAGES[n.kind as keyof typeof NOTIFICATION_MESSAGES] ?? {
      title: 'Bildirim',
      body: 'Yeni bir bildiriminiz var.',
    };
    return {
      id: n.id,
      kind: n.kind as PublicNotification['kind'],
      title: message.title,
      body: message.body,
      entity: { type: 'job-card', id: n.entityId },
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt?.toISOString() ?? null,
    };
  }

  async function processDelivery(
    delivery: ClaimedWebPushDelivery,
    signal: AbortSignal,
  ): Promise<void> {
    const { deliveryId, leaseToken, subscription, notification } = delivery;
    const at = new Date();

    let payload: PushPayloadV1;
    try {
      payload = deps.buildPayload(toPublicNotification(notification));
    } catch {
      await deps.repository.recordAbandoned({
        deliveryId, leaseToken, at, errorCode: 'BUILD_FAILED',
      } satisfies RecordAbandonedInput);
      return;
    }

    const topic = deps.topicBuilder(notification.id);

    const result: WebPushSendResult = await deps.sender.send({
      subscription: {
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      },
      payload,
      topic,
      signal,
    });

    switch (result.type) {
      case 'response': {
        const { statusCode } = result;
        if (statusCode >= 200 && statusCode < 300) {
          await deps.repository.recordDelivered({
            deliveryId, leaseToken, subscriptionId: subscription.id, at,
          } satisfies RecordDeliveredInput);
        } else if (statusCode === 404 || statusCode === 410) {
          await deps.repository.recordProviderStale({
            deliveryId, leaseToken, at, errorCode: `PROVIDER_${statusCode}`,
          } satisfies RecordProviderStaleInput);
        } else if (statusCode === 429) {
          const delayMs = computeBackoff(delivery.attemptCount);
          await deps.repository.recordRetry({
            deliveryId, leaseToken, subscriptionId: subscription.id, at,
            nextAttemptAt: new Date(at.getTime() + delayMs),
            errorCode: 'RATE_LIMITED',
          } satisfies RecordRetryInput);
        } else {
          const delayMs = computeBackoff(delivery.attemptCount);
          await deps.repository.recordRetry({
            deliveryId, leaseToken, subscriptionId: subscription.id, at,
            nextAttemptAt: new Date(at.getTime() + delayMs),
            errorCode: `HTTP_${statusCode}`,
          } satisfies RecordRetryInput);
        }
        break;
      }
      case 'network-error':
      case 'timeout': {
        const delayMs = computeBackoff(delivery.attemptCount);
        await deps.repository.recordRetry({
          deliveryId, leaseToken, subscriptionId: subscription.id, at,
          nextAttemptAt: new Date(at.getTime() + delayMs),
          errorCode: result.type === 'timeout' ? 'TIMEOUT' : 'NETWORK_ERROR',
        } satisfies RecordRetryInput);
        break;
      }
      case 'aborted':
        break;
    }
  }

  async function runCycle(): Promise<void> {
    if (shutdownRequested) return;
    const at = new Date();

    try {
      await deps.repository.cleanupDueDeliveries(at);
    } catch {
      // cleanup failures are non-fatal
    }

    let deliveries: readonly ClaimedWebPushDelivery[];
    try {
      deliveries = await deps.repository.claimDueDeliveries({
        limit: cfg.batchSize,
        at,
      } satisfies ClaimDueWebPushDeliveriesInput);
    } catch {
      return;
    }

    if (deliveries.length === 0) return;

    const cycleSignal = (abortController = new AbortController()).signal;
    const tasks = deliveries.map((d) => processDelivery(d, cycleSignal));
    const wrapped = Promise.allSettled(tasks).then(() => {
      if (abortController?.signal === cycleSignal) {
        abortController = null;
      }
    });

    inFlight.add(wrapped);
    void wrapped.finally(() => {
      inFlight.delete(wrapped);
    });
  }

  function start(): void {
    if (intervalHandle !== null) return;
    intervalHandle = setInterval(() => {
      void runCycle();
    }, cfg.pollIntervalMs);
  }

  async function stop(): Promise<void> {
    shutdownRequested = true;
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }

    if (inFlight.size === 0) return;

    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Shutdown timeout')), cfg.gracePeriodMs),
    );

    const waitForInFlight = Promise.all(
      Array.from(inFlight).map((p) =>
        p.catch(() => {
          /* swallow in-flight errors during shutdown */
        }),
      ),
    ).then(() => undefined);

    try {
      await Promise.race([waitForInFlight, timeout]);
    } catch {
      // Grace period expired — abort remaining
      abortController?.abort();
      await waitForInFlight;
    }
  }

  return { start, stop };
}
