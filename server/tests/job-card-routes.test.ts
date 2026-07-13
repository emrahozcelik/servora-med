import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

const actor: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const apps: FastifyInstance[] = [];

function serviceDouble() {
  const result = { id: 'job-1', version: 1 };
  const page = { items: [result], total: 1, limit: 25, offset: 0 };
  return {
    create: vi.fn().mockResolvedValue(result), list: vi.fn().mockResolvedValue(page),
    detail: vi.fn().mockResolvedValue(result), patch: vi.fn().mockResolvedValue({ ...result, version: 2 }),
    listDeliveryItems: vi.fn().mockResolvedValue([]), addDeliveryItem: vi.fn().mockResolvedValue({ item: { id: 'item-1' }, jobCardVersion: 2 }),
    patchDeliveryItem: vi.fn().mockResolvedValue({ item: { id: 'item-1' }, jobCardVersion: 3 }),
    removeDeliveryItem: vi.fn().mockResolvedValue({ id: 'item-1', jobCardVersion: 4 }),
    start: vi.fn().mockResolvedValue({ ...result, status: 'IN_PROGRESS' }),
    submitForApproval: vi.fn().mockResolvedValue({ ...result, status: 'WAITING_APPROVAL' }),
    approve: vi.fn().mockResolvedValue({ ...result, status: 'COMPLETED' }),
    requestRevision: vi.fn().mockResolvedValue({ ...result, status: 'REVISION_REQUESTED' }),
    listActivity: vi.fn().mockResolvedValue([]),
  };
}

