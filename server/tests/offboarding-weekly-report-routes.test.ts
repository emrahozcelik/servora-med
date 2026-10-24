import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { peopleRoutes } from '../src/modules/people/routes.js';

const actor: SafeUser = {
  id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'admin@example.test',
  role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
};
const jobCardId = '550e8400-e29b-41d4-a716-446655440000';
const apps: ReturnType<typeof Fastify>[] = [];

async function appWithOffboarding() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const result = toErrorResponse(error);
    reply.code(result.statusCode).send(result.body);
  });
  const offboarding = {
    listWeeklyReportBlockers: vi.fn().mockResolvedValue({ total: 0, limit: 50, hasMore: false, items: [] }),
  };
  await app.register(peopleRoutes, {
    prefix: '/api', service: {} as never, offboardingService: offboarding as never,
    authenticate: async (request: FastifyRequest, _reply: FastifyReply) => { request.currentUser = actor; },
  });
  apps.push(app);
  return { app, offboarding };
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('SOF-2C bounded blocker navigation route', () => {
  it('passes only a validated keyset and target to the authorized service', async () => {
    const { app, offboarding } = await appWithOffboarding();
    const base = '/api/users/staff-1/offboarding/weekly-report-blockers';
    expect((await app.inject({ method: 'GET', url: base })).statusCode).toBe(200);
    expect(offboarding.listWeeklyReportBlockers).toHaveBeenCalledWith(actor, 'staff-1', 50, null);
    expect((await app.inject({ method: 'GET', url: `${base}?limit=20&afterJobCardId=${jobCardId}&afterPeriodStart=2026-08-03` })).statusCode).toBe(200);
    expect(offboarding.listWeeklyReportBlockers).toHaveBeenLastCalledWith(actor, 'staff-1', 20,
      { jobCardId, periodStart: '2026-08-03' });
    expect((await app.inject({ method: 'GET', url: `${base}?afterJobCardId=${jobCardId}&afterPeriodStart=null` })).statusCode).toBe(200);
    expect(offboarding.listWeeklyReportBlockers).toHaveBeenLastCalledWith(actor, 'staff-1', 50,
      { jobCardId, periodStart: null });
  });

  it('rejects unknown, incomplete, oversized and malformed page requests before querying', async () => {
    const { app, offboarding } = await appWithOffboarding();
    const base = '/api/users/staff-1/offboarding/weekly-report-blockers';
    for (const query of [
      'offset=50', 'limit=0', 'limit=51', 'limit=-1', 'limit=1.5', 'limit=99999999999999999999',
      'afterPeriodStart=2026-08-03', `afterJobCardId=${jobCardId}`,
      'afterJobCardId=not-a-uuid&afterPeriodStart=2026-08-03',
      `afterJobCardId=${jobCardId}&afterPeriodStart=2026-02-30`,
      `afterJobCardId=${jobCardId}&afterPeriodStart=`,
    ]) {
      expect((await app.inject({ method: 'GET', url: `${base}?${query}` })).statusCode, query).toBe(400);
    }
    expect(offboarding.listWeeklyReportBlockers).not.toHaveBeenCalled();
  });
});
