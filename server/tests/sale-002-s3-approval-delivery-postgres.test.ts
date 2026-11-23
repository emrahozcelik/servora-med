import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { toErrorResponse } from '../src/errors/index.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { waitFor } from './support/lifecycle-intent-harness.js';
import { saleFixture, saleTime, standaloneSale, withSaleFixture } from './support/sale-harness.js';

/**
 * SALE-002 slice S3 (backend) — sale approval opens the delivery atomically.
 * Owning contract: docs/features/visit-to-sale/sale-002-contract.md
 *   §5.1 API shape, §5.2 validation reuse, §5.3 card properties, §5.4 JOB-010
 *   interplay and the FAILED retry rule, §5.5 atomicity/activity/realtime,
 *   §4.5 request identity, §4.8 edge cases, §9.3 delivery bullets.
 */

type Fixture = Awaited<ReturnType<typeof saleFixture>>;

const MEETING_AT = '2026-10-14T07:50:00.000Z';
// The lifecycle business instant is the database clock (reserved_at), not the
// injected service clock, so every planned time is relative to the real now.
const MINUTE = 60_000;
const at = (offsetMs: number) => new Date(Math.floor((Date.now() + offsetMs) / MINUTE) * MINUTE).toISOString();
const DELIVERY_AT = at(2 * 24 * 60 * MINUTE);
const DELIVERY_ENDS_AT = new Date(Date.parse(DELIVERY_AT) + 30 * MINUTE).toISOString();
const LATER_DELIVERY_AT = at(3 * 24 * 60 * MINUTE);

/** The fixture service, but with the JOB-010 window on and a capturing publisher. */
function windowService(f: Fixture) {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  const service = new JobCardService(
    f.repository, () => saleTime, publisher,
    { enabled: false }, { enabled: false }, { enabled: false, reminderLeadMinutes: 30 },
    {}, { enabled: true },
  );
  return { service, published };
}
type Service = ReturnType<typeof windowService>['service'];

function deliveryBody(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    assignedTo: f.otherStaff.id,
    scheduledAt: DELIVERY_AT,
    items: [
      { productId: f.products[0]!, quantity: 2 },
      { productId: f.products[1]!, quantity: 15 },
    ],
    ...overrides,
  };
}

async function count(f: Fixture, sql: string, values: unknown[] = []) {
  return (await f.pool.query<{ n: number }>(sql, values)).rows[0]!.n;
}

async function status(f: Fixture, jobCardId: string) {
  return (await f.pool.query<{ status: string; version: number }>(
    'SELECT status, version FROM job_cards WHERE id = $1', [jobCardId],
  )).rows[0]!;
}

/** A standalone sale, submitted and waiting for the manager. */
async function waitingStandalone(f: Fixture, service: Service, key = 's3') {
  const sale = await standaloneSale(f, { clientActionId: `${key}-standalone` });
  const submitted = await service.submitForApproval(f.staff, sale.jobCardId, {
    clientActionId: `${key}-submit`, expectedVersion: sale.version, note: 'Telefon siparişi.',
  });
  return { saleId: sale.jobCardId, version: submitted.version };
}

/** A coordinated visit + sale pair, submitted together and waiting for the manager. */
async function waitingPair(f: Fixture, service: Service, key = 's3') {
  const sale = await service.createSaleFromVisit(f.staff, f.visitId, {
    ...f.input, clientActionId: `${key}-sale-create`,
  });
  const details = await service.patchMeetingDetails(f.staff, f.visitId, {
    clientActionId: `${key}-meeting`,
    expectedVersion: f.input.expectedSourceVersion,
    meetingAt: MEETING_AT,
    outcome: 'FOLLOW_UP_REQUIRED',
    unsuccessfulReason: 'REQUESTED_LATER',
    meetingSummary: 'Klinik yetkilisiyle görüşüldü; takip planlandı.',
    nextFollowUpAt: null,
  });
  const submitted = await service.submitForApproval(f.staff, f.visitId, {
    clientActionId: `${key}-pair-submit`,
    expectedVersion: details.jobCardVersion,
    expectedSaleVersion: sale.version,
    note: 'Ziyaret ve bağlı satış kaydı onaya hazır.',
  });
  const saleRow = await status(f, sale.jobCardId);
  return { saleId: sale.jobCardId, saleVersion: saleRow.version, visitVersion: submitted.version };
}

