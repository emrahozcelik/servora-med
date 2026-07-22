import type { FastifyReply, FastifyRequest } from 'fastify';

import type { WebPushService } from './service.js';
import { parseCreateWebPushSubscription } from './validation.js';
import { AppError } from '../../errors/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function identity(request: FastifyRequest) {
  return {
    organizationId: request.currentUser!.organizationId,
    userId: request.currentUser!.id,
    sessionId: request.currentSessionId!,
  };
}

function subscriptionId(request: FastifyRequest): string {
  const value = (request.params as { subscriptionId?: unknown }).subscriptionId;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new AppError(
      'INVALID_WEB_PUSH_SUBSCRIPTION_ID',
      400,
      'Cihaz bildirimi kimliği geçersiz.',
    );
  }
  return value;
}

export function createWebPushHandlers(service: WebPushService) {
  return {
    status: (request: FastifyRequest) => service.status(identity(request)),
    create: async (request: FastifyRequest, reply: FastifyReply) => reply
      .code(201)
      .send(await service.create(
        identity(request),
        parseCreateWebPushSubscription(request.body),
      )),
    disable: async (request: FastifyRequest, reply: FastifyReply) => {
      await service.disable(identity(request), subscriptionId(request));
      return reply.code(204).send();
    },
  };
}
