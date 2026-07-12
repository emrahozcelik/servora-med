import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify';

import type { JobCardService } from './service.js';
import type { JobCardActor } from './types.js';

export type ReferenceRoutesOptions = { service: JobCardService; authenticate: preHandlerHookHandler };

export const referenceRoutes: FastifyPluginAsync<ReferenceRoutesOptions> = async (app, options) => {
  const secured = { preHandler: options.authenticate };
  const actor = (request: Parameters<typeof options.authenticate>[0]): JobCardActor => {
    const user = request.currentUser!;
    return { id: user.id, organizationId: user.organizationId, role: user.role };
  };
  app.get('/customers', secured, async (request) => ({ items: await options.service.listReferenceCustomers(actor(request)) }));
  app.get('/products', secured, async (request) => ({ items: await options.service.listReferenceProducts(actor(request)) }));
};
