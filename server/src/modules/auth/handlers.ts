import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import { authenticatedUser, withOverviewDashboard } from '../capabilities/service.js';
import type {
  AuthenticatedCapabilities,
  AuthenticatedSupport,
} from '../capabilities/types.js';
import { readModuleEnabledOrFalse, type ModuleStateReader } from '../installation-modules/state.js';
import { SESSION_COOKIE_NAME } from './middleware.js';
import type { AuthService } from './service.js';

type CookieOptions = { httpOnly: true; sameSite: 'lax'; path: '/'; secure: boolean; maxAge: number };

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('VALIDATION_ERROR', 400, `${field} alanı zorunludur.`);
  }
  return value;
}

export function createAuthHandlers(
  authService: AuthService,
  cookieOptions: CookieOptions,
  capabilities: AuthenticatedCapabilities | undefined,
  support: AuthenticatedSupport | undefined,
  moduleState: ModuleStateReader,
) {
  // Overview is runtime module state (MOD-002): one read per login / me, off on
  // failure (logged), never an env fallback.
  const runtimeCapabilities = async (request: FastifyRequest) => withOverviewDashboard(
    capabilities,
    await readModuleEnabledOrFalse(moduleState, 'OVERVIEW', request.log),
  );
  return {
    login: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, unknown> | null;
      const result = await authService.login(
        requireString(body?.email, 'email'),
        requireString(body?.password, 'password'),
      );
      reply.setCookie(SESSION_COOKIE_NAME, result.rawToken, cookieOptions);
      return { user: authenticatedUser(result.user, await runtimeCapabilities(request), support) };
    },
    me: async (request: FastifyRequest) => ({
      user: authenticatedUser(request.currentUser!, await runtimeCapabilities(request), support),
    }),
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
