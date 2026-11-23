import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { baselineIso, HOUR_MS, MINUTE_MS, readDbBaseline } from './support/db-clock-baseline.js';
import { readyVisit, saleFixture, standaloneSale, withSaleFixture } from './support/sale-harness.js';

/**
 * SALE-002 slice S3 acceptance — sale approval opens one delivery.
 * Written by an independent test author from the accepted contract only:
 * docs/features/visit-to-sale/sale-002-contract.md
 *   §5 (whole), §4.5-§4.7 (pair approve, idempotency, lock order, atomicity),
 *   §4.8 (edge cases), §8.1 (read side), §9.3 (delivery bullets).
 *
 * Time model. Lifecycle business time is the 049 DB arbitration clock
 * (`reservedAt`), not the service clock, so every delivery instant below is
 * derived from the database clock (`readDbBaseline`), never from `saleTime`.
 * The assignment window (JOB-010 2b) is switched ON for the service under
 * test, because the SALE_APPROVAL offer only exists behind that flag.
 *
 * Conventions: a definitive 4xx marks the 049 intent(s) FAILED, so every
 * corrected retry in this file uses a NEW clientActionId (§5.4).
 */

type Fixture = Awaited<ReturnType<typeof saleFixture>>;
type App = ReturnType<typeof Fastify>;
type Injected = Awaited<ReturnType<App['inject']>>;

const APPROVAL_NOTE = 'Satış onaylandı; teslimat planlandı.';
const DELIVERY_NOTE = 'Klinik kabul saatlerinde teslim edilecek.';
const MEETING_AT = '2026-10-14T07:50:00.000Z';
const ACK = { code: 'CUSTOMER_WAITING', text: 'Müşteri klinikte bekliyor, teslim bugün yapılabilir.' } as const;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function windowedService(f: Fixture, published: RealtimeEventRecord[] = []) {
  return new JobCardService(
    f.repository,
    () => new Date('2026-10-14T08:00:00.000Z'),
    { publish: (event: RealtimeEventRecord) => { published.push(event); } },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
    {},
    { enabled: true },
  );
}

async function withApp(
  f: Fixture,
  actor: () => JobCardActor,
  run: (app: App) => Promise<void>,
  service: JobCardService = windowedService(f),
) {
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

/** One-shot HTTP call as `actor` against a fresh app on the windowed service. */
async function call(
  f: Fixture,
  actor: JobCardActor,
  request: { method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> },
  service?: JobCardService,
): Promise<Injected> {
  let response: Injected | null = null;
  await withApp(f, () => actor, async (app) => {
    response = await app.inject(request);
  }, service);
  return response!;
}

function approveSale(
  f: Fixture,
  saleId: string,
  payload: Record<string, unknown>,
  actor: JobCardActor = f.manager,
  service?: JobCardService,
) {
  return call(f, actor, {
    method: 'POST',
    url: `/api/job-cards/${saleId}/approve?includeSaleCapability=true`,
    payload,
  }, service);
}

function approveVisit(
  f: Fixture,
  payload: Record<string, unknown>,
  actor: JobCardActor = f.manager,
  service?: JobCardService,
) {
  return call(f, actor, { method: 'POST', url: `/api/job-cards/${f.visitId}/approve`, payload }, service);
}

async function count(f: Fixture, sql: string, values: unknown[] = []): Promise<number> {
  return (await f.pool.query<{ n: number }>(sql, values)).rows[0]!.n;
}

async function cardRow(f: Fixture, id: string) {
  return (await f.pool.query<{
    status: string;
    version: number;
    assigned_to: string;
    manager_approved_at: Date | null;
    manager_approved_by: string | null;
    manager_approval_note: string | null;
  }>(
    `SELECT status, version, assigned_to, manager_approved_at, manager_approved_by, manager_approval_note
       FROM job_cards WHERE id = $1`,
    [id],
  )).rows[0]!;
}

/** Everything an approval can write, for "nothing committed" proofs. */
async function world(f: Fixture) {
  return (await f.pool.query<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM job_cards) AS jobs,
            (SELECT count(*)::int FROM job_card_delivery_items) AS items,
            (SELECT count(*)::int FROM job_card_activity_logs) AS activities,
            (SELECT count(*)::int FROM job_card_assignment_offers) AS offers,
            (SELECT count(*)::int FROM realtime_events) AS realtime,
            (SELECT count(*)::int FROM processed_actions) AS receipts`,
  )).rows[0]!;
}

async function deliveriesOf(f: Fixture, saleId: string) {
  return (await f.pool.query<{
    id: string;
    type: string;
    status: string;
    data_class: string;
    customer_id: string;
    assigned_to: string;
    created_by: string;
    title: string;
    description: string | null;
    due_date: Date | null;
    source_job_card_id: string | null;
    delivery_source_sale_id: string | null;
    scheduled_at: Date;
    scheduled_ends_at: Date;
  }>(
    `SELECT id, type, status, data_class, customer_id, assigned_to, created_by, title, description,
            due_date, source_job_card_id, delivery_source_sale_id, scheduled_at, scheduled_ends_at
       FROM job_cards WHERE delivery_source_sale_id = $1`,
    [saleId],
  )).rows;
}

async function deliveryItems(f: Fixture, deliveryId: string) {
  return (await f.pool.query<{
    product_id: string;
    delivery_purpose: string;
    delivered_at: Date | null;
    quantity: string;
    delivery_note: string | null;
  }>(
    `SELECT product_id, delivery_purpose, delivered_at, quantity::text AS quantity, delivery_note
       FROM job_card_delivery_items WHERE job_card_id = $1 ORDER BY sort_order, id`,
    [deliveryId],
  )).rows;
}

async function activities(f: Fixture, jobCardId: string, eventType: string) {
  return (await f.pool.query<{ metadata: Record<string, unknown> | null; new_value: unknown }>(
    `SELECT metadata, new_value FROM job_card_activity_logs
      WHERE job_card_id = $1 AND event_type = $2 ORDER BY created_at, id`,
    [jobCardId, eventType],
  )).rows;
}

async function intentsFor(f: Fixture, clientActionId: string) {
  return (await f.pool.query<{
    job_card_id: string;
    state: string;
    failure_code: string | null;
    failed_at: Date | null;
    operation_key: string;
  }>(
    `SELECT job_card_id, state, failure_code, failed_at, operation_key
       FROM job_card_lifecycle_intents WHERE client_action_id = $1 ORDER BY operation_key`,
    [clientActionId],
  )).rows;
}

/** A whole-minute instant `offsetMs` from the DB clock. */
async function instant(f: Fixture, offsetMs: number): Promise<string> {
  const base = await readDbBaseline(f.pool);
  const rounded = Math.floor((base.getTime() + offsetMs) / MINUTE_MS) * MINUTE_MS;
  return baselineIso(new Date(rounded), 0);
}

function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MINUTE_MS).toISOString();
}

type DeliveryBody = Record<string, unknown>;

/**
 * Tomorrow-ish delivery for the sale's own staff: no urgency, no acknowledgement.
 * CONTRACT-AMBIGUITY: §5.2 says the assignee "defaults to the sale's assigned_to" but
 * the §5.1 example lists `assignedTo` without marking it optional, so every request in
 * this file sends it explicitly and no test depends on the omitted-field default.
 */
async function deliveryBody(f: Fixture, overrides: DeliveryBody = {}): Promise<DeliveryBody> {
  return {
    assignedTo: f.staff.id,
    scheduledAt: await instant(f, 26 * HOUR_MS),
    items: [{ productId: f.products[0]!, quantity: 2 }],
    ...overrides,
  };
}

/** A SALE created as a standalone record and submitted, so it is WAITING_APPROVAL. */
async function waitingStandalone(f: Fixture, key = 's3-standalone', overrides: Record<string, unknown> = {}) {
  const sale = await standaloneSale(f, {
    clientActionId: `${key}-create`,
    items: [
      { productId: f.products[0]!, quantity: 2 },
      { productId: f.products[1]!, quantity: 15 },
    ],
    ...overrides,
  });
  const submitted = await f.service.submitForApproval(f.staff, sale.jobCardId, {
    clientActionId: `${key}-submit`,
    expectedVersion: sale.version,
    note: 'Telefon siparişi kaydı.',
  });
  expect(submitted.status).toBe('WAITING_APPROVAL');
  return { saleId: sale.jobCardId, version: submitted.version };
}

/**
 * Visit + coordinated sale, both WAITING_APPROVAL (same staff).
 * `followUp: true` makes the JOB-008 follow-up proposal mandatory.
 */
async function waitingPair(f: Fixture, options: { followUp: boolean } = { followUp: false }) {
  let visitVersion: number;
  let sale: { jobCardId: string; version: number };
  if (options.followUp) {
    // Same order as the S2 suites: the sale is created first, then the visit result.
    sale = await f.service.createSaleFromVisit(f.staff, f.visitId, {
      ...f.input, clientActionId: 's3-pair-sale-create',
    });
    const details = await f.service.patchMeetingDetails(f.staff, f.visitId, {
      clientActionId: 's3-pair-meeting',
      expectedVersion: f.input.expectedSourceVersion,
      meetingAt: MEETING_AT,
      outcome: 'FOLLOW_UP_REQUIRED',
      unsuccessfulReason: 'REQUESTED_LATER',
      meetingSummary: 'Klinik yetkilisiyle görüşüldü; takip planlandı.',
      nextFollowUpAt: null,
    });
    visitVersion = details.jobCardVersion;
  } else {
    visitVersion = await readyVisit(f, {
      expectedVersion: f.input.expectedSourceVersion,
      clientActionId: 's3-pair-ready',
    });
    sale = await f.service.createSaleFromVisit(f.staff, f.visitId, {
      ...f.input, clientActionId: 's3-pair-sale-create', expectedSourceVersion: visitVersion,
    });
  }
  await f.service.submitForApproval(f.staff, f.visitId, {
    clientActionId: 's3-pair-submit',
    expectedVersion: visitVersion,
    expectedSaleVersion: sale.version,
    note: 'Ziyaret ve bağlı satış kaydı onaya hazır.',
  });
  const visit = await cardRow(f, f.visitId);
  const saleRow = await cardRow(f, sale.jobCardId);
  expect(visit.status).toBe('WAITING_APPROVAL');
  expect(saleRow.status).toBe('WAITING_APPROVAL');
  return { saleId: sale.jobCardId, visitVersion: visit.version, saleVersion: saleRow.version };
}

async function extraProduct(
  f: Fixture,
  options: { active?: boolean; organizationId?: string; demoDatasetId?: string | null } = {},
): Promise<string> {
  const demo = options.demoDatasetId ?? null;
  return (await f.pool.query<{ id: string }>(
    `INSERT INTO products (organization_id, name, sku, unit, is_active, data_class, demo_dataset_id)
     VALUES ($1, $2, $3, 'adet', $4, $5, $6) RETURNING id`,
    [
      options.organizationId ?? f.organizationId,
      `Ürün ${randomUUID().slice(0, 8)}`,
      `SKU-${randomUUID().slice(0, 12)}`,
      options.active ?? true,
      demo === null ? 'BUSINESS' : 'DEMO',
      demo,
    ],
  )).rows[0]!.id;
}

async function otherOrganization(f: Fixture): Promise<string> {
  return (await f.pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ('Other org', 'Europe/Istanbul') RETURNING id`,
  )).rows[0]!.id;
}

