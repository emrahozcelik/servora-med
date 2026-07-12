import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createPeopleHandlers } from './handlers.js';
import type { PeopleService } from './service.js';

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type PeopleRoutesOptions = { service: PeopleService; authenticate: Authenticate };

export const peopleRoutes: FastifyPluginAsync<PeopleRoutesOptions> = async (app, options) => {
  const handlers = createPeopleHandlers(options.service);
  const auth = { preHandler: options.authenticate };

  app.get('/users', auth, handlers.listUsers);
  app.post('/users', auth, handlers.createUser);
  app.get('/users/:userId', auth, handlers.getUser);
  app.patch('/users/:userId', auth, handlers.updateUser);
  app.post('/users/:userId/change-role', auth, handlers.changeRole);
  app.post('/users/:userId/activate', auth, handlers.activate);
  app.post('/users/:userId/deactivate', auth, handlers.deactivate);
  app.post('/users/:userId/reset-password', auth, handlers.resetPassword);

  app.get('/staff', auth, handlers.listStaff);
  app.get('/staff/me', auth, handlers.getOwnStaffProfile);
  app.get('/staff/:userId', auth, handlers.getStaffProfile);
  app.patch('/staff/:userId', auth, handlers.updateStaffProfile);
};
