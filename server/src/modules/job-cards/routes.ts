import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify';

import { createJobCardHandlers } from './handlers.js';
import type { JobCardService } from './service.js';

export type JobCardRoutesOptions = { service: JobCardService; authenticate: preHandlerHookHandler };

export const jobCardRoutes: FastifyPluginAsync<JobCardRoutesOptions> = async (app, options) => {
  const h = createJobCardHandlers(options.service);
  const secured = { preHandler: options.authenticate };
  app.get('/', secured, h.list);
  app.post('/', secured, h.create);
  app.get<{ Params: { id: string } }>('/:id', secured, h.detail);
  app.patch<{ Params: { id: string } }>('/:id', secured, h.patch);
  app.get<{ Params: { id: string } }>('/:id/delivery-items', secured, h.listDeliveryItems);
  app.post<{ Params: { id: string } }>('/:id/delivery-items', secured, h.addDeliveryItem);
  app.patch<{ Params: { id: string; itemId: string } }>('/:id/delivery-items/:itemId', secured, h.patchDeliveryItem);
  app.delete<{ Params: { id: string; itemId: string } }>('/:id/delivery-items/:itemId', secured, h.removeDeliveryItem);
  app.post<{ Params: { id: string } }>('/:id/start', secured, h.start);
  app.post<{ Params: { id: string } }>('/:id/submit-for-approval', secured, h.submit);
  app.post<{ Params: { id: string } }>('/:id/approve', secured, h.approve);
  app.post<{ Params: { id: string } }>('/:id/request-revision', secured, h.requestRevision);
  app.get<{ Params: { id: string } }>('/:id/activity', secured, h.activity);
};
