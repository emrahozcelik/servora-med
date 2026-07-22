import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import { crmRoutes } from '../src/modules/crm/routes.js';

const apps: FastifyInstance[] = [];
const manager = { id: 'manager-1', organizationId: 'org-1', name: 'Manager',
  email: 'manager@example.com', role: 'MANAGER' as const, mustChangePassword: false,
  isActive: true, version: 1 };

function serviceDouble() {
  const customer = { id: 'customer-1', organizationId: 'org-1', name: 'Demo Klinik',
    customerType: 'clinic', taxNumber: null, phone: null, email: null, city: 'İstanbul',
    district: null, address: null, assignedStaffUserId: null, status: 'prospect', version: 1 };
  const contact = { id: 'contact-1', organizationId: 'org-1', customerId: 'customer-1',
    name: 'Dr. Ayşe', title: null, phone: null, email: null, isPrimary: false,
    isActive: true, version: 1 };
  return {
    listCustomers: vi.fn().mockResolvedValue({ items: [customer], total: 1, limit: 25, offset: 5 }),
    getCustomer: vi.fn().mockResolvedValue(customer), createCustomer: vi.fn().mockResolvedValue(customer),
    updateCustomer: vi.fn().mockResolvedValue({ ...customer, version: 2 }),
    activateCustomer: vi.fn().mockResolvedValue({ ...customer, status: 'active', version: 2 }),
    deactivateCustomer: vi.fn().mockResolvedValue({ ...customer, status: 'inactive', version: 2 }),
    deleteCustomer: vi.fn().mockResolvedValue(undefined),
    listContacts: vi.fn().mockResolvedValue({ items: [contact], total: 1, limit: 10, offset: 2 }),
    getContact: vi.fn().mockResolvedValue(contact), createContact: vi.fn().mockResolvedValue(contact),
    updateContact: vi.fn().mockResolvedValue({ ...contact, version: 2 }),
    activateContact: vi.fn().mockResolvedValue({ ...contact, isActive: true, version: 2 }),
    deactivateContact: vi.fn().mockResolvedValue({ ...contact, isActive: false, version: 2 }),
    makePrimary: vi.fn().mockResolvedValue({ contact: { ...contact, isPrimary: true, version: 2 }, previousPrimaryContactId: null }),
  };
}

