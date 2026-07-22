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
import { presentNotification } from '../notifications/presenter.js';
import type { NotificationRecord } from '../notifications/types.js';

export const WEB_PUSH_DISPATCH_CONCURRENCY = 4;
export const WEB_PUSH_POLL_INTERVAL_MS = 5_000;
export const WEB_PUSH_SEND_TIMEOUT_MS = 10_000;
export const WEB_PUSH_LEASE_DURATION_MS = 30_000;
export const WEB_PUSH_SHUTDOWN_GRACE_MS = 15_000;
export const WEB_PUSH_DELIVERY_TTL_MS = 24 * 60 * 60 * 1_000;
export const WEB_PUSH_MAX_ATTEMPTS = 6;

export const WEB_PUSH_RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
] as const;

export function retryDelayForAttempt(attemptCount: number): number | null {
  return WEB_PUSH_RETRY_DELAYS_MS[attemptCount - 1] ?? null;
}

export type DispatcherConfig = Readonly<{
  pollIntervalMs: number;
  gracePeriodMs: number;
}>;

type DispatchOutcome =
  | 'DELIVERED'
  | 'PROVIDER_STALE'
  | 'RETRYABLE'
  | 'TERMINAL';

function classifyResponse(statusCode: number): DispatchOutcome {
  if (statusCode >= 200 && statusCode < 300) return 'DELIVERED';
  if (statusCode === 404 || statusCode === 410) return 'PROVIDER_STALE';
  if (statusCode === 408 || statusCode === 429) return 'RETRYABLE';
  if (statusCode >= 500 && statusCode < 600) return 'RETRYABLE';
  if (statusCode >= 300 && statusCode < 400) return 'TERMINAL';
  if (statusCode >= 400 && statusCode < 500) return 'TERMINAL';
  return 'TERMINAL';
}

function errorCodeForStatus(statusCode: number): string {
  if (statusCode >= 200 && statusCode < 300) return '';
  if (statusCode === 404) return 'PROVIDER_404';
  if (statusCode === 408) return 'PROVIDER_408';
  if (statusCode === 410) return 'PROVIDER_410';
  if (statusCode === 429) return 'PROVIDER_429';
  if (statusCode >= 500 && statusCode < 600) return 'PROVIDER_5XX';
  if (statusCode >= 300 && statusCode < 400) return 'PROVIDER_REDIRECT';
  if (statusCode >= 400 && statusCode < 500) return 'PROVIDER_4XX';
  return 'PROVIDER_4XX';
}

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
  pollIntervalMs: WEB_PUSH_POLL_INTERVAL_MS,
  gracePeriodMs: WEB_PUSH_SHUTDOWN_GRACE_MS,
};

