import type { FastifyInstance } from 'fastify';

import { getHealthHandler } from './handlers.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/', getHealthHandler);
}

