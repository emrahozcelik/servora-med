import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { peopleRoutes } from '../src/modules/people/routes.js';
import { PeopleService } from '../src/modules/people/service.js';
import type {
  PaginatedWeeklyReportHistory,
  WeeklyReportHistoryReadPort,
} from '../src/modules/weekly-reports/history-port.js';

const admin: SafeUser = {
  id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'admin@example.test',
  role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
};
const manager: SafeUser = { ...admin, id: 'manager-1', name: 'Manager', role: 'MANAGER' };
const staff: SafeUser = { ...admin, id: 'staff-1', name: 'Staff', role: 'STAFF' };

const page = (total: number): PaginatedWeeklyReportHistory =>
  ({ items: [], total, limit: 20, offset: 0 });

const credentials = { validatePassword: vi.fn(), hashPassword: vi.fn() };
const summaries = { getOne: vi.fn(), getMany: vi.fn() };

function repositoryDouble(existingProfile: unknown = { id: 'profile-1' }) {
  return { getStaffProfile: vi.fn().mockResolvedValue(existingProfile) };
}

function portDouble(total = 2) {
  const listForStaff = vi.fn().mockResolvedValue(page(total));
  return { listForStaff } satisfies WeeklyReportHistoryReadPort;
}

function serviceWith(repository: ReturnType<typeof repositoryDouble>, port?: WeeklyReportHistoryReadPort) {
  return new PeopleService(repository as never, credentials, summaries, undefined, port);
}

describe('PeopleService Weekly Report history — profile authorization', () => {
  // 1. STAFF own scope resolves to the actor, never a client-supplied id.
  it('delegates /staff/me to the authenticated Staff owner with tenant and paging', async () => {
    const repository = repositoryDouble();
    const port = portDouble(4);
    const service = serviceWith(repository, port);
    await expect(service.listOwnStaffWeeklyReports(staff, { limit: 20, offset: 40 }))
      .resolves.toMatchObject({ total: 4 });
    expect(port.listForStaff).toHaveBeenCalledWith({
      organizationId: 'org-1', targetUserId: 'staff-1',
      actor: { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' },
      limit: 20, offset: 40,
    });
  });

  // 2. A MANAGER owns no weekly reports: the self endpoint is Staff-only.
  it('refuses MANAGER on the own endpoint', async () => {
    const port = portDouble();
    const service = serviceWith(repositoryDouble(), port);
    await expect(service.listOwnStaffWeeklyReports(manager, { limit: 20, offset: 0 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(port.listForStaff).not.toHaveBeenCalled();
  });

  // 3. Same for ADMIN.
  it('refuses ADMIN on the own endpoint', async () => {
    const port = portDouble();
    const service = serviceWith(repositoryDouble(), port);
    await expect(service.listOwnStaffWeeklyReports(admin, { limit: 20, offset: 0 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(port.listForStaff).not.toHaveBeenCalled();
  });

  // 4. STAFF cannot enumerate another staff member's reports (concealed as 404).
  it('conceals another staff target from a STAFF caller', async () => {
    const repository = repositoryDouble();
    const port = portDouble();
    const service = serviceWith(repository, port);
    await expect(service.listStaffWeeklyReports(staff, 'staff-2', { limit: 20, offset: 0 }))
      .rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });
    expect(repository.getStaffProfile).not.toHaveBeenCalled();
    expect(port.listForStaff).not.toHaveBeenCalled();
  });

  // 5. MANAGER reads a real staff profile in its own organization.
  it('allows MANAGER on a staff target with an existing profile', async () => {
    const repository = repositoryDouble();
    const port = portDouble(3);
    const service = serviceWith(repository, port);
    await expect(service.listStaffWeeklyReports(manager, 'staff-2', { limit: 10, offset: 5 }))
      .resolves.toMatchObject({ total: 3 });
    expect(repository.getStaffProfile).toHaveBeenCalledWith('org-1', 'staff-2');
    expect(port.listForStaff).toHaveBeenCalledWith({
      organizationId: 'org-1', targetUserId: 'staff-2',
      actor: { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' },
      limit: 10, offset: 5,
    });
  });

  // 6. ADMIN reads a real staff profile.
  it('allows ADMIN on a staff target with an existing profile', async () => {
    const repository = repositoryDouble();
    const port = portDouble(1);
    const service = serviceWith(repository, port);
    await expect(service.listStaffWeeklyReports(admin, 'staff-2', { limit: 20, offset: 0 }))
      .resolves.toMatchObject({ total: 1 });
    expect(port.listForStaff).toHaveBeenCalledTimes(1);
  });

  // 7. A missing/foreign target profile is not disclosed.
  it('conceals a missing staff profile from management', async () => {
    const repository = repositoryDouble(null);
    const port = portDouble();
    const service = serviceWith(repository, port);
    await expect(service.listStaffWeeklyReports(manager, 'missing', { limit: 20, offset: 0 }))
      .rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });
    expect(port.listForStaff).not.toHaveBeenCalled();
  });

  // 8. Unwired port fails closed on the own endpoint.
  it('fails closed on the own endpoint when the read port is not wired', async () => {
    const service = serviceWith(repositoryDouble());
    await expect(service.listOwnStaffWeeklyReports(staff, { limit: 20, offset: 0 }))
      .rejects.toMatchObject({ code: 'WEEKLY_REPORT_HISTORY_UNAVAILABLE', statusCode: 404 });
  });

  // 9. Unwired port fails closed on the management endpoint too.
  it('fails closed on the management endpoint when the read port is not wired', async () => {
    const service = serviceWith(repositoryDouble());
    await expect(service.listStaffWeeklyReports(manager, 'staff-2', { limit: 20, offset: 0 }))
      .rejects.toMatchObject({ code: 'WEEKLY_REPORT_HISTORY_UNAVAILABLE', statusCode: 404 });
  });

  // 10. Role concealment outranks the wiring check (no availability oracle).
  it('keeps role concealment ahead of the wiring check', async () => {
    const service = serviceWith(repositoryDouble());
    await expect(service.listStaffWeeklyReports(staff, 'staff-2', { limit: 20, offset: 0 }))
      .rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });
  });

  // 11. The wiring check precedes the profile lookup (mirrors listStaffJobHistory).
  //     This is fail-closed and leaks no per-target oracle: the port's presence is
  //     deployment-global, so an unwired build answers UNAVAILABLE for every target
  //     regardless of whether that profile exists.
  it('fails closed before the profile lookup when the read port is not wired', async () => {
    const repository = repositoryDouble(null);
    const service = serviceWith(repository);
    await expect(service.listStaffWeeklyReports(manager, 'missing', { limit: 20, offset: 0 }))
      .rejects.toMatchObject({ code: 'WEEKLY_REPORT_HISTORY_UNAVAILABLE', statusCode: 404 });
    expect(repository.getStaffProfile).not.toHaveBeenCalled();
  });
});

const apps: FastifyInstance[] = [];

function routesServiceDouble() {
  return {
    listOwnStaffWeeklyReports: vi.fn().mockResolvedValue(page(0)),
    listStaffWeeklyReports: vi.fn().mockResolvedValue(page(0)),
    listOwnStaffJobHistory: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 }),
    listStaffJobHistory: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 }),
  };
}

