import { EventEmitter } from 'node:events';

import Fastify, {
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDependencies } from '../src/app.js';
import { SESSION_COOKIE_NAME } from '../src/modules/auth/middleware.js';
import {
  createRealtimeHandler,
  realtimeRoutes,
} from '../src/modules/realtime/routes.js';

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

function forcedPasswordAuthRepository() {
  const user = {
    id: 'staff-1',
    organizationId: 'org-1',
    name: 'Staff',
    email: 'staff@example.com',
    passwordHash: 'unused',
    role: 'STAFF' as const,
    mustChangePassword: true,
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

const apps: Awaited<ReturnType<typeof Fastify>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('realtime SSE route', () => {
  it('rejects an invalid Last-Event-ID before opening the stream', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const open = vi.fn();
    await app.register(realtimeRoutes, {
      service: { open } as never,
      authenticate: async (
        request: FastifyRequest,
        _reply: FastifyReply,
      ) => {
        request.currentUser = {
          id: 'manager-1',
          organizationId: 'org-1',
          role: 'MANAGER',
          mustChangePassword: false,
        } as never;
      },
      heartbeatMs: 20_000,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/events',
      headers: { 'last-event-id': 'not-a-number' },
    });

    expect(response.statusCode).toBe(400);
    expect(open).not.toHaveBeenCalled();
  });

  it('formats change events as SSE frames', async () => {
    const writes: string[] = [];
    const raw = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
      on: vi.fn(),
      once: vi.fn(),
      end: vi.fn(),
      destroyed: false,
    };
    const reply = {
      hijack: vi.fn(),
      raw,
    };
    const service = {
      open: vi.fn(async (_viewer, _cursor, sink) => {
        await sink.send({
          id: '42',
          type: 'job.started',
          entity: { type: 'job-card', id: 'job-1' },
          resourceKeys: ['job-board'],
          occurredAt: '2026-07-19T14:30:00.000Z',
        });
        return { close: vi.fn() };
      }),
    };

    await createRealtimeHandler(service as never, 20_000)(
      {
        headers: {},
        currentUser: {
          id: 'manager-1',
          organizationId: 'org-1',
          role: 'MANAGER',
        },
        raw: { on: vi.fn(), once: vi.fn() },
        log: { error: vi.fn() },
      } as never,
      reply as never,
    );

    expect(raw.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/event-stream; charset=utf-8',
    );
    expect(writes.join('')).toContain('id: 42\n');
    expect(writes.join('')).toContain('event: servora.change\n');
    expect(writes.join('')).toContain('"type":"job.started"');
  });

  it('cleans up the heartbeat and subscription when the connection closes', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const closeSubscription = vi.fn();
    const closeListeners = new Map<string, () => void>();
    const requestRaw = {
      once: vi.fn((event: string, listener: () => void) => {
        closeListeners.set(event, listener);
      }),
    };
    const raw = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
      once: vi.fn((event: string, listener: () => void) => {
        closeListeners.set(event, listener);
      }),
      end: vi.fn(),
      destroyed: false,
    };
    const service = {
      open: vi.fn(async () => ({ close: closeSubscription })),
    };

    try {
      await createRealtimeHandler(service as never, 1_000)(
        {
          headers: {},
          currentUser: {
            id: 'manager-1',
            organizationId: 'org-1',
            role: 'MANAGER',
          },
          raw: requestRaw,
          log: { error: vi.fn() },
        } as never,
        { hijack: vi.fn(), raw } as never,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(writes).toEqual([': heartbeat\n\n']);

      closeListeners.get('close')!();
      expect(closeSubscription).toHaveBeenCalledOnce();
      expect(raw.end).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(writes).toEqual([': heartbeat\n\n']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes subscription when disconnect happens before service.open completes', async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const closeSubscription = vi.fn();
    const service = {
      open: vi.fn(async () => {
        await openGate;
        return { close: closeSubscription };
      }),
    };
    const closeListeners = new Map<string, () => void>();
    const requestRaw = {
      once: vi.fn((event: string, listener: () => void) => {
        closeListeners.set(event, listener);
      }),
    };
    const raw = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(() => true),
      once: vi.fn(),
      end: vi.fn(),
      destroyed: false,
    };

    const handlerPromise = createRealtimeHandler(service as never, 20_000)(
      {
        headers: {},
        currentUser: { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' },
        raw: requestRaw,
        log: { error: vi.fn() },
      } as never,
      { hijack: vi.fn(), raw } as never,
    );

    closeListeners.get('close')!();
    releaseOpen();

    await handlerPromise;
    expect(closeSubscription).toHaveBeenCalledOnce();
  });

  it('settles an initial backpressured write when the request closes', async () => {
    const requestRaw = new EventEmitter();
    const raw = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(() => false),
      end: vi.fn(),
      destroyed: false,
    });
    const closeSubscription = vi.fn();
    const service = {
      open: vi.fn(async (_viewer, _cursor, sink) => {
        await sink.send({
          id: '0',
          type: 'sync.required',
          resourceKeys: ['workspace'],
          occurredAt: '2026-07-20T00:00:00.000Z',
        });
        return { close: closeSubscription };
      }),
    };

    const handler = createRealtimeHandler(service as never, 20_000)(
      {
        headers: {},
        currentUser: {
          id: 'manager-1',
          organizationId: 'org-1',
          role: 'MANAGER',
        },
        raw: requestRaw,
        log: { error: vi.fn() },
      } as never,
      { hijack: vi.fn(), raw } as never,
    );
    await new Promise(process.nextTick);
    requestRaw.emit('close');

    await expect(Promise.race([
      handler.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ])).resolves.toBe(true);
    expect(closeSubscription).toHaveBeenCalledOnce();
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('rejects a forced-password-change session before stream start', async () => {
    const open = vi.fn();
    const app = await buildApp(testConfig, {
      authRepository: forcedPasswordAuthRepository(),
      realtimeService: { open, close() {} } as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/realtime/events',
      cookies: { [SESSION_COOKIE_NAME]: 'any-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
    expect(open).not.toHaveBeenCalled();
  });
});
