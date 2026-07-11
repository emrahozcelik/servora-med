import type { FastifyReply, FastifyRequest } from 'fastify';

import { getPublicHealthStatus } from './service.js';

export async function getHealthHandler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.code(200).send(getPublicHealthStatus());
}

