import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { JobCardService } from '../src/modules/job-cards/service.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import { toErrorResponse } from '../src/errors/index.js';
import {
  PostgresJobCardRepository,
  type CriticalActionClaim,
  type CriticalActionResult,
  type CriticalActionWorkResult,
  type JobCardTransaction,
} from '../src/modules/job-cards/repository.js';
import { saleFixture, saleTime, withSaleFixture } from './support/sale-harness.js';

type Fixture = Awaited<ReturnType<typeof saleFixture>>;

function standaloneInput(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    clientActionId: 'standalone-create',
    title: 'Telefon siparişi',
    description: 'Klinik telefonla aradı',
    customerId: f.customerId,
    assignedTo: f.staff.id,
    soldAt: saleTime.toISOString(),
    saleContactId: f.plannedContactId,
    items: [{ productId: f.products[0], quantity: 2 }, { productId: f.products[1], quantity: 5 }],
    ...overrides,
  };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('Standalone sale creation (SALE-002 §6.1)', () => {
  it('creates a standalone SALE with no source snapshots and no source event', async () => {
    await withSaleFixture(async (f) => {
      const visitBefore = (await f.pool.query('SELECT * FROM job_cards WHERE id=$1', [f.visitId])).rows[0];
      const sale = await f.service.createStandaloneSale(f.staff, standaloneInput(f));
      expect(sale.version).toBe(1);
      const root = (await f.pool.query('SELECT * FROM job_cards WHERE id=$1', [sale.jobCardId])).rows[0];
      expect(root).toMatchObject({
        type: 'SALE', status: 'ACCEPTED', title: 'Telefon siparişi',
        customer_id: f.customerId, assigned_to: f.staff.id, created_by: f.staff.id,
        contact_id: null, engagement_kind: null, scheduled_at: null, scheduled_ends_at: null,
        due_date: null, source_job_card_id: null, sale_source_visit_id: null,
        delivery_source_sale_id: null, data_class: 'BUSINESS',
      });
      expect(root.accepted_at).toEqual(saleTime);
      expect(root.accepted_by).toBe(f.staff.id);
      const details = (await f.pool.query(
        'SELECT * FROM job_card_sale_details WHERE job_card_id=$1', [sale.jobCardId],
      )).rows[0];
      expect(details).toMatchObject({
        sold_at: saleTime, sale_contact_id: f.plannedContactId,
        sale_contact_name_snapshot: 'Planned doctor', sale_contact_title_snapshot: 'Dr.',
        source_visit_version: null, source_visit_title_snapshot: null,
        source_customer_name_snapshot: null, source_planned_contact_id: null,
        source_planned_contact_name_snapshot: null, source_planned_contact_title_snapshot: null,
        source_met_contact_id: null, source_met_contact_name_snapshot: null,
        source_met_contact_title_snapshot: null,
      });
      const items = (await f.pool.query(
        `SELECT product_id,quantity::text,product_name_snapshot,unit_snapshot
           FROM job_card_sale_items WHERE job_card_id=$1 ORDER BY sort_order`, [sale.jobCardId],
      )).rows;
      expect(items).toEqual([
        { product_id: f.products[0], quantity: '2.000', product_name_snapshot: 'Matrix set', unit_snapshot: null },
        { product_id: f.products[1], quantity: '5.000', product_name_snapshot: 'Bonding liquid', unit_snapshot: 'ml' },
      ]);
      expect((await f.pool.query(
        `SELECT event_type FROM job_card_activity_logs WHERE job_card_id=$1`,
        [sale.jobCardId],
      )).rows.map((row) => row.event_type).sort())
        .toEqual(['JOB_CREATED', 'SALE_ITEM_ADDED', 'SALE_ITEM_ADDED']);
      expect((await f.pool.query('SELECT * FROM job_cards WHERE id=$1', [f.visitId])).rows[0])
        .toEqual(visitBefore);
      expect((await f.pool.query(
        `SELECT COUNT(*)::int AS n FROM job_card_activity_logs WHERE event_type='SALE_FROM_VISIT_CREATED'`,
      )).rows[0].n).toBe(0);
    });
  });

  it('lets management assign another active STAFF member and creates NEW', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createStandaloneSale(f.manager,
        standaloneInput(f, { assignedTo: f.otherStaff.id, clientActionId: 'standalone-manager' }));
      const root = (await f.pool.query(
        'SELECT status,assigned_to,created_by,accepted_at,accepted_by FROM job_cards WHERE id=$1',
        [sale.jobCardId],
      )).rows[0];
      expect(root).toEqual({
        status: 'NEW', assigned_to: f.otherStaff.id, created_by: f.manager.id,
        accepted_at: null, accepted_by: null,
      });
    });
  });

  it('forbids STAFF from creating for another STAFF member without writing anything', async () => {
    await withSaleFixture(async (f) => {
      await expect(f.service.createStandaloneSale(f.staff, standaloneInput(f, {
        assignedTo: f.otherStaff.id, clientActionId: 'standalone-foreign-assignee',
      }))).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      expect((await f.pool.query(`SELECT COUNT(*)::int AS n FROM job_cards WHERE type='SALE'`)).rows[0].n).toBe(0);
      expect((await f.pool.query(
        `SELECT COUNT(*)::int AS n FROM processed_actions WHERE operation_key='SALE_STANDALONE_CREATE'`,
      )).rows[0].n).toBe(0);
    });
  });

  it('maps every reference/sold-time rejection to its existing domain error', async () => {
    await withSaleFixture(async (f) => {
      const otherCustomer = (await f.pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id,name,customer_type,status)
         VALUES ($1,'Other clinic','clinic','active') RETURNING id`, [f.organizationId],
      )).rows[0]!.id;
      const foreignContact = (await f.pool.query<{ id: string }>(
        `INSERT INTO contacts (organization_id,customer_id,name) VALUES ($1,$2,'Other doctor') RETURNING id`,
        [f.organizationId, otherCustomer],
      )).rows[0]!.id;
      const demoDataset = (await f.pool.query<{ id: string }>(
        `INSERT INTO demo_datasets (organization_id,dataset_key,seed_version,created_by)
         VALUES ($1,'standalone-policy','v1',$2) RETURNING id`, [f.organizationId, f.admin.id],
      )).rows[0]!.id;
      const cases: Array<[string, Record<string, unknown>, string, number]> = [
        ['unknown key', { type: 'SALE' }, 'VALIDATION_ERROR', 400],
        ['missing customer', { customerId: '00000000-0000-4000-8000-0000000000ff' }, 'CUSTOMER_NOT_FOUND', 404],
        ['future sold time', { soldAt: new Date(saleTime.valueOf() + 16 * 60_000).toISOString() }, 'SALE_TIME_INVALID', 400],
        ['foreign contact', { saleContactId: foreignContact }, 'CONTACT_NOT_IN_CUSTOMER', 409],
      ];
      // Each case gets a unique key and its own thrown AppError.
      for (const [label, overrides, code, statusCode] of cases) {
        await expect(f.service.createStandaloneSale(f.staff, standaloneInput(f, {
          ...overrides, clientActionId: 'standalone-error-' + label,
        })), label).rejects.toMatchObject({ code, statusCode });
      }
      // DEMO product is switched on only for its own case.
      await f.pool.query(
        `UPDATE products SET data_class='DEMO',demo_dataset_id=$2 WHERE id=$1`, [f.products[1], demoDataset],
      );
      await expect(f.service.createStandaloneSale(f.staff, standaloneInput(f, {
        clientActionId: 'standalone-error-demo-product',
        items: [{ productId: f.products[1], quantity: 1 }],
      }))).rejects.toMatchObject({ code: 'SALE_REFERENCE_NOT_ELIGIBLE', statusCode: 409 });
      await f.pool.query(
        `UPDATE products SET data_class='BUSINESS',demo_dataset_id=NULL WHERE id=$1`, [f.products[1]],
      );
      await f.pool.query(`UPDATE products SET is_active=false WHERE id=$1`, [f.products[1]]);
      await expect(f.service.createStandaloneSale(f.staff, standaloneInput(f, {
        clientActionId: 'standalone-error-inactive-product',
        items: [{ productId: f.products[1], quantity: 1 }],
      }))).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND', statusCode: 404 });
      await f.pool.query(`UPDATE products SET is_active=true WHERE id=$1`, [f.products[1]]);
      await f.pool.query(`UPDATE contacts SET is_active=false WHERE id=$1`, [f.plannedContactId]);
      await expect(f.service.createStandaloneSale(f.staff, standaloneInput(f, {
        clientActionId: 'standalone-error-inactive-contact',
      }))).rejects.toMatchObject({ code: 'CONTACT_INACTIVE', statusCode: 409 });
      await f.pool.query(`UPDATE contacts SET is_active=true WHERE id=$1`, [f.plannedContactId]);
      await f.pool.query(`UPDATE customers SET status='inactive' WHERE id=$1`, [f.customerId]);
      await expect(f.service.createStandaloneSale(f.staff, standaloneInput(f, {
        clientActionId: 'standalone-error-inactive-customer',
      }))).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE', statusCode: 409 });
      await f.pool.query(`UPDATE customers SET status='active' WHERE id=$1`, [f.customerId]);
      await f.pool.query(
        `UPDATE customers SET data_class='DEMO',demo_dataset_id=$2 WHERE id=$1`, [f.customerId, demoDataset],
      );
      await expect(f.service.createStandaloneSale(f.staff, standaloneInput(f, {
        clientActionId: 'standalone-error-demo-customer',
      }))).rejects.toMatchObject({ code: 'SALE_REFERENCE_NOT_ELIGIBLE', statusCode: 409 });
      await f.pool.query(
        `UPDATE customers SET data_class='BUSINESS',demo_dataset_id=NULL WHERE id=$1`, [f.customerId],
      );
      expect((await f.pool.query(`SELECT COUNT(*)::int AS n FROM job_cards WHERE type='SALE'`)).rows[0].n).toBe(0);
    });
  });

  it('replays the original receipt and rejects a changed payload under the same key', async () => {
    await withSaleFixture(async (f) => {
      const first = await f.service.createStandaloneSale(f.staff,
        standaloneInput(f, { clientActionId: 'standalone-replay' }));
      const replay = await f.service.createStandaloneSale(f.staff,
        standaloneInput(f, { clientActionId: 'standalone-replay' }));
      expect(replay).toEqual(first);
      await expect(f.service.createStandaloneSale(f.staff,
        standaloneInput(f, { clientActionId: 'standalone-replay', title: 'Değişik başlık' })))
        .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      const counts = (await f.pool.query(`SELECT
        (SELECT COUNT(*)::int FROM job_cards WHERE type='SALE') AS jobs,
        (SELECT COUNT(*)::int FROM job_card_sale_details) AS details,
        (SELECT COUNT(*)::int FROM job_card_sale_items) AS items,
        (SELECT COUNT(*)::int FROM job_card_activity_logs
          WHERE job_card_id=$1 AND event_type='JOB_CREATED') AS created,
        (SELECT COUNT(*)::int FROM processed_actions WHERE operation_key='SALE_STANDALONE_CREATE') AS receipts`,
      [first.jobCardId])).rows[0];
      expect(counts).toEqual({ jobs: 1, details: 1, items: 2, created: 1, receipts: 1 });
    });
  });

  it('allows multiple standalone sales while leaving the visit slot index untouched', async () => {
    await withSaleFixture(async (f) => {
      const first = await f.service.createStandaloneSale(f.staff,
        standaloneInput(f, { clientActionId: 'standalone-multi-1' }));
      const second = await f.service.createStandaloneSale(f.staff,
        standaloneInput(f, { clientActionId: 'standalone-multi-2' }));
      expect(second.jobCardId).not.toBe(first.jobCardId);
      expect((await f.pool.query(`SELECT COUNT(*)::int AS n FROM job_cards WHERE type='SALE'`)).rows[0].n).toBe(2);
    });
  });

  it('submits a standalone sale once started (SALE_ORIGIN_VALID is met without a source)', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createStandaloneSale(f.staff,
        standaloneInput(f, { clientActionId: 'standalone-submit-create' }));
      const started = await f.service.start(f.staff, sale.jobCardId, {
        clientActionId: 'standalone-submit-start', expectedVersion: 1,
      });
      await f.service.submitForApproval(f.staff, sale.jobCardId, {
        clientActionId: 'standalone-submit', expectedVersion: started.version, note: 'Telefon siparişi hazır',
      });
      expect((await f.pool.query('SELECT status FROM job_cards WHERE id=$1', [sale.jobCardId])).rows[0].status)
        .toBe('WAITING_APPROVAL');
    });
  });

  it('rejects a source-linked sale whose source is no longer a visit', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId,
        { ...f.input, clientActionId: 'source-gone-create' });
      const started = await f.service.start(f.staff, sale.jobCardId, {
        clientActionId: 'source-gone-start', expectedVersion: 1,
      });
      // A terminal non-visit source: no live pair, so the sale reaches its own
      // readiness check, where SALE_ORIGIN_VALID is the failing item (R4).
      await f.pool.query(
        `UPDATE job_cards SET type='GENERAL_TASK',engagement_kind=NULL,status='COMPLETED',
           staff_completed_at=$2,staff_completed_by=$3,
           manager_approved_at=$2,manager_approved_by=$3 WHERE id=$1`,
        [f.visitId, saleTime, f.manager.id],
      );
      await expect(f.service.submitForApproval(f.staff, sale.jobCardId, {
        clientActionId: 'source-gone-submit', expectedVersion: started.version, note: 'Hazır',
      })).rejects.toMatchObject({ code: 'SALE_NOT_READY', statusCode: 400 });
    });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Sale from a completed visit (SALE-002 §6.2)', () => {
  it('creates the retro sale with source snapshots, blocks a second active slot, and allows one after cancellation', async () => {
    await withSaleFixture(async (f) => {
      await f.pool.query(
        `UPDATE job_cards SET status='COMPLETED',
           staff_completed_at=$2,staff_completed_by=$3,
           manager_approved_at=$2,manager_approved_by=$3 WHERE id=$1`,
        [f.visitId, saleTime, f.manager.id],
      );
      const visitBefore = (await f.pool.query('SELECT * FROM job_cards WHERE id=$1', [f.visitId])).rows[0];
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId,
        { ...f.input, clientActionId: 'retro-sale-1' });
      const root = (await f.pool.query('SELECT * FROM job_cards WHERE id=$1', [sale.jobCardId])).rows[0];
      expect(root).toMatchObject({ type: 'SALE', status: 'ACCEPTED', sale_source_visit_id: f.visitId });
      const details = (await f.pool.query(
        'SELECT * FROM job_card_sale_details WHERE job_card_id=$1', [sale.jobCardId],
      )).rows[0];
      expect(details).toMatchObject({
        source_visit_version: f.input.expectedSourceVersion,
        source_visit_title_snapshot: 'Clinic visit',
        source_customer_name_snapshot: 'Dental Klinik',
      });
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId,
        { ...f.input, clientActionId: 'retro-sale-2' }))
        .rejects.toMatchObject({ code: 'SALE_FROM_VISIT_ACTIVE_EXISTS', statusCode: 409 });
      expect((await f.pool.query(`SELECT COUNT(*)::int AS n FROM job_cards WHERE type='SALE'`)).rows[0].n).toBe(1);
      await f.service.cancel(f.manager, sale.jobCardId, {
        clientActionId: 'retro-sale-cancel', expectedVersion: 1, cancelReason: 'Retro kayıt iptali',
      });
      const replacement = await f.service.createSaleFromVisit(f.staff, f.visitId,
        { ...f.input, clientActionId: 'retro-sale-3' });
      expect(replacement.jobCardId).not.toBe(sale.jobCardId);
      expect((await f.pool.query('SELECT * FROM job_cards WHERE id=$1', [f.visitId])).rows[0])
        .toEqual(visitBefore);
      expect((await f.pool.query(
        `SELECT COUNT(*)::int AS n FROM job_card_activity_logs
          WHERE job_card_id=$1 AND event_type='SALE_FROM_VISIT_CREATED'`, [f.visitId],
      )).rows[0].n).toBe(2);
    });
  });

  it('still rejects a cancelled visit source', async () => {
    await withSaleFixture(async (f) => {
      await f.service.cancel(f.manager, f.visitId, {
        clientActionId: 'visit-cancel-before-retro', expectedVersion: f.input.expectedSourceVersion,
        cancelReason: 'Ziyaret iptal',
      });
      const cancelled = (await f.pool.query<{ version: number }>(
        'SELECT version FROM job_cards WHERE id=$1', [f.visitId],
      )).rows[0]!.version;
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId,
        { ...f.input, expectedSourceVersion: cancelled, clientActionId: 'retro-cancelled' }))
        .rejects.toMatchObject({ code: 'SALE_FROM_VISIT_SOURCE_NOT_ELIGIBLE', statusCode: 409 });
      expect((await f.pool.query(`SELECT COUNT(*)::int AS n FROM job_cards WHERE type='SALE'`)).rows[0].n).toBe(0);
    });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Standalone sale HTTP route', () => {
  it('returns 201 with the receipt, replays, serializes the standalone origin and isolates tenants', async () => {
    await withSaleFixture(async (f) => {
      let actor = f.staff;
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error);
        return reply.code(response.statusCode).send(response.body);
      });
      await app.register(jobCardRoutes, {
        prefix: '/api/job-cards', service: f.service,
        authenticate: async (request) => { request.currentUser = { ...actor } as never; },
      });
      try {
        const created = await app.inject({
          method: 'POST', url: '/api/job-cards/sales', payload: standaloneInput(f, { clientActionId: 'http-standalone' }),
        });
        expect(created.statusCode).toBe(201);
        const receipt = created.json() as { jobCardId: string; version: number };
        expect(receipt).toEqual({ jobCardId: expect.any(String), version: 1 });
        const replayed = await app.inject({
          method: 'POST', url: '/api/job-cards/sales', payload: standaloneInput(f, { clientActionId: 'http-standalone' }),
        });
        expect(replayed.statusCode).toBe(201);
        expect(replayed.json()).toEqual(receipt);
        const detail = await app.inject({
          method: 'GET', url: '/api/job-cards/' + receipt.jobCardId + '/sale-details?includeSaleCapability=true',
        });
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toMatchObject({
          jobCardId: receipt.jobCardId,
          sourceVisit: { kind: 'STANDALONE' },
        });
        const invalid = await app.inject({
          method: 'POST', url: '/api/job-cards/sales',
          payload: { ...standaloneInput(f, { clientActionId: 'http-standalone-invalid' }), type: 'SALE' },
        });
        expect(invalid.statusCode).toBe(400);
        const foreignOrg = (await f.pool.query<{ id: string }>(
          `INSERT INTO organizations (name) VALUES ('HTTP foreign SALE-002') RETURNING id`,
        )).rows[0]!.id;
        actor = await f.user('MANAGER', foreignOrg);
        const foreignStaff = await f.user('STAFF', foreignOrg);
        const foreign = await app.inject({
          method: 'POST', url: '/api/job-cards/sales',
          payload: standaloneInput(f, { clientActionId: 'http-standalone-foreign', assignedTo: foreignStaff.id }),
        });
        expect(foreign.statusCode).toBe(404);
        expect(foreign.body).not.toContain(f.customerId);
      } finally {
        await app.close();
      }
    });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Standalone sale read and realtime projections', () => {
  it('projects the standalone origin instead of the restricted source message', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createStandaloneSale(f.staff,
        standaloneInput(f, { clientActionId: 'standalone-read' }));
      for (const viewer of [f.staff, f.manager, f.admin]) {
        const detail = await f.service.getSaleDetails(viewer, sale.jobCardId);
        expect(detail.sourceVisit).toEqual({ kind: 'STANDALONE' });
        expect(detail.jobCardId).toBe(sale.jobCardId);
        expect(detail.items.map((item) => item.quantity)).toEqual(['2', '5']);
      }
      await expect(f.service.getSaleDetails(f.otherStaff, sale.jobCardId))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('never looks up a source visit for a standalone sale realtime event', async () => {
    await withSaleFixture(async (f) => {
      const repository = new RecordingRepository(f.pool);
      const service = new JobCardService(repository, () => saleTime);
      await service.createStandaloneSale(f.staff,
        standaloneInput(f, { clientActionId: 'standalone-realtime' }));
      expect(repository.jobLookups).not.toContain(null);
      expect(repository.jobLookups).toEqual([]);
      await service.createSaleFromVisit(f.staff, f.visitId,
        { ...f.input, clientActionId: 'standalone-realtime-visit-sale' });
      expect(repository.jobLookups).toContain(f.visitId);
    });
  });
});

class RecordingRepository extends PostgresJobCardRepository {
  readonly jobLookups: Array<string | null> = [];

  override async executeCriticalAction<T>(
    claim: CriticalActionClaim,
    work: (transaction: JobCardTransaction) => Promise<CriticalActionWorkResult<T>>,
  ): Promise<CriticalActionResult<T>> {
    return super.executeCriticalAction(claim, (transaction) => work(new Proxy(transaction, {
      get: (target, property, receiver) => {
        if (property === 'getJob') {
          return (organizationId: string, jobCardId: string | null) => {
            this.jobLookups.push(jobCardId);
            return target.getJob(organizationId, jobCardId);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
  }
}
