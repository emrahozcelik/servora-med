import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify';

import { createMessagingHandlers } from './handlers.js';
import type { MessagingService } from './service.js';

export type MessagingRoutesOptions = {
  service: MessagingService;
  authenticate: preHandlerHookHandler;
  gate: preHandlerHookHandler;
};

export const messagingRoutes: FastifyPluginAsync<MessagingRoutesOptions> = async (
  app,
  options,
) => {
  const handlers = createMessagingHandlers(options.service);
  const preHandler = [options.authenticate, options.gate];

  app.get('/conversations', { preHandler }, handlers.listConversations);
  app.get('/recipients', { preHandler }, handlers.getRecipients);
  app.post('/conversations', { preHandler }, handlers.createOrGetConversation);
  app.get('/conversations/job/:jobId', { preHandler }, handlers.getJobConversationByJobId);
  app.get('/conversations/:conversationId/messages', { preHandler }, handlers.listMessages);
  app.post('/conversations/:conversationId/messages', { preHandler }, handlers.sendMessage);
  app.post('/conversations/:conversationId/archive', { preHandler }, handlers.archiveConversation);
  app.post('/conversations/:conversationId/unarchive', { preHandler }, handlers.unarchiveConversation);
  app.patch('/conversations/:conversationId/read', { preHandler }, handlers.markRead);
  app.get('/unread-count', { preHandler }, handlers.unreadCount);
  app.post('/conversations/:conversationId/job-assignee-sync', { preHandler }, handlers.syncJobAssignee);
};
