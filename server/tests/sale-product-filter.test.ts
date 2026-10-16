import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { withSaleFixture } from './support/sale-harness.js';
import { productRoutes } from '../src/modules/products/routes.js';
import { ProductService } from '../src/modules/products/service.js';
import { PostgresProductRepository } from '../src/modules/products/repository.js';
import { toErrorResponse } from '../src/errors/index.js';

describe('Sale BUSINESS product search', () => {
  it('filters at SQL before count and pagination, retaining defaults and tenant scope', async () => {
    await withSaleFixture(async (f) => {
      const dataset = (await f.pool.query("INSERT INTO demo_datasets(organization_id,dataset_key,seed_version,created_by) VALUES ($1,'fixture','1',$2) RETURNING id", [f.organizationId, f.admin.id])).rows[0]!.id;
      await f.pool.query("INSERT INTO products(organization_id,name,data_class,demo_dataset_id) VALUES ($1,'AAA demo','DEMO',$2)", [f.organizationId, dataset]);
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const r = toErrorResponse(error); return reply.code(r.statusCode).send(r.body);
      });
      await app.register(productRoutes, { prefix: '/api', service: new ProductService(new PostgresProductRepository(f.pool)),
        authenticate: async (request) => { request.currentUser = { ...f.staff } as never; } });
      try {
        const response = await app.inject('/api/products?status=active&dataClass=BUSINESS&limit=1&offset=1');
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ total: 2, limit: 1, offset: 1 });
        expect(response.json().items[0].id).toBe(f.products[0]);
        const defaultPage = (await app.inject('/api/products?status=active')).json();
        expect(defaultPage.total).toBe(3);
        for (const value of ['DEMO', 'all', 'business']) {
          expect((await app.inject('/api/products?dataClass=' + value)).statusCode).toBe(400);
        }
      } finally { await app.close(); }
    });
  });
});
