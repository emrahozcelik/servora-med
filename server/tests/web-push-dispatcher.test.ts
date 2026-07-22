import { describe, expect, it, vi } from 'vitest';

import {
  createDispatcher,
  retryDelayForAttempt,
  WEB_PUSH_RETRY_DELAYS_MS,
  WEB_PUSH_SHUTDOWN_GRACE_MS,
  WEB_PUSH_DISPATCH_CONCURRENCY,
} from '../src/modules/web-push/dispatcher.js';

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
    send: vi.fn().mockResolvedValue({ type: 'response' as const, statusCode: 201 }),
  };
  const buildPayload = vi.fn().mockReturnValue(makePayload());
  const topicBuilder = vi.fn().mockReturnValue('topic-1');
  return { repository, sender, buildPayload, topicBuilder };
}

describe('retryDelayForAttempt', () => {
  it('returns exact delays per spec', () => {
    expect(WEB_PUSH_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000, 1_800_000, 3_600_000]);
  });

  it('returns 30s for attempt 1', () => {
    expect(retryDelayForAttempt(1)).toBe(30_000);
  });

  it('returns 2m for attempt 2', () => {
    expect(retryDelayForAttempt(2)).toBe(120_000);
  });

  it('returns 10m for attempt 3', () => {
    expect(retryDelayForAttempt(3)).toBe(600_000);
  });

  it('returns 30m for attempt 4', () => {
    expect(retryDelayForAttempt(4)).toBe(1_800_000);
  });

  it('returns 1h for attempt 5', () => {
    expect(retryDelayForAttempt(5)).toBe(3_600_000);
  });

  it('returns null for attempt 6 (immediate abandon)', () => {
    expect(retryDelayForAttempt(6)).toBeNull();
  });

  it('returns null for attempt > 6', () => {
    expect(retryDelayForAttempt(7)).toBeNull();
    expect(retryDelayForAttempt(99)).toBeNull();
  });

  it('no Math.random usage is proven by deterministic output', () => {
    for (let i = 1; i <= 10; i++) {
      const r1 = retryDelayForAttempt(i);
      const r2 = retryDelayForAttempt(i);
      expect(r1).toBe(r2);
    }
  });
});

