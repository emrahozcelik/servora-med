import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import { toErrorResponse } from '../src/errors/index.js';
import { withSaleFixture } from './support/sale-harness.js';

describe('Sale public write routes', () => {
  it('corrects details and product rows through versioned dedicated routes', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error); return reply.code(response.statusCode).send(response.body);
      });
      await app.register(jobCardRoutes, { prefix: '/api/job-cards', service: f.service,
        authenticate: async (request) => { request.currentUser = { ...f.staff } as never; } });
      try {
        const base = '/api/job-cards/' + sale.jobCardId;
        const details = await app.inject({ method: 'PATCH', url: base + '/sale-details?includeSaleCapability=true',
          payload: { clientActionId: 'details', expectedVersion: 1, saleContactId: null } });
        expect(details.statusCode).toBe(200);
        const item = (await f.service.getSaleDetails(f.staff, sale.jobCardId)).items[0]!;
        const patch = { clientActionId: 'quantity', expectedVersion: 2, quantity: 2 };
        const quantity = await app.inject({ method: 'PATCH', url: base + '/sale-items/' + item.id + '?includeSaleCapability=true', payload: patch });
        expect(quantity.statusCode).toBe(200);
        expect((await app.inject({ method: 'PATCH', url: base + '/sale-items/' + item.id + '?includeSaleCapability=true', payload: patch })).json()).toEqual(quantity.json());
        const removed = await app.inject({ method: 'DELETE', url: base + '/sale-items/' + item.id + '?includeSaleCapability=true',
          payload: { clientActionId: 'remove', expectedVersion: 3 } });
        expect(removed.statusCode).toBe(200);
        const added = await app.inject({ method: 'POST', url: base + '/sale-items?includeSaleCapability=true',
          payload: { clientActionId: 'add', expectedVersion: 4, productId: item.productId, quantity: 15 } });
        expect(added.statusCode).toBe(201);
        expect((await f.service.getSaleDetails(f.staff, sale.jobCardId)).items.find((i) => i.productId === item.productId)?.quantity).toBe('15');
      } finally { await app.close(); }
    });
  });
  it('creates a Sale with exact replay and keeps the source unchanged', async () => {
    await withSaleFixture(async (f) => {
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error); return reply.code(response.statusCode).send(response.body);
      });
      await app.register(jobCardRoutes, { prefix: '/api/job-cards', service: f.service,
        authenticate: async (request) => { request.currentUser = { ...f.staff } as never; } });
      try {
        const url = '/api/job-cards/' + f.visitId + '/sales?includeSaleCapability=true';
        const created = await app.inject({ method: 'POST', url, payload: f.input });
        expect(created.statusCode).toBe(201);
        const replay = await app.inject({ method: 'POST', url, payload: f.input });
        expect(replay.json()).toEqual(created.json());
        const detail = await f.service.getSaleDetails(f.staff, created.json().jobCardId);
        expect(detail.items.map((i) => [i.productId, i.quantity])).toEqual(f.input.items.map((i) => [i.productId, String(i.quantity)]));
        expect((await f.pool.query('SELECT status,version FROM job_cards WHERE id=$1', [f.visitId])).rows[0])
          .toEqual({ status: 'IN_PROGRESS', version: f.input.expectedSourceVersion });
      } finally { await app.close(); }
    });
  });
});

