import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { createReportsHandlers } from './handlers.js';
import type { ReportsService } from './service.js';

type Authenticate = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export type ReportsRoutesOptions = {
  service: ReportsService;
  authenticate: Authenticate;
};

export const reportsRoutes: FastifyPluginAsync<ReportsRoutesOptions> =
async (app, options) => {
  const handlers = createReportsHandlers(options.service);
  const secured = { preHandler: options.authenticate };

  app.get('/dashboard', secured, handlers.dashboard);
  app.get('/staff/me', secured, handlers.getOwnStaffReport);
  app.get<{ Params: { userId: string } }>(
    '/staff/:userId',
    secured,
    handlers.getStaffReport,
  );
  app.get('/deliveries', secured, handlers.getDeliveries);
  app.get('/approvals', secured, handlers.getApprovals);
};
