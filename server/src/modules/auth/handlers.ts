import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import { SESSION_COOKIE_NAME } from './middleware.js';
import type { AuthService } from './service.js';

type CookieOptions = { httpOnly: true; sameSite: 'lax'; path: '/'; secure: boolean; maxAge: number };

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('VALIDATION_ERROR', 400, `${field} alanı zorunludur.`);
  }
  return value;
}

export function createAuthHandlers(authService: AuthService, cookieOptions: CookieOptions) {
  return {
    login: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, unknown> | null;
      const result = await authService.login(
        requireString(body?.email, 'email'),
        requireString(body?.password, 'password'),
      );
      reply.setCookie(SESSION_COOKIE_NAME, result.rawToken, cookieOptions);
      return { user: result.user };
    },
    me: async (request: FastifyRequest) => ({ user: request.currentUser }),
    logout: async (request: FastifyRequest, reply: FastifyReply) => {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (token) await authService.logout(token);
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/', secure: cookieOptions.secure, sameSite: 'lax' });
      return reply.code(204).send();
    },
    changePassword: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, unknown> | null;
      await authService.changePassword(
        request.currentUser!.id,
        requireString(body?.currentPassword, 'currentPassword'),
        requireString(body?.newPassword, 'newPassword'),
      );
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/', secure: cookieOptions.secure, sameSite: 'lax' });
      return reply.code(204).send();
    },
  };
}
