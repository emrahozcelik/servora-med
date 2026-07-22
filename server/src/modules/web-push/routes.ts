import type {
  FastifyPluginAsync,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';

import { createWebPushHandlers } from './handlers.js';
import type { WebPushService } from './service.js';
import { hashSessionToken } from '../auth/crypto.js';
import { SESSION_COOKIE_NAME } from '../auth/middleware.js';

const mutationRateLimit = {
  max: 6,
  timeWindow: 60_000,
  groupId: 'web-push-mutations',
  keyGenerator(request: FastifyRequest) {
    return requestKey(request);
  },
};

function requestKey(request: FastifyRequest): string {
  const rawToken = request.cookies[SESSION_COOKIE_NAME];
  return rawToken ? hashSessionToken(rawToken) : request.ip;
}

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
  app.post('/subscriptions', {
    preHandler: options.authenticate,
    config: { rateLimit: mutationRateLimit },
  }, handlers.create);
  app.delete(
    '/subscriptions/:subscriptionId',
    {
      preHandler: options.authenticate,
      config: { rateLimit: mutationRateLimit },
    },
    handlers.disable,
  );
};