describe('Sale HTTP boundaries and concurrency', () => {
  it('conceals every dedicated correction for legacy, foreign and reassigned actors', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const item = (await f.service.getSaleDetails(f.staff, sale.jobCardId)).items[0]!;
      const foreignOrg = (await f.pool.query("INSERT INTO organizations(name) VALUES ('Foreign HTTP fixture') RETURNING id")).rows[0]!.id;
      const foreign = await f.user('MANAGER', foreignOrg);
      let actor = f.staff;
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => { const r = toErrorResponse(error); return reply.code(r.statusCode).send(r.body); });
      await app.register(jobCardRoutes, { prefix: '/api/job-cards', service: f.service,
        authenticate: async (request) => { request.currentUser = { ...actor } as never; } });
      const routes = [
        ['PATCH','/sale-details',{saleContactId:null}], ['POST','/sale-items',{productId:f.products[0],quantity:1}],
        ['PATCH','/sale-items/'+item.id,{quantity:2}], ['DELETE','/sale-items/'+item.id,{}],
      ] as const;
      const counts = () => f.pool.query('SELECT (SELECT count(*) FROM processed_actions) AS receipts,(SELECT count(*) FROM job_card_activity_logs) AS activities,(SELECT count(*) FROM realtime_events) AS events');
      try {
        const before = await counts();
        for (const viewer of [f.staff, f.otherStaff, foreign]) {
          actor = viewer;
          for (const capability of [false,true]) {
            if (capability && actor.id === f.staff.id) continue;
            for (const [method,suffix,fields] of routes) {
              const response = await app.inject({method,url:'/api/job-cards/'+sale.jobCardId+suffix+(capability?'?includeSaleCapability=true':''),
                payload:{clientActionId:'denied-'+actor.id,expectedVersion:1,...fields}});
              expect(response.statusCode).toBe(404);expect(response.body).not.toContain(sale.jobCardId);
            }
          }
        }
        expect((await counts()).rows).toEqual(before.rows);
        actor = f.otherStaff;
        expect((await app.inject({method:'POST',url:'/api/job-cards/'+f.visitId+'/sales?includeSaleCapability=true',payload:f.input})).statusCode).toBe(404);
        await f.service.patch(f.manager,sale.jobCardId,{expectedVersion:1,assignedTo:f.otherStaff.id});
        actor = f.staff;
        expect((await app.inject({method:'PATCH',url:'/api/job-cards/'+sale.jobCardId+'/sale-items/'+item.id+'?includeSaleCapability=true',payload:{clientActionId:'former',expectedVersion:2,quantity:2}})).statusCode).toBe(404);
      } finally { await app.close(); }
    });
  });
  it('validates exact intent and fractions, races two distinct requests and replays a lost response once', async () => {
    await withSaleFixture(async (f) => {
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => { const r = toErrorResponse(error); return reply.code(r.statusCode).send(r.body); });
      await app.register(jobCardRoutes,{prefix:'/api/job-cards',service:f.service,authenticate:async(request)=>{request.currentUser={...f.staff} as never;}});
      const url='/api/job-cards/'+f.visitId+'/sales?includeSaleCapability=true';
      try {
        for (const quantity of [0,-1,0.001,0.5,1.5,1000000000,'1',null]) {
          const response=await app.inject({method:'POST',url,payload:{...f.input,items:[{productId:f.products[0],quantity}]}});
          expect(response.statusCode).toBe(400);
        }
        for (const field of ['customerId','assignedTo','type','price','sourceJobCardId']) {
          expect((await app.inject({method:'POST',url,payload:{...f.input,[field]:f.customerId}})).statusCode).toBe(400);
        }
        const requests=[{...f.input,clientActionId:'race-a'},{...f.input,clientActionId:'race-b'}];
        const responses=await Promise.all(requests.map((payload)=>app.inject({method:'POST',url,payload})));
        expect(responses.map((r)=>r.statusCode).sort()).toEqual([201,409]);
        const winner=responses.findIndex((r)=>r.statusCode===201);
        // Treat the first committed response as lost; retry the same HTTP intent.
        const replay=await app.inject({method:'POST',url,payload:requests[winner]});
        expect(replay.json()).toEqual(responses[winner]!.json());
        const conflict=await app.inject({method:'POST',url,payload:{...requests[winner],title:'Different intent'}});
        expect(conflict.statusCode).toBe(409);expect(conflict.json().code).toBe('CLIENT_ACTION_REUSED');
        const rows=(await f.pool.query("SELECT type,status,version,source_job_card_id FROM job_cards ORDER BY type")).rows;
        expect(rows).toHaveLength(2);expect(rows.find((r)=>r.type==='SALES_MEETING')).toMatchObject({status:'IN_PROGRESS',version:f.input.expectedSourceVersion});
        expect(rows.find((r)=>r.type==='SALE')?.source_job_card_id).toBeNull();
        expect((await f.pool.query('SELECT count(*)::int AS n FROM job_card_delivery_items')).rows[0]!.n).toBe(0);
        expect((await f.pool.query("SELECT count(*)::int AS n FROM processed_actions WHERE operation_key='SALE_FROM_VISIT_CREATE'")).rows[0]!.n).toBe(1);
      } finally { await app.close(); }
    });
  });
});
