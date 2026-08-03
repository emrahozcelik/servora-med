import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createStaffConfidentialNotesHandlers } from './handlers.js';
import type { StaffConfidentialNotesService } from './service.js';

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type StaffConfidentialNotesRoutesOptions = {
  service: StaffConfidentialNotesService;
  authenticate: Authenticate;
};

export const staffConfidentialNotesRoutes: FastifyPluginAsync<
  StaffConfidentialNotesRoutesOptions
> = async (app, options) => {
  const handlers = createStaffConfidentialNotesHandlers(options.service);
  const auth = { preHandler: options.authenticate };
  app.post('/staff/:userId/confidential-notes', auth, handlers.create);
  app.get('/staff/:userId/confidential-notes', auth, handlers.list);
};
