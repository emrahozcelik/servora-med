import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const apps: FastifyInstance[] = [];

function serviceDouble(overrides: Record<string, unknown> = {}) {
  return {
    getSubmissionDelay: vi.fn().mockResolvedValue({ open: null }),
    remindSubmission: vi.fn().mockResolvedValue({
      jobCardId: JOB_ID,
      incidentId: 'incident-1',
      reminderId: 'reminder-1',
      sentAt: '2026-08-03T09:00:00.000Z',
      targetUserId: 'staff-1',
    }),
    ...overrides,
  };
}

async function createApp(role: JobCardActor['role'], overrides: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false });
  const service = serviceDouble(overrides);
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

describe('OVR-4 submission delay read endpoint', () => {
  it('serves the current delay signal to any authenticated job actor', async () => {
    const { app, service } = await createApp('STAFF');
    const response = await app.inject({
      method: 'GET', url: `/api/job-cards/${JOB_ID}/submission-delay`,
    });
    expect(response.statusCode).toBe(200);
    expect(service.getSubmissionDelay).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'STAFF' }),
      JOB_ID,
    );
    expect(response.json()).toEqual({ open: null });
  });

  it('rejects a non-uuid job id', async () => {
    const { app } = await createApp('MANAGER');
    const response = await app.inject({
      method: 'GET', url: '/api/job-cards/not-a-uuid/submission-delay',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('OVR-4 manual submission reminder endpoint', () => {
  it('delegates a management reminder with the client action id', async () => {
    const { app, service } = await createApp('MANAGER');
    const response = await app.inject({
      method: 'POST',
      url: `/api/job-cards/${JOB_ID}/submission-reminder`,
      payload: { clientActionId: 'action-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(service.remindSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'MANAGER' }),
      JOB_ID,
      { clientActionId: 'action-1' },
    );
  });

  it('rejects an unknown body field', async () => {
    const { app } = await createApp('MANAGER');
    const response = await app.inject({
      method: 'POST',
      url: `/api/job-cards/${JOB_ID}/submission-reminder`,
      payload: { clientActionId: 'action-1', note: 'please' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a non-object body', async () => {
    const { app } = await createApp('MANAGER');
    const response = await app.inject({
      method: 'POST',
      url: `/api/job-cards/${JOB_ID}/submission-reminder`,
      payload: [],
    });
    expect(response.statusCode).toBe(400);
  });

  it('propagates the service 403 for a STAFF actor', async () => {
    const { app } = await createApp('STAFF', {
      remindSubmission: vi.fn().mockRejectedValue(
        new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.'),
      ),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/job-cards/${JOB_ID}/submission-reminder`,
      payload: { clientActionId: 'action-1' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('propagates the fail-closed 409 when no open submission delay exists', async () => {
    const { app } = await createApp('MANAGER', {
      remindSubmission: vi.fn().mockRejectedValue(
        new AppError('NO_OPEN_SUBMISSION_DELAY', 409, 'Bu iş için açık bir gecikme yok.'),
      ),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/job-cards/${JOB_ID}/submission-reminder`,
      payload: { clientActionId: 'action-1' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'NO_OPEN_SUBMISSION_DELAY' });
  });
});