async function createApp(authenticated = true) {
  const app = Fastify({ logger: false }); const service = serviceDouble();
  app.setErrorHandler((error, _request, reply) => { const response = toErrorResponse(error); reply.code(response.statusCode).send(response.body); });
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!authenticated) throw new AppError('UNAUTHENTICATED', 401, 'Oturum açmanız gerekiyor.');
    request.currentUser = { ...actor, name: 'Staff', email: 'staff@example.com', mustChangePassword: false };
  };
  await app.register(jobCardRoutes, { prefix: '/api/job-cards', service: service as never, authenticate });
  apps.push(app); return { app, service };
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('JobCard routes', () => {
  it('requires authentication', async () => {
    const { app } = await createApp(false);
    expect((await app.inject({ method: 'GET', url: '/api/job-cards' })).statusCode).toBe(401);
  });

  it('dispatches create, list, detail, and patch with the authenticated actor', async () => {
    const { app, service } = await createApp();
    const body = { clientActionId: 'c1', type: 'PRODUCT_DELIVERY', title: 'Teslim', customerId: 'customer-1', contactId: 'contact-1', assignedTo: 'staff-1' };
    expect((await app.inject({ method: 'POST', url: '/api/job-cards', payload: body })).statusCode).toBe(201);
    await app.inject({ method: 'GET', url: '/api/job-cards' });
    await app.inject({ method: 'GET', url: '/api/job-cards/job-1' });
    await app.inject({ method: 'PATCH', url: '/api/job-cards/job-1', payload: { expectedVersion: 1, title: 'Yeni', contactId: 'contact-1' } });
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'staff-1' }), body);
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'staff-1' }),
      expect.objectContaining({ status: 'active', limit: 25, offset: 0 }),
    );
    expect(service.detail).toHaveBeenCalledWith(expect.anything(), 'job-1');
    expect(service.patch).toHaveBeenCalledWith(expect.anything(), 'job-1', { expectedVersion: 1, title: 'Yeni', contactId: 'contact-1' });
  });

  it('returns the canonical page and forwards the parsed list query', async () => {
    const { app, service } = await createApp();
    const page = { items: [{ id: 'job-2' }], total: 9, limit: 1, offset: 2 };
    service.list.mockResolvedValueOnce(page);

    const response = await app.inject({
      method: 'GET',
      url: '/api/job-cards?status=closed&type=PRODUCT_DELIVERY&priority=urgent&dueAfter=2026-07-01&dueBefore=2026-07-31&limit=1&offset=2',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(page);
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'staff-1', organizationId: 'org-1' }),
      expect.objectContaining({
        status: 'closed', type: 'PRODUCT_DELIVERY', priority: 'urgent',
        dueAfter: '2026-07-01', dueBefore: '2026-07-31', limit: 1, offset: 2,
      }),
    );
  });

  it.each([
    '/api/job-cards?unknown=value',
    '/api/job-cards?status=active&status=closed',
    '/api/job-cards?type=GENERAL_TASK',
    '/api/job-cards?dueBefore=2026-02-30',
    '/api/job-cards?limit=101',
  ])('rejects invalid list query %s', async (url) => {
    const { app, service } = await createApp();
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.list).not.toHaveBeenCalled();
  });

  it('dispatches delivery item CRUD and rejects unknown financial fields', async () => {
    const { app, service } = await createApp();
    const valid = { clientActionId: 'd1', expectedVersion: 1, productId: 'product-1', deliveryPurpose: 'SALE', deliveredAt: '2026-07-11T10:00:00Z', quantity: 2 };
    expect((await app.inject({ method: 'POST', url: '/api/job-cards/job-1/delivery-items', payload: valid })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/job-cards/job-1/delivery-items', payload: { ...valid, unitPrice: 10 } })).statusCode).toBe(400);
    await app.inject({ method: 'GET', url: '/api/job-cards/job-1/delivery-items' });
    await app.inject({ method: 'PATCH', url: '/api/job-cards/job-1/delivery-items/item-1', payload: { expectedVersion: 2, quantity: 3 } });
    await app.inject({ method: 'DELETE', url: '/api/job-cards/job-1/delivery-items/item-1', payload: { expectedVersion: 3 } });
    expect(service.addDeliveryItem).toHaveBeenCalledOnce();
    expect(service.listDeliveryItems).toHaveBeenCalled();
    expect(service.patchDeliveryItem).toHaveBeenCalled();
    expect(service.removeDeliveryItem).toHaveBeenCalled();
  });

  it('serializes nullable delivery snapshots without fallback values', async () => {
    const { app, service } = await createApp();
    service.listDeliveryItems.mockResolvedValueOnce([{ id: 'item-1', unit: null, productSkuSnapshot: null, productModelSnapshot: null }]);

    const response = await app.inject({ method: 'GET', url: '/api/job-cards/job-1/delivery-items' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{ id: 'item-1', unit: null, productSkuSnapshot: null, productModelSnapshot: null }],
    });
  });

  it.each([
    ['start', 'start', { clientActionId: 'a1', expectedVersion: 1 }],
    ['submit-for-approval', 'submitForApproval', { clientActionId: 'a2', expectedVersion: 2, note: 'Bitti' }],
    ['approve', 'approve', { clientActionId: 'a3', expectedVersion: 3, note: 'Uygun' }],
    ['request-revision', 'requestRevision', { clientActionId: 'a4', expectedVersion: 3, revisionReason: 'Düzeltin' }],
  ])('dispatches %s lifecycle command', async (path, method, payload) => {
    const { app, service } = await createApp();
    expect((await app.inject({ method: 'POST', url: `/api/job-cards/job-1/${path}`, payload })).statusCode).toBe(200);
    if (method === 'start') {
      expect(service.start).toHaveBeenCalledWith(expect.anything(), { jobCardId: 'job-1', ...payload });
    } else {
      expect(service[method as 'submitForApproval']).toHaveBeenCalledWith(expect.anything(), 'job-1', payload);
    }
  });

  it('exposes scoped immutable activity', async () => {
    const { app, service } = await createApp();
    expect((await app.inject({ method: 'GET', url: '/api/job-cards/job-1/activity' })).statusCode).toBe(200);
    expect(service.listActivity).toHaveBeenCalledWith(expect.anything(), 'job-1');
  });
});
