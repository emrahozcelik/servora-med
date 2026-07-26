import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { overviewRoutes } from '../src/modules/overview/routes.js';
import { OverviewService } from '../src/modules/overview/service.js';

const apps: FastifyInstance[] = [];
const range = { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' };
const actor: SafeUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe',
  email: 'ayse@example.test', role: 'STAFF', mustChangePassword: false,
  isActive: true, version: 1,
};

async function createApp(enabled: boolean, authenticated = true) {
  const app = Fastify({ logger: false });
  const repository = {
    getStaffOverview: vi.fn().mockResolvedValue({
      scope: 'staff', range, generatedAt: '2026-07-26T08:00:00.000Z',
      openJobCards: 1, waitingApproval: 0, revisionRequested: 0, completedInPeriod: 2,
      recentCompletedWork: [], recentNotes: [],
    }),
    getManagementOverview: vi.fn(),
  };
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    reply.code(response.statusCode).send(response.body);
  });
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!authenticated) throw new AppError('UNAUTHENTICATED', 401, 'Oturum açmanız gerekiyor.');
    request.currentUser = actor;
  };
  await app.register(overviewRoutes, {
    prefix: '/api/overview',
    service: new OverviewService(enabled, repository as never, () => new Date('2026-07-26T08:00:00.000Z')),
    authenticate,
  });
  apps.push(app);
  return { app, repository };
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('Overview HTTP route', () => {
  it('serves the exact authenticated endpoint and validates report-style date bounds', async () => {
    const { app, repository } = await createApp(true);
    const response = await app.inject({
      method: 'GET',
      url: '/api/overview?from=2026-07-01&to=2026-07-31',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ scope: 'staff', openJobCards: 1 });
    expect(repository.getStaffOverview).toHaveBeenCalledWith(
      actor,
      { requestedRange: { from: '2026-07-01', to: '2026-07-31' } },
      expect.any(Date),
    );
    expect((await app.inject({
      method: 'GET',
      url: '/api/overview?from=2026-07-31&to=2026-07-01',
    })).statusCode).toBe(400);
  });

  it('requires authentication and conceals the route when disabled', async () => {
    const { app: unauthenticated } = await createApp(true, false);
    expect((await unauthenticated.inject({ method: 'GET', url: '/api/overview' })).statusCode)
      .toBe(401);
    const { app: disabled, repository } = await createApp(false);
    const response = await disabled.inject({ method: 'GET', url: '/api/overview' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(repository.getStaffOverview).not.toHaveBeenCalled();
  });
});
