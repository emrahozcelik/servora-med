import type { FastifyPluginAsync } from 'fastify';

import type { AppConfig } from '../../config.js';
import { createAuthHandlers } from './handlers.js';
import { requireAuthentication } from './middleware.js';
import type { AuthService } from './service.js';

export type AuthRoutesOptions = { authService: AuthService; config: AppConfig };

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const handlers = createAuthHandlers(options.authService, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: options.config.nodeEnv === 'production',
    maxAge: options.config.sessionTtlSeconds,
  });
  const authenticated = requireAuthentication(options.authService);

  app.post('/login', {
    config: { rateLimit: { max: options.config.loginRateLimitMax, timeWindow: options.config.rateLimitWindowMs } },
  }, handlers.login);
  app.get('/me', { preHandler: authenticated }, handlers.me);
  app.post('/logout', { preHandler: authenticated }, handlers.logout);
  app.post('/change-password', { preHandler: authenticated }, handlers.changePassword);
};
