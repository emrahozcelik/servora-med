import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { referenceRoutes } from '../src/modules/job-cards/reference-routes.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('tracer reference routes', () => {
  it('returns organization-scoped customers and active products through authenticated service calls', async () => {
    const app = Fastify({ logger: false }); apps.push(app);
    const service = {
      listReferenceCustomers: vi.fn().mockResolvedValue([{ id: 'customer-1', name: 'Klinik' }]),
      listReferenceProducts: vi.fn().mockResolvedValue([{ id: 'product-1', name: 'Set', unit: 'adet' }]),
    };
    const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
      request.currentUser = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF', name: 'Staff', email: 'staff@example.com', mustChangePassword: false };
    };
    await app.register(referenceRoutes, { prefix: '/api/reference', service: service as never, authenticate });

    expect((await app.inject({ method: 'GET', url: '/api/reference/customers' })).json()).toEqual({ items: [{ id: 'customer-1', name: 'Klinik' }] });
    expect((await app.inject({ method: 'GET', url: '/api/reference/products' })).json()).toEqual({ items: [{ id: 'product-1', name: 'Set', unit: 'adet' }] });
    expect(service.listReferenceCustomers).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
    expect(service.listReferenceProducts).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
  });
});
