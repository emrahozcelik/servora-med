import type { FastifyRequest } from 'fastify';

import type { WebPushService } from './service.js';

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
  };
}
