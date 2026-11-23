import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { saleFixture, saleTime, withSaleFixture } from './support/sale-harness.js';

/**
 * SALE-002 slice S1 acceptance — standalone sale creation over HTTP.
 * Owning contract: docs/features/visit-to-sale/sale-002-contract.md §6.1, §9.3.
 *
 * The route, the strict body allowlist, the status rule, the source-free
 * details shape and the idempotency contract are all named by the contract.
 * Nothing here reaches into implementation modules beyond the existing test
 * harness (JobCardService/PostgresJobCardRepository/routes).
 */

type Fixture = Awaited<ReturnType<typeof saleFixture>>;
type App = ReturnType<typeof Fastify>;

const STANDALONE_URL = '/api/job-cards/sales?includeSaleCapability=true';

function standaloneBody(fixture: Fixture, clientActionId: string, overrides: Record<string, unknown> = {}) {
  return {
    clientActionId,
    title: 'Telefon siparişi — Matrix set',
    description: 'Klinik telefonla sipariş verdi.',
    customerId: fixture.customerId,
    assignedTo: fixture.staff.id,
    soldAt: saleTime.toISOString(),
    saleContactId: fixture.metContactId,
    items: [
      { productId: fixture.products[0]!, quantity: 3 },
      { productId: fixture.products[1]!, quantity: 1 },
    ],
    ...overrides,
  };
}

async function withApp(
  fixture: Fixture,
  actor: () => JobCardActor,
  run: (app: App) => Promise<void>,
  service: JobCardService = fixture.service,
): Promise<void> {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    return reply.code(response.statusCode).send(response.body);
  });
  await app.register(jobCardRoutes, {
    prefix: '/api/job-cards',
    service,
    authenticate: async (request) => {
      request.currentUser = { ...actor() } as never;
    },
  });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

/** Service whose repository records every getJob call, to prove the R21 guard. */
function serviceRecordingGetJob(fixture: Fixture) {
  const calls: unknown[][] = [];
  const repository = new PostgresJobCardRepository(fixture.pool);
  const proxy = new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'getJob') {
        return (...args: unknown[]) => {
          calls.push(args);
          return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...callArgs: unknown[]) => unknown).bind(target);
    },
  });
  return { service: new JobCardService(proxy as never, () => saleTime), calls };
}

