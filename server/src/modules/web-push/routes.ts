import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify';

import { createWebPushHandlers } from './handlers.js';
import type { WebPushService } from './service.js';

export type WebPushRoutesOptions = Readonly<{
  service: WebPushService;
  authenticate: preHandlerHookHandler;
}>;

export const webPushRoutes: FastifyPluginAsync<WebPushRoutesOptions> = async (
  app,
  options,
) => {
  const handlers = createWebPushHandlers(options.service);
  app.get('/status', { preHandler: options.authenticate }, handlers.status);
};
