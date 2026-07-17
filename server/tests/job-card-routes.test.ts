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
    board: vi.fn().mockResolvedValue({
      columns: {
        NEW: { items: [], count: 0 }, ACCEPTED: { items: [], count: 0 },
        IN_PROGRESS: { items: [], count: 0 }, WAITING_APPROVAL: { items: [], count: 0 },
        REVISION_REQUESTED: { items: [], count: 0 },
      },
      closedCounts: { COMPLETED: 0, CANCELLED: 0 },
    }),
    detail: vi.fn().mockResolvedValue(result), patch: vi.fn().mockResolvedValue({ ...result, version: 2 }),
    getMeetingDetails: vi.fn().mockResolvedValue({
      jobCardId: '11111111-1111-4111-8111-111111111111', meetingAt: null,
      outcome: null, meetingSummary: null, nextFollowUpAt: null, jobCardVersion: 1,
    }),
    patchMeetingDetails: vi.fn().mockResolvedValue({
      jobCardId: '11111111-1111-4111-8111-111111111111',
      meetingAt: '2026-07-15T10:00:00.000Z', outcome: 'POSITIVE',
      meetingSummary: 'Olumlu görüşme', nextFollowUpAt: null, jobCardVersion: 2,
    }),
    listDeliveryItems: vi.fn().mockResolvedValue([]), addDeliveryItem: vi.fn().mockResolvedValue({ item: { id: 'item-1' }, jobCardVersion: 2 }),
    patchDeliveryItem: vi.fn().mockResolvedValue({ item: { id: 'item-1' }, jobCardVersion: 3 }),
    removeDeliveryItem: vi.fn().mockResolvedValue({ id: 'item-1', jobCardVersion: 4 }),
    acceptAssignment: vi.fn().mockResolvedValue({ ...result, status: 'ACCEPTED' }),
    start: vi.fn().mockResolvedValue({ ...result, status: 'IN_PROGRESS' }),
    submitForApproval: vi.fn().mockResolvedValue({ ...result, status: 'WAITING_APPROVAL' }),
    approve: vi.fn().mockResolvedValue({ ...result, status: 'COMPLETED' }),
    requestRevision: vi.fn().mockResolvedValue({ ...result, status: 'REVISION_REQUESTED' }),
    withdrawFromApproval: vi.fn().mockResolvedValue({ ...result, status: 'IN_PROGRESS' }),
    resume: vi.fn().mockResolvedValue({ ...result, status: 'IN_PROGRESS' }),
    cancel: vi.fn().mockResolvedValue({ ...result, status: 'CANCELLED' }),
    listActivity: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
    listNotes: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 }),
    addNote: vi.fn().mockResolvedValue({
      id: 'note-1', jobCardId: 'job-1', note: 'Klinik arandı',
      author: { id: 'staff-1', name: 'Staff' }, createdAt: '2026-07-13T12:00:00.000Z',
    }),
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
    const body = {
      clientActionId: 'c1', type: 'PRODUCT_DELIVERY', title: 'Teslim',
      customerId: '22222222-2222-4222-8222-222222222222',
      contactId: '33333333-3333-4333-8333-333333333333',
      assignedTo: '11111111-1111-4111-8111-111111111111',
      scheduledAt: '2026-07-16T14:30:00+03:00',
    };
    expect((await app.inject({ method: 'POST', url: '/api/job-cards', payload: body })).statusCode).toBe(201);
    await app.inject({ method: 'GET', url: '/api/job-cards' });
    await app.inject({ method: 'GET', url: '/api/job-cards/job-1' });
    await app.inject({ method: 'PATCH', url: '/api/job-cards/job-1', payload: { expectedVersion: 1, title: 'Yeni', contactId: 'contact-1' } });
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'staff-1' }), {
      ...body, description: null, priority: 'normal', dueDate: null,
      scheduledAt: '2026-07-16T11:30:00.000Z',
    });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'staff-1' }),
      expect.objectContaining({ status: 'active', limit: 25, offset: 0 }),
    );
    expect(service.detail).toHaveBeenCalledWith(expect.anything(), 'job-1');
    expect(service.patch).toHaveBeenCalledWith(expect.anything(), 'job-1', { expectedVersion: 1, title: 'Yeni', contactId: 'contact-1' });
  });

  it('dispatches the exact normalized General Task create body', async () => {
    const { app, service } = await createApp();
    const body = {
      clientActionId: 'task-create-1', type: 'GENERAL_TASK', title: 'Doktoru ara',
      assignedTo: '11111111-1111-4111-8111-111111111111',
    };

    const response = await app.inject({ method: 'POST', url: '/api/job-cards', payload: body });

    expect(response.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'staff-1' }), {
      ...body, description: null, customerId: null, contactId: null,
      priority: 'normal', dueDate: null, scheduledAt: null,
    });
  });

  it('returns the canonical page and forwards the parsed list query', async () => {
    const { app, service } = await createApp();
    const page = { items: [{ id: 'job-2' }], total: 9, limit: 1, offset: 2 };
    service.list.mockResolvedValueOnce(page);

    const response = await app.inject({
      method: 'GET',
      url: '/api/job-cards?status=closed&type=SALES_MEETING&priority=urgent&dueAfter=2026-07-01&dueBefore=2026-07-31&limit=1&offset=2',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(page);
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'staff-1', organizationId: 'org-1' }),
      expect.objectContaining({
        status: 'closed', type: 'SALES_MEETING', priority: 'urgent',
        dueAfter: '2026-07-01', dueBefore: '2026-07-31', limit: 1, offset: 2,
      }),
    );
  });

  it('dispatches exact Sales Meeting detail GET and normalized PATCH', async () => {
    const { app, service } = await createApp();
    const jobCardId = '11111111-1111-4111-8111-111111111111';

    const getResponse = await app.inject({
      method: 'GET', url: `/api/job-cards/${jobCardId}/meeting-details`,
    });
    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/api/job-cards/${jobCardId}/meeting-details`,
      payload: {
        clientActionId: 'meeting-save-1', expectedVersion: 1,
        meetingAt: '2026-07-15T12:00:00+02:00',
        outcome: 'POSITIVE', meetingSummary: '  Olumlu görüşme  ',
      },
    });

    expect(getResponse.statusCode).toBe(200);
    expect(patchResponse.statusCode).toBe(200);
    expect(service.getMeetingDetails).toHaveBeenCalledWith(expect.anything(), jobCardId);
    expect(service.patchMeetingDetails).toHaveBeenCalledWith(expect.anything(), jobCardId, {
      clientActionId: 'meeting-save-1', expectedVersion: 1,
      meetingAt: '2026-07-15T10:00:00.000Z',
      outcome: 'POSITIVE', meetingSummary: 'Olumlu görüşme',
    });
  });

  it('rejects malformed meeting paths before service and exact-body violations', async () => {
    const { app, service } = await createApp();
    const validId = '11111111-1111-4111-8111-111111111111';

    const malformedPath = await app.inject({
      method: 'GET', url: '/api/job-cards/not-a-uuid/meeting-details',
    });
    const unknownBody = await app.inject({
      method: 'PATCH', url: `/api/job-cards/${validId}/meeting-details`,
      payload: {
        clientActionId: 'meeting-save-2', expectedVersion: 1,
        outcome: 'POSITIVE', hidden: true,
      },
    });

    expect(malformedPath.statusCode).toBe(404);
    expect(malformedPath.json()).toMatchObject({ code: 'JOB_CARD_NOT_FOUND' });
    expect(unknownBody.statusCode).toBe(400);
    expect(unknownBody.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.getMeetingDetails).not.toHaveBeenCalled();
    expect(service.patchMeetingDetails).not.toHaveBeenCalled();
  });

  it.each([
    '/api/job-cards?unknown=value',
    '/api/job-cards?status=active&status=closed',
    '/api/job-cards?dueBefore=2026-02-30',
    '/api/job-cards?limit=101',
  ])('rejects invalid list query %s', async (url) => {
    const { app, service } = await createApp();
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.list).not.toHaveBeenCalled();
  });

  it('dispatches the static board route with parsed defaults and Staff actor', async () => {
    const { app, service } = await createApp();
    const response = await app.inject({ method: 'GET', url: '/api/job-cards/board' });

    expect(response.statusCode).toBe(200);
    expect(service.board).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'staff-1', organizationId: 'org-1' }),
      expect.objectContaining({ limit: 25, q: null, assignedTo: null }),
    );
    expect(service.detail).not.toHaveBeenCalled();
  });

  it.each([
    '/api/job-cards/board?status=active',
    '/api/job-cards/board?offset=0',
    '/api/job-cards/board?unknown=value',
    '/api/job-cards/board?limit=25&limit=50',
  ])('rejects invalid board query %s', async (url) => {
    const { app, service } = await createApp();
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.board).not.toHaveBeenCalled();
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

  it('returns the canonical General Task delivery-resource error on all four paths', async () => {
    const { app, service } = await createApp();
    const error = new AppError(
      'INVALID_JOB_TYPE', 409,
      'Teslim kalemleri yalnız ürün teslimi işlerinde kullanılabilir.',
    );
    service.listDeliveryItems.mockRejectedValueOnce(error);
    service.addDeliveryItem.mockRejectedValueOnce(error);
    service.patchDeliveryItem.mockRejectedValueOnce(error);
    service.removeDeliveryItem.mockRejectedValueOnce(error);
    const addBody = {
      clientActionId: 'delivery-add', expectedVersion: 1, productId: 'product-1',
      deliveryPurpose: 'SALE', deliveredAt: '2026-07-15T08:00:00.000Z', quantity: 1,
    };

    for (const request of [
      { method: 'GET' as const, url: '/api/job-cards/job-1/delivery-items' },
      { method: 'POST' as const, url: '/api/job-cards/job-1/delivery-items', payload: addBody },
      { method: 'PATCH' as const, url: '/api/job-cards/job-1/delivery-items/item-1', payload: { expectedVersion: 1, quantity: 2 } },
      { method: 'DELETE' as const, url: '/api/job-cards/job-1/delivery-items/item-1', payload: { expectedVersion: 1 } },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'INVALID_JOB_TYPE',
        error: 'Teslim kalemleri yalnız ürün teslimi işlerinde kullanılabilir.',
      });
    }
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
    ['accept', 'acceptAssignment', { clientActionId: 'a0', expectedVersion: 1 }],
    ['start', 'start', { clientActionId: 'a1', expectedVersion: 1 }],
    ['submit-for-approval', 'submitForApproval', { clientActionId: 'a2', expectedVersion: 2, note: 'Bitti' }],
    ['approve', 'approve', { clientActionId: 'a3', expectedVersion: 3, note: 'Uygun' }],
    ['request-revision', 'requestRevision', { clientActionId: 'a4', expectedVersion: 3, revisionReason: 'Düzeltin' }],
    ['withdraw-from-approval', 'withdrawFromApproval', { clientActionId: 'a4w', expectedVersion: 3 }],
    ['resume', 'resume', { clientActionId: 'a5', expectedVersion: 4 }],
    ['cancel', 'cancel', { clientActionId: 'a6', expectedVersion: 2, cancelReason: 'Müşteri iptal etti' }],
  ])('dispatches %s lifecycle command', async (path, method, payload) => {
    const { app, service } = await createApp();
    expect((await app.inject({ method: 'POST', url: `/api/job-cards/job-1/${path}`, payload })).statusCode).toBe(200);
    expect(service[method as 'submitForApproval']).toHaveBeenCalledWith(expect.anything(), 'job-1', payload);
  });

  it.each([
    ['accept', { clientActionId: 'x1', expectedVersion: 1, note: 'forbidden' }],
    ['start', { clientActionId: 'x2', expectedVersion: 1, revisionReason: 'forbidden' }],
    ['resume', { clientActionId: 'x3', expectedVersion: 1, cancelReason: 'forbidden' }],
    ['submit-for-approval', { clientActionId: 'x4', expectedVersion: 1, cancelReason: 'forbidden' }],
    ['approve', { clientActionId: 'x5', expectedVersion: 1, revisionReason: 'forbidden' }],
    ['request-revision', { clientActionId: 'x6', expectedVersion: 1, revisionReason: 'Düzelt', note: 'forbidden' }],
    ['withdraw-from-approval', { clientActionId: 'x6w', expectedVersion: 1, note: 'forbidden' }],
    ['cancel', { clientActionId: 'x7', expectedVersion: 1, cancelReason: 'İptal', note: 'forbidden' }],
  ])('rejects unknown fields for %s lifecycle command', async (path, payload) => {
    const { app, service } = await createApp();
    const response = await app.inject({ method: 'POST', url: `/api/job-cards/job-1/${path}`, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(Object.values(service).filter((value) => typeof value === 'function')
      .every((mock) => !(mock as ReturnType<typeof vi.fn>).mock?.calls.length)).toBe(true);
  });

  it('exposes scoped immutable activity with parsed default page', async () => {
    const { app, service } = await createApp();
    const response = await app.inject({ method: 'GET', url: '/api/job-cards/job-1/activity' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], total: 0, limit: 50, offset: 0 });
    expect(service.listActivity).toHaveBeenCalledWith(expect.anything(), 'job-1', { limit: 50, offset: 0 });
  });

  it('forwards an explicit activity page', async () => {
    const { app, service } = await createApp();
    const page = { items: [{ id: 'activity-1' }], total: 9, limit: 10, offset: 20 };
    service.listActivity.mockResolvedValueOnce(page);
    const response = await app.inject({
      method: 'GET', url: '/api/job-cards/job-1/activity?limit=10&offset=20',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(page);
    expect(service.listActivity).toHaveBeenCalledWith(expect.anything(), 'job-1', { limit: 10, offset: 20 });
  });

  it.each([
    '/api/job-cards/job-1/activity?unknown=value',
    '/api/job-cards/job-1/activity?limit=1&limit=2',
    '/api/job-cards/job-1/activity?limit=0',
    '/api/job-cards/job-1/activity?limit=101',
    '/api/job-cards/job-1/activity?offset=-1',
    '/api/job-cards/job-1/activity?offset=1.5',
  ])('rejects invalid activity query %s', async (url) => {
    const { app, service } = await createApp();
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.listActivity).not.toHaveBeenCalled();
  });

  it('lists notes with the default and explicit canonical page', async () => {
    const { app, service } = await createApp();
    const first = await app.inject({ method: 'GET', url: '/api/job-cards/job-1/notes' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ items: [], total: 0, limit: 25, offset: 0 });
    expect(service.listNotes).toHaveBeenNthCalledWith(1, expect.anything(), 'job-1', { limit: 25, offset: 0 });

    const page = { items: [{ id: 'note-2' }, { id: 'note-1' }], total: 4, limit: 2, offset: 1 };
    service.listNotes.mockResolvedValueOnce(page);
    const second = await app.inject({ method: 'GET', url: '/api/job-cards/job-1/notes?limit=2&offset=1' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(page);
    expect(service.listNotes).toHaveBeenNthCalledWith(2, expect.anything(), 'job-1', { limit: 2, offset: 1 });
  });

  it.each([
    '/api/job-cards/job-1/notes?unknown=value',
    '/api/job-cards/job-1/notes?limit=1&limit=2',
    '/api/job-cards/job-1/notes?limit=0',
    '/api/job-cards/job-1/notes?limit=101',
    '/api/job-cards/job-1/notes?offset=-1',
    '/api/job-cards/job-1/notes?offset=1.5',
  ])('rejects invalid notes query %s', async (url) => {
    const { app, service } = await createApp();
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.listNotes).not.toHaveBeenCalled();
  });

  it('appends with the exact body and returns 201 for first completion and replay', async () => {
    const { app, service } = await createApp();
    const payload = { clientActionId: 'note-action', note: 'Klinik arandı' };
    const first = await app.inject({ method: 'POST', url: '/api/job-cards/job-1/notes', payload });
    const replay = await app.inject({ method: 'POST', url: '/api/job-cards/job-1/notes', payload });
    expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(service.addNote).toHaveBeenNthCalledWith(1, expect.anything(), 'job-1', payload);
  });

  it('rejects unknown note body keys and maps an in-progress append to 409', async () => {
    const { app, service } = await createApp();
    for (const payload of [
      { clientActionId: 'n1', note: 'Not', expectedVersion: 1 },
      { clientActionId: 'n1', note: 'Not', extra: true },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/job-cards/job-1/notes', payload });
      expect(response.statusCode).toBe(400);
    }
    expect(service.addNote).not.toHaveBeenCalled();

    service.addNote.mockRejectedValueOnce(new AppError('ACTION_IN_PROGRESS', 409, 'İşlem devam ediyor.'));
    const response = await app.inject({
      method: 'POST', url: '/api/job-cards/job-1/notes', payload: { clientActionId: 'busy', note: 'Not' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'ACTION_IN_PROGRESS' });
  });

  it('exposes no note update or delete route', async () => {
    const { app } = await createApp();
    expect((await app.inject({ method: 'PATCH', url: '/api/job-cards/job-1/notes/note-1', payload: { note: 'X' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/job-cards/job-1/notes/note-1' })).statusCode).toBe(404);
  });
});
