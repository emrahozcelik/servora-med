import net from 'node:net';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { SESSION_COOKIE_NAME } from '../src/modules/auth/middleware.js';

/**
 * Production regression (OVR-3 outage, 2026-09-18):
 *
 * SIGTERM at 15:24:08 left app.close() hanging for the full 25 s shutdown
 * guard because an open hijacked SSE stream keeps server.close() waiting on
 * the socket. Fastify reaches onClose hooks only AFTER in-flight HTTP
 * requests complete, so the hook that closes the SSE could never run and the
 * hang force-exited the process with code 1 BEFORE any cleanup (scanner/
 * calendar/web-push workers) could run — which combined with operator
 * restarts and the systemd start limit into a ~2.5 minute outage.
 *
 * The remediation registers realtime teardown in `preClose`, the hook
 * Fastify runs BEFORE connection draining, exactly for removing
 * server-blocking state. Ordinary in-flight HTTP requests must still drain
 * gracefully, so these tests also pin down that the shutdown:
 * 1. closes the SSE via preClose (no stall),
 * 2. does NOT forcibly reset an ordinary in-flight request,
 * 3. lets the ordinary request complete,
 * 4. resolves app.close(),
 * 5. runs realtime teardown exactly once.
 *
 * The realtime stand-in below is deliberately faithful to the production
 * contract instead of being a no-op: RealtimeService.close() walks its active
 * subscriptions and calls each sink's close(), and it is that sink close that
 * ends the hijacked reply (routes.ts close() -> reply.raw.end()). A no-op
 * mock would keep the hijacked socket open no matter which hook the teardown
 * runs from, so it could not tell `preClose` apart from a force-close.
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

type FakeSink = { send: (event: unknown) => void; close?: () => void };

/**
 * Stand-in for RealtimeService that preserves the one property this
 * regression depends on: close() ends every open stream through its sink.
 */
function fakeRealtimeService() {
  const openSinks: FakeSink[] = [];
  const service = {
    open: vi.fn(async (_viewer: unknown, _cursor: unknown, sink: FakeSink) => {
      openSinks.push(sink);
      return { close: vi.fn() };
    }),
    close: vi.fn(() => {
      for (const sink of openSinks.splice(0)) {
        sink.close?.();
      }
    }),
  };
  return { service };
}

/** Open a real hijacked SSE stream the way Caddy forwards one. */
async function openSseStream(port: number): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(
    `GET /api/realtime/events HTTP/1.1\r\n`
    + `Host: 127.0.0.1\r\n`
    + `Cookie: ${SESSION_COOKIE_NAME}=any-token\r\n`
    + `Accept: text/event-stream\r\n\r\n`,
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE response timed out')), 5_000);
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes('200')) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        resolve();
      }
    };
    socket.on('data', onData);
  });
  // Allow the handler to finish registering the subscription.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return socket;
}

/** Wait until `predicate` holds, else fail with `message`. */
async function waitFor(predicate: () => boolean, timeoutMs: number, message: string) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterAll(async () => {
  vi.restoreAllMocks();
});

describe('shutdown with an open SSE stream (OVR-3 outage regression)', () => {
  it('closes promptly and runs realtime teardown despite an open hijacked stream', async () => {
    const { service: realtimeService } = fakeRealtimeService();

    const app = await buildApp(testConfig, {
      authRepository: activeManagerAuthRepository(),
      realtimeService: realtimeService as never,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected a TCP address');
    }

    let socket: net.Socket | null = null;
    try {
      socket = await openSseStream(address.port);
      expect(realtimeService.open).toHaveBeenCalledTimes(1);

      // SIGTERM equivalent: the app must reach its cleanup hooks and finish.
      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
      });

      await waitFor(() => closed, 3_000, 'app.close() must not stall on an open SSE stream');

      socket.destroy();
      socket = null;
      await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      expect(realtimeService.close).toHaveBeenCalledTimes(1);
    } finally {
      socket?.destroy();
      await app.close().catch(() => {});
    }
  });

  it('preClose closes the SSE while an ordinary in-flight request still completes', async () => {
    const { service: realtimeService } = fakeRealtimeService();

    const app = await buildApp(testConfig, {
      authRepository: activeManagerAuthRepository(),
      realtimeService: realtimeService as never,
    });

    // Test-only ordinary route whose handler holds the request open until the
    // gate is released AFTER app.close() has begun.
    let slowEntered = false;
    let releaseSlow: (() => void) | null = null;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    app.get('/test/slow', async () => {
      slowEntered = true;
      await slowGate;
      return { ok: true };
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected a TCP address');
    }

    let sseSocket: net.Socket | null = null;
    let slowSocket: net.Socket | null = null;
    try {
      sseSocket = await openSseStream(address.port);
      expect(realtimeService.open).toHaveBeenCalledTimes(1);

      // Ordinary in-flight request on its own connection, held by the gate.
      slowSocket = net.connect(address.port, '127.0.0.1');
      await new Promise<void>((resolve) => slowSocket!.once('connect', resolve));
      const slowResponse: Buffer[] = [];
      let slowReset = false;
      slowSocket.on('data', (chunk) => slowResponse.push(chunk));
      slowSocket.on('error', () => {
        slowReset = true;
      });
      slowSocket.write(
        `GET /test/slow HTTP/1.1\r\n`
        + `Host: 127.0.0.1\r\n`
        + `Connection: close\r\n\r\n`,
      );
      await waitFor(() => slowEntered, 5_000, 'slow handler never entered');

      // SIGTERM equivalent: preClose must close the SSE (removing the
      // server-blocking state) while the ordinary request keeps draining.
      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
      });

      await waitFor(() => realtimeService.close.mock.calls.length > 0, 3_000,
        'realtime teardown must run from preClose during shutdown');
      const sseClosed = new Promise<boolean>((resolve) => {
        if (sseSocket!.destroyed || !sseSocket!.writable) {
          resolve(true);
          return;
        }
        sseSocket!.once('close', () => resolve(true));
        setTimeout(() => resolve(false), 3_000);
      });
      expect(await sseClosed, 'SSE stream must be closed by preClose').toBe(true);

      // The ordinary request must NOT have been forcibly reset; release it
      // and let it complete while shutdown is still draining.
      expect(slowReset, 'ordinary in-flight request must not be reset').toBe(false);
      releaseSlow!();

      await waitFor(() => closed, 3_000,
        'app.close() must resolve after the ordinary request drains');
      await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 1_000))]);

      const slowBody = Buffer.concat(slowResponse).toString();
      expect(slowBody.includes('200'), 'ordinary request must complete with 200').toBe(true);
      expect(slowBody.includes('ok'), 'ordinary request body must arrive').toBe(true);
      expect(realtimeService.close, 'realtime teardown must run exactly once').toHaveBeenCalledTimes(1);
    } finally {
      releaseSlow?.();
      sseSocket?.destroy();
      slowSocket?.destroy();
      await app.close().catch(() => {});
    }
  });
});
