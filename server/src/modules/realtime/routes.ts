import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';

import { AppError } from '../../errors/index.js';
import type { RealtimeService } from './service.js';
import type {
  RealtimeEventEnvelope,
} from './types.js';

type Options = {
  service: RealtimeService;
  authenticate: preHandlerHookHandler;
  heartbeatMs?: number;
};

function parseCursor(value: unknown): bigint | null {
  if (value === undefined) return null;
  if (
    typeof value !== 'string'
    || !/^(0|[1-9]\d*)$/.test(value)
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      'Last-Event-ID geçersiz.',
    );
  }
  return BigInt(value);
}

function frame(event: RealtimeEventEnvelope): string {
  return `id: ${event.id}\nevent: servora.change\ndata: ${
    JSON.stringify(event)
  }\n\n`;
}

export function createRealtimeHandler(
  service: RealtimeService,
  heartbeatMs = 20_000,
) {
  return async function realtimeHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const currentUser = request.currentUser!;
    const cursor = parseCursor(request.headers['last-event-id']);

    reply.hijack();
    reply.raw.setHeader(
      'Content-Type',
      'text/event-stream; charset=utf-8',
    );
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    let subscription: { close(): void } | undefined;
    let writeChain = Promise.resolve();
    let closed = false;

    const write = (chunk: string) => {
      writeChain = writeChain.then(async () => {
        if (closed) return;
        const accepted = reply.raw.write(chunk);
        if (!accepted) {
          await new Promise<void>((resolve) => {
            reply.raw.once('drain', resolve);
          });
        }
      });
      return writeChain;
    };

    const heartbeat = setInterval(() => {
      void write(': heartbeat\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription?.close();
      if (!reply.raw.destroyed) reply.raw.end();
    };

    request.raw.once('close', close);
    request.raw.once('aborted', close);

    try {
      const opened = await service.open(
        {
          organizationId: currentUser.organizationId,
          userId: currentUser.id,
          role: currentUser.role,
        },
        cursor,
        {
          send: (event) => write(frame(event)),
          close,
        },
      );
      if (closed) {
        opened.close();
        return;
      }
      subscription = opened;
    } catch (error) {
      close();
      request.log.error(
        { err: error },
        'Realtime stream failed',
      );
    }
  };
}

export const realtimeRoutes: FastifyPluginAsync<Options> = async (
  app,
  options,
) => {
  app.get(
    '/events',
    { preHandler: options.authenticate },
    createRealtimeHandler(
      options.service,
      options.heartbeatMs ?? 20_000,
    ),
  );
};
