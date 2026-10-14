import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import { toErrorResponse } from '../src/errors/index.js';
import { withSaleFixture } from './support/sale-harness.js';

describe('Sale capability on public readers', () => {
  it('keeps legacy list totals and detail safe, while opted-in GET readers expose Sale', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error); return reply.code(response.statusCode).send(response.body);
      });
      await app.register(jobCardRoutes, { prefix: '/api/job-cards', service: f.service,
        authenticate: async (request) => { request.currentUser = { ...f.staff } as never; } });
      try {
        const legacy = (await app.inject('/api/job-cards?status=all&limit=1')).json();
        expect(legacy.total).toBe(1);
        expect(legacy.items.every((item: { type: string }) => item.type !== 'SALE')).toBe(true);
        expect((await app.inject('/api/job-cards/' + sale.jobCardId)).statusCode).toBe(404);
        const current = (await app.inject('/api/job-cards?status=all&includeSaleCapability=true')).json();
        expect(current.total).toBe(2);
        expect(current.items.some((item: { type: string }) => item.type === 'SALE')).toBe(true);
        const detail = await app.inject('/api/job-cards/' + sale.jobCardId + '/sale-details?includeSaleCapability=true');
        expect(detail.statusCode).toBe(200);
        expect(detail.json().items[1].quantity).toBe('0.001');
        const oldActivity = (await app.inject('/api/job-cards/' + f.visitId + '/activity')).json();
        expect(oldActivity.items.some((item: { eventType: string }) => item.eventType === 'SALE_FROM_VISIT_CREATED')).toBe(false);
        const newActivity = (await app.inject('/api/job-cards/' + f.visitId + '/activity?includeSaleCapability=true')).json();
        expect(newActivity.items.find((item: { eventType: string }) => item.eventType === 'SALE_FROM_VISIT_CREATED').details).toEqual({ kind: 'SALE_RELATION' });
        expect((await app.inject({ method: 'POST', url: '/api/job-cards/' + f.visitId + '/sales', payload: f.input })).statusCode).toBe(404);
      } finally { await app.close(); }
    });
  });
});
