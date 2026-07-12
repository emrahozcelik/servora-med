import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import { peopleRoutes } from '../src/modules/people/routes.js';

const apps: FastifyInstance[] = [];
const actor = { id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'admin@example.com',
  role: 'ADMIN' as const, mustChangePassword: false, isActive: true, version: 1 };

function serviceDouble() {
  const user = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'staff@example.com',
    role: 'STAFF', mustChangePassword: true, isActive: true, version: 1, lastLoginAt: null,
    createdAt: new Date(), updatedAt: new Date() };
  const staff = { id: 'profile-1', user, title: null, phone: null, region: null,
    managerUserId: null, managerName: null, version: 1,
    counters: { open: 1, waitingApproval: 2, revisionRequested: 3, completedThisMonth: 4, overdue: 5 } };
  return {
    listUsers: vi.fn().mockResolvedValue([user]), getUser: vi.fn().mockResolvedValue(user),
    createUser: vi.fn().mockResolvedValue(user), updateUser: vi.fn().mockResolvedValue({ ...user, version: 2 }),
    changeRole: vi.fn().mockResolvedValue({ ...user, role: 'MANAGER', version: 2 }),
    activate: vi.fn().mockResolvedValue({ ...user, isActive: true, version: 2 }),
    deactivate: vi.fn().mockResolvedValue({ ...user, isActive: false, version: 2 }),
    resetPassword: vi.fn().mockResolvedValue({ ...user, version: 2 }),
    listStaff: vi.fn().mockResolvedValue([staff]), getOwnStaffProfile: vi.fn().mockResolvedValue(staff),
    getStaffProfile: vi.fn().mockResolvedValue(staff), updateStaffProfile: vi.fn().mockResolvedValue({ ...staff, version: 2 }),
  };
}

async function createApp(current = actor) {
  const app = Fastify({ logger: false }); const service = serviceDouble();
  app.setErrorHandler((error, _request, reply) => { const result = toErrorResponse(error); reply.code(result.statusCode).send(result.body); });
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => { request.currentUser = current; };
  await app.register(peopleRoutes, { prefix: '/api', service: service as never, authenticate });
  apps.push(app); return { app, service };
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('People HTTP routes', () => {
  it('registers Admin user list, create, detail, and name update', async () => {
    const { app, service } = await createApp();
    expect((await app.inject({ method: 'GET', url: '/api/users' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/users', payload: {
      name: 'Ayşe', email: 'staff@example.com', role: 'STAFF', temporaryPassword: 'temporary-password',
      staffProfile: { title: null, phone: null, region: null, managerUserId: null },
    } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/api/users/staff-1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/api/users/staff-1', payload: { expectedVersion: 1, name: 'Yeni Ad' } })).statusCode).toBe(200);
    expect(service.updateUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'admin-1' }), 'staff-1', { expectedVersion: 1, name: 'Yeni Ad' });
  });

  it.each([
    ['change-role', { expectedVersion: 1, role: 'MANAGER' }, 'changeRole'],
    ['activate', { expectedVersion: 1 }, 'activate'],
    ['deactivate', { expectedVersion: 1 }, 'deactivate'],
    ['reset-password', { expectedVersion: 1, temporaryPassword: 'temporary-password' }, 'resetPassword'],
  ])('dispatches named %s command', async (path, payload, method) => {
    const { app, service } = await createApp();
    expect((await app.inject({ method: 'POST', url: `/api/users/staff-1/${path}`, payload })).statusCode).toBe(200);
    expect(service[method as 'activate']).toHaveBeenCalled();
  });

  it('exposes role-scoped Staff list, own profile, detail, and update', async () => {
    const { app, service } = await createApp();
    expect((await app.inject({ method: 'GET', url: '/api/staff?status=all' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/staff/me' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/staff/staff-1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/api/staff/staff-1', payload: {
      expectedVersion: 1, title: 'Uzman', phone: null, region: 'Marmara', managerUserId: 'manager-1',
    } })).statusCode).toBe(200);
    expect(service.listStaff).toHaveBeenCalledWith(expect.anything(), 'all');
  });

  it('rejects unknown fields and invalid expectedVersion before service dispatch', async () => {
    const { app, service } = await createApp();
    const unknown = await app.inject({ method: 'PATCH', url: '/api/users/staff-1', payload: { expectedVersion: 1, name: 'Ad', isActive: false } });
    const invalid = await app.inject({ method: 'POST', url: '/api/users/staff-1/deactivate', payload: { expectedVersion: 0 } });
    expect(unknown.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(400);
    expect(service.updateUser).not.toHaveBeenCalled();
    expect(service.deactivate).not.toHaveBeenCalled();
  });

  it('does not serialize credential fields in user responses', async () => {
    const { app } = await createApp();
    const response = await app.inject({ method: 'GET', url: '/api/users' });
    expect(response.body).not.toMatch(/passwordHash|temporaryPassword|token|session/i);
  });

  it('returns authentication and service authorization errors unchanged', async () => {
    const app = Fastify({ logger: false }); const service = serviceDouble();
    app.setErrorHandler((error, _request, reply) => { const result = toErrorResponse(error); reply.code(result.statusCode).send(result.body); });
    const authenticate = async () => { throw new AppError('UNAUTHENTICATED', 401, 'Oturum açmanız gerekiyor.'); };
    await app.register(peopleRoutes, { prefix: '/api', service: service as never, authenticate }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/users' })).statusCode).toBe(401);
  });
});
