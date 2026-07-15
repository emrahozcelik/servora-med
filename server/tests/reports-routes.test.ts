import { readFileSync } from 'node:fs';

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { reportsRoutes } from '../src/modules/reports/routes.js';
import { ReportsService } from '../src/modules/reports/service.js';

const ORG_ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_ONE = '11111111-1111-4111-8111-111111111111';
const INACTIVE_STAFF = '22222222-2222-4222-8222-222222222222';
const MISSING_STAFF = '33333333-3333-4333-8333-333333333333';
const requestTime = new Date('2026-07-14T12:00:00.000Z');
const resolvedRange = {
  from: '2026-07-01',
  to: '2026-07-31',
  timezone: 'Europe/Istanbul',
};
const apps: FastifyInstance[] = [];

function actor(role: SafeUser['role']): SafeUser {
  return {
    id: role === 'STAFF' ? STAFF_ONE : `${role.toLowerCase()}-1`,
    organizationId: ORG_ONE,
    name: role,
    email: `${role.toLowerCase()}@example.com`,
    role,
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

function dependencies() {
  const reports = {
    getDashboard: vi.fn(async () => ({
      range: resolvedRange,
      counters: {
        activeJobCards: 1,
        overdueJobCards: 0,
        waitingApproval: 1,
        revisionRequested: 0,
        completedInPeriod: 0,
        cancelledInPeriod: 0,
      },
      completedTrend: [],
    })),
    getStaffIdentity: vi.fn(async ({ staffUserId }) => {
      if (staffUserId === MISSING_STAFF) return null;
      return {
        userId: staffUserId,
        name: staffUserId === INACTIVE_STAFF ? 'Eski Personel' : 'Aktif Personel',
        isActive: staffUserId !== INACTIVE_STAFF,
      };
    }),
    getOne: vi.fn(async ({ staffUserId }) => ({
      staffUserId,
      range: resolvedRange,
      counters: {
        openJobCards: 1,
        waitingApproval: 1,
        revisionRequested: 0,
        overdueJobCards: 0,
        completedInPeriod: 0,
      },
    })),
    getMany: vi.fn(),
    getStaffDeliveriesByPurpose: vi.fn(async () => []),
    getDeliveryReport: vi.fn(async (input) => ({
      groupBy: input.groupBy,
      items: [],
      range: resolvedRange,
      total: 0,
      limit: input.limit,
      offset: input.offset,
    })),
    getApprovalSummary: vi.fn(async () => ({
      pendingCount: 0,
      oldestWaitingMinutes: null,
      averageWaitingMinutes: null,
      under2Hours: 0,
      between2And8Hours: 0,
      between8And24Hours: 0,
      over24Hours: 0,
    })),
  };
  const approvalItems = { getApprovalItems: vi.fn(async () => []) };
  return { reports, approvalItems };
}

async function createApp(current: SafeUser, authenticated = true) {
  const app = Fastify({ logger: false });
  const ports = dependencies();
  const service = new ReportsService(
    ports.reports as never,
    ports.approvalItems as never,
    () => requestTime,
  );
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    reply.code(response.statusCode).send(response.body);
  });
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!authenticated) {
      throw new AppError('UNAUTHENTICATED', 401, 'Oturum açmanız gerekiyor.');
    }
    request.currentUser = current;
  };
  await app.register(reportsRoutes, {
    prefix: '/api/reports',
    service,
    authenticate,
  });
  apps.push(app);
  return { app, ...ports };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Reports HTTP routes', () => {
  it('registers exactly the five authenticated GET report routes', async () => {
    const { app, reports, approvalItems } = await createApp(actor('MANAGER'));

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/reports/dashboard' }),
      app.inject({ method: 'GET', url: `/api/reports/staff/${STAFF_ONE}` }),
      app.inject({ method: 'GET', url: '/api/reports/deliveries?groupBy=day' }),
      app.inject({ method: 'GET', url: '/api/reports/approvals' }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    expect((await app.inject({
      method: 'GET',
      url: '/api/reports/staff/me',
    })).statusCode).toBe(403);
    expect(reports.getDashboard).toHaveBeenCalledOnce();
    expect(reports.getDeliveryReport).toHaveBeenCalledOnce();
    expect(reports.getApprovalSummary).toHaveBeenCalledOnce();
    expect(approvalItems.getApprovalItems).toHaveBeenCalledOnce();

    expect((await app.inject({ method: 'POST', url: '/api/reports/dashboard' })).statusCode)
      .toBe(404);
  });

  it('allows Staff only its own report and denies four management reports', async () => {
    const { app } = await createApp(actor('STAFF'));

    expect((await app.inject({ method: 'GET', url: '/api/reports/staff/me' })).statusCode)
      .toBe(200);
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/reports/dashboard' }),
      app.inject({ method: 'GET', url: `/api/reports/staff/${STAFF_ONE}` }),
      app.inject({ method: 'GET', url: '/api/reports/deliveries?groupBy=day' }),
      app.inject({ method: 'GET', url: '/api/reports/approvals' }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403, 403]);
  });

  it.each(['ADMIN', 'MANAGER'] as const)(
    'allows %s management reports and denies the Staff self route',
    async (role) => {
      const { app } = await createApp(actor(role));
      expect((await app.inject({ method: 'GET', url: '/api/reports/dashboard' })).statusCode)
        .toBe(200);
      expect((await app.inject({
        method: 'GET',
        url: `/api/reports/staff/${INACTIVE_STAFF}`,
      })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/reports/staff/me' })).statusCode)
        .toBe(403);
    },
  );

  it('returns concealed 404 for malformed and unavailable Staff path IDs', async () => {
    const { app, reports } = await createApp(actor('MANAGER'));

    const malformed = await app.inject({
      method: 'GET',
      url: '/api/reports/staff/not-a-uuid',
    });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND' });
    expect(reports.getStaffIdentity).not.toHaveBeenCalled();

    const unavailable = await app.inject({
      method: 'GET',
      url: `/api/reports/staff/${MISSING_STAFF}`,
    });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND' });
  });

  it('separates malformed and unavailable delivery Staff filters', async () => {
    const { app, reports } = await createApp(actor('MANAGER'));

    const malformed = await app.inject({
      method: 'GET',
      url: '/api/reports/deliveries?groupBy=staff&staffUserId=bad',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(reports.getStaffIdentity).not.toHaveBeenCalled();
    expect(reports.getDeliveryReport).not.toHaveBeenCalled();

    const unavailable = await app.inject({
      method: 'GET',
      url: `/api/reports/deliveries?groupBy=staff&staffUserId=${MISSING_STAFF}`,
    });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND' });
    expect(reports.getDeliveryReport).not.toHaveBeenCalled();
  });

  it.each([
    '/api/reports/dashboard?unknown=value',
    '/api/reports/dashboard?from=2026-07-01&from=2026-07-02&to=2026-07-31',
    '/api/reports/staff/me?to=2026-07-31&to=2026-07-30&from=2026-07-01',
    `/api/reports/staff/${STAFF_ONE}?unknown=value`,
    '/api/reports/deliveries?groupBy=day&groupBy=staff',
    '/api/reports/deliveries?groupBy=day&limit=10&limit=20',
    '/api/reports/approvals?offset=0&offset=1',
    '/api/reports/approvals?unknown=value',
  ])('rejects unknown or repeated scalar query before dispatch: %s', async (url) => {
    const { app, reports, approvalItems } = await createApp(actor('MANAGER'));

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(reports.getDashboard).not.toHaveBeenCalled();
    expect(reports.getDeliveryReport).not.toHaveBeenCalled();
    expect(reports.getApprovalSummary).not.toHaveBeenCalled();
    expect(approvalItems.getApprovalItems).not.toHaveBeenCalled();
  });

  it('uses the authenticate function through every route options object', async () => {
    const { app } = await createApp(actor('MANAGER'), false);

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/reports/dashboard' }),
      app.inject({ method: 'GET', url: '/api/reports/staff/me' }),
      app.inject({ method: 'GET', url: `/api/reports/staff/${STAFF_ONE}` }),
      app.inject({ method: 'GET', url: '/api/reports/deliveries?groupBy=day' }),
      app.inject({ method: 'GET', url: '/api/reports/approvals' }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401, 401, 401]);

    const source = readFileSync(
      new URL('../src/modules/reports/routes.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('const secured = { preHandler: options.authenticate }');
    expect(source.replace(/\s+/g, ' ').match(/secured, handlers\./g)).toHaveLength(5);
    expect(source).not.toMatch(/app\.get\([^\n]+options\.authenticate/);
  });
});
