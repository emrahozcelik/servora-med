import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify';

import { createCalendarHandlers } from './handlers.js';
import type { CalendarService } from './service.js';

export type CalendarRoutesOptions = {
  service: CalendarService;
  authenticate: preHandlerHookHandler;
};

export const calendarRoutes: FastifyPluginAsync<CalendarRoutesOptions> = async (
  app,
  options,
) => {
  const handlers = createCalendarHandlers(options.service);
  const secured = { preHandler: options.authenticate };
  app.get('/', secured, handlers.list);
  app.get('/assignees', secured, handlers.assignees);
  app.get<{ Params: { eventId: string } }>(
    '/events/:eventId',
    secured,
    handlers.detail,
  );
  app.post('/events', secured, handlers.create);
  app.patch<{ Params: { eventId: string } }>(
    '/events/:eventId',
    secured,
    handlers.patch,
  );
  app.post<{ Params: { eventId: string } }>(
    '/events/:eventId/cancel',
    secured,
    handlers.cancel,
  );
};
