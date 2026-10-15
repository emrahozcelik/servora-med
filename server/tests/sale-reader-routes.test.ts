import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import { toErrorResponse } from '../src/errors/index.js';
import { withSaleFixture } from './support/sale-harness.js';
import { parseWeeklyReportCreateInput } from '../src/modules/weekly-reports/create-input.js';

describe('Sale capability on public readers', () => {
  it('keeps normal JobCard, meeting, delivery and weekly read shapes identical with either capability', async () => {
    await withSaleFixture(async (f) => {
      const ids = [f.visitId];
      for (const type of ['GENERAL_TASK', 'PRODUCT_DELIVERY'] as const) {
        ids.push((await f.service.create(f.staff, { clientActionId: 'normal-' + type, type, title: type,
          customerId: f.customerId, contactId: null, assignedTo: f.staff.id, description: null,
          priority: 'normal', dueDate: null, scheduledAt: type === 'PRODUCT_DELIVERY' ? '2026-10-15T11:00:00.000Z' : null })).id);
      }
      ids.push((await f.service.createWeeklyReport(f.staff,
        parseWeeklyReportCreateInput({ clientActionId: 'normal-weekly', periodStart: '2026-10-12' }))).jobCardId);
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error); return reply.code(response.statusCode).send(response.body);
      });
      await app.register(jobCardRoutes, { prefix: '/api/job-cards', service: f.service,
        authenticate: async (request) => { request.currentUser = { ...f.manager } as never; } });
      try {
        for (const id of ids) for (const suffix of ['', '/notes', '/activity', '/submission-lateness', '/overdue-incidents']) {
          const legacy = await app.inject('/api/job-cards/' + id + suffix);
          const current = await app.inject('/api/job-cards/' + id + suffix + '?includeSaleCapability=true');
          expect(legacy.statusCode).toBe(200);
          expect(current.statusCode).toBe(200);
          expect(current.json()).toEqual(legacy.json());
        }
      } finally { await app.close(); }
    });
  });
  it('preserves opted-in Sale permissions and conceals inaccessible subresources after reassignment', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      await f.service.patch(f.manager, sale.jobCardId, { expectedVersion: 1, assignedTo: f.otherStaff.id });
      const foreignOrg = (await f.pool.query<{ id: string }>("INSERT INTO organizations(name) VALUES ('Foreign review org') RETURNING id")).rows[0]!.id;
      const foreignManager = await f.user('MANAGER', foreignOrg);
      const foreignStaff = await f.user('STAFF', foreignOrg);
      const unrelated = await f.user('STAFF');
      let actor = f.otherStaff;
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error); return reply.code(response.statusCode).send(response.body);
      });
      await app.register(jobCardRoutes, { prefix: '/api/job-cards', service: f.service,
        authenticate: async (request) => { request.currentUser = { ...actor } as never; } });
      try {
        const accepted = await app.inject({ method: 'POST', url: '/api/job-cards/' + sale.jobCardId + '/accept?includeSaleCapability=true',
          payload: { clientActionId: 'review-sale-accept', expectedVersion: 2 } });
        expect(accepted.statusCode).toBe(200);
        for (const viewer of [f.otherStaff, f.manager, f.admin, f.staff, unrelated, foreignManager, foreignStaff]) {
          actor = viewer;
          const allowed = [f.otherStaff.id, f.manager.id, f.admin.id].includes(viewer.id);
          for (const suffix of ['', '/activity', '/notes', '/submission-lateness', '/overdue-incidents']) {
            const response = await app.inject('/api/job-cards/' + sale.jobCardId + suffix + '?includeSaleCapability=true');
            const expected = !allowed ? 404 : suffix === '/overdue-incidents' && actor.role === 'STAFF' ? 403 : 200;
            expect.soft(response.statusCode, actor.role + ' ' + actor.id + suffix).toBe(expected);
            if (!allowed) expect.soft(response.body).not.toContain(sale.jobCardId);
          }
          const note = await app.inject({ method: 'POST', url: '/api/job-cards/' + sale.jobCardId + '/notes?includeSaleCapability=true',
            payload: { clientActionId: 'review-note-' + actor.id, note: 'Historical quantities reviewed' } });
          expect.soft(note.statusCode).toBe(allowed ? 201 : 404);
          if (!allowed) expect.soft(note.body).not.toContain(sale.jobCardId);
          const reminder = await app.inject({ method: 'POST', url: '/api/job-cards/' + sale.jobCardId + '/submission-reminder?includeSaleCapability=true',
            payload: { clientActionId: 'review-reminder-' + actor.id, expectedVersion: 3 } });
          expect.soft(reminder.statusCode).toBe(!allowed ? 404 : actor.role === 'STAFF' ? 403 : 409);
          if (!allowed) expect.soft(reminder.body).not.toContain(sale.jobCardId);
        }
        actor = f.otherStaff;
        const started = await app.inject({ method: 'POST', url: '/api/job-cards/' + sale.jobCardId + '/start?includeSaleCapability=true',
          payload: { clientActionId: 'review-sale-start', expectedVersion: 3 } });
        expect(started.statusCode).toBe(200);
        expect(started.json()).toMatchObject({ type: 'SALE', status: 'IN_PROGRESS' });
        expect((await f.pool.query('SELECT status,version FROM job_cards WHERE id=$1', [f.visitId])).rows[0])
          .toEqual({ status: 'IN_PROGRESS', version: f.input.expectedSourceVersion });
      } finally { await app.close(); }
    });
  });
  it('conceals every direct Sale route from legacy clients before reads or writes', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error); return reply.code(response.statusCode).send(response.body);
      });
      await app.register(jobCardRoutes, { prefix: '/api/job-cards', service: f.service,
        authenticate: async (request) => { request.currentUser = { ...f.staff } as never; } });
      const routes = [
        ['GET', ''], ['HEAD', ''], ['PATCH', ''], ['GET', '/activity'], ['HEAD', '/activity'], ['GET', '/notes'], ['POST', '/notes'],
        ['GET', '/submission-lateness'], ['GET', '/overdue-incidents'], ['POST', '/submission-reminder'],
        ['GET', '/weekly-report'], ['PATCH', '/weekly-report'], ['GET', '/weekly-report/submissions'],
        ['GET', '/weekly-report/submissions/1/pdf'], ['GET', '/follow-ups'], ['POST', '/follow-ups'],
        ['GET', '/follow-up-suggestion'], ['GET', '/meeting-details'], ['PATCH', '/meeting-details'],
        ['GET', '/delivery-items'], ['POST', '/delivery-items'],
        ['PATCH', '/delivery-items/' + f.products[0]], ['DELETE', '/delivery-items/' + f.products[0]],
        ...['accept', 'start', 'submit-for-approval', 'approve', 'request-revision',
          'withdraw-from-approval', 'resume', 'cancel', 'invalidate'].map((command) => ['POST', '/' + command]),
        ['GET', '/sale-details'], ['GET', '/sale-create-context'], ['GET', '/sales'],
      ] as const;
      const effectCounts = 'SELECT (SELECT count(*)::int FROM job_card_notes WHERE job_card_id=$1) AS notes, '
        + '(SELECT count(*)::int FROM realtime_events) AS events, (SELECT count(*)::int FROM processed_actions) AS receipts';
      const before = await f.pool.query(effectCounts, [sale.jobCardId]);
      try {
        for (const [method, suffix] of routes) {
          const response = await app.inject({ method: method as 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE',
            url: '/api/job-cards/' + sale.jobCardId + suffix,
            ...(method === 'GET' || method === 'HEAD' ? {} : { payload: { clientActionId: 'legacy-sale-note', note: 'Must be concealed' } }),
          });
          expect.soft(response.statusCode, method + ' ' + suffix).toBe(404);
          expect.soft(response.body, method + ' ' + suffix).not.toContain(sale.jobCardId);
        }
        const after = await f.pool.query(effectCounts, [sale.jobCardId]);
        expect(after.rows).toEqual(before.rows);
      } finally { await app.close(); }
    });
  });
  it('keeps legacy list totals and detail safe, while opted-in GET readers expose Sale', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error); return reply.code(response.statusCode).send(response.body);
      });
      await app.register(jobCardRoutes, { prefix: '/api/job-cards', service: f.service,
        authenticate: async (request) => { request.currentUser = { ...f.staff } as never; } });
      try {
        const legacy = (await app.inject('/api/job-cards?status=all&limit=1')).json();
        expect(legacy.total).toBe(1);
        expect(legacy.items.every((item: { type: string }) => item.type !== 'SALE')).toBe(true);
        expect((await app.inject('/api/job-cards/' + sale.jobCardId)).statusCode).toBe(404);
        const current = (await app.inject('/api/job-cards?status=all&includeSaleCapability=true')).json();
        expect(current.total).toBe(2);
        expect(current.items.some((item: { type: string }) => item.type === 'SALE')).toBe(true);
        const detail = await app.inject('/api/job-cards/' + sale.jobCardId + '/sale-details?includeSaleCapability=true');
        expect(detail.statusCode).toBe(200);
        expect(detail.json().items[1].quantity).toBe('15');
        const oldActivity = (await app.inject('/api/job-cards/' + f.visitId + '/activity')).json();
        expect(oldActivity.items.some((item: { eventType: string }) => item.eventType === 'SALE_FROM_VISIT_CREATED')).toBe(false);
        const newActivity = (await app.inject('/api/job-cards/' + f.visitId + '/activity?includeSaleCapability=true')).json();
        expect(newActivity.items.find((item: { eventType: string }) => item.eventType === 'SALE_FROM_VISIT_CREATED').details).toEqual({ kind: 'SALE_RELATION' });
        expect((await app.inject({ method: 'POST', url: '/api/job-cards/' + f.visitId + '/sales', payload: f.input })).statusCode).toBe(404);
      } finally { await app.close(); }
    });
  });
});