async function createApp(current: SafeUser, withPort: boolean) {
  const app = Fastify({ logger: false });
  const service = routesServiceDouble();
  app.setErrorHandler((error, _request, reply) => {
    const result = toErrorResponse(error);
    reply.code(result.statusCode).send(result.body);
  });
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    request.currentUser = current;
  };
  await app.register(peopleRoutes, {
    prefix: '/api',
    service: service as never,
    authenticate,
    ...(withPort ? { weeklyReportHistoryReadPort: portDouble() as never } : {}),
  });
  apps.push(app);
  return { app, service };
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('People HTTP routes — weekly report history', () => {
  it('registers the history routes only when the read port is wired', async () => {
    const withoutPort = await createApp(manager, false);
    expect((await withoutPort.app.inject({ method: 'GET', url: '/api/staff/me/weekly-reports' })).statusCode)
      .toBe(404);
    expect((await withoutPort.app.inject({ method: 'GET', url: '/api/staff/staff-1/weekly-reports' })).statusCode)
      .toBe(404);
    const { app } = await createApp(manager, true);
    expect((await app.inject({ method: 'GET', url: '/api/staff/me/weekly-reports' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/staff/staff-1/weekly-reports' })).statusCode).toBe(200);
  });

  it('parses paging exactly and dispatches actor/target to the service', async () => {
    const { app, service } = await createApp(manager, true);
    expect((await app.inject({ method: 'GET', url: '/api/staff/me/weekly-reports?limit=50&offset=100' }))
      .statusCode).toBe(200);
    expect(service.listOwnStaffWeeklyReports).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'manager-1' }), { limit: 50, offset: 100 },
    );
    expect((await app.inject({ method: 'GET', url: '/api/staff/staff-9/weekly-reports' })).statusCode).toBe(200);
    expect(service.listStaffWeeklyReports).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'manager-1' }), 'staff-9', { limit: 20, offset: 0 },
    );
  });

  it('rejects unknown fields and out-of-range paging before service dispatch', async () => {
    const { app, service } = await createApp(manager, true);
    for (const url of [
      '/api/staff/me/weekly-reports?unknown=x',
      '/api/staff/me/weekly-reports?status=all',
      '/api/staff/me/weekly-reports?limit=0',
      '/api/staff/me/weekly-reports?limit=51',
      '/api/staff/me/weekly-reports?limit=abc',
      '/api/staff/me/weekly-reports?offset=-1',
      '/api/staff/me/weekly-reports?limit=',
      // Overflows int8: must be refused here, never forwarded to Postgres.
      '/api/staff/me/weekly-reports?offset=99999999999999999999',
      '/api/staff/me/weekly-reports?limit=99999999999999999999',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(400);
    }
    expect(service.listOwnStaffWeeklyReports).not.toHaveBeenCalled();
  });

  it('keeps the self route ahead of the parameterized route', async () => {
    const { app, service } = await createApp(manager, true);
    await app.inject({ method: 'GET', url: '/api/staff/me/weekly-reports' });
    expect(service.listOwnStaffWeeklyReports).toHaveBeenCalledTimes(1);
    expect(service.listStaffWeeklyReports).not.toHaveBeenCalled();
  });

  it('preserves service authorization errors unchanged', async () => {
    const { app, service } = await createApp(manager, true);
    service.listStaffWeeklyReports.mockRejectedValueOnce(
      new AppError('STAFF_PROFILE_NOT_FOUND', 404, 'Personel profili bulunamadı.'),
    );
    const response = await app.inject({ method: 'GET', url: '/api/staff/missing/weekly-reports' });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).code).toBe('STAFF_PROFILE_NOT_FOUND');
  });
});
