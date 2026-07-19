import Fastify, {
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRealtimeHandler,
  realtimeRoutes,
} from '../src/modules/realtime/routes.js';

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
});
