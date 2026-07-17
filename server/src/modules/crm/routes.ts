import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createCrmHandlers } from './handlers.js';
import type { CrmService } from './service.js';

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type CrmRoutesOptions = { service: CrmService; authenticate: Authenticate };

export const crmRoutes: FastifyPluginAsync<CrmRoutesOptions> = async (app, options) => {
  const handlers = createCrmHandlers(options.service);
  const auth = { preHandler: options.authenticate };

  app.get('/customers', auth, handlers.listCustomers);
  app.post('/customers', auth, handlers.createCustomer);
  app.get('/customers/:customerId', auth, handlers.getCustomer);
  app.patch('/customers/:customerId', auth, handlers.updateCustomer);
  app.post('/customers/:customerId/activate', auth, handlers.activateCustomer);
  app.post('/customers/:customerId/deactivate', auth, handlers.deactivateCustomer);
  app.delete('/customers/:customerId', auth, handlers.deleteCustomer);
  app.get('/customers/:customerId/contacts', auth, handlers.listContacts);
  app.post('/customers/:customerId/contacts', auth, handlers.createContact);
  app.get('/customers/:customerId/contacts/:contactId', auth, handlers.getContact);
  app.patch('/customers/:customerId/contacts/:contactId', auth, handlers.updateContact);
  app.post('/customers/:customerId/contacts/:contactId/activate', auth, handlers.activateContact);
  app.post('/customers/:customerId/contacts/:contactId/deactivate', auth, handlers.deactivateContact);
  app.post('/customers/:customerId/contacts/:contactId/make-primary', auth, handlers.makePrimary);
};
