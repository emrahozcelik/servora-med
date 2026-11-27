import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config.js';
import { AppError, toErrorResponse } from '../../errors/index.js';
import { findInstallationModule } from '../installation-modules/registry.js';
import type { OperatorService } from './service.js';
import {
  OPERATOR_COOKIE_PATH,
  OPERATOR_SESSION_COOKIE_NAME,
  OPERATOR_SESSION_TTL_SECONDS,
} from './types.js';

export type OperatorRoutesOptions = { service: OperatorService; config: AppConfig };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Email + password + JSON framing fit comfortably; anything larger is hostile. */
const LOGIN_BODY_LIMIT_BYTES = 2_048;
const WRITE_BODY_LIMIT_BYTES = 1_024;

function validationError(message: string) {
  return new AppError('VALIDATION_ERROR', 400, message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`${field} alanı zorunludur.`);
  }
  return value;
}

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError('İstek gövdesi geçersiz.');
  }
  return body as Record<string, unknown>;
}

export const operatorRoutes: FastifyPluginAsync<OperatorRoutesOptions> = async (app, options) => {
  const { service, config } = options;
  const secure = config.nodeEnv === 'production';
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict',
    path: OPERATOR_COOKIE_PATH,
    secure,
    maxAge: OPERATOR_SESSION_TTL_SECONDS,
  } as const;

  // Exact-Origin enforcement on every operator write in EVERY environment
  // (the global hook only enforces it in production). Runs before rate
  // limiting and body parsing, so a foreign origin spends nothing.
  app.addHook('onRequest', async (request) => {
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== config.corsOrigin) {
      throw new AppError('INVALID_ORIGIN', 403, 'İstek kaynağına izin verilmiyor.');
    }
  });
  // Oversized or malformed request bodies are client errors, not 500s; every
  // other error keeps the application-wide mapping (incl. 429 rate limits).
  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) {
      return reply.code(413).send({
        error: 'İstek gövdesi çok büyük.',
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
    if (statusCode === 400 && !(error instanceof AppError)) {
      return reply.code(400).send({ error: 'İstek gövdesi geçersiz.', code: 'VALIDATION_ERROR' });
    }
    const response = toErrorResponse(error);
    if (response.statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled request error');
    }
    return reply.code(response.statusCode).send(response.body);
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  async function authenticate(request: FastifyRequest) {
    const rawToken = request.cookies[OPERATOR_SESSION_COOKIE_NAME];
    if (!rawToken) {
      throw new AppError('OPERATOR_UNAUTHENTICATED', 401, 'Oturum açmanız gerekiyor.');
    }
    request.operatorSession = await service.authenticate(rawToken);
  }

  async function requireModuleManagement(request: FastifyRequest) {
    await authenticate(request);
    service.requireModuleManagement(request.operatorSession!);
  }

  // Failed and successful attempts are counted per client address (trusted
  // proxy aware via request.ip) and per normalized email, both before any KDF
  // work and in groups separate from the customer login limit.
  const loginRateLimit = {
    max: config.loginRateLimitMax,
    timeWindow: config.rateLimitWindowMs,
  };
  // `createRateLimit` (not `rateLimit`): the route-level per-address hook has
  // already run for this request, and the decorated handler would skip itself.
  const emailLimiter = app.createRateLimit({
    ...loginRateLimit,
    keyGenerator(request: FastifyRequest) {
      const email = (request.body as { email?: unknown } | null | undefined)?.email;
      if (typeof email !== 'string') return `ip:${request.ip}`;
      return `email:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
    },
  });
  async function limitLoginByEmail(request: FastifyRequest, reply: FastifyReply) {
    const result = await emailLimiter(request);
    if (!result.isAllowed && result.isExceeded) {
      reply.header('retry-after', result.ttlInSeconds);
      // Mapped to the application-wide 429 response (RATE_LIMIT_EXCEEDED).
      throw Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 });
    }
  }

  app.post('/login', {
    bodyLimit: LOGIN_BODY_LIMIT_BYTES,
    config: { rateLimit: { ...loginRateLimit, groupId: 'operator-login-ip' } },
    preHandler: limitLoginByEmail,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = bodyRecord(request);
    const result = await service.login(
      requireString(body.email, 'email'),
      requireString(body.password, 'password'),
    );
    reply.setCookie(OPERATOR_SESSION_COOKIE_NAME, result.rawToken, cookieOptions);
    return { operator: result.operator };
  });

  app.post('/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = request.cookies[OPERATOR_SESSION_COOKIE_NAME];
    if (rawToken) await service.logout(rawToken);
    reply.clearCookie(OPERATOR_SESSION_COOKIE_NAME, {
      path: OPERATOR_COOKIE_PATH,
      secure,
      sameSite: 'strict',
      httpOnly: true,
    });
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: authenticate }, async (request: FastifyRequest) => ({
    operator: request.operatorSession!.operator,
  }));

  app.get('/modules', { preHandler: requireModuleManagement }, async (request: FastifyRequest) => ({
    modules: await service.listModules(request.log),
  }));

  app.put('/modules/:key', {
    bodyLimit: WRITE_BODY_LIMIT_BYTES,
    preHandler: requireModuleManagement,
  }, async (request: FastifyRequest) => {
    const module = findInstallationModule((request.params as { key: string }).key);
    if (!module) throw new AppError('NOT_FOUND', 404, 'Modül bulunamadı.');
    const body = bodyRecord(request);
    const { enabled, expectedVersion } = body;
    if (typeof enabled !== 'boolean') throw validationError('enabled alanı true veya false olmalıdır.');
    if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1) {
      throw validationError('expectedVersion alanı pozitif bir tam sayı olmalıdır.');
    }
    return {
      module: await service.setModuleEnabled(
        request.operatorSession!,
        module.key,
        enabled,
        expectedVersion as number,
      ),
    };
  });
};
