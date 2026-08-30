import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createPeopleHandlers } from './handlers.js';
import type { PostgresStaffOffboardingService } from './offboarding.js';
import type { PeopleService } from './service.js';
import type { JobHistoryReadPort } from '../job-cards/history-port.js';

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type PeopleRoutesOptions = {
  service: PeopleService;
  authenticate: Authenticate;
  jobHistoryReadPort?: JobHistoryReadPort;
  offboardingService?: PostgresStaffOffboardingService;
};

export const peopleRoutes: FastifyPluginAsync<PeopleRoutesOptions> = async (app, options) => {
  const handlers = createPeopleHandlers(options.service, options.offboardingService);
  const auth = { preHandler: options.authenticate };

  if (options.jobHistoryReadPort) {
    app.get('/staff/me/jobs', auth, handlers.listOwnStaffJobHistory);
    app.get('/staff/:userId/jobs', auth, handlers.listStaffJobHistory);
  }
  app.get('/users', auth, handlers.listUsers);
  app.post('/users', auth, handlers.createUser);
  app.get('/users/:userId', auth, handlers.getUser);
  app.delete('/users/:userId', auth, handlers.deleteUser);
  app.patch('/users/:userId', auth, handlers.updateUser);
  app.post('/users/:userId/change-role', auth, handlers.changeRole);
  app.post('/users/:userId/activate', auth, handlers.activate);
  app.post('/users/:userId/deactivate', auth, handlers.deactivate);
  app.post('/users/:userId/reset-password', auth, handlers.resetPassword);
  if (options.offboardingService) {
    app.post('/users/:userId/offboarding/preview', auth, handlers.offboardingPreview);
    app.post('/users/:userId/offboarding/execute', auth, handlers.offboardingExecute);
  }

  app.get('/staff', auth, handlers.listStaff);
  app.get('/staff/me', auth, handlers.getOwnStaffProfile);
  app.get('/staff/:userId', auth, handlers.getStaffProfile);
  app.patch('/staff/:userId', auth, handlers.updateStaffProfile);
};
