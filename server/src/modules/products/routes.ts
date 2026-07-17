import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createProductHandlers } from './handlers.js';
import type { ProductService } from './service.js';

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type ProductRoutesOptions = { service: ProductService; authenticate: Authenticate };

export const productRoutes: FastifyPluginAsync<ProductRoutesOptions> = async (app, options) => {
  const handlers = createProductHandlers(options.service);
  const auth = { preHandler: options.authenticate };

  app.get('/products', auth, handlers.listProducts);
  app.post('/products', auth, handlers.createProduct);
  app.get('/products/:productId', auth, handlers.getProduct);
  app.patch('/products/:productId', auth, handlers.updateProduct);
  app.post('/products/:productId/activate', auth, handlers.activateProduct);
  app.post('/products/:productId/deactivate', auth, handlers.deactivateProduct);
  app.delete('/products/:productId', auth, handlers.deleteProduct);
};
