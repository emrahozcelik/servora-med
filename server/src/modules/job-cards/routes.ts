import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify';

import { createJobCardHandlers } from './handlers.js';
import type { JobCardService } from './service.js';

export type JobCardRoutesOptions = { service: JobCardService; authenticate: preHandlerHookHandler };

export const jobCardRoutes: FastifyPluginAsync<JobCardRoutesOptions> = async (app, options) => {
  const h = createJobCardHandlers(options.service);
  const secured = { preHandler: options.authenticate };
  app.get('/', secured, h.list);
  app.post('/', secured, h.create);
  app.get('/board', secured, h.board);
  app.get<{ Params: { id: string } }>('/:id', secured, h.detail);
  app.patch<{ Params: { id: string } }>('/:id', secured, h.patch);
  app.get<{ Params: { id: string } }>('/:id/meeting-details', secured, h.meetingDetails);
  app.patch<{ Params: { id: string } }>('/:id/meeting-details', secured, h.patchMeetingDetails);
  app.get<{ Params: { id: string } }>('/:id/delivery-items', secured, h.listDeliveryItems);
  app.post<{ Params: { id: string } }>('/:id/delivery-items', secured, h.addDeliveryItem);
  app.patch<{ Params: { id: string; itemId: string } }>('/:id/delivery-items/:itemId', secured, h.patchDeliveryItem);
  app.delete<{ Params: { id: string; itemId: string } }>('/:id/delivery-items/:itemId', secured, h.removeDeliveryItem);
  app.post<{ Params: { id: string } }>('/:id/accept', secured, h.accept);
  app.post<{ Params: { id: string } }>('/:id/start', secured, h.start);
  app.post<{ Params: { id: string } }>('/:id/submit-for-approval', secured, h.submit);
  app.post<{ Params: { id: string } }>('/:id/approve', secured, h.approve);
  app.post<{ Params: { id: string } }>('/:id/request-revision', secured, h.requestRevision);
  app.post<{ Params: { id: string } }>('/:id/withdraw-from-approval', secured, h.withdrawFromApproval);
  app.post<{ Params: { id: string } }>('/:id/resume', secured, h.resume);
  app.post<{ Params: { id: string } }>('/:id/cancel', secured, h.cancel);
  app.get<{ Params: { id: string } }>('/:id/activity', secured, h.activity);
  app.get<{ Params: { id: string } }>('/:id/notes', secured, h.listNotes);
  app.post<{ Params: { id: string } }>('/:id/notes', secured, h.addNote);
};
