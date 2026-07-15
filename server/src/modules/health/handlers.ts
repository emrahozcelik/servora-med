import type { FastifyReply, FastifyRequest } from 'fastify';

import type { HealthReadinessPort } from './service.js';
import { getPublicHealthStatus } from './service.js';

export function createHealthHandlers(readiness: HealthReadinessPort) {
  return {
    async getHealth(_request: FastifyRequest, reply: FastifyReply) {
      const result = await readiness.check();
      const statusCode = result === 'ok' ? 200 : 503;
      return reply.code(statusCode).send(getPublicHealthStatus(result));
    },
  };
}
