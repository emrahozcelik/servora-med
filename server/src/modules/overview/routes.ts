import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify';

import { createOverviewHandlers } from './handlers.js';
import type { OverviewService } from './service.js';

export type OverviewRoutesOptions = {
  service: OverviewService;
  authenticate: preHandlerHookHandler;
};

export const overviewRoutes: FastifyPluginAsync<OverviewRoutesOptions> = async (
  app,
  options,
) => {
  const handlers = createOverviewHandlers(options.service);
  app.get('/', { preHandler: options.authenticate }, handlers.get);
};
