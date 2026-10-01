import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  CHANGE_PASSWORD_RATE_LIMIT_MAX_DEFAULT,
  type AppConfig,
} from '../../config.js';
import { hashSessionToken } from './crypto.js';
import { createAuthHandlers } from './handlers.js';
import { requireAuthentication, SESSION_COOKIE_NAME } from './middleware.js';
import type { AuthService } from './service.js';

export type AuthRoutesOptions = { authService: AuthService; config: AppConfig };

/**
 * Authenticated-write budget for `POST /api/auth/change-password`.
 *
 * Keyed by the presented session token (falling back to the client IP when no
 * cookie is present), mirroring the web-push mutation policy: the bucket
 * follows the signed-in session rather than the whole authenticated surface, so
 * repeated current-password guessing is bounded without throttling unrelated
 * authenticated routes. The rate-limit hook runs at `onRequest`, before the
 * auth pre-handler, so the key is derived from the cookie rather than
 * `request.currentUser`.
 */
function changePasswordRateLimit(config: AppConfig) {
  return {
    max: config.changePasswordRateLimitMax ?? CHANGE_PASSWORD_RATE_LIMIT_MAX_DEFAULT,
    timeWindow: config.rateLimitWindowMs,
    groupId: 'auth-change-password',
    keyGenerator(request: FastifyRequest) {
      const rawToken = request.cookies[SESSION_COOKIE_NAME];
      return rawToken ? hashSessionToken(rawToken) : request.ip;
    },
  };
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const handlers = createAuthHandlers(options.authService, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: options.config.nodeEnv === 'production',
    maxAge: options.config.sessionTtlSeconds,
  }, options.config.capabilities, options.config.support);
  const authenticated = requireAuthentication(options.authService);

  app.post('/login', {
    config: { rateLimit: { max: options.config.loginRateLimitMax, timeWindow: options.config.rateLimitWindowMs } },
  }, handlers.login);
  app.get('/me', { preHandler: authenticated }, handlers.me);
  app.post('/logout', { preHandler: authenticated }, handlers.logout);
  app.post('/change-password', {
    preHandler: authenticated,
    config: { rateLimit: changePasswordRateLimit(options.config) },
  }, handlers.changePassword);
};
