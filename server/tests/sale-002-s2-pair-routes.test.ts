import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

import { toErrorResponse } from '../src/errors/index.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import type { JobCardService } from '../src/modules/job-cards/service.js';

/**
 * SALE-002 §4.5 (R18): every pair-capable handler accepts
 * `expectedSaleVersion` explicitly, because `body(request, FIELDS)` rejects
 * unknown keys. The non-pair commands keep their strict allowlists, so the
 * field can never leak into START, accept/decline/release, cancel or
 * invalidate. No database is needed: the service is a stub.
 */

const jobCardId = '11111111-1111-4111-8111-111111111111';

function stubService() {
  const detail = { id: jobCardId, status: 'WAITING_APPROVAL', version: 5 };
  const calls: Array<{ method: string; body: unknown; id: string }> = [];
  const method = (name: string) => vi.fn(async (_actor: unknown, id: string, body: unknown) => {
    calls.push({ method: name, body, id });
    return detail;
  });
  const service = {
    // The legacy capability preHandler runs on every route; this suite only
    // asserts body allowlists, so it always resolves.
    assertSaleCapability: vi.fn(async () => undefined),
    submitForApproval: method('submitForApproval'),
    approve: method('approve'),
    requestRevision: method('requestRevision'),
    withdrawFromApproval: method('withdrawFromApproval'),
    resume: method('resume'),
    start: method('start'),
    acceptAssignment: method('acceptAssignment'),
    declineAssignment: method('declineAssignment'),
    releaseAssignment: method('releaseAssignment'),
    cancel: method('cancel'),
    invalidate: vi.fn(async () => detail),
  };
  return { service: service as unknown as JobCardService, calls };
}

async function appWith(service: JobCardService) {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    return reply.code(response.statusCode).send(response.body);
  });
  await app.register(jobCardRoutes, {
    prefix: '/api/job-cards',
    service,
    authenticate: async (request) => {
      request.currentUser = {
        id: '22222222-2222-4222-8222-222222222222',
        organizationId: '33333333-3333-4333-8333-333333333333',
        role: 'MANAGER',
        name: 'Route Manager',
        email: 'route@test.local',
        mustChangePassword: false,
        isActive: true,
        version: 1,
      } as never;
    },
  });
  return app;
}

describe('SALE-002 §4.5 expectedSaleVersion handler allowlists', () => {
  it.each([
    ['submit-for-approval', { note: 'Ziyaret ve satış onaya gönderildi.' }],
    ['approve', { note: null }],
    ['request-revision', { revisionReason: 'Miktar kontrol edilmeli.' }],
    ['withdraw-from-approval', {}],
    ['resume', {}],
  ] as const)('accepts expectedSaleVersion on %s', async (path, extra) => {
    const { service, calls } = stubService();
    const app = await appWith(service);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/job-cards/${jobCardId}/${path}`,
        payload: {
          clientActionId: `pair-${path}`,
          expectedVersion: 4,
          expectedSaleVersion: 2,
          ...extra,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toMatchObject({ expectedVersion: 4, expectedSaleVersion: 2 });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['start', {}],
    ['accept', {}],
    ['decline', { reasonCode: 'ASSIGNMENT_REMOVED', reasonText: 'Atama kaldırıldı.' }],
    ['release', { reasonCode: 'ASSIGNMENT_REMOVED', reasonText: 'Atama kaldırıldı.' }],
    ['cancel', { cancelReason: 'Müşteri vazgeçti.' }],
    ['invalidate', { reasonCode: 'CREATED_BY_MISTAKE', note: null }],
  ] as const)('still rejects expectedSaleVersion on %s', async (path, extra) => {
    const { service, calls } = stubService();
    const app = await appWith(service);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/job-cards/${jobCardId}/${path}`,
        payload: {
          clientActionId: `strict-${path}`,
          expectedVersion: 4,
          expectedSaleVersion: 2,
          ...extra,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('passes the S3 delivery object through the approve allowlist untouched', async () => {
    const { service, calls } = stubService();
    const app = await appWith(service);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/job-cards/${jobCardId}/approve`,
        payload: {
          clientActionId: 'pair-approve-delivery',
          expectedVersion: 4,
          expectedSaleVersion: 2,
          delivery: { assignedTo: jobCardId, scheduledAt: '2026-11-24T07:00:00.000Z' },
        },
      });
      // SALE-002 §5.1: `delivery` is an approve member; the service parses it.
      expect(response.statusCode).toBe(200);
      expect(calls).toEqual([{
        method: 'approve',
        id: jobCardId,
        body: {
          clientActionId: 'pair-approve-delivery',
          expectedVersion: 4,
          expectedSaleVersion: 2,
          delivery: { assignedTo: jobCardId, scheduledAt: '2026-11-24T07:00:00.000Z' },
        },
      }]);
    } finally {
      await app.close();
    }
  });

  it.each(['submitForApproval', 'requestRevision', 'withdrawFromApproval', 'resume', 'start', 'cancel'])(
    'keeps rejecting delivery outside the approve allowlist (%s)',
    async (name) => {
      const { service, calls } = stubService();
      const app = await appWith(service);
      const url = {
        submitForApproval: 'submit-for-approval', requestRevision: 'request-revision',
        withdrawFromApproval: 'withdraw-from-approval', resume: 'resume', start: 'start', cancel: 'cancel',
      }[name]!;
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${jobCardId}/${url}`,
          payload: { clientActionId: 'no-delivery', expectedVersion: 4, delivery: { scheduledAt: 'x' } },
        });
        expect(response.statusCode).toBe(400);
        expect(calls).toHaveLength(0);
      } finally {
        await app.close();
      }
    },
  );
});
