import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createDemoDatasetHandlers } from './handlers.js';
import type { DemoDatasetService } from './service.js';

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type DemoDatasetRoutesOptions = {
  service: DemoDatasetService;
  authenticate: Authenticate;
};

export const demoDatasetRoutes: FastifyPluginAsync<DemoDatasetRoutesOptions> = async (app, options) => {
  const handlers = createDemoDatasetHandlers(options.service);
  const auth = { preHandler: options.authenticate };

  app.get('/demo-datasets', auth, handlers.list);
  app.get('/demo-datasets/:datasetId', auth, handlers.inspect);
  app.get('/demo-datasets/:datasetId/preview', auth, handlers.preview);
  app.post('/demo-datasets', auth, handlers.create);
  app.post('/demo-datasets/:datasetId/purge', auth, handlers.purge);
};
