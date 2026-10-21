import type { FastifyBaseLogger, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../../errors/index.js';
import { duplicateUuidPattern } from './duplicate-cursor.js';
import type { DuplicateComparisonService, DuplicateListInput } from './duplicate-service.js';
import type { DuplicateRegisterService } from './duplicate-register-service.js';
import type { DuplicateReviewService } from './duplicate-review-service.js';
import { parseDuplicateDecisionCommand, parseDuplicateReopenCommand } from './duplicate-command.js';
import { DUPLICATE_LIMITS } from './duplicate-types.js';

type Options = {
  service: DuplicateComparisonService;
  reviewService?: DuplicateReviewService;
  registerService?: DuplicateRegisterService;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};
const invalid = (): never => { throw new AppError('VALIDATION_ERROR', 400, 'Geçersiz karşılaştırma parametreleri.'); };
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !duplicateUuidPattern.test(value.toLowerCase())) return invalid();
  return value.toLowerCase();
}
function query(request: FastifyRequest, allowed: string[]) {
  const fields = request.query as Record<string, unknown>;
  if (Object.entries(fields).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string')) invalid();
  return fields as Record<string, string | undefined>;
}
const actor = (request: FastifyRequest) => request.currentUser!;

export const duplicateRoutes: FastifyPluginAsync<Options> = async (app, { service, reviewService, registerService, authenticate }) => {
  type ChildLoggerArgs = Parameters<FastifyBaseLogger['child']>;
  const privacyLogger = (logger: FastifyBaseLogger, bindings: ChildLoggerArgs[0], options: ChildLoggerArgs[1]) => {
    const childOptions = options ?? {};
    return logger.child(bindings, {
      ...childOptions,
      serializers: {
        ...childOptions.serializers,
        req: (request: FastifyRequest) => ({ method: request.method, url: request.url.split('?')[0] }),
      },
    });
  };
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store'); if (reply.statusCode === 429 && !reply.hasHeader('Retry-After')) reply.header('Retry-After', '1'); return payload; });
  const requireManagement = async (request: FastifyRequest) => {
    if (!request.currentUser || !['ADMIN', 'MANAGER'].includes(request.currentUser.role)) throw new AppError('FORBIDDEN', 403, 'Bu ekranı yalnız yöneticiler kullanabilir.');
  };
  const limiter = (kind: 'LIST' | 'DETAIL' | 'COMMAND', max: number) => app.rateLimit({ max, timeWindow: 60_000,
    keyGenerator: (request) => JSON.stringify([`CRM_DUPLICATE_${kind}:v1`, actor(request).organizationId, actor(request).id]) });
  const listLimit = limiter('LIST', DUPLICATE_LIMITS.listPerMinute);
  const detailLimit = limiter('DETAIL', DUPLICATE_LIMITS.detailPerMinute);
  const commandLimit = limiter('COMMAND', DUPLICATE_LIMITS.commandPerMinute);
  app.get('/customers/duplicate-candidates', { childLoggerFactory: privacyLogger, config: { rateLimit: false }, preHandler: [authenticate, requireManagement, listLimit] }, async (request) => {
    const fields = query(request, ['view', 'anchorCustomerId', 'cursor', 'limit']);
    if (fields.view !== undefined && fields.view !== 'ALL' && fields.view !== 'ATTENTION') invalid();
    const limit = fields.limit === undefined ? DUPLICATE_LIMITS.page : Number(fields.limit);
    if (fields.limit !== undefined && !/^[1-9]\d*$/.test(fields.limit) || !Number.isInteger(limit) || limit < 1 || limit > DUPLICATE_LIMITS.page) invalid();
    if (fields.cursor !== undefined && (!fields.cursor.length || fields.cursor.length > 2048)) invalid();
    const input: DuplicateListInput = { view: (fields.view ?? 'ATTENTION') as DuplicateListInput['view'],
      anchorCustomerId: fields.anchorCustomerId === undefined ? null : uuid(fields.anchorCustomerId), cursor: fields.cursor ?? null, limit };
    return service.candidates(actor(request), input);
  });
  app.get('/customers/duplicate-review-pairs/:aId/:bId', { childLoggerFactory: privacyLogger, config: { rateLimit: false }, preHandler: [authenticate, requireManagement, detailLimit] }, async (request) => {
    query(request, []);
    const params = request.params as { aId: unknown; bId: unknown };
    const a = uuid(params.aId); const b = uuid(params.bId);
    if (a === b) invalid();
    return service.comparison(actor(request), a, b);
  });
  if (reviewService) {
    app.post('/customers/duplicate-review-pairs/:aId/:bId/decisions', { childLoggerFactory: privacyLogger, config: { rateLimit: false }, preHandler: [authenticate, requireManagement, commandLimit] }, async (request, reply) => {
      query(request, []);
      const params = request.params as { aId: unknown; bId: unknown };
      const a = uuid(params.aId); const b = uuid(params.bId);
      const result = await reviewService.decide(actor(request), a, b, parseDuplicateDecisionCommand(request.body));
      if (result.replayed) reply.header('Idempotency-Replayed', 'true');
      return result.receipt;
    });
    app.post('/customers/duplicate-review-pairs/:aId/:bId/reopen', { childLoggerFactory: privacyLogger, config: { rateLimit: false }, preHandler: [authenticate, requireManagement, commandLimit] }, async (request, reply) => {
      query(request, []);
      const params = request.params as { aId: unknown; bId: unknown };
      const a = uuid(params.aId); const b = uuid(params.bId);
      const result = await reviewService.reopen(actor(request), a, b, parseDuplicateReopenCommand(request.body));
      if (result.replayed) reply.header('Idempotency-Replayed', 'true');
      return result.receipt;
    });
    app.get('/customers/duplicate-reviews/:reviewId/history', { childLoggerFactory: privacyLogger, config: { rateLimit: false }, preHandler: [authenticate, requireManagement, detailLimit] }, async (request) => {
      const fields = query(request, ['cursor', 'limit']);
      const reviewId = uuid((request.params as { reviewId: unknown }).reviewId);
      const limit = fields.limit === undefined ? 20 : Number(fields.limit);
      if (fields.limit !== undefined && (!/^[1-9]\d*$/.test(fields.limit) || !Number.isInteger(limit) || limit < 1 || limit > 50)) invalid();
      if (fields.cursor !== undefined && (!fields.cursor.length || fields.cursor.length > 2048)) invalid();
      return reviewService.history(actor(request), reviewId, fields.cursor ?? null, limit);
    });
  }
  if (registerService) {
    app.get('/customers/duplicate-reviews', { childLoggerFactory: privacyLogger, config: { rateLimit: false }, preHandler: [authenticate, requireManagement, listLimit] }, async (request) => {
      const fields = query(request, ['view', 'cursor', 'limit']);
      if (fields.view !== undefined && fields.view !== 'ALL' && fields.view !== 'ATTENTION') invalid();
      const limit = fields.limit === undefined ? DUPLICATE_LIMITS.page : Number(fields.limit);
      if (fields.limit !== undefined && !/^[1-9]\d*$/.test(fields.limit) || !Number.isInteger(limit) || limit < 1 || limit > DUPLICATE_LIMITS.page) invalid();
      if (fields.cursor !== undefined && (!fields.cursor.length || fields.cursor.length > 2048)) invalid();
      return registerService.register(actor(request), {
        view: (fields.view ?? 'ATTENTION') as 'ALL' | 'ATTENTION', cursor: fields.cursor ?? null, limit,
      });
    });
  }
};
