import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import type { AuthService } from './service.js';

export const SESSION_COOKIE_NAME = 'servora_session';

export function requireAuthentication(authService: AuthService) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
    const rawToken = request.cookies[SESSION_COOKIE_NAME];
    if (!rawToken) {
      throw new AppError('UNAUTHENTICATED', 401, 'Oturum açmanız gerekiyor.');
    }
    const authenticated = await authService.authenticateSession(rawToken);
    request.currentUser = authenticated.user;
    request.sessionTokenHash = authenticated.tokenHash;
    request.currentSessionId = authenticated.sessionId;
  };
}

export function requirePasswordChanged() {
  return async function passwordChanged(request: FastifyRequest, _reply: FastifyReply) {
    if (request.currentUser?.mustChangePassword) {
      throw new AppError(
        'PASSWORD_CHANGE_REQUIRED',
        403,
        'Devam etmek için parolanızı değiştirin.',
      );
    }
  };
}
