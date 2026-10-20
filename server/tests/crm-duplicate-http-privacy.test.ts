import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { duplicateRoutes } from '../src/modules/crm/duplicate-routes.js';
import { AppError, toErrorResponse } from '../src/errors/index.js';

it('API-9: does not copy cursor values or query overrides into automatic HTTP request logs', async () => {
  let logs = '';
  const app = Fastify({ logger: { level: 'info', stream: new Writable({ write(chunk, _encoding, callback) { logs += chunk; callback(); } }) } });
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((error, _request, reply) => { const result = toErrorResponse(error); reply.code(result.statusCode).send(result.body); });
  await app.register(duplicateRoutes, { prefix: '/api', service: { candidates: async () => ({ items: [] }) } as never,
    authenticate: async (request) => { request.currentUser = { id: 'actor', organizationId: 'org', role: 'ADMIN' } as never; } });
  try {
    await app.inject('/api/customers/duplicate-candidates?cursor=synthetic-sensitive-cursor');
    expect(logs).not.toContain('synthetic-sensitive-cursor');
    expect(logs).toContain('/api/customers/duplicate-candidates');
  } finally { await app.close(); }
});

it('F18/SEC-04: command routes reject every query before source or receipt work and preserve auth precedence', async () => {
  const decide = vi.fn(async () => ({ receipt: { reviewVersion: 1 }, replayed: false }));
  const reopen = vi.fn(async () => ({ receipt: { reviewVersion: 2 }, replayed: false }));
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((error, _request, reply) => { const result = toErrorResponse(error); reply.code(result.statusCode).send(result.body); });
  await app.register(duplicateRoutes, { prefix: '/api', service: {} as never, reviewService: { decide, reopen } as never,
    authenticate: async (request) => {
      if (!request.headers['x-role']) throw new AppError('UNAUTHENTICATED', 401, 'Oturum açın.');
      request.currentUser = { id: randomUUID(), organizationId: randomUUID(), role: request.headers['x-role'] } as never;
    } });
  const common = { clientActionId: randomUUID(), expectedReviewVersion: 0,
    expectedEvidenceRevision: 'ev1.synthetic.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', matchingRuleVersion: 'crm-duplicate-v1' };
  try {
    for (const route of ['decisions', 'reopen']) {
      const payload = route === 'decisions' ? { ...common, decision: 'DISMISSED', reasonCode: 'DISTINCT_BRANCH' } : common;
      for (const query of ['organizationId=foreign', 'force=true', 'force=true&force=false', 'unknown=x', 'actor=other']) {
        for (const [role, status] of [[undefined, 401], ['STAFF', 403], ['MANAGER', 400]] as const) {
          const response = await app.inject({ method: 'POST',
            url: `/api/customers/duplicate-review-pairs/10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/${route}?${query}`,
            headers: role ? { 'x-role': role } : {}, payload });
          expect(response.statusCode, `${route}?${query} ${role}`).toBe(status);
          expect(response.headers['cache-control']).toBe('no-store');
          if (status === 400) expect(response.json().code).toBe('VALIDATION_ERROR');
        }
      }
    }
    expect(decide).not.toHaveBeenCalled(); expect(reopen).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
