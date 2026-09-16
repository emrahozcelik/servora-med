import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const apps: FastifyInstance[] = [];

function serviceDouble() {
  return {
    listOverdueIncidents: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 }),
  };
}

async function createApp(role: JobCardActor['role']) {
  const app = Fastify({ logger: false });
  const service = serviceDouble();
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    reply.code(response.statusCode).send(response.body);
  });
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    request.currentUser = {
      id: 'user-1', organizationId: 'org-1', role,
      name: 'Test', email: 'test@example.com', mustChangePassword: false,
    };
  };
  await app.register(jobCardRoutes, {
    prefix: '/api/job-cards', service: service as never, authenticate,
  });
  apps.push(app);
  return { app, service };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('OVR-2 overdue incident history endpoint', () => {
  it('serves the management history page for MANAGER', async () => {
    const { app, service } = await createApp('MANAGER');
    const response = await app.inject({
      method: 'GET', url: `/api/job-cards/${JOB_ID}/overdue-incidents`,
    });
    expect(response.statusCode).toBe(200);
    expect(service.listOverdueIncidents).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'MANAGER' }),
      JOB_ID,
      { limit: 25, offset: 0 },
    );
    expect(response.json()).toMatchObject({ items: [], total: 0, limit: 25, offset: 0 });
  });

  it('delegates authorization to the service layer', async () => {
    // Management-only enforcement lives in the service (same posture as
    // follow-up reads); the route passes the actor through untouched.
    const { app, service } = await createApp('STAFF');
    const response = await app.inject({
      method: 'GET', url: `/api/job-cards/${JOB_ID}/overdue-incidents`,
    });
    expect(response.statusCode).toBe(200);
    expect(service.listOverdueIncidents).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'STAFF' }),
      JOB_ID,
      { limit: 25, offset: 0 },
    );
  });

  it('validates limit/offset like other paged job-card reads', async () => {
    const { app } = await createApp('ADMIN');
    for (const query of ['?limit=0', '?limit=101', '?limit=nope', '?offset=-1', '?unknown=1']) {
      const response = await app.inject({
        method: 'GET', url: `/api/job-cards/${JOB_ID}/overdue-incidents${query}`,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