async function count(pool: Fixture['pool'], sql: string, values: unknown[] = []): Promise<number> {
  return (await pool.query<{ n: number }>(sql, values)).rows[0]!.n;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S1 standalone sale creation', () => {
  it('creates one source-free accepted sale with details, items, activity and no side effects', async () => {
    await withSaleFixture(async (f) => {
      const visitBefore = (await f.pool.query('SELECT * FROM job_cards WHERE id = $1', [f.visitId])).rows[0];
      const realtimeBefore = await count(f.pool, 'SELECT count(*)::int AS n FROM realtime_events');
      const { service, calls } = serviceRecordingGetJob(f);
      const body = standaloneBody(f, 's1-standalone-create');

      await withApp(f, () => f.staff, async (app) => {
        const created = await app.inject({ method: 'POST', url: STANDALONE_URL, payload: body });
        expect(created.statusCode).toBe(201);
        expect(created.json()).toEqual({ jobCardId: expect.any(String), version: 1 });
        const saleId = created.json().jobCardId as string;

        const root = (await f.pool.query(
          `SELECT type, status, version, data_class, customer_id, assigned_to, created_by,
                  sale_source_visit_id, source_job_card_id, scheduled_at, scheduled_ends_at,
                  due_date, contact_id, title, description, accepted_at, accepted_by,
                  manager_approved_at
             FROM job_cards WHERE id = $1`,
          [saleId],
        )).rows[0];
        expect(root).toMatchObject({
          type: 'SALE',
          status: 'ACCEPTED',
          version: 1,
          data_class: 'BUSINESS',
          customer_id: f.customerId,
          assigned_to: f.staff.id,
          created_by: f.staff.id,
          sale_source_visit_id: null,
          source_job_card_id: null,
          scheduled_at: null,
          scheduled_ends_at: null,
          due_date: null,
          contact_id: null,
          title: 'Telefon siparişi — Matrix set',
          description: 'Klinik telefonla sipariş verdi.',
          accepted_by: f.staff.id,
          manager_approved_at: null,
        });
        expect(root.accepted_at).not.toBeNull();

        // S1 only ships the source-free shape; no snapshot is fabricated.
        const details = (await f.pool.query(
          `SELECT sold_at, sale_contact_id, sale_contact_name_snapshot,
                  source_visit_version, source_visit_title_snapshot,
                  source_customer_name_snapshot, source_planned_contact_id,
                  source_planned_contact_name_snapshot, source_planned_contact_title_snapshot,
                  source_met_contact_id, source_met_contact_name_snapshot,
                  source_met_contact_title_snapshot
             FROM job_card_sale_details WHERE job_card_id = $1`,
          [saleId],
        )).rows[0];
        expect(details).toMatchObject({
          sale_contact_id: f.metContactId,
          sale_contact_name_snapshot: 'Actual doctor',
          source_visit_version: null,
          source_visit_title_snapshot: null,
          source_customer_name_snapshot: null,
          source_planned_contact_id: null,
          source_planned_contact_name_snapshot: null,
          source_planned_contact_title_snapshot: null,
          source_met_contact_id: null,
          source_met_contact_name_snapshot: null,
          source_met_contact_title_snapshot: null,
        });
        expect(new Date(details.sold_at).toISOString()).toBe(saleTime.toISOString());

        const items = (await f.pool.query(
          `SELECT product_id, quantity::text AS quantity, product_name_snapshot, sort_order
             FROM job_card_sale_items WHERE job_card_id = $1 ORDER BY sort_order`,
          [saleId],
        )).rows;
        expect(items).toEqual([
          { product_id: f.products[0], quantity: '3.000', product_name_snapshot: 'Matrix set', sort_order: 0 },
          { product_id: f.products[1], quantity: '1.000', product_name_snapshot: 'Bonding liquid', sort_order: 1 },
        ]);

        const events = (await f.pool.query<{ event_type: string }>(
          'SELECT event_type FROM job_card_activity_logs WHERE job_card_id = $1',
          [saleId],
        )).rows.map((row) => row.event_type).sort();
        expect(events).toEqual(['JOB_CREATED', 'SALE_ITEM_ADDED', 'SALE_ITEM_ADDED']);
        expect(await count(f.pool,
          "SELECT count(*)::int AS n FROM job_card_activity_logs WHERE event_type = 'SALE_FROM_VISIT_CREATED'",
        )).toBe(0);

        expect((await f.pool.query(
          `SELECT client_action_id, operation_key FROM processed_actions
            WHERE organization_id = $1 AND operation_key = 'SALE_STANDALONE_CREATE'`,
          [f.organizationId],
        )).rows).toEqual([{ client_action_id: 's1-standalone-create', operation_key: 'SALE_STANDALONE_CREATE' }]);

        // No delivery, no follow-up child, no visit mutation.
        expect(await count(f.pool, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'PRODUCT_DELIVERY'")).toBe(0);
        expect(await count(f.pool, 'SELECT count(*)::int AS n FROM job_cards WHERE source_job_card_id IS NOT NULL')).toBe(0);
        expect((await f.pool.query('SELECT * FROM job_cards WHERE id = $1', [f.visitId])).rows[0]).toEqual(visitBefore);

        // Realtime publishing ran for a sale whose source is absent (R21 guard).
        expect(await count(f.pool, 'SELECT count(*)::int AS n FROM realtime_events')).toBeGreaterThan(realtimeBefore);

        // Same body replays the stored result without another row or event.
        const replay = await app.inject({ method: 'POST', url: STANDALONE_URL, payload: body });
        expect([200, 201]).toContain(replay.statusCode);
        expect(replay.json()).toEqual(created.json());
        expect(await count(f.pool, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'SALE'")).toBe(1);
        expect(await count(f.pool,
          "SELECT count(*)::int AS n FROM processed_actions WHERE operation_key = 'SALE_STANDALONE_CREATE'",
        )).toBe(1);

        // Same key with a changed body is a conflict, never a second sale.
        const conflict = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: { ...body, title: 'Başka bir sözleşme' },
        });
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json().code).toBe('CLIENT_ACTION_REUSED');
        expect(await count(f.pool, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'SALE'")).toBe(1);
      }, service);

      // The guard: no getJob call ever received a null source id.
      expect(calls.filter((args) => args.some((argument) => argument === null))).toEqual([]);
    });
  });

  it('lets management create NEW for any active staff member while staff only create for themselves', async () => {
    await withSaleFixture(async (f) => {
      let actor: JobCardActor = f.manager;
      await withApp(f, () => actor, async (app) => {
        const byManager = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-manager-create', { assignedTo: f.otherStaff.id, saleContactId: null }),
        });
        expect(byManager.statusCode).toBe(201);
        const managerSale = (await f.pool.query(
          `SELECT status, assigned_to, created_by, accepted_at, accepted_by, manager_approved_at
             FROM job_cards WHERE id = $1`,
          [byManager.json().jobCardId],
        )).rows[0];
        expect(managerSale).toEqual({
          status: 'NEW',
          assigned_to: f.otherStaff.id,
          created_by: f.manager.id,
          accepted_at: null,
          accepted_by: null,
          manager_approved_at: null,
        });

        actor = f.admin;
        const byAdmin = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-admin-create', { assignedTo: f.staff.id, saleContactId: null }),
        });
        expect(byAdmin.statusCode).toBe(201);
        expect((await f.pool.query('SELECT status, created_by FROM job_cards WHERE id = $1', [byAdmin.json().jobCardId])).rows[0])
          .toEqual({ status: 'NEW', created_by: f.admin.id });

        actor = f.staff;
        const staffForAnother = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-staff-other', { assignedTo: f.otherStaff.id }),
        });
        expect(staffForAnother.statusCode).toBe(403);
        expect(staffForAnother.json().code).toBe('FORBIDDEN');

        actor = f.manager;
        const inactiveStaff = await f.user('STAFF');
        await f.pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [inactiveStaff.id]);
        const inactiveAssignee = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-inactive-assignee', { assignedTo: inactiveStaff.id }),
        });
        expect(inactiveAssignee.statusCode).toBe(403);
        expect(inactiveAssignee.json().code).toBe('FORBIDDEN');

        const foreignOrg = (await f.pool.query<{ id: string }>(
          "INSERT INTO organizations (name) VALUES ('S1 foreign staff org') RETURNING id",
        )).rows[0]!.id;
        const foreignStaff = await f.user('STAFF', foreignOrg);
        const crossOrgAssignee = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-cross-org-assignee', { assignedTo: foreignStaff.id }),
        });
        expect(crossOrgAssignee.statusCode).toBe(404);
        expect(crossOrgAssignee.json().code).toBe('ASSIGNEE_NOT_FOUND');

        actor = await f.user('MANAGER', foreignOrg);
        const foreignActor = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-foreign-actor'),
        });
        // Contract lock order is users first: the other organization's assignee is
        // concealed as not found before the customer is read; nothing is written.
        expect(foreignActor.statusCode).toBe(404);
        expect(foreignActor.json().code).toBe('ASSIGNEE_NOT_FOUND');

        expect(await count(f.pool, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'SALE'")).toBe(2);
      });
    });
  });

  it('rejects ineligible customers, contacts and products atomically', async () => {
    await withSaleFixture(async (f) => {
      const demoDatasetId = (await f.pool.query<{ id: string }>(
        `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
         VALUES ($1, 's1-demo', 'demo-standard-v1', $2) RETURNING id`,
        [f.organizationId, f.admin.id],
      )).rows[0]!.id;
      const demoProductId = (await f.pool.query<{ id: string }>(
        `INSERT INTO products (organization_id, name, unit, is_active, data_class, demo_dataset_id)
         VALUES ($1, 'Demo ürün', 'adet', TRUE, 'DEMO', $2) RETURNING id`,
        [f.organizationId, demoDatasetId],
      )).rows[0]!.id;
      const inactiveProductId = (await f.pool.query<{ id: string }>(
        `INSERT INTO products (organization_id, name, unit, is_active)
         VALUES ($1, 'Pasif ürün', 'adet', FALSE) RETURNING id`,
        [f.organizationId],
      )).rows[0]!.id;
      const inactiveContactId = (await f.pool.query<{ id: string }>(
        `INSERT INTO contacts (organization_id, customer_id, name, is_active)
         VALUES ($1, $2, 'Pasif kişi', FALSE) RETURNING id`,
        [f.organizationId, f.customerId],
      )).rows[0]!.id;
      const otherCustomerId = (await f.pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Diğer klinik', 'clinic', 'active') RETURNING id`,
        [f.organizationId],
      )).rows[0]!.id;
      const otherCustomerContactId = (await f.pool.query<{ id: string }>(
        `INSERT INTO contacts (organization_id, customer_id, name) VALUES ($1, $2, 'Diğer kişi') RETURNING id`,
        [f.organizationId, otherCustomerId],
      )).rows[0]!.id;
      const foreignOrganizationId = (await f.pool.query<{ id: string }>(
        "INSERT INTO organizations (name) VALUES ('S1 foreign reference org') RETURNING id",
      )).rows[0]!.id;
      const foreignCustomerId = (await f.pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Yabancı klinik', 'clinic', 'active') RETURNING id`,
        [foreignOrganizationId],
      )).rows[0]!.id;
      const foreignProductId = (await f.pool.query<{ id: string }>(
        `INSERT INTO products (organization_id, name) VALUES ($1, 'Yabancı ürün') RETURNING id`,
        [foreignOrganizationId],
      )).rows[0]!.id;

      await withApp(f, () => f.staff, async (app) => {
        await f.pool.query("UPDATE customers SET status = 'inactive' WHERE id = $1", [f.customerId]);
        const inactiveCustomer = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-ineligible-inactive-customer'),
        });
        expect(inactiveCustomer.statusCode).toBe(409);
        expect(inactiveCustomer.json().code).toBe('CUSTOMER_INACTIVE');
        await f.pool.query("UPDATE customers SET status = 'active' WHERE id = $1", [f.customerId]);

        const cases: Array<[string, Record<string, unknown>, number | null, string]> = [
          ['inactive product', { items: [{ productId: inactiveProductId, quantity: 1 }] }, 404, 'PRODUCT_NOT_FOUND'],
          // The contract names these codes but not their HTTP status; any 4xx is contract-compliant.
          ['demo product', { items: [{ productId: demoProductId, quantity: 1 }] }, null, 'SALE_REFERENCE_NOT_ELIGIBLE'],
          ['foreign product', { items: [{ productId: foreignProductId, quantity: 1 }] }, 404, 'PRODUCT_NOT_FOUND'],
          ['inactive contact', { saleContactId: inactiveContactId }, 409, 'CONTACT_INACTIVE'],
          ['contact of another customer', { saleContactId: otherCustomerContactId }, 409, 'CONTACT_NOT_IN_CUSTOMER'],
          ['unknown contact', { saleContactId: '00000000-0000-4000-8000-000000000000' }, 404, 'CONTACT_NOT_FOUND'],
          ['foreign customer', { customerId: foreignCustomerId }, 404, 'CUSTOMER_NOT_FOUND'],
          // Sale time keeps the SALE-001 15-minute clock-skew tolerance; beyond it is invalid.
          ['future sale time', { soldAt: '2026-10-14T08:15:00.001Z' }, null, 'SALE_TIME_INVALID'],
        ];

        for (const [label, overrides, statusCode, code] of cases) {
          const response = await app.inject({
            method: 'POST',
            url: STANDALONE_URL,
            payload: standaloneBody(f, 's1-ineligible-' + label.replaceAll(' ', '-'), overrides),
          });
          if (statusCode === null) {
            expect.soft(response.statusCode, label).toBeGreaterThanOrEqual(400);
            expect.soft(response.statusCode, label).toBeLessThan(500);
          } else {
            expect.soft(response.statusCode, label).toBe(statusCode);
          }
          expect.soft(response.json().code, label).toBe(code);
        }

        expect(await count(f.pool, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'SALE'")).toBe(0);
        expect(await count(f.pool, 'SELECT count(*)::int AS n FROM job_card_sale_details')).toBe(0);
        expect(await count(f.pool,
          "SELECT count(*)::int AS n FROM processed_actions WHERE operation_key = 'SALE_STANDALONE_CREATE'",
        )).toBe(0);
      });
    });
  });

  it('accepts only the documented body allowlist and trims a 1–255 title', async () => {
    await withSaleFixture(async (f) => {
      await withApp(f, () => f.staff, async (app) => {
        for (const forbidden of [
          'type', 'status', 'saleSourceVisitId', 'sourceVisitId', 'expectedSourceVersion',
          'price', 'sourceJobCardId', 'sale_customer_name_snapshot', 'unexpectedField',
        ]) {
          const response = await app.inject({
            method: 'POST',
            url: STANDALONE_URL,
            payload: standaloneBody(f, 's1-forbidden-' + forbidden, { [forbidden]: 'x' }),
          });
          expect.soft(response.statusCode, forbidden).toBe(400);
        }

        const base = standaloneBody(f, 's1-required');
        for (const field of ['clientActionId', 'title', 'customerId', 'assignedTo', 'soldAt', 'items']) {
          const payload = { ...base } as Record<string, unknown>;
          delete payload[field];
          const response = await app.inject({ method: 'POST', url: STANDALONE_URL, payload });
          expect.soft(response.statusCode, field).toBe(400);
        }

        for (const [label, overrides] of [
          ['blank title', { title: '   ' }],
          ['long title', { title: 'x'.repeat(256) }],
          ['long description', { description: 'x'.repeat(4001) }],
        ] as const) {
          const response = await app.inject({
            method: 'POST',
            url: STANDALONE_URL,
            payload: standaloneBody(f, 's1-field-' + label.replaceAll(' ', '-'), overrides),
          });
          expect.soft(response.statusCode, label).toBe(400);
        }

        const padded = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-trimmed-title', {
            title: '   Telefon siparişi   ',
            description: null,
            saleContactId: null,
          }),
        });
        expect(padded.statusCode).toBe(201);
        expect((await f.pool.query('SELECT title, description FROM job_cards WHERE id = $1', [padded.json().jobCardId])).rows[0])
          .toEqual({ title: 'Telefon siparişi', description: null });

        expect(await count(f.pool, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'SALE'")).toBe(1);
        expect(await count(f.pool, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'SALES_MEETING'")).toBe(1);
      });
    });
  });

  it('keeps 1–25 distinct whole-unit product lines', async () => {
    await withSaleFixture(async (f) => {
      const organizationId = f.organizationId;
      const extraProducts: string[] = [];
      for (let index = 0; index < 24; index++) {
        extraProducts.push((await f.pool.query<{ id: string }>(
          `INSERT INTO products (organization_id, name) VALUES ($1, $2) RETURNING id`,
          [organizationId, `S1 ürün ${index}`],
        )).rows[0]!.id);
      }
      const batchOf26 = [f.products[0]!, f.products[1]!, ...extraProducts]
        .map((productId) => ({ productId, quantity: 1 }));

      await withApp(f, () => f.staff, async (app) => {
        const empty = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-empty-items', { items: [] }),
        });
        // The contract fixes 1–25 lines but not the status of an empty batch.
        expect([400, 409]).toContain(empty.statusCode);
        expect(['SALE_ITEM_LIMIT', 'VALIDATION_ERROR']).toContain(empty.json().code);

        const tooMany = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-too-many-items', { items: batchOf26 }),
        });
        expect(tooMany.statusCode).toBe(409);
        expect(tooMany.json().code).toBe('SALE_ITEM_LIMIT');

        const duplicate = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-duplicate-item', {
            items: [{ productId: f.products[0]!, quantity: 1 }, { productId: f.products[0]!, quantity: 2 }],
          }),
        });
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.json().code).toBe('SALE_PRODUCT_DUPLICATE');

        for (const [index, quantity] of [0, -1, 0.5, 1.5, '1', null, 1_000_000_000].entries()) {
          const response = await app.inject({
            method: 'POST',
            url: STANDALONE_URL,
            payload: standaloneBody(f, `s1-bad-quantity-${index}`, {
              items: [{ productId: f.products[0]!, quantity }],
            }),
          });
          expect.soft(response.statusCode, `quantity ${String(quantity)}`).toBe(400);
        }

        const maxBatch = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-max-batch', { items: batchOf26.slice(0, 25) }),
        });
        expect(maxBatch.statusCode).toBe(201);

        const maxQuantity = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-max-quantity', {
            items: [{ productId: f.products[0]!, quantity: 999_999_999 }],
          }),
        });
        expect(maxQuantity.statusCode).toBe(201);
        expect((await f.pool.query<{ quantity: string }>(
          'SELECT quantity::text AS quantity FROM job_card_sale_items WHERE job_card_id = $1',
          [maxQuantity.json().jobCardId],
        )).rows[0]!.quantity).toBe('999999999.000');

        expect(await count(f.pool, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'SALE'")).toBe(2);
      });
    });
  });

  it('serializes on the shared customer row against a concurrent visit-origin create without deadlocking', async () => {
    await withSaleFixture(async (f) => {
      await withApp(f, () => f.staff, async (app) => {
        const results = await Promise.allSettled([
          f.service.createSaleFromVisit(f.staff, f.visitId, {
            ...f.input,
            clientActionId: 's1-concurrent-visit-origin',
          }),
          app.inject({
            method: 'POST',
            url: STANDALONE_URL,
            payload: standaloneBody(f, 's1-concurrent-standalone-a'),
          }),
          app.inject({
            method: 'POST',
            url: STANDALONE_URL,
            payload: standaloneBody(f, 's1-concurrent-standalone-b', {
              items: [{ productId: f.products[1]!, quantity: 2 }],
            }),
          }),
        ]);

        const visitOrigin = results[0]!;
        expect(visitOrigin.status).toBe('fulfilled');
        const standaloneResponses = results.slice(1).map((result) => {
          expect(result.status).toBe('fulfilled');
          return (result as PromiseFulfilledResult<Awaited<ReturnType<App['inject']>>>).value;
        });
        for (const response of standaloneResponses) {
          expect(response.statusCode).toBe(201);
          expect(response.json()).not.toMatchObject({ code: 'ACTION_IN_PROGRESS' });
        }

        const sales = (await f.pool.query<{ sale_source_visit_id: string | null }>(
          "SELECT sale_source_visit_id FROM job_cards WHERE type = 'SALE' ORDER BY created_at, id",
        )).rows;
        expect(sales).toHaveLength(3);
        expect(sales.filter((row) => row.sale_source_visit_id === f.visitId)).toHaveLength(1);
        expect(sales.filter((row) => row.sale_source_visit_id === null)).toHaveLength(2);
        expect((await f.pool.query('SELECT status, version FROM job_cards WHERE id = $1', [f.visitId])).rows[0])
          .toEqual({ status: 'IN_PROGRESS', version: f.input.expectedSourceVersion });
      });
    });
  });

  it('projects a STANDALONE origin to authorized readers and conceals it from the rest', async () => {
    await withSaleFixture(async (f) => {
      let saleId = '';
      await withApp(f, () => f.staff, async (app) => {
        const created = await app.inject({
          method: 'POST',
          url: STANDALONE_URL,
          payload: standaloneBody(f, 's1-standalone-origin'),
        });
        expect(created.statusCode).toBe(201);
        saleId = created.json().jobCardId as string;
      });

      const detail = await f.service.getSaleDetails(f.staff, saleId);
      const serialized = JSON.stringify(detail);
      // R11: a standalone sale has no source to conceal, so it must never claim
      // the restricted visit origin and must never render a restricted message.
      expect(serialized).not.toContain('SALE_FROM_VISIT');
      expect(serialized).not.toContain('RESTRICTED');
      expect(serialized).not.toContain(f.visitId);
      const origin = (detail.sourceVisit ?? (detail as { origin?: unknown }).origin) as
        | { kind?: string; access?: string }
        | undefined;
      expect(origin).toMatchObject({ kind: 'STANDALONE' });
      expect(origin?.access).not.toBe('RESTRICTED');

      expect((await f.service.getSaleDetails(f.manager, saleId)).items).toHaveLength(2);
      await expect(f.service.getSaleDetails(f.otherStaff, saleId)).rejects.toMatchObject({ statusCode: 404 });
      const foreignOrganizationId = (await f.pool.query<{ id: string }>(
        "INSERT INTO organizations (name) VALUES ('S1 foreign reader org') RETURNING id",
      )).rows[0]!.id;
      await expect(f.service.getSaleDetails(
        { ...f.manager, organizationId: foreignOrganizationId },
        saleId,
      )).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
