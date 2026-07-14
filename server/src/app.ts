import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import type { AppConfig } from './config.js';
import { toErrorResponse } from './errors/index.js';
import { healthRoutes } from './modules/health/routes.js';
import { AuthService } from './modules/auth/service.js';
import type { AuthRepository } from './modules/auth/repository.js';
import { authRoutes } from './modules/auth/routes.js';
import { AppError } from './errors/index.js';
import type { JobCardRepository } from './modules/job-cards/repository.js';
import { JobCardService } from './modules/job-cards/service.js';
import { jobCardRoutes } from './modules/job-cards/routes.js';
import { requireAuthentication, requirePasswordChanged } from './modules/auth/middleware.js';
import { referenceRoutes } from './modules/job-cards/reference-routes.js';
import type { PeopleRepository } from './modules/people/repository.js';
import { PeopleService } from './modules/people/service.js';
import { peopleRoutes } from './modules/people/routes.js';
import { AuthCredentialAdministration } from './modules/auth/admin-ports.js';
import type { CrmRepository } from './modules/crm/repository.js';
import { CrmService } from './modules/crm/service.js';
import { crmRoutes } from './modules/crm/routes.js';
import type { ProductRepository } from './modules/products/repository.js';
import { ProductService } from './modules/products/service.js';
import { productRoutes } from './modules/products/routes.js';
import type { ApprovalQueueItemPort, ReportsReadModel } from './modules/reports/ports.js';
import { ReportsService } from './modules/reports/service.js';
import { reportsRoutes } from './modules/reports/routes.js';

export const LOGGER_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.temporaryPassword',
  'req.body.token',
  'req.body.sessionToken',
];

export type AppDependencies = {
  authRepository?: AuthRepository;
  jobCardRepository?: JobCardRepository;
  peopleRepository?: PeopleRepository;
  crmRepository?: CrmRepository;
  productRepository?: ProductRepository;
  approvalQueueItemPort?: ApprovalQueueItemPort;
  reportsRepository?: ReportsReadModel;
};

export async function buildApp(config: AppConfig, dependencies: AppDependencies = {}) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: LOGGER_REDACT_PATHS,
    },
  });

  await app.register(cookie);
  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(rateLimit, { global: false });

  app.addHook('onRequest', async (request) => {
    if (
      config.nodeEnv === 'production' &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin !== config.corsOrigin
    ) {
      throw new AppError('INVALID_ORIGIN', 403, 'İstek kaynağına izin verilmiyor.');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const response = toErrorResponse(error);
    if (response.statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled request error');
    }
    return reply.code(response.statusCode).send(response.body);
  });

  await app.register(healthRoutes, { prefix: '/api/health' });
  if (dependencies.authRepository) {
    const authService = new AuthService(dependencies.authRepository, config.sessionTtlSeconds);
    await app.register(authRoutes, {
      prefix: '/api/auth',
      authService,
      config,
    });
    const authenticate = requireAuthentication(authService);
    const passwordChanged = requirePasswordChanged();
    const authenticateDomain = async (...args: Parameters<typeof authenticate>) => {
      await authenticate(...args);
      await passwordChanged(...args);
    };
    if (dependencies.jobCardRepository) {
      const jobCardService = new JobCardService(dependencies.jobCardRepository);
      await app.register(jobCardRoutes, {
        prefix: '/api/job-cards',
        service: jobCardService,
        authenticate: authenticateDomain,
      });
      await app.register(referenceRoutes, {
        prefix: '/api/reference',
        service: jobCardService,
        authenticate: authenticateDomain,
      });
    }
    if (dependencies.peopleRepository && dependencies.reportsRepository) {
      await app.register(peopleRoutes, {
        prefix: '/api',
        service: new PeopleService(
          dependencies.peopleRepository,
          new AuthCredentialAdministration(),
          dependencies.reportsRepository,
        ),
        authenticate: authenticateDomain,
      });
    }
    if (dependencies.reportsRepository && dependencies.approvalQueueItemPort) {
      await app.register(reportsRoutes, {
        prefix: '/api/reports',
        service: new ReportsService(
          dependencies.reportsRepository,
          dependencies.approvalQueueItemPort,
        ),
        authenticate: authenticateDomain,
      });
    }
    if (dependencies.crmRepository) {
      await app.register(crmRoutes, {
        prefix: '/api',
        service: new CrmService(dependencies.crmRepository),
        authenticate: authenticateDomain,
      });
    }
    if (dependencies.productRepository) {
      await app.register(productRoutes, {
        prefix: '/api',
        service: new ProductService(dependencies.productRepository),
        authenticate: authenticateDomain,
      });
    }
  }

  return app;
}
