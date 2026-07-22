import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { WebPushDispatcher } from '../src/modules/web-push/dispatcher.js';

describe('Web Push lifecycle', () => {
  it('does not wire dispatcher when no webPushRepository', async () => {
    const config = { ...loadConfig(), webPush: { enabled: true, vapidSubject: null, vapidPublicKey: null, vapidPrivateKey: null } };
    const app = await buildApp(config, {
      authRepository: {
        authenticate: vi.fn().mockResolvedValue({ id: 'u1', organizationId: 'o1', role: 'ADMIN' }),
        provision: vi.fn(),
        handlePasswordChange: vi.fn(),
      },
    });
    expect(app.hasPlugin('@fastify/cookie')).toBe(true);
    await app.close();
  });

  it('wires and starts injected dispatcher on ready', async () => {
    const start = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    const dispatcher: WebPushDispatcher = { start, stop };

    const config = { ...loadConfig(), webPush: { ...loadConfig().webPush, enabled: true } };
    const app = await buildApp(config, {
      authRepository: {
        authenticate: vi.fn().mockResolvedValue({ id: 'u1', organizationId: 'o1', role: 'ADMIN' }),
        provision: vi.fn(),
        handlePasswordChange: vi.fn(),
      },
      webPushRepository: {
        findCurrentSession: vi.fn(),
        upsert: vi.fn(),
        disable: vi.fn(),
        cleanupDueDeliveries: vi.fn().mockResolvedValue(0),
        claimDueDeliveries: vi.fn().mockResolvedValue([]),
        recordDelivered: vi.fn().mockResolvedValue(true),
        recordRetry: vi.fn().mockResolvedValue(true),
        recordAbandoned: vi.fn().mockResolvedValue(true),
        recordProviderStale: vi.fn().mockResolvedValue(true),
      },
      webPushDispatcher: dispatcher,
    });

    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();

    await app.ready();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    await app.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not start dispatcher when webPush is disabled and no injected dispatcher', async () => {
    const config = { ...loadConfig(), webPush: { enabled: false, vapidSubject: null, vapidPublicKey: null, vapidPrivateKey: null } };

    const app = await buildApp(config, {
      authRepository: {
        authenticate: vi.fn().mockResolvedValue({ id: 'u1', organizationId: 'o1', role: 'ADMIN' }),
        provision: vi.fn(),
        handlePasswordChange: vi.fn(),
      },
      webPushRepository: {
        findCurrentSession: vi.fn(),
        upsert: vi.fn(),
        disable: vi.fn(),
        cleanupDueDeliveries: vi.fn().mockResolvedValue(0),
        claimDueDeliveries: vi.fn().mockResolvedValue([]),
        recordDelivered: vi.fn().mockResolvedValue(true),
        recordRetry: vi.fn().mockResolvedValue(true),
        recordAbandoned: vi.fn().mockResolvedValue(true),
        recordProviderStale: vi.fn().mockResolvedValue(true),
      },
    });

    await app.ready();
    await app.close();
    // No dispatcher related errors — clean lifecycle
  });

  it('does not start or stop injected dispatcher when webPush is disabled', async () => {
    const start = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    const dispatcher: WebPushDispatcher = { start, stop };

    const config = {
      ...loadConfig(),
      webPush: {
        enabled: false,
        vapidSubject: null,
        vapidPublicKey: null,
        vapidPrivateKey: null,
      },
    };

    const app = await buildApp(config, {
      authRepository: {
        authenticate: vi.fn().mockResolvedValue({ id: 'u1', organizationId: 'o1', role: 'ADMIN' }),
        provision: vi.fn(),
        handlePasswordChange: vi.fn(),
      },
      webPushRepository: {
        findCurrentSession: vi.fn(),
        upsert: vi.fn(),
        disable: vi.fn(),
        cleanupDueDeliveries: vi.fn().mockResolvedValue(0),
        claimDueDeliveries: vi.fn().mockResolvedValue([]),
        recordDelivered: vi.fn().mockResolvedValue(true),
        recordRetry: vi.fn().mockResolvedValue(true),
        recordAbandoned: vi.fn().mockResolvedValue(true),
        recordProviderStale: vi.fn().mockResolvedValue(true),
      },
      webPushDispatcher: dispatcher,
    });

    await app.ready();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();

    await app.close();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});
