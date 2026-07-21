import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createNotificationHandlers } from './handlers.js';
import type { NotificationService } from './service.js';

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type NotificationRoutesOptions = {
  service: NotificationService;
  authenticate: Authenticate;
};

export const notificationRoutes: FastifyPluginAsync<NotificationRoutesOptions> = async (app, options) => {
  const handlers = createNotificationHandlers(options.service);
  app.get('/unread-count', { preHandler: options.authenticate }, handlers.unreadCount);
  app.get('/', { preHandler: options.authenticate }, handlers.list);
  app.patch('/:notificationId/read', { preHandler: options.authenticate }, handlers.markRead);
};