export function createDispatcher(
  config: Partial<DispatcherConfig>,
  deps: DispatcherDeps,
): WebPushDispatcher {
  const cfg: DispatcherConfig = {
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_CONFIG.pollIntervalMs,
    gracePeriodMs: config.gracePeriodMs ?? DEFAULT_CONFIG.gracePeriodMs,
  };

  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let stopping = false;
  let pollInFlight = false;
  const activeSends = new Map<string, {
    controller: AbortController;
    promise: Promise<void>;
  }>();

  function toNotificationRecord(
    n: ClaimedWebPushDelivery['notification'],
  ): NotificationRecord {
    return {
      id: n.id,
      organizationId: n.organizationId,
      recipientUserId: n.recipientUserId,
      sourceRealtimeEventId: 0n,
      kind: n.kind as NotificationRecord['kind'],
      entityType: 'job-card',
      entityId: n.entityId,
      createdAt: n.createdAt,
      readAt: n.readAt,
    };
  }

  async function processDelivery(
    delivery: ClaimedWebPushDelivery,
  ): Promise<void> {
    const { deliveryId, leaseToken, subscription, notification } = delivery;

    let payload: PushPayloadV1;
    try {
      const record = toNotificationRecord(notification);
      const publicNotification: PublicNotification = presentNotification(record);
      payload = deps.buildPayload(publicNotification);
    } catch {
      await deps.repository.recordAbandoned({
        deliveryId, leaseToken, at: new Date(), errorCode: 'INVALID_PAYLOAD',
      } satisfies RecordAbandonedInput);
      return;
    }

    const controller = new AbortController();

    const sendPromise = (async () => {
      const topic = deps.topicBuilder(notification.id);

      const result: WebPushSendResult = await deps.sender.send({
        subscription: {
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
        payload,
        topic,
        signal: controller.signal,
      });

      if (result.type === 'aborted') return;

      const resultAt = new Date();

      if (result.type === 'response') {
        const outcome = classifyResponse(result.statusCode);

        switch (outcome) {
          case 'DELIVERED':
            await deps.repository.recordDelivered({
              deliveryId, leaseToken, subscriptionId: subscription.id, at: resultAt,
            } satisfies RecordDeliveredInput);
            break;

          case 'PROVIDER_STALE':
            await deps.repository.recordProviderStale({
              deliveryId, leaseToken, at: resultAt,
              errorCode: errorCodeForStatus(result.statusCode),
            } satisfies RecordProviderStaleInput);
            break;

          case 'RETRYABLE': {
            const delayMs = retryDelayForAttempt(delivery.attemptCount);
            if (delayMs === null) {
              await deps.repository.recordAbandoned({
                deliveryId, leaseToken, at: resultAt, errorCode: 'MAX_ATTEMPTS',
              } satisfies RecordAbandonedInput);
            } else {
              await deps.repository.recordRetry({
                deliveryId, leaseToken, subscriptionId: subscription.id, at: resultAt,
                nextAttemptAt: new Date(resultAt.getTime() + delayMs),
                errorCode: errorCodeForStatus(result.statusCode),
              } satisfies RecordRetryInput);
            }
            break;
          }

          case 'TERMINAL':
            await deps.repository.recordAbandoned({
              deliveryId, leaseToken, at: resultAt,
              errorCode: errorCodeForStatus(result.statusCode),
            } satisfies RecordAbandonedInput);
            break;
        }
      } else {
        const delayMs = retryDelayForAttempt(delivery.attemptCount);
        if (delayMs === null) {
          await deps.repository.recordAbandoned({
            deliveryId, leaseToken, at: resultAt, errorCode: 'MAX_ATTEMPTS',
          } satisfies RecordAbandonedInput);
        } else {
          await deps.repository.recordRetry({
            deliveryId, leaseToken, subscriptionId: subscription.id, at: resultAt,
            nextAttemptAt: new Date(resultAt.getTime() + delayMs),
            errorCode: result.type === 'timeout' ? 'TIMEOUT' : 'NETWORK',
          } satisfies RecordRetryInput);
        }
      }
    })();

    activeSends.set(deliveryId, { controller, promise: sendPromise });

    try {
      await sendPromise;
    } finally {
      activeSends.delete(deliveryId);
    }
  }

  async function runCycle(): Promise<void> {
    if (stopping || pollInFlight) return;
    pollInFlight = true;
    try {
      const at = new Date();

      try {
        await deps.repository.cleanupDueDeliveries(at);
      } catch {
        // cleanup failures are non-fatal
      }

      const availableSlots = WEB_PUSH_DISPATCH_CONCURRENCY - activeSends.size;
      if (availableSlots <= 0) return;

      let deliveries: readonly ClaimedWebPushDelivery[];
      try {
        deliveries = await deps.repository.claimDueDeliveries({
          limit: availableSlots,
          at,
        } satisfies ClaimDueWebPushDeliveriesInput);
      } catch {
        return;
      }

      if (deliveries.length === 0) return;

      if (stopping) return;

      for (const d of deliveries) {
        void processDelivery(d);
      }
    } finally {
      pollInFlight = false;
    }
  }

  function start(): void {
    if (intervalHandle !== null) return;
    intervalHandle = setInterval(() => {
      void runCycle();
    }, cfg.pollIntervalMs);
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }

    if (activeSends.size === 0) return;

    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Shutdown timeout')), cfg.gracePeriodMs),
    );

    const waitForActive = Promise.all(
      Array.from(activeSends.values()).map((a) =>
        a.promise.catch(() => undefined),
      ),
    ).then(() => undefined);

    try {
      await Promise.race([waitForActive, timeout]);
    } catch {
      for (const active of activeSends.values()) {
        active.controller.abort();
      }
      await waitForActive;
    }
  }

  return { start, stop };
}
