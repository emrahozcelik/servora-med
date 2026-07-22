import { describe, expect, it, vi } from 'vitest';

import { createDispatcher } from '../src/modules/web-push/dispatcher.js';
import type { PublicNotification } from '../src/modules/notifications/presenter.js';

function makeDelivery(overrides?: Record<string, unknown>) {
  const id = 'del-1';
  const subscriptionId = 'sub-1';
  return {
    deliveryId: id,
    leaseToken: 'tok-1',
    attemptCount: 1,
    notification: {
      id: 'notif-1',
      organizationId: 'org-1',
      recipientUserId: 'user-1',
      kind: 'job.assigned',
      entityType: 'job-card',
      entityId: '00000000-0000-0000-0000-000000000001',
      createdAt: new Date(),
      readAt: null,
    },
    subscription: {
      id: subscriptionId,
      endpoint: 'https://fcm.googleapis.com/fcm/send/test',
      p256dh: 'test-p256dh',
      auth: 'test-auth',
    },
    ...overrides,
  };
}

function makePayload() {
  return {
    version: 1 as const,
    notificationId: 'notif-1',
    title: 'Test',
    body: 'Test body',
    url: '/jobs/1',
  };
}

function makeDeps() {
  const repository = {
    cleanupDueDeliveries: vi.fn().mockResolvedValue(0),
    claimDueDeliveries: vi.fn().mockResolvedValue([]),
    recordDelivered: vi.fn().mockResolvedValue(true),
    recordRetry: vi.fn().mockResolvedValue(true),
    recordAbandoned: vi.fn().mockResolvedValue(true),
    recordProviderStale: vi.fn().mockResolvedValue(true),
  };
  const sender = {
    send: vi.fn().mockResolvedValue({ type: 'response', statusCode: 201 }),
  };
  const buildPayload = vi.fn().mockReturnValue(makePayload());
  const topicBuilder = vi.fn().mockReturnValue('topic-1');
  return { repository, sender, buildPayload, topicBuilder };
}

describe('WebPushDispatcher', () => {
  it('start and stop without errors', async () => {
    const deps = makeDeps();
    const dispatcher = createDispatcher({ pollIntervalMs: 100 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(deps.repository.cleanupDueDeliveries).not.toHaveBeenCalled();
    // No deliveries to claim, so no further calls
  });

  it('claims and delivers a single delivery', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue([makeDelivery()]);
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.claimDueDeliveries).toHaveBeenCalled();
    expect(deps.buildPayload).toHaveBeenCalled();
    expect(deps.sender.send).toHaveBeenCalled();
    expect(deps.repository.recordDelivered).toHaveBeenCalled();
  });

  it('retries on 5xx response', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue([makeDelivery()]);
    deps.sender.send.mockResolvedValue({ type: 'response', statusCode: 503 });
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.recordRetry).toHaveBeenCalled();
    expect(deps.repository.recordDelivered).not.toHaveBeenCalled();
    const retryArg = deps.repository.recordRetry.mock.calls[0]![0];
    expect(retryArg.errorCode).toBe('HTTP_503');
    expect(retryArg.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('records provider stale on 410', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue([makeDelivery()]);
    deps.sender.send.mockResolvedValue({ type: 'response', statusCode: 410 });
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.recordProviderStale).toHaveBeenCalled();
    const arg = deps.repository.recordProviderStale.mock.calls[0]![0];
    expect(arg.errorCode).toBe('PROVIDER_410');
  });

  it('records provider stale on 404', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue([makeDelivery()]);
    deps.sender.send.mockResolvedValue({ type: 'response', statusCode: 404 });
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.recordProviderStale).toHaveBeenCalled();
    const arg = deps.repository.recordProviderStale.mock.calls[0]![0];
    expect(arg.errorCode).toBe('PROVIDER_404');
  });

  it('abandons delivery on build failure', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue([makeDelivery()]);
    deps.buildPayload.mockImplementation(() => {
      throw new Error('Invalid entity');
    });
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.recordAbandoned).toHaveBeenCalled();
    const arg = deps.repository.recordAbandoned.mock.calls[0]![0];
    expect(arg.errorCode).toBe('BUILD_FAILED');
  });

  it('retries on network error', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue([makeDelivery()]);
    deps.sender.send.mockResolvedValue({ type: 'network-error' });
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.recordRetry).toHaveBeenCalled();
    const arg = deps.repository.recordRetry.mock.calls[0]![0];
    expect(arg.errorCode).toBe('NETWORK_ERROR');
  });

  it('retries on timeout', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue([makeDelivery()]);
    deps.sender.send.mockResolvedValue({ type: 'timeout' });
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.recordRetry).toHaveBeenCalled();
    const arg = deps.repository.recordRetry.mock.calls[0]![0];
    expect(arg.errorCode).toBe('TIMEOUT');
  });

  it('does nothing on aborted result', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue([makeDelivery()]);
    deps.sender.send.mockResolvedValue({ type: 'aborted' });
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.recordDelivered).not.toHaveBeenCalled();
    expect(deps.repository.recordRetry).not.toHaveBeenCalled();
    expect(deps.repository.recordAbandoned).not.toHaveBeenCalled();
    expect(deps.repository.recordProviderStale).not.toHaveBeenCalled();
  });

  it('handles empty claim gracefully', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue([]);
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.claimDueDeliveries).toHaveBeenCalled();
    expect(deps.sender.send).not.toHaveBeenCalled();
  });

  it('does not crash when claimDueDeliveries throws', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockRejectedValue(new Error('DB error'));
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();
    // Should not throw
  });

  it('waits for in-flight deliveries on stop', async () => {
    const deps = makeDeps();
    const delivery = makeDelivery();
    deps.repository.claimDueDeliveries.mockResolvedValue([delivery]);

    let resolveSend!: () => void;
    deps.sender.send.mockReturnValue(
      new Promise((r) => {
        resolveSend = () => r({ type: 'response', statusCode: 201 });
      }),
    );

    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);
    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));

    const stopPromise = dispatcher.stop();
    resolveSend!();
    await stopPromise;

    expect(deps.repository.recordDelivered).toHaveBeenCalled();
  });

  it('shutdown abort after grace period', async () => {
    const deps = makeDeps();
    const delivery = makeDelivery();
    deps.repository.claimDueDeliveries.mockResolvedValue([delivery]);
    deps.sender.send.mockImplementation(({ signal }: { signal: AbortSignal }) => {
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ type: 'aborted' });
        });
      });
    });
    const dispatcher = createDispatcher({ pollIntervalMs: 50, gracePeriodMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();
  });
});
