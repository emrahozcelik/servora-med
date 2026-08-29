import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createDataManagementHandlers } from './handlers.js';
import type { DataManagementService } from './service.js';

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type DataManagementRoutesOptions = {
  service: DataManagementService;
  authenticate: Authenticate;
};

export const dataManagementRoutes: FastifyPluginAsync<DataManagementRoutesOptions> = async (app, options) => {
  const handlers = createDataManagementHandlers(options.service);
  app.get('/data-management/summary', { preHandler: options.authenticate }, handlers.getSummary);
};