async function createApp(current = manager) {
  const app = Fastify({ logger: false });
  const service = serviceDouble();
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error); reply.code(response.statusCode).send(response.body);
  });
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => { request.currentUser = current; };
  await app.register(crmRoutes, { prefix: '/api', service: service as never, authenticate });
  apps.push(app);
  return { app, service };
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('CRM HTTP routes', () => {
  it.each([
    ['UNAUTHENTICATED', 401],
    ['PASSWORD_CHANGE_REQUIRED', 403],
  ])('runs the %s guard before handler dispatch', async (code, statusCode) => {
    const app = Fastify({ logger: false }); const service = serviceDouble();
    app.setErrorHandler((error, _request, reply) => {
      const response = toErrorResponse(error); reply.code(response.statusCode).send(response.body);
    });
    const authenticate = async () => { throw new AppError(code, statusCode, 'Erişim engellendi.'); };
    await app.register(crmRoutes, { prefix: '/api', service: service as never, authenticate });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/customers' });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ code });
    expect(service.listCustomers).not.toHaveBeenCalled();
  });

  it('registers the exact Customer and nested Contact route surface', async () => {
    const { app } = await createApp();
    const routes = [
      ['GET', '/api/customers'], ['POST', '/api/customers'], ['GET', '/api/customers/customer-1'],
      ['PATCH', '/api/customers/customer-1'], ['POST', '/api/customers/customer-1/activate'],
      ['POST', '/api/customers/customer-1/deactivate'], ['DELETE', '/api/customers/customer-1', { expectedVersion: 1 }],
      ['GET', '/api/customers/customer-1/contacts'],
      ['POST', '/api/customers/customer-1/contacts'], ['GET', '/api/customers/customer-1/contacts/contact-1'],
      ['PATCH', '/api/customers/customer-1/contacts/contact-1'],
      ['POST', '/api/customers/customer-1/contacts/contact-1/activate'],
      ['POST', '/api/customers/customer-1/contacts/contact-1/deactivate'],
      ['POST', '/api/customers/customer-1/contacts/contact-1/make-primary'],
    ] as const;
    for (const entry of routes) {
      const method = entry[0];
      const url = entry[1];
      const explicitPayload = entry.length > 2 ? entry[2] : undefined;
      const payload = method === 'GET' ? undefined
        : explicitPayload !== undefined ? explicitPayload
        : url.endsWith('/customers') && method === 'POST'
        ? { name: 'Klinik', customerType: 'clinic', taxNumber: null, phone: null, email: null,
          city: null, district: null, address: null, assignedStaffUserId: null }
        : url.endsWith('/contacts') && method === 'POST' ? { name: 'Dr. Ayşe', title: null, phone: null, email: null }
          : url.includes('/contacts/') && method === 'PATCH'
            ? { expectedVersion: 1, name: 'Dr. Ayşe', title: null, phone: null, email: null }
            : method === 'PATCH'
              ? { expectedVersion: 1, name: 'Klinik', customerType: 'clinic', taxNumber: null,
                phone: null, email: null, city: null, district: null, address: null,
                assignedStaffUserId: null }
              : { expectedVersion: 1 };
      expect((await app.inject({ method, url, payload })).statusCode, `${method} ${url}`).not.toBe(404);
    }
  });

  it('dispatches Customer delete and returns 204', async () => {
    const { app, service } = await createApp();
    const response = await app.inject({
      method: 'DELETE', url: '/api/customers/customer-1',
      payload: { expectedVersion: 1 },
    });
    expect(response.statusCode).toBe(204);
    expect(service.deleteCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'manager-1' }), 'customer-1', 1,
    );
  });

  it('preserves Customer delete operation-history conflicts', async () => {
    const { app, service } = await createApp();
    service.deleteCustomer.mockRejectedValueOnce(new AppError(
      'CUSTOMER_HAS_OPERATION_HISTORY', 409,
      'Bu müşteri geçmiş iş veya teslimat kayıtlarında kullanıldığı için silinemez.',
    ));
    const response = await app.inject({
      method: 'DELETE', url: '/api/customers/customer-1',
      payload: { expectedVersion: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'CUSTOMER_HAS_OPERATION_HISTORY',
      error: 'Bu müşteri geçmiş iş veya teslimat kayıtlarında kullanıldığı için silinemez.',
    });
  });

  it('passes only exact Customer filters and bounded pagination', async () => {
    const { app, service } = await createApp();
    expect((await app.inject({ method: 'GET', url: '/api/customers?q=demo&status=active&customerType=clinic&assignedStaffUserId=staff-1&city=Istanbul&unassigned=true&limit=25&offset=5' })).statusCode).toBe(200);
    expect(service.listCustomers).toHaveBeenCalledWith(expect.objectContaining({ id: 'manager-1' }), {
      q: 'demo', status: 'active', customerType: 'clinic', assignedStaffUserId: 'staff-1',
      city: 'Istanbul', unassigned: true, limit: 25, offset: 5,
    });
    for (const url of ['/api/customers?unknown=x', '/api/customers?limit=0',
      '/api/customers?limit=201', '/api/customers?offset=-1', '/api/customers?unassigned=yes']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(400);
    }
  });

  it('passes exact Contact filters and pagination on the nested parent path', async () => {
    const { app, service } = await createApp();
    expect((await app.inject({ method: 'GET', url: '/api/customers/customer-1/contacts?q=ayse&status=inactive&limit=10&offset=2' })).statusCode).toBe(200);
    expect(service.listContacts).toHaveBeenCalledWith(expect.anything(), 'customer-1', {
      q: 'ayse', status: 'inactive', limit: 10, offset: 2,
    });
    expect((await app.inject({ method: 'GET', url: '/api/customers/customer-1/contacts?customerId=other' })).statusCode).toBe(400);
  });

  it('uses exact mutation allowlists and positive integer versions', async () => {
    const { app, service } = await createApp();
    const customerPatch = { expectedVersion: 3, name: 'Yeni Klinik', customerType: 'hospital',
      taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
      assignedStaffUserId: null };
    expect((await app.inject({ method: 'PATCH', url: '/api/customers/customer-1', payload: customerPatch })).statusCode).toBe(200);
    expect(service.updateCustomer).toHaveBeenCalledWith(expect.anything(), 'customer-1', customerPatch);
    const contactPatch = { expectedVersion: 2, name: 'Dr. Ece', title: null, phone: null, email: null };
    expect((await app.inject({ method: 'PATCH', url: '/api/customers/customer-1/contacts/contact-1', payload: contactPatch })).statusCode).toBe(200);
    expect(service.updateContact).toHaveBeenCalledWith(expect.anything(), 'customer-1', 'contact-1', contactPatch);
    for (const payload of [{ ...customerPatch, notes: 'secret' }, { ...customerPatch, expectedVersion: 0 },
      { ...customerPatch, expectedVersion: 1.5 }]) {
      expect((await app.inject({ method: 'PATCH', url: '/api/customers/customer-1', payload })).statusCode).toBe(400);
    }
  });

  it.each([
    ['POST', '/api/customers', ''],
    ['POST', '/api/customers', '   '],
    ['PATCH', '/api/customers/customer-1', ''],
    ['PATCH', '/api/customers/customer-1', '   '],
  ])('rejects an empty assignedStaffUserId on %s %s', async (method, url, assignedStaffUserId) => {
    const { app, service } = await createApp();
    const payload = { name: 'Klinik', customerType: 'clinic', taxNumber: null, phone: null,
      email: null, city: null, district: null, address: null, assignedStaffUserId,
      ...(method === 'PATCH' ? { expectedVersion: 1 } : {}) };

    const response = await app.inject({ method, url, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.createCustomer).not.toHaveBeenCalled();
    expect(service.updateCustomer).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/customers/customer-1/activate', 'activateCustomer'],
    ['/api/customers/customer-1/deactivate', 'deactivateCustomer'],
    ['/api/customers/customer-1/contacts/contact-1/activate', 'activateContact'],
    ['/api/customers/customer-1/contacts/contact-1/deactivate', 'deactivateContact'],
    ['/api/customers/customer-1/contacts/contact-1/make-primary', 'makePrimary'],
  ])('dispatches named lifecycle command %s', async (url, method) => {
    const { app, service } = await createApp();
    expect((await app.inject({ method: 'POST', url, payload: { expectedVersion: 4 } })).statusCode).toBe(200);
    expect(service[method as 'activateCustomer']).toHaveBeenCalledWith(
      expect.anything(), 'customer-1', ...(url.includes('/contacts/') ? ['contact-1'] : []), 4,
    );
  });

  it('allows Staff to create customers while blocking mutations and concealing cross-org', async () => {
    const staff = { ...manager, id: 'staff-1', role: 'STAFF' as const };
    const { app, service } = await createApp(staff);
    expect((await app.inject({ method: 'GET', url: '/api/customers' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/customers/customer-1/contacts/contact-1' })).statusCode).toBe(200);

    expect((await app.inject({ method: 'POST', url: '/api/customers', payload: {
      name: 'Klinik', customerType: 'clinic', taxNumber: null, phone: null, email: null,
      city: null, district: null, address: null, assignedStaffUserId: null,
    } })).statusCode).toBe(201);

    const forbidPayload = { expectedVersion: 1, name: 'Klinik', customerType: 'clinic',
      taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
      assignedStaffUserId: null };
    const forbidPayloadVersions = [
      ['PATCH', '/api/customers/customer-1', 'updateCustomer'],
      ['DELETE', '/api/customers/customer-1', 'deleteCustomer'],
      ['POST', '/api/customers/customer-1/activate', 'activateCustomer'],
      ['POST', '/api/customers/customer-1/deactivate', 'deactivateCustomer'],
      ['POST', '/api/customers/customer-1/contacts', 'createContact'],
      ['PATCH', '/api/customers/customer-1/contacts/contact-1', 'updateContact'],
      ['POST', '/api/customers/customer-1/contacts/contact-1/activate', 'activateContact'],
      ['POST', '/api/customers/customer-1/contacts/contact-1/deactivate', 'deactivateContact'],
      ['POST', '/api/customers/customer-1/contacts/contact-1/make-primary', 'makePrimary'],
    ] as const;
    for (const [method, url, methodName] of forbidPayloadVersions) {
      service[methodName].mockRejectedValueOnce(new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz yok.'));
      const payload = method === 'DELETE' ? { expectedVersion: 1 }
        : methodName === 'createContact' ? { name: 'Dr. Ayşe', title: null, phone: null, email: null }
        : methodName === 'updateContact' ? { expectedVersion: 1, name: 'Dr. Ayşe', title: null, phone: null, email: null }
        : methodName === 'activateCustomer' || methodName === 'deactivateCustomer' || methodName === 'activateContact' || methodName === 'deactivateContact' || methodName === 'makePrimary'
        ? { expectedVersion: 1 }
        : forbidPayload;
      const response = await app.inject({ method, url, payload });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }

    service.getCustomer.mockRejectedValueOnce(new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.'));
    const concealed = await app.inject({ method: 'GET', url: '/api/customers/cross-org' });
    expect(concealed.statusCode).toBe(404);
    expect(concealed.json()).toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  it('preserves stable conflicts and never serializes notes fields', async () => {
    const { app, service } = await createApp();
    service.activateCustomer.mockRejectedValueOnce(new AppError('VERSION_CONFLICT', 409,
      'Kayıt başka bir kullanıcı tarafından güncellendi.', { currentVersion: 5 }));
    const conflict = await app.inject({ method: 'POST', url: '/api/customers/customer-1/activate', payload: { expectedVersion: 4 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 5 } });
    expect((await app.inject({ method: 'GET', url: '/api/customers' })).body).not.toMatch(/notes/i);
    expect((await app.inject({ method: 'GET', url: '/api/customers/customer-1/contacts' })).body).not.toMatch(/notes/i);
  });
});