/** Recursively find the first occurrence of `key` anywhere inside a JSON value. */
function findKey(value: unknown, key: string): { found: boolean; value?: unknown } {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = findKey(entry, key);
      if (hit.found) return hit;
    }
    return { found: false };
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, key)) return { found: true, value: record[key] };
    for (const entry of Object.values(record)) {
      const hit = findKey(entry, key);
      if (hit.found) return hit;
    }
  }
  return { found: false };
}

// ---------------------------------------------------------------------------
// 1. Independent sale approved WITH a delivery
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 independent sale approval with delivery', () => {
  it('creates exactly one planned delivery card with its items, facts and offer', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const scheduledAt = await instant(f, 26 * HOUR_MS);
      const published: RealtimeEventRecord[] = [];
      const service = windowedService(f, published);

      const response = await approveSale(f, saleId, {
        clientActionId: 's3-approve-with-delivery',
        expectedVersion: version,
        note: APPROVAL_NOTE,
        delivery: {
          assignedTo: f.staff.id,
          scheduledAt,
          note: DELIVERY_NOTE,
          // Request order is deliberately NOT product-id order and NOT the sale's order.
          items: [
            { productId: f.products[1]!, quantity: 4 },
            { productId: f.products[0]!, quantity: 2 },
          ],
        },
      }, f.manager, service);
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ id: saleId, status: 'COMPLETED' });
      expect(typeof body.deliveryJobCardId).toBe('string');
      // A standalone sale has no visit pair: no linked-sale id is reported.
      expect(body.linkedSaleJobCardId ?? null).toBeNull();

      // Sale: completed by the manager, version moved once.
      expect(await cardRow(f, saleId)).toMatchObject({
        status: 'COMPLETED',
        version: version + 1,
        manager_approved_by: f.manager.id,
        manager_approval_note: APPROVAL_NOTE,
      });

      // §5.3 card properties.
      const deliveries = await deliveriesOf(f, saleId);
      expect(deliveries).toHaveLength(1);
      const delivery = deliveries[0]!;
      expect(delivery.id).toBe(body.deliveryJobCardId);
      expect(delivery).toMatchObject({
        type: 'PRODUCT_DELIVERY',
        status: 'NEW',
        data_class: 'BUSINESS',
        customer_id: f.customerId,
        assigned_to: f.staff.id,
        created_by: f.manager.id,
        title: 'Telefon siparişi',
        description: DELIVERY_NOTE,
        due_date: null,
        source_job_card_id: null,
        delivery_source_sale_id: saleId,
      });
      expect(delivery.scheduled_at.toISOString()).toBe(scheduledAt);
      // Canonical end (PRODUCT_DELIVERY = 30 minutes) was derived by the server.
      expect(delivery.scheduled_ends_at.toISOString()).toBe(plusMinutes(scheduledAt, 30));

      // §5.2 planned items: default purpose SALE, no actual time, whole units, note NOT duplicated.
      // Lines inserted in one transaction share sort_order/created_at, so compare as a set.
      const byProduct = (a: { product_id: string }, b: { product_id: string }) => a.product_id.localeCompare(b.product_id);
      expect((await deliveryItems(f, delivery.id)).sort(byProduct)).toEqual([
        { product_id: f.products[1], delivery_purpose: 'SALE', delivered_at: null, quantity: '4.000', delivery_note: null },
        { product_id: f.products[0], delivery_purpose: 'SALE', delivered_at: null, quantity: '2.000', delivery_note: null },
      ].sort(byProduct));

      // §5.3: one JOB_CREATED and one DELIVERY_ITEM_ADDED per line on the delivery.
      expect(await activities(f, delivery.id, 'JOB_CREATED')).toHaveLength(1);
      expect(await activities(f, delivery.id, 'DELIVERY_ITEM_ADDED')).toHaveLength(2);

      // §5.5 SALE_DELIVERY_CREATED on the sale, with exactly the documented shape.
      // CONTRACT-AMBIGUITY: §5.5 gives the key set but not the JSON type of `quantity`
      // or `scheduledAt`; they are asserted as the request's own number / canonical ISO
      // string, the same representation DELIVERY_ITEM_ADDED already uses.
      const facts = await activities(f, saleId, 'SALE_DELIVERY_CREATED');
      expect(facts).toHaveLength(1);
      expect(facts[0]!.metadata).toEqual({
        deliveryJobCardId: delivery.id,
        assignedTo: f.staff.id,
        scheduledAt,
        itemCount: 2,
        items: [
          { productId: f.products[1], quantity: 4 },
          { productId: f.products[0], quantity: 2 },
        ],
      });
      // The delivery carries no back-link fact of its own.
      expect(await activities(f, delivery.id, 'SALE_DELIVERY_CREATED')).toHaveLength(0);

      // §5.4: a manager-created delivery is a direct producer: SALE_APPROVAL offer.
      const offers = (await f.pool.query<{
        assignee_user_id: string;
        opened_reason: string;
        opened_by: string;
        state: string;
      }>(
        `SELECT assignee_user_id, opened_reason, opened_by, state
           FROM job_card_assignment_offers WHERE job_card_id = $1`,
        [delivery.id],
      )).rows;
      expect(offers).toEqual([{
        assignee_user_id: f.staff.id,
        opened_reason: 'SALE_APPROVAL',
        opened_by: f.manager.id,
        state: 'OPEN',
      }]);

      // §5.5 realtime: the delivery produces job.created, published only after commit.
      expect(await count(f,
        `SELECT count(*)::int AS n FROM realtime_events
          WHERE event_type = 'job.created' AND entity_id = $1`, [delivery.id])).toBeGreaterThan(0);
      expect(published.some((event) => event.entityId === delivery.id)).toBe(true);

      // §4.5: the stored receipt carries the delivery id for replay parity.
      const receipt = (await f.pool.query<{ response_body: Record<string, unknown>; status: string }>(
        `SELECT response_body, status FROM processed_actions WHERE client_action_id = $1`,
        ['s3-approve-with-delivery'],
      )).rows;
      expect(receipt).toHaveLength(1);
      expect(receipt[0]!.status).toBe('completed');
      expect(receipt[0]!.response_body).toMatchObject({ deliveryJobCardId: delivery.id });
    });
  });

  it('keeps an explicit purpose, canonical end and boundary-size note and line count', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const lines = [f.products[0]!, f.products[1]!];
      while (lines.length < 25) lines.push(await extraProduct(f));
      const scheduledAt = await instant(f, 30 * HOUR_MS);
      const note = 'n'.repeat(4000);

      const response = await approveSale(f, saleId, {
        clientActionId: 's3-approve-boundaries',
        expectedVersion: version,
        delivery: {
          assignedTo: f.staff.id,
          scheduledAt,
          scheduledEndsAt: plusMinutes(scheduledAt, 30),
          deliveryPurpose: 'SAMPLE',
          note,
          items: lines.map((productId) => ({ productId, quantity: 999_999_999 })),
        },
      });
      expect(response.statusCode).toBe(200);
      const deliveryId = response.json().deliveryJobCardId as string;
      const items = await deliveryItems(f, deliveryId);
      expect(items).toHaveLength(25);
      expect(items.every((row) => row.delivery_purpose === 'SAMPLE')).toBe(true);
      expect(items.every((row) => Number(row.quantity) === 999_999_999)).toBe(true);
      expect((await deliveriesOf(f, saleId))[0]).toMatchObject({ description: note });
      expect(await activities(f, deliveryId, 'DELIVERY_ITEM_ADDED')).toHaveLength(25);
      expect((await activities(f, saleId, 'SALE_DELIVERY_CREATED'))[0]!.metadata)
        .toMatchObject({ itemCount: 25 });
    });
  });

  it('accepts a sale from a COMPLETED visit (retro sale) with a delivery and leaves the visit alone', async () => {
    await withSaleFixture(async (f) => {
      const visitVersion = await readyVisit(f, { expectedVersion: f.input.expectedSourceVersion });
      await f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 's3-retro-visit-submit', expectedVersion: visitVersion, note: 'Ziyaret tamamlandı.',
      });
      const waiting = await cardRow(f, f.visitId);
      await f.service.approve(f.manager, f.visitId, {
        clientActionId: 's3-retro-visit-approve', expectedVersion: waiting.version,
      });
      const completedVisit = await cardRow(f, f.visitId);
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, {
        ...f.input, clientActionId: 's3-retro-sale', expectedSourceVersion: completedVisit.version,
      });
      const submitted = await f.service.submitForApproval(f.staff, sale.jobCardId, {
        clientActionId: 's3-retro-submit', expectedVersion: sale.version, note: 'Satış sonradan kaydedildi.',
      });

      const response = await approveSale(f, sale.jobCardId, {
        clientActionId: 's3-retro-approve',
        expectedVersion: submitted.version,
        delivery: await deliveryBody(f),
      });
      expect(response.statusCode).toBe(200);
      const deliveries = await deliveriesOf(f, sale.jobCardId);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ source_job_card_id: null, delivery_source_sale_id: sale.jobCardId });
      expect(await cardRow(f, f.visitId)).toEqual(completedVisit);
    });
  });

  it('redirects a coordinated sale approved on its own card and creates no delivery', async () => {
    await withSaleFixture(async (f) => {
      const pair = await waitingPair(f);
      const before = await world(f);

      const response = await approveSale(f, pair.saleId, {
        clientActionId: 's3-redirect-with-delivery',
        expectedVersion: pair.saleVersion,
        delivery: await deliveryBody(f),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('SALE_APPROVE_VIA_VISIT_REQUIRED');
      expect(await deliveriesOf(f, pair.saleId)).toHaveLength(0);
      expect(await world(f)).toEqual(before);
      expect(await cardRow(f, pair.saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version: pair.saleVersion });
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Pair approve WITH a delivery
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 pair approval with delivery', () => {
  it('completes both cards and creates the follow-up child and the delivery in one transaction', async () => {
    await withSaleFixture(async (f) => {
      const pair = await waitingPair(f, { followUp: true });
      const scheduledAt = await instant(f, 26 * HOUR_MS);

      const response = await approveVisit(f, {
        clientActionId: 's3-pair-approve',
        expectedVersion: pair.visitVersion,
        expectedSaleVersion: pair.saleVersion,
        note: APPROVAL_NOTE,
        delivery: {
          assignedTo: f.staff.id,
          scheduledAt,
          note: DELIVERY_NOTE,
          items: [{ productId: f.products[0]!, quantity: 3 }],
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ status: 'COMPLETED', linkedSaleJobCardId: pair.saleId });
      expect(typeof body.followUpJobCardId).toBe('string');
      expect(typeof body.deliveryJobCardId).toBe('string');

      const visit = await cardRow(f, f.visitId);
      const sale = await cardRow(f, pair.saleId);
      expect(visit).toMatchObject({ status: 'COMPLETED', manager_approved_by: f.manager.id });
      expect(sale).toMatchObject({ status: 'COMPLETED', manager_approved_by: f.manager.id });
      expect(visit.manager_approved_at!.getTime()).toBe(sale.manager_approved_at!.getTime());

      // The follow-up is the visit's child; the delivery is the SALE's child, not the visit's.
      const followUps = (await f.pool.query<{ id: string; type: string }>(
        'SELECT id, type FROM job_cards WHERE source_job_card_id = $1', [f.visitId])).rows;
      expect(followUps).toEqual([{ id: body.followUpJobCardId, type: 'SALES_MEETING' }]);
      const deliveries = await deliveriesOf(f, pair.saleId);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        id: body.deliveryJobCardId,
        type: 'PRODUCT_DELIVERY',
        status: 'NEW',
        source_job_card_id: null,
        created_by: f.manager.id,
        description: DELIVERY_NOTE,
      });
      expect(await deliveriesOf(f, f.visitId)).toHaveLength(0);

      // Facts: two approvals, one delivery fact (on the sale only).
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_activity_logs
          WHERE job_card_id = ANY($1::uuid[]) AND event_type = 'JOB_APPROVED'`,
        [[f.visitId, pair.saleId]])).toBe(2);
      expect(await activities(f, pair.saleId, 'SALE_DELIVERY_CREATED')).toHaveLength(1);
      expect(await activities(f, f.visitId, 'SALE_DELIVERY_CREATED')).toHaveLength(0);

      // One transaction: one anchor receipt, two COMPLETED intents.
      const anchorKey = `JOB_APPROVE_PAIR:${f.visitId}`;
      const intents = await intentsFor(f, 's3-pair-approve');
      expect(intents.map((row) => row.state)).toEqual(['COMPLETED', 'COMPLETED']);
      expect(intents.map((row) => row.operation_key).sort()).toEqual([anchorKey, `${anchorKey}:participant`]);
      expect(await count(f,
        'SELECT count(*)::int AS n FROM processed_actions WHERE operation_key = $1', [anchorKey])).toBe(1);
    });
  });

  it('rolls the follow-up child back with a failed delivery: no half-approved pair', async () => {
    await withSaleFixture(async (f) => {
      const pair = await waitingPair(f, { followUp: true });
      const before = await world(f);
      // The delivery is created after the follow-up child (§4.3 step 6), so a
      // window failure proves the child is rolled back with everything else.
      const tooShort = plusMinutes(await instant(f, 0), -25);

      const response = await approveVisit(f, {
        clientActionId: 's3-pair-rollback',
        expectedVersion: pair.visitVersion,
        expectedSaleVersion: pair.saleVersion,
        delivery: await deliveryBody(f, { scheduledAt: tooShort }),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('ASSIGNMENT_WINDOW_TOO_SHORT');

      expect(await cardRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL', version: pair.visitVersion });
      expect(await cardRow(f, pair.saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version: pair.saleVersion });
      expect(await count(f,
        'SELECT count(*)::int AS n FROM job_cards WHERE source_job_card_id = $1', [f.visitId])).toBe(0);
      expect(await world(f)).toEqual(before);
      const intents = await intentsFor(f, 's3-pair-rollback');
      expect(intents).toHaveLength(2);
      expect(intents.every((row) => row.state === 'FAILED'
        && row.failure_code === 'ASSIGNMENT_WINDOW_TOO_SHORT')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Approve without `delivery`
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 approval without delivery', () => {
  it('writes no delivery and no SALE_DELIVERY_CREATED for an independent sale', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const response = await approveSale(f, saleId, {
        clientActionId: 's3-approve-plain', expectedVersion: version, note: APPROVAL_NOTE,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'COMPLETED' });
      expect(response.json().deliveryJobCardId ?? null).toBeNull();
      expect(await deliveriesOf(f, saleId)).toHaveLength(0);
      expect(await count(f, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'PRODUCT_DELIVERY'")).toBe(0);
      expect(await count(f,
        "SELECT count(*)::int AS n FROM job_card_activity_logs WHERE event_type = 'SALE_DELIVERY_CREATED'")).toBe(0);
      expect(await count(f, 'SELECT count(*)::int AS n FROM job_card_assignment_offers')).toBe(0);
    });
  });

  it('writes no delivery for a pair approved without the payload', async () => {
    await withSaleFixture(async (f) => {
      const pair = await waitingPair(f);
      const response = await approveVisit(f, {
        clientActionId: 's3-pair-plain',
        expectedVersion: pair.visitVersion,
        expectedSaleVersion: pair.saleVersion,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'COMPLETED', linkedSaleJobCardId: pair.saleId });
      expect(response.json().deliveryJobCardId ?? null).toBeNull();
      expect(await count(f, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'PRODUCT_DELIVERY'")).toBe(0);
      expect(await count(f,
        "SELECT count(*)::int AS n FROM job_card_activity_logs WHERE event_type = 'SALE_DELIVERY_CREATED'")).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. `delivery` on an approval that does not complete a SALE
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 delivery on a non-sale approval', () => {
  it('rejects the payload on a plain visit with no sale and writes nothing', async () => {
    await withSaleFixture(async (f) => {
      const visitVersion = await readyVisit(f, { expectedVersion: f.input.expectedSourceVersion });
      await f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 's3-plain-visit-submit', expectedVersion: visitVersion, note: 'Ziyaret tamamlandı.',
      });
      const waiting = await cardRow(f, f.visitId);
      const before = await world(f);

      const response = await approveVisit(f, {
        clientActionId: 's3-plain-visit-delivery',
        expectedVersion: waiting.version,
        delivery: await deliveryBody(f),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
      // Not the generic unknown-body-key rejection: `delivery` is a known field that
      // is refused because this approval does not complete a SALE.
      expect(response.json().error).not.toBe('İstek desteklenmeyen alan içeriyor.');
      expect(await cardRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL', version: waiting.version });
      expect(await world(f)).toEqual(before);
    });
  });

  it('rejects the payload when the legacy sale is not WAITING_APPROVAL (it would not be completed)', async () => {
    await withSaleFixture(async (f) => {
      const pair = await waitingPair(f);
      // Legacy pre-S2 state, as the S2 suite builds it.
      const legacy = (await f.pool.query<{ version: number }>(
        `UPDATE job_cards SET status = 'IN_PROGRESS', version = version + 1 WHERE id = $1 RETURNING version`,
        [pair.saleId],
      )).rows[0]!;
      const before = await world(f);

      const response = await approveVisit(f, {
        clientActionId: 's3-legacy-sale-delivery',
        expectedVersion: pair.visitVersion,
        expectedSaleVersion: legacy.version,
        delivery: await deliveryBody(f),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
      // Not the generic unknown-body-key rejection: `delivery` is a known field that
      // is refused because this approval does not complete a SALE.
      expect(response.json().error).not.toBe('İstek desteklenmeyen alan içeriyor.');
      expect(await cardRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL', version: pair.visitVersion });
      expect(await cardRow(f, pair.saleId)).toMatchObject({ status: 'IN_PROGRESS', version: legacy.version });
      expect(await world(f)).toEqual(before);
      expect(await deliveriesOf(f, pair.saleId)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Payload validation (§5.2): no second implementation, all-or-nothing
// ---------------------------------------------------------------------------

type ValidationCase = {
  name: string;
  status: number;
  code: string;
  build: (f: Fixture) => Promise<DeliveryBody>;
};

const VALIDATION_CASES: ValidationCase[] = [
  { name: 'zero items', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { items: [] }) },
  { name: 'items omitted', status: 400, code: 'VALIDATION_ERROR',
    build: async (f) => { const body = await deliveryBody(f); delete body.items; return body; } },
  { name: 'items not an array', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { items: { productId: f.products[0], quantity: 1 } }) },
  { name: '26 items (cap is 25)', status: 400, code: 'VALIDATION_ERROR',
    build: async (f) => {
      const lines = [f.products[0]!, f.products[1]!];
      while (lines.length < 26) lines.push(await extraProduct(f));
      return deliveryBody(f, { items: lines.map((productId) => ({ productId, quantity: 1 })) });
    } },
  { name: 'fractional quantity', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { items: [{ productId: f.products[0], quantity: 1.5 }] }) },
  { name: 'zero quantity', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { items: [{ productId: f.products[0], quantity: 0 }] }) },
  { name: 'negative quantity', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { items: [{ productId: f.products[0], quantity: -1 }] }) },
  { name: 'overflow quantity (999999999 + 1)', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { items: [{ productId: f.products[0], quantity: 1_000_000_000 }] }) },
  { name: 'string quantity', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { items: [{ productId: f.products[0], quantity: '2' }] }) },
  { name: 'duplicate product', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, {
      items: [{ productId: f.products[0], quantity: 1 }, { productId: f.products[0], quantity: 2 }],
    }) },
  { name: 'productId not a uuid', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { items: [{ productId: 'not-a-uuid', quantity: 1 }] }) },
  { name: 'unknown key inside delivery', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { surprise: true }) },
  { name: 'deliveryNote key (the note is `note`, stored once as description)', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { deliveryNote: 'x' }) },
  { name: 'delivery is not an object', status: 400, code: 'VALIDATION_ERROR',
    build: async () => 'tomorrow' as unknown as DeliveryBody },
  { name: 'scheduledEndsAt not canonical', status: 400, code: 'VALIDATION_ERROR',
    build: async (f) => {
      const scheduledAt = await instant(f, 26 * HOUR_MS);
      return deliveryBody(f, { scheduledAt, scheduledEndsAt: plusMinutes(scheduledAt, 45) });
    } },
  { name: 'note over 4000 characters', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { note: 'n'.repeat(4001) }) },
  { name: 'note is not a string', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { note: 12 }) },
  { name: 'scheduledAt missing', status: 400, code: 'VALIDATION_ERROR',
    build: async (f) => { const body = await deliveryBody(f); delete body.scheduledAt; return body; } },
  { name: 'scheduledAt not an ISO instant', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { scheduledAt: 'yarın sabah' }) },
  { name: 'unknown deliveryPurpose', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { deliveryPurpose: 'GIFT' }) },
  { name: 'assignedTo not a uuid', status: 400, code: 'VALIDATION_ERROR',
    build: (f) => deliveryBody(f, { assignedTo: 'staff' }) },
  { name: 'inactive product', status: 404, code: 'PRODUCT_NOT_FOUND',
    build: async (f) => deliveryBody(f, {
      items: [{ productId: await extraProduct(f, { active: false }), quantity: 1 }],
    }) },
  { name: 'product of another organization', status: 404, code: 'PRODUCT_NOT_FOUND',
    build: async (f) => deliveryBody(f, {
      items: [{ productId: await extraProduct(f, { organizationId: await otherOrganization(f) }), quantity: 1 }],
    }) },
  { name: 'unknown product id', status: 404, code: 'PRODUCT_NOT_FOUND',
    build: (f) => deliveryBody(f, { items: [{ productId: randomUUID(), quantity: 1 }] }) },
  { name: 'DEMO (non-BUSINESS) product', status: 404, code: 'PRODUCT_NOT_FOUND',
    build: async (f) => {
      const datasetId = (await f.pool.query<{ id: string }>(
        `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
         VALUES ($1, $2, 's3-test', $3) RETURNING id`,
        [f.organizationId, `s3-${randomUUID()}`, f.manager.id],
      )).rows[0]!.id;
      return deliveryBody(f, {
        items: [{ productId: await extraProduct(f, { demoDatasetId: datasetId }), quantity: 1 }],
      });
    } },
  { name: 'one bad line poisons a good batch', status: 404, code: 'PRODUCT_NOT_FOUND',
    build: async (f) => deliveryBody(f, {
      items: [
        { productId: f.products[0], quantity: 1 },
        { productId: await extraProduct(f, { active: false }), quantity: 1 },
      ],
    }) },
];

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 delivery payload validation', () => {
  // CONTRACT-AMBIGUITY: §5.2 names the reused validators but not whether each
  // failure is a pre-lock 400 or an in-transaction 4xx; only the status/code
  // and the "nothing committed" outcome are asserted, never the intent rows.
  it.each(VALIDATION_CASES)('rejects $name and commits nothing', async ({ build, status, code }) => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const delivery = await build(f);
      const before = await world(f);

      const response = await approveSale(f, saleId, {
        clientActionId: 's3-validation', expectedVersion: version, note: APPROVAL_NOTE, delivery,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().code).toBe(code);
      expect(await cardRow(f, saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version });
      expect(await deliveriesOf(f, saleId)).toHaveLength(0);
      expect(await world(f)).toEqual(before);

      // Control: the rejection was about the payload only. A corrected, valid
      // delivery under a NEW key is accepted on the very same sale, so the case
      // cannot pass merely because `delivery` is an unknown body key.
      const corrected = await approveSale(f, saleId, {
        clientActionId: 's3-validation-corrected',
        expectedVersion: version,
        note: APPROVAL_NOTE,
        delivery: await deliveryBody(f),
      });
      expect(corrected.statusCode).toBe(200);
      expect(await deliveriesOf(f, saleId)).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Assignee (§5.2): active same-organization STAFF only
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 delivery assignee', () => {
  it('accepts a different active STAFF member and leaves the sale with its own owner', async () => {
    await withSaleFixture(async (f) => {
      const pair = await waitingPair(f, { followUp: false });

      const response = await approveVisit(f, {
        clientActionId: 's3-other-assignee',
        expectedVersion: pair.visitVersion,
        expectedSaleVersion: pair.saleVersion,
        delivery: await deliveryBody(f, { assignedTo: f.otherStaff.id }),
      });
      expect(response.statusCode).toBe(200);
      const deliveryId = response.json().deliveryJobCardId as string;
      expect((await deliveriesOf(f, pair.saleId))[0]).toMatchObject({
        id: deliveryId, assigned_to: f.otherStaff.id, created_by: f.manager.id, status: 'NEW',
      });
      // The pair's owner is unchanged (sale and visit stay with the sale's staff).
      expect((await cardRow(f, pair.saleId)).assigned_to).toBe(f.staff.id);
      expect((await cardRow(f, f.visitId)).assigned_to).toBe(f.staff.id);
      expect((await activities(f, pair.saleId, 'SALE_DELIVERY_CREATED'))[0]!.metadata)
        .toMatchObject({ assignedTo: f.otherStaff.id });

      // The offer is addressed to the delivery staff, not the sale's staff.
      const offers = (await f.pool.query<{ assignee_user_id: string; opened_reason: string }>(
        'SELECT assignee_user_id, opened_reason FROM job_card_assignment_offers WHERE job_card_id = $1',
        [deliveryId],
      )).rows;
      expect(offers).toEqual([{ assignee_user_id: f.otherStaff.id, opened_reason: 'SALE_APPROVAL' }]);

      // Realtime: a staff member who cannot read the sale never receives its id.
      const events = (await f.pool.query<{
        entity_id: string;
        event_type: string;
        audience_user_ids: string[];
        resource_keys: string[];
      }>('SELECT entity_id, event_type, audience_user_ids, resource_keys FROM realtime_events')).rows;
      const toOtherStaff = events.filter((event) => event.audience_user_ids.includes(f.otherStaff.id));
      expect(toOtherStaff.some((event) => event.entity_id === deliveryId)).toBe(true);
      for (const event of toOtherStaff) {
        expect(JSON.stringify(event)).not.toContain(pair.saleId);
      }
    });
  });

  it('works for an independent sale as well', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const response = await approveSale(f, saleId, {
        clientActionId: 's3-standalone-other-assignee',
        expectedVersion: version,
        delivery: await deliveryBody(f, { assignedTo: f.otherStaff.id }),
      });
      expect(response.statusCode).toBe(200);
      expect((await deliveriesOf(f, saleId))[0]).toMatchObject({ assigned_to: f.otherStaff.id });
      expect((await cardRow(f, saleId)).assigned_to).toBe(f.staff.id);
    });
  });

  // CONTRACT-AMBIGUITY: §5.2 says the assignee must satisfy assertCanCreateForAssignee
  // (FORBIDDEN 403 for inactive / non-STAFF) but does not state the code for an
  // assignee of another organization (locked lookup miss: 404 vs 403). Only the
  // 4xx class and the "nothing committed" outcome are asserted.
  it.each([
    ['an inactive STAFF user', async (f: Fixture) => {
      const user = await f.user('STAFF');
      await f.pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [user.id]);
      return user.id;
    }],
    ['a MANAGER', async (f: Fixture) => f.manager.id],
    ['an ADMIN', async (f: Fixture) => f.admin.id],
    ['a STAFF user of another organization', async (f: Fixture) => (await f.user('STAFF', await otherOrganization(f))).id],
    ['an unknown user id', async () => randomUUID()],
  ] as const)('rejects %s as the assignee and commits nothing', async (_name, makeAssignee) => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const assignedTo = await makeAssignee(f);
      const before = await world(f);

      const response = await approveSale(f, saleId, {
        clientActionId: 's3-bad-assignee',
        expectedVersion: version,
        delivery: await deliveryBody(f, { assignedTo }),
      });
      expect([403, 404]).toContain(response.statusCode);
      expect(await cardRow(f, saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version });
      expect(await deliveriesOf(f, saleId)).toHaveLength(0);
      expect(await world(f)).toEqual(before);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Inactive customer: blocks only the delivery, atomically; corrected retry needs a new key
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 inactive customer', () => {
  it('rejects an independent approval with CUSTOMER_INACTIVE, then refuses the same key and accepts a new one', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      await f.pool.query("UPDATE customers SET status = 'inactive' WHERE id = $1", [f.customerId]);
      const before = await world(f);
      const payload = {
        clientActionId: 's3-inactive-customer',
        expectedVersion: version,
        note: APPROVAL_NOTE,
        delivery: await deliveryBody(f),
      };

      const failed = await approveSale(f, saleId, payload);
      expect(failed.statusCode).toBe(409);
      expect(failed.json().code).toBe('CUSTOMER_INACTIVE');
      // No partial approval.
      expect(await cardRow(f, saleId)).toMatchObject({
        status: 'WAITING_APPROVAL', version, manager_approved_by: null,
      });
      expect(await deliveriesOf(f, saleId)).toHaveLength(0);
      expect(await world(f)).toEqual(before);
      const intents = await intentsFor(f, 's3-inactive-customer');
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ job_card_id: saleId, state: 'FAILED', failure_code: 'CUSTOMER_INACTIVE' });

      // The customer is repaired, yet the SAME key stays terminal (049 FAILED).
      await f.pool.query("UPDATE customers SET status = 'active' WHERE id = $1", [f.customerId]);
      const retried = await approveSale(f, saleId, payload);
      expect(retried.statusCode).toBe(409);
      // CONTRACT-AMBIGUITY: §5.4 names `lifecycleIntentError` ("Yeni bir işlem
      // anahtarıyla tekrar deneyin"); its code is the stored failure code today.
      expect(retried.json().error).toContain('Yeni bir işlem anahtarıyla');
      expect(await cardRow(f, saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version });
      expect(await deliveriesOf(f, saleId)).toHaveLength(0);

      // A corrected attempt with a NEW key succeeds.
      const corrected = await approveSale(f, saleId, { ...payload, clientActionId: 's3-inactive-customer-2' });
      expect(corrected.statusCode).toBe(200);
      expect(await cardRow(f, saleId)).toMatchObject({ status: 'COMPLETED' });
      expect(await deliveriesOf(f, saleId)).toHaveLength(1);
    });
  });

  it('fails the whole pair together: both cards stay WAITING_APPROVAL and both intents FAILED', async () => {
    await withSaleFixture(async (f) => {
      const pair = await waitingPair(f, { followUp: false });
      await f.pool.query("UPDATE customers SET status = 'inactive' WHERE id = $1", [f.customerId]);
      const before = await world(f);
      const payload = {
        clientActionId: 's3-pair-inactive',
        expectedVersion: pair.visitVersion,
        expectedSaleVersion: pair.saleVersion,
        note: APPROVAL_NOTE,
        delivery: await deliveryBody(f),
      };

      const failed = await approveVisit(f, payload);
      expect(failed.statusCode).toBe(409);
      expect(failed.json().code).toBe('CUSTOMER_INACTIVE');
      expect(await cardRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL', version: pair.visitVersion });
      expect(await cardRow(f, pair.saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version: pair.saleVersion });
      expect(await deliveriesOf(f, pair.saleId)).toHaveLength(0);
      expect(await world(f)).toEqual(before);
      const intents = await intentsFor(f, 's3-pair-inactive');
      expect(intents).toHaveLength(2);
      expect(intents.every((row) => row.state === 'FAILED' && row.failure_code === 'CUSTOMER_INACTIVE')).toBe(true);
      expect(intents[0]!.failed_at!.getTime()).toBe(intents[1]!.failed_at!.getTime());

      await f.pool.query("UPDATE customers SET status = 'active' WHERE id = $1", [f.customerId]);
      const retried = await approveVisit(f, payload);
      expect(retried.statusCode).toBe(409);
      expect(retried.json().error).toContain('Yeni bir işlem anahtarıyla');
      expect(await cardRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL' });

      const corrected = await approveVisit(f, { ...payload, clientActionId: 's3-pair-inactive-2' });
      expect(corrected.statusCode).toBe(200);
      expect(corrected.json()).toMatchObject({ status: 'COMPLETED', linkedSaleJobCardId: pair.saleId });
      expect(await deliveriesOf(f, pair.saleId)).toHaveLength(1);
    });
  });

  it('blocks only the delivery: an approval without the payload still completes', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      await f.pool.query("UPDATE customers SET status = 'inactive' WHERE id = $1", [f.customerId]);
      const response = await approveSale(f, saleId, {
        clientActionId: 's3-inactive-no-delivery', expectedVersion: version,
      });
      expect(response.statusCode).toBe(200);
      expect(await cardRow(f, saleId)).toMatchObject({ status: 'COMPLETED' });
      expect(await deliveriesOf(f, saleId)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. JOB-010 interplay: window, past start, acknowledgement (§5.4)
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 assignment window interplay', () => {
  it('walks too-short -> past-start -> acknowledged, each correction with a NEW key', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const before = await world(f);

      // Start 25 minutes ago: the 30-minute window ends in 5 minutes (< the 10-minute minimum).
      const tooShortAt = plusMinutes(await instant(f, 0), -25);
      const tooShort = await approveSale(f, saleId, {
        clientActionId: 's3-window-1', expectedVersion: version,
        delivery: await deliveryBody(f, { scheduledAt: tooShortAt }),
      });
      expect(tooShort.statusCode).toBe(409);
      expect(tooShort.json().code).toBe('ASSIGNMENT_WINDOW_TOO_SHORT');
      expect(await world(f)).toEqual(before);
      expect(await cardRow(f, saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version });
      expect((await intentsFor(f, 's3-window-1'))[0]).toMatchObject({
        state: 'FAILED', failure_code: 'ASSIGNMENT_WINDOW_TOO_SHORT',
      });

      // Start 5 minutes ago: the window fits, but the start has passed -> acknowledgement required.
      const pastAt = plusMinutes(await instant(f, 0), -5);
      const past = await approveSale(f, saleId, {
        clientActionId: 's3-window-2', expectedVersion: version,
        delivery: await deliveryBody(f, { scheduledAt: pastAt }),
      });
      expect(past.statusCode).toBe(409);
      expect(past.json().code).toBe('PAST_START_ACKNOWLEDGEMENT_REQUIRED');
      expect(await world(f)).toEqual(before);
      expect(await cardRow(f, saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version });

      // Same key, identical body: still terminal (049 FAILED).
      const sameKey = await approveSale(f, saleId, {
        clientActionId: 's3-window-1', expectedVersion: version,
        delivery: await deliveryBody(f, { scheduledAt: tooShortAt }),
      });
      expect(sameKey.statusCode).toBe(409);
      expect(sameKey.json().error).toContain('Yeni bir işlem anahtarıyla');
      // Same key, corrected time: the request identity check (ARC-001) runs
      // before the FAILED state check, so a changed body is CLIENT_ACTION_REUSED.
      // Either way the key is spent and the client must mint a new one (§5.4).
      const sameKeyCorrected = await approveSale(f, saleId, {
        clientActionId: 's3-window-1', expectedVersion: version,
        delivery: await deliveryBody(f),
      });
      expect(sameKeyCorrected.statusCode).toBe(409);
      expect(sameKeyCorrected.json().code).toBe('CLIENT_ACTION_REUSED');
      expect(await deliveriesOf(f, saleId)).toHaveLength(0);

      // With the acknowledgement (new key) it succeeds and the offer records it.
      const acknowledged = await approveSale(f, saleId, {
        clientActionId: 's3-window-3', expectedVersion: version,
        delivery: await deliveryBody(f, { scheduledAt: pastAt, pastStartAcknowledgement: ACK }),
      });
      expect(acknowledged.statusCode).toBe(200);
      const deliveryId = acknowledged.json().deliveryJobCardId as string;
      const offers = (await f.pool.query<{
        opened_reason: string; urgent_reason: string | null; ack_code: string | null; ack_text: string | null;
      }>(
        'SELECT opened_reason, urgent_reason, ack_code, ack_text FROM job_card_assignment_offers WHERE job_card_id = $1',
        [deliveryId],
      )).rows;
      expect(offers).toEqual([{
        opened_reason: 'SALE_APPROVAL',
        urgent_reason: 'START_PASSED',
        ack_code: ACK.code,
        ack_text: ACK.text,
      }]);
    });
  });

  it('opens a SHORT_NOTICE offer, without any acknowledgement, for a start soon in the future', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const response = await approveSale(f, saleId, {
        clientActionId: 's3-short-notice', expectedVersion: version,
        delivery: await deliveryBody(f, { scheduledAt: await instant(f, 30 * MINUTE_MS) }),
      });
      expect(response.statusCode).toBe(200);
      const offers = (await f.pool.query<{ opened_reason: string; urgent_reason: string | null }>(
        'SELECT opened_reason, urgent_reason FROM job_card_assignment_offers WHERE job_card_id = $1',
        [response.json().deliveryJobCardId],
      )).rows;
      expect(offers).toEqual([{ opened_reason: 'SALE_APPROVAL', urgent_reason: 'SHORT_NOTICE' }]);
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Idempotency (§4.5)
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 idempotency', () => {
  it('replays an identical approval with the same response, the same delivery and no new rows or events', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const published: RealtimeEventRecord[] = [];
      const service = windowedService(f, published);
      const payload = {
        clientActionId: 's3-replay',
        expectedVersion: version,
        note: APPROVAL_NOTE,
        delivery: await deliveryBody(f, { note: DELIVERY_NOTE }),
      };

      const first = await approveSale(f, saleId, payload, f.manager, service);
      expect(first.statusCode).toBe(200);
      const deliveryId = first.json().deliveryJobCardId as string;
      const afterFirst = await world(f);
      const publishedAfterFirst = published.length;
      expect(publishedAfterFirst).toBeGreaterThan(0);

      const replay = await approveSale(f, saleId, payload, f.manager, service);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(replay.json().deliveryJobCardId).toBe(deliveryId);
      expect(await world(f)).toEqual(afterFirst);
      expect(published).toHaveLength(publishedAfterFirst);
      expect(await deliveriesOf(f, saleId)).toHaveLength(1);
      expect(await activities(f, saleId, 'SALE_DELIVERY_CREATED')).toHaveLength(1);
    });
  });

  it('replays an identical pair approval with the same delivery and no new rows', async () => {
    await withSaleFixture(async (f) => {
      const pair = await waitingPair(f, { followUp: true });
      const payload = {
        clientActionId: 's3-pair-replay',
        expectedVersion: pair.visitVersion,
        expectedSaleVersion: pair.saleVersion,
        note: APPROVAL_NOTE,
        delivery: await deliveryBody(f),
      };
      const first = await approveVisit(f, payload);
      expect(first.statusCode).toBe(200);
      const afterFirst = await world(f);

      const replay = await approveVisit(f, payload);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(replay.json()).toMatchObject({
        deliveryJobCardId: first.json().deliveryJobCardId,
        followUpJobCardId: first.json().followUpJobCardId,
        linkedSaleJobCardId: pair.saleId,
      });
      expect(await world(f)).toEqual(afterFirst);
    });
  });

  it('rejects the same key with a changed delivery payload as CLIENT_ACTION_REUSED', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const base = await deliveryBody(f, { note: DELIVERY_NOTE });
      const payload = { clientActionId: 's3-reused', expectedVersion: version, delivery: base };
      const first = await approveSale(f, saleId, payload);
      expect(first.statusCode).toBe(200);
      const afterFirst = await world(f);

      const variants: Array<[string, Record<string, unknown>]> = [
        ['other quantity', { ...base, items: [{ productId: f.products[0], quantity: 3 }] }],
        ['other assignee', { ...base, assignedTo: f.otherStaff.id }],
        ['other time', { ...base, scheduledAt: plusMinutes(base.scheduledAt as string, 60) }],
        ['other note', { ...base, note: 'Başka not.' }],
        ['other purpose', { ...base, deliveryPurpose: 'SAMPLE' }],
        ['extra line', {
          ...base,
          items: [
            { productId: f.products[0], quantity: 2 },
            { productId: f.products[1], quantity: 1 },
          ],
        }],
      ];
      for (const [label, delivery] of variants) {
        const reused = await approveSale(f, saleId, { ...payload, delivery });
        expect(reused.statusCode, label).toBe(409);
        expect(reused.json().code, label).toBe('CLIENT_ACTION_REUSED');
      }

      // delivery removed under the same key.
      const removed = await approveSale(f, saleId, { clientActionId: 's3-reused', expectedVersion: version });
      expect(removed.statusCode).toBe(409);
      expect(removed.json().code).toBe('CLIENT_ACTION_REUSED');

      expect(await world(f)).toEqual(afterFirst);
      expect(await deliveriesOf(f, saleId)).toHaveLength(1);
    });
  });

  it('rejects the same key when a delivery is ADDED to an already committed plain approval', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const plain = { clientActionId: 's3-reused-added', expectedVersion: version };
      expect((await approveSale(f, saleId, plain)).statusCode).toBe(200);
      const afterFirst = await world(f);

      const added = await approveSale(f, saleId, { ...plain, delivery: await deliveryBody(f) });
      expect(added.statusCode).toBe(409);
      expect(added.json().code).toBe('CLIENT_ACTION_REUSED');
      expect(await world(f)).toEqual(afterFirst);
      expect(await deliveriesOf(f, saleId)).toHaveLength(0);
    });
  });

  it('treats a changed delivery in a pair approval as CLIENT_ACTION_REUSED too', async () => {
    await withSaleFixture(async (f) => {
      const pair = await waitingPair(f, { followUp: false });
      const payload = {
        clientActionId: 's3-pair-reused',
        expectedVersion: pair.visitVersion,
        expectedSaleVersion: pair.saleVersion,
        delivery: await deliveryBody(f),
      };
      expect((await approveVisit(f, payload)).statusCode).toBe(200);
      const afterFirst = await world(f);

      const changed = await approveVisit(f, {
        ...payload,
        delivery: await deliveryBody(f, { items: [{ productId: f.products[0], quantity: 5 }] }),
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('CLIENT_ACTION_REUSED');
      expect(await world(f)).toEqual(afterFirst);
    });
  });
});

// ---------------------------------------------------------------------------
// 10. One delivery per sale (071 unique index) is a domain 409, never a 500
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 one delivery per sale', () => {
  it('maps an already-linked delivery to 409 SALE_DELIVERY_ALREADY_EXISTS and commits nothing', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      // A delivery already hangs off the sale (e.g. written by another path): only
      // the 071 unique index can catch it, because no SALE_DELIVERY_CREATED fact exists.
      const existing = await f.service.createProductDelivery(f.manager, {
        clientActionId: 's3-preexisting-delivery',
        type: 'PRODUCT_DELIVERY',
        title: 'Önceden bağlanmış teslim',
        description: null,
        customerId: f.customerId,
        contactId: null,
        assignedTo: f.staff.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: '2026-10-14T11:00:00.000Z',
        scheduledEndsAt: '2026-10-14T11:30:00.000Z',
        overrideReason: null,
        deliveryPurpose: 'SALE',
        deliveryNote: null,
        items: [{ productId: f.products[0]!, quantity: 1 }],
      });
      await f.pool.query('UPDATE job_cards SET delivery_source_sale_id = $2 WHERE id = $1',
        [existing.jobCardId, saleId]);
      const before = await world(f);

      const response = await approveSale(f, saleId, {
        clientActionId: 's3-second-delivery',
        expectedVersion: version,
        delivery: await deliveryBody(f),
      });
      // CONTRACT-AMBIGUITY: §4.8 names the code (409 SALE_DELIVERY_ALREADY_EXISTS) for the
      // second-delivery case; §3 says the unique index is the last authority. A raw
      // unique violation surfacing as 500 is the failure this test exists to catch.
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('SALE_DELIVERY_ALREADY_EXISTS');
      expect(await cardRow(f, saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version });
      expect(await world(f)).toEqual(before);
      expect(await deliveriesOf(f, saleId)).toHaveLength(1);
    });
  });

  it('keeps the index as the last authority after a real approval created the delivery', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const approved = await approveSale(f, saleId, {
        clientActionId: 's3-one-delivery', expectedVersion: version, delivery: await deliveryBody(f),
      });
      expect(approved.statusCode).toBe(200);

      const second = await f.service.createProductDelivery(f.manager, {
        clientActionId: 's3-one-delivery-extra',
        type: 'PRODUCT_DELIVERY',
        title: 'Ek teslim',
        description: null,
        customerId: f.customerId,
        contactId: null,
        assignedTo: f.staff.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: '2026-10-14T12:00:00.000Z',
        scheduledEndsAt: '2026-10-14T12:30:00.000Z',
        overrideReason: null,
        deliveryPurpose: 'SALE',
        deliveryNote: null,
        items: [{ productId: f.products[1]!, quantity: 1 }],
      });
      await expect(f.pool.query(
        'UPDATE job_cards SET delivery_source_sale_id = $2 WHERE id = $1', [second.jobCardId, saleId],
      )).rejects.toMatchObject({ code: '23505', constraint: 'job_cards_one_delivery_per_sale_idx' });
      expect(await deliveriesOf(f, saleId)).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 11. Read side (§5.5, §8.1)
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 read side', () => {
  // CONTRACT-AMBIGUITY: §8.1 names `deliverySourceSaleId` (delivery detail) and a
  // "Bağlı teslimat" panel (sale detail) but does not fix where the fields sit in
  // the DTO. The helpers search the whole JSON of GET /:id (and, for the sale,
  // GET /:id/sale-details) for the key, so placement is free but the value is not.
  async function deliveryDetail(f: Fixture, actor: JobCardActor, deliveryId: string) {
    return call(f, actor, { method: 'GET', url: `/api/job-cards/${deliveryId}` });
  }

  async function saleViews(f: Fixture, actor: JobCardActor, saleId: string) {
    const detail = await call(f, actor, { method: 'GET', url: `/api/job-cards/${saleId}?includeSaleCapability=true` });
    const saleDetails = await call(f, actor, {
      method: 'GET', url: `/api/job-cards/${saleId}/sale-details?includeSaleCapability=true`,
    });
    expect(detail.statusCode).toBe(200);
    expect(saleDetails.statusCode).toBe(200);
    return [detail.json(), saleDetails.json()] as unknown[];
  }

  it('exposes linkedDelivery {id, status} on the sale only after the approval', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);

      for (const view of await saleViews(f, f.manager, saleId)) {
        const hit = findKey(view, 'linkedDelivery');
        if (hit.found) expect(hit.value ?? null).toBeNull();
      }

      const approved = await approveSale(f, saleId, {
        clientActionId: 's3-read-linked', expectedVersion: version, delivery: await deliveryBody(f),
      });
      expect(approved.statusCode).toBe(200);
      const deliveryId = approved.json().deliveryJobCardId as string;

      for (const viewer of [f.manager, f.staff]) {
        const hits = (await saleViews(f, viewer, saleId)).map((view) => findKey(view, 'linkedDelivery'));
        const exposed = hits.filter((hit) => hit.found && hit.value);
        expect(exposed.length, `linkedDelivery missing for ${viewer.role}`).toBeGreaterThan(0);
        for (const hit of exposed) {
          expect(hit.value).toMatchObject({ id: deliveryId, status: 'NEW' });
        }
      }
    });
  });

  it('shows deliverySourceSaleId to a viewer who can read the sale, and hides it from one who cannot', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const approved = await approveSale(f, saleId, {
        clientActionId: 's3-read-provenance',
        expectedVersion: version,
        delivery: await deliveryBody(f, { assignedTo: f.otherStaff.id }),
      });
      expect(approved.statusCode).toBe(200);
      const deliveryId = approved.json().deliveryJobCardId as string;

      // Management reads the sale: provenance is exposed.
      const asManager = await deliveryDetail(f, f.manager, deliveryId);
      expect(asManager.statusCode).toBe(200);
      expect(findKey(asManager.json(), 'deliverySourceSaleId')).toEqual({ found: true, value: saleId });

      // The delivery's own staff cannot read the (other staff's) sale: no id anywhere.
      const asAssignee = await deliveryDetail(f, f.otherStaff, deliveryId);
      expect(asAssignee.statusCode).toBe(200);
      const hidden = findKey(asAssignee.json(), 'deliverySourceSaleId');
      expect(hidden.found ? hidden.value ?? null : null).toBeNull();
      expect(JSON.stringify(asAssignee.json())).not.toContain(saleId);

      // The sale itself is not readable by that staff member either.
      const saleAsOther = await call(f, f.otherStaff, {
        method: 'GET', url: `/api/job-cards/${saleId}?includeSaleCapability=true`,
      });
      expect(saleAsOther.statusCode).toBe(404);
    });
  });

  it('shows deliverySourceSaleId to the sale owner when the delivery stays with the sale staff', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const approved = await approveSale(f, saleId, {
        clientActionId: 's3-read-owner', expectedVersion: version, delivery: await deliveryBody(f),
      });
      const deliveryId = approved.json().deliveryJobCardId as string;
      const asOwner = await deliveryDetail(f, f.staff, deliveryId);
      expect(asOwner.statusCode).toBe(200);
      expect(findKey(asOwner.json(), 'deliverySourceSaleId')).toEqual({ found: true, value: saleId });
    });
  });

  it('keeps deliverySourceSaleId null for an ordinary delivery', async () => {
    await withSaleFixture(async (f) => {
      const ordinary = await f.service.createProductDelivery(f.manager, {
        clientActionId: 's3-read-ordinary',
        type: 'PRODUCT_DELIVERY',
        title: 'Sıradan teslim',
        description: null,
        customerId: f.customerId,
        contactId: null,
        assignedTo: f.staff.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: '2026-10-14T11:00:00.000Z',
        scheduledEndsAt: '2026-10-14T11:30:00.000Z',
        overrideReason: null,
        deliveryPurpose: 'SALE',
        deliveryNote: null,
        items: [{ productId: f.products[0]!, quantity: 1 }],
      });
      const detail = await deliveryDetail(f, f.manager, ordinary.jobCardId);
      expect(detail.statusCode).toBe(200);
      const hit = findKey(detail.json(), 'deliverySourceSaleId');
      expect(hit.found ? hit.value ?? null : null).toBeNull();
    });
  });

  it('presents SALE_DELIVERY_CREATED in the sale activity feed with only the documented shape', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const approved = await approveSale(f, saleId, {
        clientActionId: 's3-read-activity', expectedVersion: version, delivery: await deliveryBody(f),
      });
      const deliveryId = approved.json().deliveryJobCardId as string;
      const feed = await call(f, f.manager, {
        method: 'GET', url: `/api/job-cards/${saleId}/activity?includeSaleCapability=true`,
      });
      expect(feed.statusCode).toBe(200);
      const text = JSON.stringify(feed.json());
      expect(text).toContain('SALE_DELIVERY_CREATED');
      expect(text).toContain(deliveryId);
      // §5.5: raw internal payloads are not emitted.
      expect(text).not.toContain('clientActionId');
    });
  });
});

// ---------------------------------------------------------------------------
// 12. Authorization
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 approval authorization', () => {
  it('forbids STAFF from approving an independent sale even with a delivery payload', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const before = await world(f);
      // The owner may read the sale and is refused the management command
      // (403); another STAFF member cannot read it and gets the existing
      // concealment 404 — never a hint that the sale exists.
      for (const [actor, status] of [[f.staff, 403], [f.otherStaff, 404]] as const) {
        const response = await approveSale(f, saleId, {
          clientActionId: `s3-staff-approve-${actor.id}`,
          expectedVersion: version,
          delivery: await deliveryBody(f),
        }, actor);
        expect(response.statusCode).toBe(status);
      }
      expect(await cardRow(f, saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version });
      expect(await world(f)).toEqual(before);
    });
  });

  it('forbids STAFF from approving a pair with a delivery payload', async () => {
    await withSaleFixture(async (f) => {
      const pair = await waitingPair(f, { followUp: false });
      const before = await world(f);
      const response = await approveVisit(f, {
        clientActionId: 's3-staff-pair-approve',
        expectedVersion: pair.visitVersion,
        expectedSaleVersion: pair.saleVersion,
        delivery: await deliveryBody(f),
      }, f.staff);
      expect(response.statusCode).toBe(403);
      expect(await cardRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL' });
      expect(await cardRow(f, pair.saleId)).toMatchObject({ status: 'WAITING_APPROVAL' });
      expect(await world(f)).toEqual(before);
    });
  });

  it('does not let a manager of another organization approve or open a delivery', async () => {
    await withSaleFixture(async (f) => {
      const { saleId, version } = await waitingStandalone(f);
      const foreign = await f.user('MANAGER', await otherOrganization(f));
      const before = await world(f);
      const response = await approveSale(f, saleId, {
        clientActionId: 's3-foreign-manager', expectedVersion: version, delivery: await deliveryBody(f),
      }, foreign);
      expect([403, 404]).toContain(response.statusCode);
      expect(await cardRow(f, saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version });
      expect(await world(f)).toEqual(before);
    });
  });
});


describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 approval without delivery (window on, follow-up)', () => {
  it('still completes a pair and creates its follow-up child with no delivery payload', async () => {
    await withSaleFixture(async (f) => {
      const pair = await waitingPair(f, { followUp: true });
      const response = await approveVisit(f, {
        clientActionId: 'probe', expectedVersion: pair.visitVersion, expectedSaleVersion: pair.saleVersion,
      });
      expect(response.statusCode).toBe(200);
      expect(typeof response.json().followUpJobCardId).toBe('string');
      expect(await count(f, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'PRODUCT_DELIVERY'")).toBe(0);
    });
  });
});