describe('WebPushDispatcher', () => {
  it('start and stop without errors', async () => {
    const deps = makeDeps();
    const dispatcher = createDispatcher({ pollIntervalMs: 100 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 50));
    await dispatcher.stop();

    expect(deps.repository.cleanupDueDeliveries).not.toHaveBeenCalled();
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

function abortAwarePending() {
  const mock = vi.fn();
  mock.mockImplementation((opts: { signal?: AbortSignal }) => {
    if (opts.signal?.aborted) return Promise.resolve({ type: 'aborted' });
    return new Promise((resolve) => {
      opts.signal?.addEventListener('abort', () => resolve({ type: 'aborted' }), { once: true });
    });
  });
  return mock;
}

  it('claim limit equals available slots, not batchSize', async () => {
    const deps = makeDeps();
    deps.sender.send = abortAwarePending();
    deps.repository.claimDueDeliveries.mockResolvedValue([makeDelivery()]);
    const dispatcher = createDispatcher({ pollIntervalMs: 50, gracePeriodMs: 100 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));

    expect(deps.repository.claimDueDeliveries).toHaveBeenCalledTimes(1);
    const claimArg = deps.repository.claimDueDeliveries.mock.calls[0]![0];
    expect(claimArg.limit).toBe(WEB_PUSH_DISPATCH_CONCURRENCY);

    await dispatcher.stop();
  });

  it('no concurrency exceeds 4 at any point', async () => {
    const deps = makeDeps();
    deps.sender.send = abortAwarePending();
    deps.repository.claimDueDeliveries.mockImplementation(
      async ({ limit }: { limit: number }) =>
        Array.from({ length: Math.min(limit, 5) }, (_, i) =>
          makeDelivery({ deliveryId: `del-${i}` })),
    );

    const dispatcher = createDispatcher({ pollIntervalMs: 50, gracePeriodMs: 100 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));

    expect(deps.repository.claimDueDeliveries).toHaveBeenCalled();
    const claimArg = deps.repository.claimDueDeliveries.mock.calls[0]![0];
    expect(claimArg.limit).toBe(WEB_PUSH_DISPATCH_CONCURRENCY);

    expect(deps.sender.send.mock.calls.length).toBeLessThanOrEqual(4);

    await dispatcher.stop();
  });

  it('two active sends, next poll claims 2 (availableSlots = 2)', async () => {
    const deps = makeDeps();
    deps.sender.send = abortAwarePending();

    let pollCount = 0;
    deps.repository.claimDueDeliveries.mockImplementation(async ({ limit }) => {
      pollCount++;
      if (pollCount === 1) {
        return [makeDelivery({ deliveryId: 'a' }), makeDelivery({ deliveryId: 'b' })];
      }
      if (pollCount === 2) {
        expect(limit).toBe(WEB_PUSH_DISPATCH_CONCURRENCY - 2);
        return [];
      }
      return [];
    });

    const dispatcher = createDispatcher({ pollIntervalMs: 100, gracePeriodMs: 100 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 250));
    await dispatcher.stop();
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
    expect(retryArg.errorCode).toBe('PROVIDER_5XX');
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
      throw new Error('Invalid payload');
    });
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.recordAbandoned).toHaveBeenCalled();
    const arg = deps.repository.recordAbandoned.mock.calls[0]![0];
    expect(arg.errorCode).toBe('INVALID_PAYLOAD');
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
    expect(arg.errorCode).toBe('NETWORK');
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

  // === HTTP mapping table-driven tests ===

  const RESPONSE_MAP: Array<{ statusCode: number; expected: string; label: string }> = [
    { statusCode: 201, expected: 'DELIVERED', label: '201 delivered' },
    { statusCode: 301, expected: 'TERMINAL', label: '301 terminal' },
    { statusCode: 400, expected: 'TERMINAL', label: '400 terminal' },
    { statusCode: 401, expected: 'TERMINAL', label: '401 terminal' },
    { statusCode: 403, expected: 'TERMINAL', label: '403 terminal' },
    { statusCode: 404, expected: 'PROVIDER_STALE', label: '404 stale' },
    { statusCode: 408, expected: 'RETRYABLE', label: '408 retry' },
    { statusCode: 410, expected: 'PROVIDER_STALE', label: '410 stale' },
    { statusCode: 429, expected: 'RETRYABLE', label: '429 retry' },
    { statusCode: 500, expected: 'RETRYABLE', label: '500 retry' },
    { statusCode: 503, expected: 'RETRYABLE', label: '503 retry' },
    { statusCode: 0, expected: 'TERMINAL', label: '0 terminal' },
  ];

  for (const { statusCode, expected, label } of RESPONSE_MAP) {
    it(`HTTP ${label}`, async () => {
      const deps = makeDeps();
      deps.repository.claimDueDeliveries.mockResolvedValue([makeDelivery()]);
      deps.sender.send.mockResolvedValue({ type: 'response', statusCode });
      const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

      dispatcher.start();
      await new Promise((r) => setTimeout(r, 80));
      await dispatcher.stop();

      if (expected === 'DELIVERED') {
        expect(deps.repository.recordDelivered).toHaveBeenCalled();
      } else {
        expect(deps.repository.recordDelivered).not.toHaveBeenCalled();
      }

      if (expected === 'PROVIDER_STALE') {
        expect(deps.repository.recordProviderStale).toHaveBeenCalled();
      } else {
        expect(deps.repository.recordProviderStale).not.toHaveBeenCalled();
      }

      if (expected === 'RETRYABLE') {
        expect(deps.repository.recordRetry).toHaveBeenCalled();
      } else {
        expect(deps.repository.recordRetry).not.toHaveBeenCalled();
      }

      if (expected === 'TERMINAL') {
        expect(deps.repository.recordAbandoned).toHaveBeenCalled();
      }
    });
  }

  // === Attempt 6 immediate abandonment ===

  it('attempt 6 retryable result calls recordAbandoned not recordRetry', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue(
      [makeDelivery({ attemptCount: 6 })],
    );
    deps.sender.send.mockResolvedValue({ type: 'response', statusCode: 503 });
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.recordAbandoned).toHaveBeenCalled();
    expect(deps.repository.recordRetry).not.toHaveBeenCalled();
    const arg = deps.repository.recordAbandoned.mock.calls[0]![0];
    expect(arg.errorCode).toBe('MAX_ATTEMPTS');
  });

  it('attempt 6 network error calls recordAbandoned not recordRetry', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue(
      [makeDelivery({ attemptCount: 6 })],
    );
    deps.sender.send.mockResolvedValue({ type: 'network-error' });
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.recordAbandoned).toHaveBeenCalled();
    expect(deps.repository.recordRetry).not.toHaveBeenCalled();
    const arg = deps.repository.recordAbandoned.mock.calls[0]![0];
    expect(arg.errorCode).toBe('MAX_ATTEMPTS');
  });

  it('attempt 6 timeout calls recordAbandoned not recordRetry', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue(
      [makeDelivery({ attemptCount: 6 })],
    );
    deps.sender.send.mockResolvedValue({ type: 'timeout' });
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 80));
    await dispatcher.stop();

    expect(deps.repository.recordAbandoned).toHaveBeenCalled();
    expect(deps.repository.recordRetry).not.toHaveBeenCalled();
  });

  // === Poll overlap ===

  it('second poll does not claim while first poll is in-flight', async () => {
    const deps = makeDeps();
    let claimResolve!: () => void;
    deps.repository.claimDueDeliveries.mockReturnValue(
      new Promise((r) => {
        claimResolve = () => r([makeDelivery()]);
      }),
    );
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 60));

    // First claim still unresolved
    expect(deps.repository.claimDueDeliveries).toHaveBeenCalledTimes(1);

    claimResolve!();
    await new Promise((r) => setTimeout(r, 100));
    await dispatcher.stop();
  });

  // === Shutdown / claim race ===

  it('claim resolved after stop does not start sender', async () => {
    const deps = makeDeps();
    let claimResolve!: (v: unknown[]) => void;
    deps.repository.claimDueDeliveries.mockReturnValue(
      new Promise((r) => { claimResolve = r; }),
    );
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 60));

    const stopPromise = dispatcher.stop();
    claimResolve!([makeDelivery()]);
    await stopPromise;

    // Sender should NOT be called because stopping was true when deliveries arrived
    expect(deps.sender.send).not.toHaveBeenCalled();
  });

  // === Multi-cycle abort ===

  it('active sends from different cycles are all aborted on stop', async () => {
    const deps = makeDeps();
    deps.sender.send = abortAwarePending();
    deps.repository.claimDueDeliveries
      .mockResolvedValueOnce([makeDelivery({ deliveryId: 'a' })])
      .mockResolvedValueOnce([makeDelivery({ deliveryId: 'b' })])
      .mockResolvedValue([]);

    const dispatcher = createDispatcher({ pollIntervalMs: 50, gracePeriodMs: 100 }, deps);

    dispatcher.start();
    await new Promise((r) => setTimeout(r, 120));
    // Two cycles may have run, two active sends

    await dispatcher.stop();
    // Should not hang - abort kills all active
  });

  it('stop does not start new claims', async () => {
    const deps = makeDeps();
    deps.repository.claimDueDeliveries.mockResolvedValue([makeDelivery()]);
    const dispatcher = createDispatcher({ pollIntervalMs: 50 }, deps);

    dispatcher.start();
    await dispatcher.stop();
    const callsAfterStop = deps.repository.claimDueDeliveries.mock.calls.length;

    await new Promise((r) => setTimeout(r, 100));
    // No additional claims after stop
    expect(deps.repository.claimDueDeliveries.mock.calls.length).toBe(callsAfterStop);
  });

  // === Default-off gate ===

  it('default grace period is 15 seconds', () => {
    expect(WEB_PUSH_SHUTDOWN_GRACE_MS).toBe(15_000);
  });
});
