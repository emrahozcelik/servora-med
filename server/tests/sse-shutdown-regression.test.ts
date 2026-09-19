import net from 'node:net';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { SESSION_COOKIE_NAME } from '../src/modules/auth/middleware.js';

/**
 * Production regression (OVR-3 outage, 2026-09-18):
 *
 * SIGTERM at 15:24:08 left app.close() hanging for the full 25 s shutdown
 * guard because an open hijacked SSE stream keeps server.close() waiting on
 * the socket — and Fastify only destroys open connections during close when
 * `forceCloseConnections` is set. The hang force-exited the process with
 * code 1 BEFORE any onClose hook (realtime teardown, scanner/calendar/web
 * push workers) could run, which combined with operator restarts and the
 * systemd start limit into a ~2.5 minute outage.
 *
 * This test reproduces the exact mechanism against the real app: one open
 * hijacked SSE connection, then app.close(). Without the fix close never
 * resolves and the realtime onClose hook never fires; with the fix both
 * happen promptly.
 */

const testConfig = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 3000,
  databaseUrl: 'postgresql://unused-in-app-test',
  logLevel: 'silent',
  corsOrigin: 'http://127.0.0.1:5173',
  sessionTtlSeconds: 28_800,
  loginRateLimitMax: 5,
  rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback' as const,
  healthSchemaVersion: null,
  releaseSha: 'dev',
  actionScopedGeolocationEnabled: false,
  reverseGeocoderProvider: null,
  googleGeocodingApiKey: null,
  reverseGeocoderTimeoutMs: 2000,
  geocodingUserDailyLimit: 15,
  geocodingOrganizationDailyLimit: 250,
  geocodingGlobalMonthlyLimit: 8000,
  webPush: {
    enabled: false,
    vapidSubject: null,
    vapidPublicKey: null,
    vapidPrivateKey: null,
  },
};

function activeManagerAuthRepository() {
  const user = {
    id: 'manager-1',
    organizationId: 'org-1',
    name: 'Manager',
    email: 'manager@example.com',
    passwordHash: 'unused',
    role: 'MANAGER' as const,
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
  return {
    findSessionWithUser: async () => ({
      session: {
        id: 'session-1',
        userId: user.id,
        tokenHash: 'hash',
        expiresAt: new Date('2999-01-01T00:00:00.000Z'),
        revokedAt: null,
      },
      user,
    }),
  } as never;
}

afterAll(async () => {
  vi.restoreAllMocks();
});

describe('shutdown with an open SSE stream (OVR-3 outage regression)', () => {
  it('closes promptly and runs realtime teardown despite an open hijacked stream', async () => {
    const realtimeClose = vi.fn();
    const realtimeService = {
      open: vi.fn(async () => ({ close: realtimeClose })),
      close: vi.fn(),
    };

    const app = await buildApp(testConfig, {
      authRepository: activeManagerAuthRepository(),
      realtimeService: realtimeService as never,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected a TCP address');
    }

    // Open a real SSE stream the way Caddy forwards one: raw socket, hijacked
    // reply, headers flushed, no end of body.
    const socket = net.connect(address.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      `GET /api/realtime/events HTTP/1.1\r\n`
      + `Host: 127.0.0.1\r\n`
      + `Cookie: ${SESSION_COOKIE_NAME}=any-token\r\n`
      + `Accept: text/event-stream\r\n\r\n`,
    );
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        if (chunk.toString().includes('200')) {
          socket.removeListener('data', onData);
          resolve();
        }
      };
      socket.on('data', onData);
    });
    // Allow the handler to finish registering the subscription.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(realtimeService.open).toHaveBeenCalledTimes(1);

    // SIGTERM equivalent: the app must reach its cleanup hooks and finish.
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    const deadline = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(closed), 3_000);
    });

    const settledInTime = await deadline;
    expect(settledInTime, 'app.close() must not stall on an open SSE stream').toBe(true);

    socket.destroy();
    await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    expect(realtimeService.close).toHaveBeenCalledTimes(1);
  });
});
