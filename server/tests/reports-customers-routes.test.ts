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
const requestTime = new Date('2026-07-14T12:00:00.000Z');
const resolvedRange = {
  from: '2026-07-01',
  to: '2026-07-31',
  timezone: 'Europe/Istanbul',
};
const apps: FastifyInstance[] = [];

function actor(role: SafeUser['role']): SafeUser {
  return {
    id: role === 'STAFF' ? '11111111-1111-4111-8111-111111111111' : `${role.toLowerCase()}-1`,
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
    getCustomerReport: vi.fn(async (input) => ({
      range: resolvedRange,
      total: 0,
      limit: input.limit,
      offset: input.offset,
      items: [],
      unassigned: {
        snapshot: {
          active: 0,
          actionable: 0,
          waitingApproval: 0,
          revisionRequested: 0,
          overdue: 0,
        },
        period: {
          created: 0,
          createdWorkTypes: {
            PRODUCT_DELIVERY: 0,
            GENERAL_TASK: 0,
            SALES_MEETING: 0,
          },
          managerApproved: 0,
          followUpChildren: 0,
        },
      },
    })),
  };
  return { reports };
}

async function createApp(current: SafeUser, authenticated = true) {
  const app = Fastify({ logger: false });
  const ports = dependencies();
  const service = new ReportsService(
    ports.reports as never,
    { getApprovalItems: vi.fn(async () => []) } as never,
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

describe('Reports R2C-1 customer report HTTP routes', () => {
  it.each(['ADMIN', 'MANAGER'] as const)(
    'allows %s and dispatches the full customer report query',
    async (role) => {
      const { app, reports } = await createApp(actor(role));

      const response = await app.inject({
        method: 'GET',
        url: '/api/reports/customers?from=2026-07-01&to=2026-07-31'
          + '&search=Di%C5%9F&status=active&type=clinic&limit=10&offset=5',
      });

      expect(response.statusCode).toBe(200);
      expect(reports.getCustomerReport).toHaveBeenCalledOnce();
      expect(reports.getCustomerReport).toHaveBeenCalledWith({
        organizationId: ORG_ONE,
        requestedRange: { from: '2026-07-01', to: '2026-07-31' },
        requestTime,
        search: 'Diş',
        status: 'active',
        customerType: 'clinic',
        limit: 10,
        offset: 5,
      });
    },
  );

  it('allows an unfiltered customer report with defaults', async () => {
    const { app, reports } = await createApp(actor('MANAGER'));

    const response = await app.inject({ method: 'GET', url: '/api/reports/customers' });

    expect(response.statusCode).toBe(200);
    expect(reports.getCustomerReport).toHaveBeenCalledWith({
      organizationId: ORG_ONE,
      requestedRange: null,
      requestTime,
      search: null,
      status: null,
      customerType: null,
      limit: 50,
      offset: 0,
    });
  });

  it('denies Staff the customer report without dispatching', async () => {
    const { app, reports } = await createApp(actor('STAFF'));

    const response = await app.inject({ method: 'GET', url: '/api/reports/customers' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(reports.getCustomerReport).not.toHaveBeenCalled();
  });

  it('requires authentication before the route body runs', async () => {
    const { app } = await createApp(actor('MANAGER'), false);

    const response = await app.inject({ method: 'GET', url: '/api/reports/customers' });

    expect(response.statusCode).toBe(401);
  });

  it.each([
    '/api/reports/customers?unknown=value',
    '/api/reports/customers?search=a&search=b',
    '/api/reports/customers?status=bogus',
    '/api/reports/customers?type=bogus',
    '/api/reports/customers?limit=0',
    '/api/reports/customers?limit=abc',
    '/api/reports/customers?offset=-1',
    '/api/reports/customers?from=2026-07-31&to=2026-07-01',
    '/api/reports/customers?from=2024-01-01&to=2026-07-31',
  ])('rejects malformed customer report query before dispatch: %s', async (url) => {
    const { app, reports } = await createApp(actor('MANAGER'));

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(reports.getCustomerReport).not.toHaveBeenCalled();
  });

  it('uses the authenticate function through the customer route options object', async () => {
    const source = readFileSync(
      new URL('../src/modules/reports/routes.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("app.get('/customers', secured, handlers.getCustomers)");
  });
});