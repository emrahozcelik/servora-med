import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify';

import { createMessagingHandlers } from './handlers.js';
import type { MessagingService } from './service.js';

export type MessagingRoutesOptions = {
  service: MessagingService;
  authenticate: preHandlerHookHandler;
};

export const messagingRoutes: FastifyPluginAsync<MessagingRoutesOptions> = async (
  app,
  options,
) => {
  const handlers = createMessagingHandlers(options.service);

  app.get('/conversations', { preHandler: options.authenticate }, handlers.listConversations);
  app.get('/recipients', { preHandler: options.authenticate }, handlers.getRecipients);
  app.post('/conversations', { preHandler: options.authenticate }, handlers.createOrGetConversation);
  app.get('/conversations/:conversationId/messages', { preHandler: options.authenticate }, handlers.listMessages);
  app.post('/conversations/:conversationId/messages', { preHandler: options.authenticate }, handlers.sendMessage);
  app.patch('/conversations/:conversationId/read', { preHandler: options.authenticate }, handlers.markRead);
  app.get('/unread-count', { preHandler: options.authenticate }, handlers.unreadCount);
};
