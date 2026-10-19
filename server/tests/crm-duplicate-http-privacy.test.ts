import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { duplicateRoutes } from '../src/modules/crm/duplicate-routes.js';
import { toErrorResponse } from '../src/errors/index.js';

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
