import type { FastifyReply, FastifyRequest } from 'fastify';

import type { WebPushService } from './service.js';
import { parseCreateWebPushSubscription } from './validation.js';

function identity(request: FastifyRequest) {
  return {
    organizationId: request.currentUser!.organizationId,
    userId: request.currentUser!.id,
    sessionId: request.currentSessionId!,
  };
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
  };
}
