import type { FastifyPluginAsync } from 'fastify';

import { createHealthHandlers } from './handlers.js';
import type { HealthReadinessPort } from './service.js';

export type HealthRoutesOptions = {
  readiness: HealthReadinessPort;
};

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  const handlers = createHealthHandlers(options.readiness);
  app.get('/', handlers.getHealth);
};