async function expectUntouched(f: Fixture, ids: string[], expected: string) {
  for (const id of ids) expect((await status(f, id)).status).toBe(expected);
  expect(await count(f, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'PRODUCT_DELIVERY'")).toBe(0);
  expect(await count(f,
    "SELECT count(*)::int AS n FROM job_card_activity_logs WHERE event_type = 'SALE_DELIVERY_CREATED'")).toBe(0);
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S3 sale approval delivery', { timeout: 60_000 }, () => {
  it('approves an independent sale and opens the delivery in the same transaction', async () => {
    await withSaleFixture(async (f) => {
      const { service, published } = windowService(f);
      const { saleId, version } = await waitingStandalone(f, service);

      const approved = await service.approve(f.manager, saleId, {
        clientActionId: 's3-standalone-approve',
        expectedVersion: version,
        note: 'Satış onaylandı.',
        delivery: deliveryBody(f, { note: '  Kapıda ödeme yok.  ', deliveryPurpose: 'SAMPLE' }),
      });
      expect(approved).toMatchObject({ status: 'COMPLETED', id: saleId });
      const deliveryId = (approved as { deliveryJobCardId?: string }).deliveryJobCardId!;
      expect(typeof deliveryId).toBe('string');
      expect(approved).not.toHaveProperty('linkedSaleJobCardId');

      // §5.3 card properties.
      const card = (await f.pool.query<Record<string, unknown>>(
        `SELECT type, status, data_class, title, description, customer_id, contact_id, assigned_to,
                created_by, priority, due_date, scheduled_at, scheduled_ends_at,
                source_job_card_id, delivery_source_sale_id, accepted_at
           FROM job_cards WHERE id = $1`, [deliveryId],
      )).rows[0]!;
      expect(card).toMatchObject({
        type: 'PRODUCT_DELIVERY', status: 'NEW', data_class: 'BUSINESS',
        title: 'Telefon siparişi', description: 'Kapıda ödeme yok.',
        customer_id: f.customerId, contact_id: null, assigned_to: f.otherStaff.id,
        created_by: f.manager.id, due_date: null, source_job_card_id: null,
        delivery_source_sale_id: saleId, accepted_at: null,
      });
      expect((card.scheduled_at as Date).toISOString()).toBe(DELIVERY_AT);
      expect((card.scheduled_ends_at as Date).toISOString()).toBe(DELIVERY_ENDS_AT);

      // §5.2: planned items, whole units, the purpose, and the note is never a deliveryNote.
      const items = (await f.pool.query<{
        product_id: string; quantity: string; delivered_at: Date | null;
        delivery_purpose: string; delivery_note: string | null;
      }>(
        `SELECT product_id, quantity, delivered_at, delivery_purpose, delivery_note
           FROM job_card_delivery_items WHERE job_card_id = $1 ORDER BY created_at, id`, [deliveryId],
      )).rows;
      expect(items).toHaveLength(2);
      // Rows of one transaction share created_at; compare as a set of lines.
      expect(items.map((item) => `${item.product_id}:${Number(item.quantity)}`).sort())
        .toEqual([`${f.products[0]}:2`, `${f.products[1]}:15`].sort());
      expect(items.every((item) => item.delivered_at === null
        && item.delivery_purpose === 'SAMPLE' && item.delivery_note === null)).toBe(true);

      // §5.5 activities: JOB_CREATED + one DELIVERY_ITEM_ADDED per line, the sale fact.
      const deliveryEvents = (await f.pool.query<{ event_type: string }>(
        'SELECT event_type FROM job_card_activity_logs WHERE job_card_id = $1 ORDER BY created_at, id',
        [deliveryId],
      )).rows.map((row) => row.event_type);
      expect(deliveryEvents.filter((type) => type === 'JOB_CREATED')).toHaveLength(1);
      expect(deliveryEvents.filter((type) => type === 'DELIVERY_ITEM_ADDED')).toHaveLength(2);
      const fact = (await f.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'SALE_DELIVERY_CREATED'`, [saleId],
      )).rows;
      expect(fact).toHaveLength(1);
      expect(fact[0]!.metadata).toEqual({
        deliveryJobCardId: deliveryId,
        assignedTo: f.otherStaff.id,
        scheduledAt: DELIVERY_AT,
        itemCount: 2,
        items: [
          { productId: f.products[0], quantity: 2 },
          { productId: f.products[1], quantity: 15 },
        ],
      });

      // §5.4: the manager-created delivery is a direct JOB-010 producer.
      const offers = (await f.pool.query<{ opened_reason: string; state: string; assignee_user_id: string }>(
        `SELECT opened_reason, state, assignee_user_id FROM job_card_assignment_offers WHERE job_card_id = $1`,
        [deliveryId],
      )).rows;
      expect(offers).toEqual([{
        opened_reason: 'SALE_APPROVAL', state: 'OPEN', assignee_user_id: f.otherStaff.id,
      }]);

      // §5.1: the receipt stores the id; the presented detail replays it.
      const receipt = (await f.pool.query<{ response_body: Record<string, unknown> }>(
        `SELECT response_body FROM processed_actions WHERE operation_key = $1`,
        [`JOB_APPROVE:${saleId}`],
      )).rows;
      expect(receipt).toHaveLength(1);
      expect(receipt[0]!.response_body).toMatchObject({ jobCardId: saleId, deliveryJobCardId: deliveryId });

      // §5.5 realtime: after commit, delivery events reach the assignee, the
      // sale owner and management, and never carry the sale's detail key.
      const createdEvent = published.find((event) => event.entityId === deliveryId && event.type === 'job.created')!;
      expect(createdEvent).toBeDefined();
      expect(createdEvent.audience.roles).toEqual(['ADMIN', 'MANAGER']);
      expect(createdEvent.audience.userIds).toEqual([f.staff.id, f.otherStaff.id].sort());
      expect(published.filter((event) => event.entityId === deliveryId)
        .every((event) => !event.resourceKeys.includes(`job-detail:${saleId}`))).toBe(true);
      expect(published.some((event) => event.entityId === deliveryId && event.type === 'job.updated')).toBe(true);
    });
  });

  it('defaults the delivery assignee to the sale assignee and applies the default purpose', async () => {
    await withSaleFixture(async (f) => {
      const { service } = windowService(f);
      const { saleId, version } = await waitingStandalone(f, service);
      const body = deliveryBody(f);
      delete (body as { assignedTo?: string }).assignedTo;
      const approved = await service.approve(f.manager, saleId, {
        clientActionId: 's3-default-assignee', expectedVersion: version, delivery: body,
      }) as { deliveryJobCardId: string };
      const row = (await f.pool.query<{ assigned_to: string; status: string }>(
        'SELECT assigned_to, status FROM job_cards WHERE id = $1', [approved.deliveryJobCardId],
      )).rows[0]!;
      expect(row.assigned_to).toBe(f.staff.id);
      expect(await count(f,
        "SELECT count(*)::int AS n FROM job_card_delivery_items WHERE job_card_id = $1 AND delivery_purpose = 'SALE'",
        [approved.deliveryJobCardId])).toBe(2);
    });
  });

  it('approves a coordinated pair and creates the delivery next to the follow-up child', async () => {
    await withSaleFixture(async (f) => {
      const { service, published } = windowService(f);
      const pair = await waitingPair(f, service);

      const approved = await service.approve(f.manager, f.visitId, {
        clientActionId: 's3-pair-approve',
        expectedVersion: pair.visitVersion,
        expectedSaleVersion: pair.saleVersion,
        note: 'Ziyaret ve satış onaylandı.',
        delivery: deliveryBody(f),
      }) as { status: string; linkedSaleJobCardId: string; followUpJobCardId: string; deliveryJobCardId: string };
      expect(approved).toMatchObject({ status: 'COMPLETED', linkedSaleJobCardId: pair.saleId });
      expect(typeof approved.followUpJobCardId).toBe('string');
      expect(typeof approved.deliveryJobCardId).toBe('string');
      expect(approved.deliveryJobCardId).not.toBe(approved.followUpJobCardId);

      expect((await status(f, f.visitId)).status).toBe('COMPLETED');
      expect((await status(f, pair.saleId)).status).toBe('COMPLETED');
      const delivery = (await f.pool.query<{ delivery_source_sale_id: string; source_job_card_id: string | null }>(
        'SELECT delivery_source_sale_id, source_job_card_id FROM job_cards WHERE id = $1',
        [approved.deliveryJobCardId],
      )).rows[0]!;
      // The delivery belongs to the sale, not to the visit's follow-up chain.
      expect(delivery).toEqual({ delivery_source_sale_id: pair.saleId, source_job_card_id: null });
      expect((await f.pool.query<{ type: string }>(
        'SELECT type FROM job_cards WHERE id = $1', [approved.followUpJobCardId],
      )).rows[0]!.type).toBe('SALES_MEETING');
      expect(await count(f,
        "SELECT count(*)::int AS n FROM job_card_activity_logs WHERE job_card_id = $1 AND event_type = 'SALE_DELIVERY_CREATED'",
        [pair.saleId])).toBe(1);
      // The visit never receives the sale-delivery fact.
      expect(await count(f,
        "SELECT count(*)::int AS n FROM job_card_activity_logs WHERE job_card_id = $1 AND event_type = 'SALE_DELIVERY_CREATED'",
        [f.visitId])).toBe(0);

      // Both intents completed together; the anchor receipt carries every id.
      const anchorKey = `JOB_APPROVE_PAIR:${f.visitId}`;
      const intents = (await f.pool.query<{ state: string }>(
        'SELECT state FROM job_card_lifecycle_intents WHERE operation_key LIKE $1', [`${anchorKey}%`],
      )).rows;
      expect(intents).toHaveLength(2);
      expect(intents.every((row) => row.state === 'COMPLETED')).toBe(true);
      const receipt = (await f.pool.query<{ response_body: Record<string, unknown> }>(
        'SELECT response_body FROM processed_actions WHERE operation_key = $1', [anchorKey],
      )).rows[0]!;
      expect(receipt.response_body).toMatchObject({
        linkedSaleJobCardId: pair.saleId,
        followUpJobCardId: approved.followUpJobCardId,
        deliveryJobCardId: approved.deliveryJobCardId,
      });
      // Realtime reaches the sale owner for the delivery.
      const createdEvent = published.find(
        (event) => event.entityId === approved.deliveryJobCardId && event.type === 'job.created')!;
      expect(createdEvent.audience.userIds).toEqual([f.staff.id, f.otherStaff.id].sort());
    });
  });

  it('rejects delivery on an approval that completes no sale and writes nothing', async () => {
    await withSaleFixture(async (f) => {
      const { service } = windowService(f);
      // A visit with no linked sale (and not even submitted yet).
      await expect(service.approve(f.manager, f.visitId, {
        clientActionId: 's3-visit-only', expectedVersion: 1, delivery: deliveryBody(f),
      })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR', statusCode: 400,
        details: { fieldErrors: { delivery: expect.any(String) } },
      });
      expect(await count(f, "SELECT count(*)::int AS n FROM processed_actions WHERE operation_key LIKE 'JOB_APPROVE%'")).toBe(0);
      expect(await count(f, 'SELECT count(*)::int AS n FROM job_card_lifecycle_intents WHERE operation_key LIKE \'JOB_APPROVE%\'')).toBe(0);

      // A non-sale PRODUCT_DELIVERY card.
      const plain = await service.createProductDelivery(f.manager, {
        type: 'PRODUCT_DELIVERY', clientActionId: 's3-plain-delivery', title: 'Düz teslim',
        description: null, contactId: null, customerId: f.customerId, assignedTo: f.otherStaff.id,
        priority: 'normal', dueDate: null, scheduledAt: DELIVERY_AT, scheduledEndsAt: DELIVERY_ENDS_AT,
        deliveryPurpose: 'SALE', deliveryNote: null,
        items: [{ productId: f.products[0]!, quantity: 1 }],
      } as never);
      await expect(service.approve(f.manager, plain.jobCardId, {
        clientActionId: 's3-plain-approve', expectedVersion: plain.version, delivery: deliveryBody(f),
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { fieldErrors: { delivery: expect.any(String) } } });
      expect(await count(f,
        "SELECT count(*)::int AS n FROM job_cards WHERE delivery_source_sale_id IS NOT NULL")).toBe(0);
    });
  });

  it.each(['ACCEPTED', 'IN_PROGRESS'] as const)(
    'rejects delivery when the legacy sale of the visit is %s (the sale completes nothing)',
    async (legacyStatus) => {
      await withSaleFixture(async (f) => {
        const { service } = windowService(f);
        const pair = await waitingPair(f, service);
        const saleVersion = (await f.pool.query<{ version: number }>(
          `UPDATE job_cards SET status = $2::text, version = version + 1 WHERE id = $1 RETURNING version`,
          [pair.saleId, legacyStatus],
        )).rows[0]!.version;
        await expect(service.approve(f.manager, f.visitId, {
          clientActionId: `s3-legacy-${legacyStatus}`,
          expectedVersion: pair.visitVersion,
          expectedSaleVersion: saleVersion,
          delivery: deliveryBody(f),
        })).rejects.toMatchObject({
          code: 'VALIDATION_ERROR', statusCode: 400,
          details: { fieldErrors: { delivery: expect.any(String) } },
        });
        expect((await status(f, f.visitId)).status).toBe('WAITING_APPROVAL');
        expect((await status(f, pair.saleId)).status).toBe(legacyStatus);
        expect(await count(f, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'PRODUCT_DELIVERY'")).toBe(0);
        // Without the delivery the very same legacy approval still works (S2 behaviour).
        await expect(service.approve(f.manager, f.visitId, {
          clientActionId: `s3-legacy-${legacyStatus}-plain`,
          expectedVersion: pair.visitVersion,
          expectedSaleVersion: saleVersion,
        })).resolves.toMatchObject({ status: 'COMPLETED' });
      });
    },
  );

  it.each(['standalone', 'pair'] as const)(
    'rolls the whole %s approval back on an inactive customer; a corrected attempt needs a new key',
    async (shape) => {
      await withSaleFixture(async (f) => {
        const { service, published } = windowService(f);
        const waiting = shape === 'standalone'
          ? await waitingStandalone(f, service)
          : await waitingPair(f, service);
        const approveInput = {
          expectedVersion: shape === 'standalone'
            ? (waiting as { version: number }).version
            : (waiting as { visitVersion: number }).visitVersion,
          ...(shape === 'pair' ? { expectedSaleVersion: (waiting as { saleVersion: number }).saleVersion } : {}),
          delivery: deliveryBody(f),
        };
        const anchor = shape === 'standalone' ? (waiting as { saleId: string }).saleId : f.visitId;
        const saleId = (waiting as { saleId: string }).saleId;
        await f.pool.query("UPDATE customers SET status = 'inactive' WHERE id = $1", [f.customerId]);

        published.length = 0;
        await expect(service.approve(f.manager, anchor, {
          clientActionId: 's3-inactive', ...approveInput,
        })).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE', statusCode: 409 });
        // No partial approval: both cards stay WAITING_APPROVAL, nothing was created or published.
        await expectUntouched(f, shape === 'pair' ? [f.visitId, saleId] : [saleId], 'WAITING_APPROVAL');
        expect(published).toEqual([]);
        expect(await count(f,
          "SELECT count(*)::int AS n FROM job_card_activity_logs WHERE event_type = 'JOB_APPROVED'")).toBe(0);
        expect(await count(f, "SELECT count(*)::int AS n FROM job_cards WHERE source_job_card_id IS NOT NULL")).toBe(0);

        // §5.4: a definitive 4xx marks the intent FAILED; the same key is never retried.
        await f.pool.query("UPDATE customers SET status = 'active' WHERE id = $1", [f.customerId]);
        await expect(service.approve(f.manager, anchor, {
          clientActionId: 's3-inactive', ...approveInput,
        })).rejects.toMatchObject({ statusCode: 409 });
        await expectUntouched(f, shape === 'pair' ? [f.visitId, saleId] : [saleId], 'WAITING_APPROVAL');
        const corrected = await service.approve(f.manager, anchor, {
          clientActionId: 's3-inactive-corrected', ...approveInput,
        }) as { status: string; deliveryJobCardId: string };
        expect(corrected.status).toBe('COMPLETED');
        expect(typeof corrected.deliveryJobCardId).toBe('string');
      });
    },
  );

  it.each(['standalone', 'pair'] as const)(
    'replays a %s approval identically and refuses a changed delivery under the same key',
    async (shape) => {
      await withSaleFixture(async (f) => {
        const { service, published } = windowService(f);
        const waiting = shape === 'standalone'
          ? await waitingStandalone(f, service)
          : await waitingPair(f, service);
        const anchor = shape === 'standalone' ? (waiting as { saleId: string }).saleId : f.visitId;
        const input = {
          clientActionId: 's3-replay',
          expectedVersion: shape === 'standalone'
            ? (waiting as { version: number }).version
            : (waiting as { visitVersion: number }).visitVersion,
          ...(shape === 'pair' ? { expectedSaleVersion: (waiting as { saleVersion: number }).saleVersion } : {}),
          note: 'Onay.',
          delivery: deliveryBody(f, { note: 'Not' }),
        };
        const first = await service.approve(f.manager, anchor, input);
        const publishedAfterFirst = published.length;
        const rows = {
          cards: await count(f, 'SELECT count(*)::int AS n FROM job_cards'),
          activities: await count(f, 'SELECT count(*)::int AS n FROM job_card_activity_logs'),
          items: await count(f, 'SELECT count(*)::int AS n FROM job_card_delivery_items'),
          offers: await count(f, 'SELECT count(*)::int AS n FROM job_card_assignment_offers'),
        };

        const replay = await service.approve(f.manager, anchor, input);
        expect(replay).toEqual(first);
        expect((replay as { deliveryJobCardId?: string }).deliveryJobCardId)
          .toBe((first as { deliveryJobCardId?: string }).deliveryJobCardId);
        // A replay creates and publishes nothing.
        expect(published).toHaveLength(publishedAfterFirst);
        expect({
          cards: await count(f, 'SELECT count(*)::int AS n FROM job_cards'),
          activities: await count(f, 'SELECT count(*)::int AS n FROM job_card_activity_logs'),
          items: await count(f, 'SELECT count(*)::int AS n FROM job_card_delivery_items'),
          offers: await count(f, 'SELECT count(*)::int AS n FROM job_card_assignment_offers'),
        }).toEqual(rows);

        for (const changed of [
          deliveryBody(f, { note: 'Başka not' }),
          deliveryBody(f, { scheduledAt: LATER_DELIVERY_AT }),
          deliveryBody(f, { assignedTo: f.staff.id }),
          deliveryBody(f, { items: [{ productId: f.products[0]!, quantity: 3 }] }),
        ]) {
          await expect(service.approve(f.manager, anchor, { ...input, delivery: changed }))
            .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
        }
        // Dropping the delivery under the same key is a different request too.
        const { delivery: _dropped, ...withoutDelivery } = input;
        void _dropped;
        await expect(service.approve(f.manager, anchor, withoutDelivery))
          .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED' });
        expect(await count(f, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'PRODUCT_DELIVERY'")).toBe(1);
      });
    },
  );

  it('maps the JOB-010 window and past-start rejections onto delivery.scheduledAt without approving', async () => {
    await withSaleFixture(async (f) => {
      const { service } = windowService(f);
      const { saleId, version } = await waitingStandalone(f, service);

      // Planned window ends within the 10 minute minimum answer window.
      await expect(service.approve(f.manager, saleId, {
        clientActionId: 's3-too-short', expectedVersion: version,
        delivery: deliveryBody(f, { scheduledAt: at(-25 * MINUTE) }),
      })).rejects.toMatchObject({
        code: 'ASSIGNMENT_WINDOW_TOO_SHORT', statusCode: 409,
        details: { fieldErrors: { 'delivery.scheduledAt': expect.any(String) } },
      });
      // Planned start already passed: an acknowledgement is mandatory.
      const passed = deliveryBody(f, { scheduledAt: at(-5 * MINUTE) });
      await expect(service.approve(f.manager, saleId, {
        clientActionId: 's3-past-start', expectedVersion: version, delivery: passed,
      })).rejects.toMatchObject({
        code: 'PAST_START_ACKNOWLEDGEMENT_REQUIRED', statusCode: 409,
        details: { fieldErrors: { 'delivery.scheduledAt': expect.any(String) } },
      });
      await expectUntouched(f, [saleId], 'WAITING_APPROVAL');

      // A corrected attempt (new key) with the acknowledgement succeeds.
      const approved = await service.approve(f.manager, saleId, {
        clientActionId: 's3-past-start-ack', expectedVersion: version,
        delivery: {
          ...passed,
          pastStartAcknowledgement: { code: 'CUSTOMER_WAITING', text: 'Müşteri teslimatı bekliyor.' },
        },
      }) as { status: string; deliveryJobCardId: string };
      expect(approved.status).toBe('COMPLETED');
      const offer = (await f.pool.query<{ urgent_reason: string; opened_reason: string }>(
        'SELECT urgent_reason, opened_reason FROM job_card_assignment_offers WHERE job_card_id = $1',
        [approved.deliveryJobCardId],
      )).rows[0]!;
      expect(offer).toEqual({ urgent_reason: 'START_PASSED', opened_reason: 'SALE_APPROVAL' });
    });
  });

  it('validates the product batch like the plain delivery create and approves nothing on failure', async () => {
    await withSaleFixture(async (f) => {
      const { service } = windowService(f);
      const { saleId, version } = await waitingStandalone(f, service);
      let attempt = 0;
      const approve = (delivery: unknown) => service.approve(f.manager, saleId, {
        clientActionId: `s3-products-${attempt++}`, expectedVersion: version, delivery,
      } as never);

      await expect(approve(deliveryBody(f, {
        items: [{ productId: f.products[0]!, quantity: 1 }, { productId: f.products[0]!, quantity: 2 }],
      }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { fieldErrors: { 'delivery.items': expect.any(String) } } });
      await expect(approve(deliveryBody(f, { items: [{ productId: f.products[0]!, quantity: 1.5 }] })))
        .rejects.toMatchObject({ details: { fieldErrors: { 'delivery.items.quantity': expect.any(String) } } });
      await expect(approve(deliveryBody(f, { items: [] })))
        .rejects.toMatchObject({ details: { fieldErrors: { 'delivery.items': expect.any(String) } } });
      await expect(approve(deliveryBody(f, { deliveryNote: 'x' })))
        .rejects.toMatchObject({ details: { fieldErrors: { delivery: expect.any(String) } } });

      // Unknown product, inactive product and a DEMO product are all concealed as 404.
      await expect(approve(deliveryBody(f, {
        items: [{ productId: '7d2f9b1f-6d2e-4d6f-8c1b-2b3c4d5e6f70', quantity: 1 }],
      }))).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND', statusCode: 404 });
      await f.pool.query('UPDATE products SET is_active = false WHERE id = $1', [f.products[1]]);
      await expect(approve(deliveryBody(f))).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND', statusCode: 404 });
      await f.pool.query('UPDATE products SET is_active = true WHERE id = $1', [f.products[1]]);

      // A manager, unknown or inactive assignee never completes the sale.
      await expect(approve(deliveryBody(f, { assignedTo: f.manager.id })))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(approve(deliveryBody(f, { assignedTo: '7d2f9b1f-6d2e-4d6f-8c1b-2b3c4d5e6f71' })))
        .rejects.toMatchObject({ code: 'ASSIGNEE_NOT_FOUND', statusCode: 404 });
      await f.pool.query('UPDATE users SET is_active = false WHERE id = $1', [f.otherStaff.id]);
      await expect(approve(deliveryBody(f))).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expectUntouched(f, [saleId], 'WAITING_APPROVAL');
      expect(await count(f, "SELECT count(*)::int AS n FROM job_card_activity_logs WHERE event_type = 'JOB_APPROVED'")).toBe(0);
    });
  });

  it('keeps one delivery per sale: the unique index surfaces as SALE_DELIVERY_ALREADY_EXISTS', async () => {
    await withSaleFixture(async (f) => {
      const { service } = windowService(f);
      const { saleId, version } = await waitingStandalone(f, service);
      // A delivery already linked to the sale (planted directly: the API cannot make a second one).
      await f.pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
                                scheduled_at, scheduled_ends_at, delivery_source_sale_id)
         VALUES ($1, 'PRODUCT_DELIVERY', 'NEW', 'Mevcut teslim', $2, $3, $4, $5, $6, $7)`,
        [f.organizationId, f.customerId, f.otherStaff.id, f.manager.id, DELIVERY_AT, DELIVERY_ENDS_AT, saleId],
      );
      await expect(service.approve(f.manager, saleId, {
        clientActionId: 's3-second-delivery', expectedVersion: version, delivery: deliveryBody(f),
      })).rejects.toMatchObject({ code: 'SALE_DELIVERY_ALREADY_EXISTS', statusCode: 409 });
      expect((await status(f, saleId)).status).toBe('WAITING_APPROVAL');
      expect(await count(f, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'PRODUCT_DELIVERY'")).toBe(1);
      // The approval itself, without a delivery, is still possible.
      await expect(service.approve(f.manager, saleId, {
        clientActionId: 's3-without-delivery', expectedVersion: version,
      })).resolves.toMatchObject({ status: 'COMPLETED' });
    });
  });

  it('maps the one-delivery-per-sale unique index to SALE_DELIVERY_ALREADY_EXISTS', async () => {
    const { mapSaleIntegrityError } = await import('../src/modules/job-cards/sale-service.js');
    expect(() => mapSaleIntegrityError({ code: '23505', constraint: 'job_cards_one_delivery_per_sale_idx' }))
      .toThrowError(expect.objectContaining({ code: 'SALE_DELIVERY_ALREADY_EXISTS', statusCode: 409 }));
  });

  it('exposes the provenance on the delivery and the link on the sale detail, scoped to who can read them', async () => {
    await withSaleFixture(async (f) => {
      const { service } = windowService(f);
      const { saleId, version } = await waitingStandalone(f, service);
      const approved = await service.approve(f.manager, saleId, {
        clientActionId: 's3-read-side', expectedVersion: version, delivery: deliveryBody(f),
      }) as { deliveryJobCardId: string };
      const deliveryId = approved.deliveryJobCardId;

      // Management reads the provenance; the sale owner never carries the delivery (other staff does).
      expect(await service.detail(f.manager, deliveryId)).toMatchObject({ deliverySourceSaleId: saleId });
      // The delivery's assignee cannot read the sale: no id at all.
      const asAssignee = await service.detail(f.otherStaff, deliveryId);
      expect(asAssignee.deliverySourceSaleId).toBeNull();
      expect(JSON.stringify(asAssignee)).not.toContain(saleId);
      // A card that is not a delivery has no provenance.
      expect((await service.detail(f.manager, saleId)).deliverySourceSaleId).toBeNull();

      // Sale side: management sees the link; the sale owner does not carry the
      // delivery, so it sees the fact and status without the delivery id.
      expect(await service.detail(f.manager, saleId)).toMatchObject({
        linkedDelivery: { id: deliveryId, status: 'NEW' },
      });
      expect((await service.detail(f.staff, saleId)).linkedDelivery).toEqual({ id: null, status: 'NEW' });
      expect(JSON.stringify(await service.detail(f.staff, saleId))).not.toContain(deliveryId);
      // A card with no delivery (a delivery itself) reports none.
      expect((await service.detail(f.manager, deliveryId)).linkedDelivery).toBeNull();

      // The sale owner who also carries the delivery sees both directions.
      const second = await standaloneSale(f, { clientActionId: 's3-read-second' });
      const submitted = await service.submitForApproval(f.staff, second.jobCardId, {
        clientActionId: 's3-read-second-submit', expectedVersion: second.version, note: 'Sipariş.',
      });
      const own = await service.approve(f.manager, second.jobCardId, {
        clientActionId: 's3-read-second-approve', expectedVersion: submitted.version,
        delivery: deliveryBody(f, { assignedTo: f.staff.id }),
      }) as { deliveryJobCardId: string };
      expect(await service.detail(f.staff, own.deliveryJobCardId))
        .toMatchObject({ deliverySourceSaleId: second.jobCardId });
      expect(await service.detail(f.staff, second.jobCardId)).toMatchObject({
        linkedDelivery: { id: own.deliveryJobCardId, status: 'NEW' },
      });
      // The internal assignee never leaks into the DTO.
      expect(Object.keys((await service.detail(f.manager, saleId)).linkedDelivery!).sort())
        .toEqual(['id', 'status']);
      expect(await service.detail(f.manager, saleId)).not.toHaveProperty('deliverySourceSale');
      expect(await count(f,
        "SELECT count(*)::int AS n FROM job_cards WHERE delivery_source_sale_id IS NOT NULL")).toBe(2);
    });
  });

  it('projects the SALE_DELIVERY_CREATED fact for sale-capable readers only', async () => {
    await withSaleFixture(async (f) => {
      const { service } = windowService(f);
      const { saleId, version } = await waitingStandalone(f, service);
      const approved = await service.approve(f.manager, saleId, {
        clientActionId: 's3-activity', expectedVersion: version, delivery: deliveryBody(f),
      }) as { deliveryJobCardId: string };
      const { presentActivity } = await import('../src/modules/job-cards/activity-presenter.js');
      const record = (await f.pool.query<{ metadata: unknown; id: string; created_at: Date }>(
        `SELECT id, metadata, created_at FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'SALE_DELIVERY_CREATED'`, [saleId],
      )).rows[0]!;
      const activity = {
        id: record.id, jobCardId: saleId, eventType: 'SALE_DELIVERY_CREATED' as const,
        actorId: f.manager.id, actorName: 'Manager', oldValue: null, newValue: null,
        metadata: record.metadata, createdAt: record.created_at, startLocation: null,
      };
      expect(presentActivity(activity as never, { includeSaleCapability: true }).details).toEqual({
        kind: 'SALE_DELIVERY',
        deliveryJobCardId: approved.deliveryJobCardId,
        assignedTo: f.otherStaff.id,
        scheduledAt: DELIVERY_AT,
        itemCount: 2,
        items: [
          { productId: f.products[0], quantity: 2 },
          { productId: f.products[1], quantity: 15 },
        ],
      });
      expect(presentActivity(activity as never).details).toEqual({ kind: 'NONE' });
      expect(presentActivity({ ...activity, metadata: { deliveryJobCardId: 3 } } as never,
        { includeSaleCapability: true }).details).toEqual({ kind: 'NONE' });
    });
  });

  it.each([
    ['users', 'standalone'], ['users', 'pair'],
    ['customers', 'standalone'], ['customers', 'pair'],
    ['products', 'standalone'], ['products', 'pair'],
  ] as const)(
    'takes %s before any JobCard row on a %s approval with a delivery (ARC-003 lock order)',
    async (blocked, shape) => {
      await withSaleFixture(async (f) => {
        const { service } = windowService(f);
        const waiting = shape === 'standalone'
          ? await waitingStandalone(f, service)
          : await waitingPair(f, service);
        const saleId = (waiting as { saleId: string }).saleId;
        const cardIds = shape === 'pair' ? [f.visitId, saleId] : [saleId];
        const anchor = shape === 'standalone' ? saleId : f.visitId;
        const blocker = {
          users: ['users', f.otherStaff.id],
          customers: ['customers', f.customerId],
          products: ['products', f.products[1]!],
        }[blocked];
        const probe = async (table: string, id: string) => f.pool.query(
          `SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id],
        ).then(() => 'free', (error: { code?: string }) => error.code === '55P03' ? 'held' : `error:${error.code}`);

        // An outside transaction holds the row the approval needs next.
        const holder = await f.pool.connect();
        let running: Promise<unknown> | null = null;
        try {
          await holder.query('BEGIN');
          await holder.query(`SELECT 1 FROM ${blocker[0]} WHERE id = $1 FOR UPDATE`, [blocker[1]]);
          running = service.approve(f.manager, anchor, {
            clientActionId: `s3-lock-${blocked}-${shape}`,
            expectedVersion: shape === 'standalone'
              ? (waiting as { version: number }).version
              : (waiting as { visitVersion: number }).visitVersion,
            ...(shape === 'pair' ? { expectedSaleVersion: (waiting as { saleVersion: number }).saleVersion } : {}),
            delivery: deliveryBody(f),
          });
          void running.catch(() => undefined);
          await waitFor(async () => (await count(f,
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`,
            [`%FROM ${blocked}%FOR%`])) > 0, 10_000, `approval waiting on ${blocked}`);

          // While it waits, no card row is locked: JobCards are always taken last.
          for (const id of cardIds) expect(await probe('job_cards', id)).toBe('free');
          // Everything ordered before the awaited row is already held, everything after is not.
          if (blocked === 'users') {
            expect(await probe('customers', f.customerId)).toBe('free');
            expect(await probe('products', f.products[0]!)).toBe('free');
          }
          if (blocked === 'customers') {
            expect(await probe('products', f.products[0]!)).toBe('free');
          }
          if (blocked === 'products') {
            expect(await probe('customers', f.customerId)).toBe('held');
          }
        } finally {
          await holder.query('COMMIT').catch(() => undefined);
          holder.release();
        }
        const approved = await running as { status: string; deliveryJobCardId: string };
        expect(approved.status).toBe('COMPLETED');
        expect(typeof approved.deliveryJobCardId).toBe('string');
        expect(await count(f, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'PRODUCT_DELIVERY'")).toBe(1);
      });
    },
  );

  it('accepts the delivery object over HTTP only through the approve allowlist', async () => {
    await withSaleFixture(async (f) => {
      const { service } = windowService(f);
      const { saleId, version } = await waitingStandalone(f, service);
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error);
        return reply.code(response.statusCode).send(response.body);
      });
      let actor: JobCardActor = f.manager;
      await app.register(jobCardRoutes, {
        prefix: '/api/job-cards', service,
        authenticate: async (request) => { request.currentUser = { ...actor } as never; },
      });
      try {
        const bad = await app.inject({
          method: 'POST', url: `/api/job-cards/${saleId}/approve?includeSaleCapability=true`,
          payload: { clientActionId: 's3-http-bad', expectedVersion: version, delivery: { ...deliveryBody(f), extra: 1 } },
        });
        expect(bad.statusCode).toBe(400);
        expect(bad.json()).toMatchObject({ code: 'VALIDATION_ERROR', details: { fieldErrors: { delivery: expect.any(String) } } });
        const nullDelivery = await app.inject({
          method: 'POST', url: `/api/job-cards/${saleId}/approve?includeSaleCapability=true`,
          payload: { clientActionId: 's3-http-null', expectedVersion: version, delivery: null },
        });
        expect(nullDelivery.statusCode).toBe(400);
        const ok = await app.inject({
          method: 'POST', url: `/api/job-cards/${saleId}/approve?includeSaleCapability=true`,
          payload: { clientActionId: 's3-http-ok', expectedVersion: version, delivery: deliveryBody(f) },
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toMatchObject({ status: 'COMPLETED', deliveryJobCardId: expect.any(String) });
        // Staff cannot approve at all, delivery or not.
        actor = f.staff;
        const forbidden = await app.inject({
          method: 'POST', url: `/api/job-cards/${saleId}/approve?includeSaleCapability=true`,
          payload: { clientActionId: 's3-http-staff', expectedVersion: version + 1, delivery: deliveryBody(f) },
        });
        expect(forbidden.statusCode).toBeGreaterThanOrEqual(400);
        expect(await count(f, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'PRODUCT_DELIVERY'")).toBe(1);
      } finally {
        await app.close();
      }
    });
  });
});
