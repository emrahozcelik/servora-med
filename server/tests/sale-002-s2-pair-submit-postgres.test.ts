import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { saleFixture, saleTime, withSaleFixture } from './support/sale-harness.js';

/**
 * SALE-002 slice S2 acceptance — coordinated visit + sale submission.
 * Owning contract: docs/features/visit-to-sale/sale-002-contract.md
 *   §4.1 pair discovery, §4.2 coordinating predicates, §4.3 visit submit,
 *   §4.4 state matrix rows for submit, §4.5 request identity, §4.6 two intents,
 *   §4.7 activity/realtime, §4.8 edge cases, R9/Q1 (SALE submits from ACCEPTED).
 *
 * Written as black-box acceptance over the HTTP lifecycle routes and the
 * documented persistence (the 049 intent table, activity log, receipts).
 * Every name below is taken from the contract; the report lists the assumed
 * shapes. These tests are expected to fail until the S2 implementation lands.
 */

type Fixture = Awaited<ReturnType<typeof saleFixture>>;
type App = ReturnType<typeof Fastify>;

const MEETING_AT = '2026-10-14T07:50:00.000Z';
const SUBMIT_NOTE = 'Ziyaret ve bağlı satış kaydı onaya hazır.';

async function withApp(fixture: Fixture, actor: () => JobCardActor, run: (app: App) => Promise<void>) {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    return reply.code(response.statusCode).send(response.body);
  });
  await app.register(jobCardRoutes, {
    prefix: '/api/job-cards',
    service: fixture.service,
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

async function count(fixture: Fixture, sql: string, values: unknown[] = []): Promise<number> {
  return (await fixture.pool.query<{ n: number }>(sql, values)).rows[0]!.n;
}

async function createActiveSale(fixture: Fixture, clientActionId = 's2-pair-sale-create') {
  return fixture.service.createSaleFromVisit(fixture.staff, fixture.visitId, {
    ...fixture.input,
    clientActionId,
  });
}

/** Record the visit result so the existing MEETING_NOT_READY checks are met. */
async function recordVisitResult(
  fixture: Fixture,
  jobCardId: string,
  expectedVersion: number,
  clientActionId: string,
): Promise<number> {
  const details = await fixture.service.patchMeetingDetails(fixture.staff, jobCardId, {
    clientActionId,
    expectedVersion,
    meetingAt: MEETING_AT,
    outcome: 'FOLLOW_UP_REQUIRED',
    unsuccessfulReason: 'REQUESTED_LATER',
    meetingSummary: 'Klinik yetkilisiyle görüşüldü; takip planlandı.',
    nextFollowUpAt: null,
  });
  return details.jobCardVersion;
}

async function jobRow(fixture: Fixture, jobCardId: string) {
  return (await fixture.pool.query<{
    status: string;
    version: number;
    started_at: Date | null;
    staff_completed_at: Date | null;
    staff_completed_by: string | null;
    staff_completion_note: string | null;
    follow_up_proposed_at: Date | null;
  }>(
    `SELECT status, version, started_at, staff_completed_at, staff_completed_by,
            staff_completion_note, follow_up_proposed_at
       FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

async function insertCustomer(fixture: Fixture, name: string): Promise<string> {
  return (await fixture.pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [fixture.organizationId, name],
  )).rows[0]!.id;
}

/** A fresh IN_PROGRESS visit with recorded meeting details and no linked sale. */
async function createInProgressVisit(fixture: Fixture, customerId: string, scheduledAt: string) {
  const created = await fixture.service.create(fixture.staff, {
    clientActionId: `s2-extra-visit-create-${scheduledAt}`,
    type: 'SALES_MEETING',
    title: 'Klinik ziyareti',
    description: null,
    customerId,
    contactId: null,
    assignedTo: fixture.staff.id,
    priority: 'normal',
    dueDate: null,
    scheduledAt,
    scheduledEndsAt: new Date(Date.parse(scheduledAt) + 60 * 60 * 1000).toISOString(),
    engagementKind: 'CUSTOMER_VISIT',
  } as never);
  const started = await fixture.service.start(fixture.staff, created.id, {
    clientActionId: `s2-extra-visit-start-${scheduledAt}`,
    expectedVersion: created.version,
  });
  const version = await recordVisitResult(
    fixture,
    created.id,
    started.version,
    `s2-extra-visit-meeting-${scheduledAt}`,
  );
  return { id: created.id, version };
}

/** Legacy pre-S2 state, written directly: no lifecycle command can produce it. */
async function seedLegacySaleState(
  fixture: Fixture,
  saleId: string,
  status: string,
): Promise<number> {
  const result = await fixture.pool.query<{ version: number }>(
    `UPDATE job_cards
        SET status = $2::text,
            version = version + 1,
            started_at = CASE WHEN $2::text IN ('IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
                              THEN COALESCE(started_at, $3::timestamptz) ELSE started_at END,
            staff_completed_at = COALESCE(staff_completed_at, $3::timestamptz),
            staff_completed_by = COALESCE(staff_completed_by, $4::uuid),
            staff_completion_note = COALESCE(staff_completion_note, 'Legacy sale submission'),
            revision_requested_at = CASE WHEN $2::text = 'REVISION_REQUESTED' THEN $3::timestamptz ELSE revision_requested_at END,
            revision_requested_by = CASE WHEN $2::text = 'REVISION_REQUESTED' THEN $4::uuid ELSE revision_requested_by END,
            revision_reason = CASE WHEN $2::text = 'REVISION_REQUESTED' THEN 'Legacy revision' ELSE revision_reason END
      WHERE id = $1
      RETURNING version`,
    [saleId, status, new Date('2026-10-14T07:55:00.000Z'), fixture.staff.id],
  );
  return result.rows[0]!.version;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S2 pair submit', () => {
  it('submits the visit and its coordinated accepted sale as one pair', async () => {
    await withSaleFixture(async (f) => {
      const sale = await createActiveSale(f);
      const visitVersion = await recordVisitResult(f, f.visitId, f.input.expectedSourceVersion, 's2-submit-meeting');

      let responseBody: Record<string, unknown> = {};
      await withApp(f, () => f.staff, async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-pair-submit',
            expectedVersion: visitVersion,
            expectedSaleVersion: sale.version,
            note: SUBMIT_NOTE,
          },
        });
        expect(response.statusCode).toBe(200);
        responseBody = response.json() as Record<string, unknown>;
        expect(responseBody).toMatchObject({
          status: 'WAITING_APPROVAL',
          version: visitVersion + 1,
          linkedSaleJobCardId: sale.jobCardId,
        });
        expect(responseBody.followUpProposal).toBeTruthy();
      });

      // §4.3 step 5: both cards move to WAITING_APPROVAL with one reservation instant.
      const visit = await jobRow(f, f.visitId);
      const saleRow = await jobRow(f, sale.jobCardId);
      expect(visit).toMatchObject({
        status: 'WAITING_APPROVAL',
        version: visitVersion + 1,
        staff_completed_by: f.staff.id,
        staff_completion_note: SUBMIT_NOTE,
      });
      expect(saleRow).toMatchObject({
        status: 'WAITING_APPROVAL',
        version: sale.version + 1,
        staff_completed_by: f.staff.id,
        staff_completion_note: SUBMIT_NOTE,
      });
      expect(visit.staff_completed_at!.getTime()).toBe(saleRow.staff_completed_at!.getTime());

      // R9 / Q1: no STARTED accountability fact or activity is fabricated.
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_STARTED'`, [sale.jobCardId])).toBe(0);
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_accountability_facts
          WHERE job_card_id = $1 AND fact_type = 'STARTED'`, [sale.jobCardId])).toBe(0);

      // §4.3 step 6: exactly one submission event per card that moved, with pair metadata.
      const submissions = (await f.pool.query<{
        job_card_id: string;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT job_card_id, metadata FROM job_card_activity_logs
          WHERE job_card_id = ANY($1::uuid[]) AND event_type = 'JOB_SUBMITTED_FOR_APPROVAL'`,
        [[f.visitId, sale.jobCardId]],
      )).rows;
      expect(submissions).toHaveLength(2);
      const metadataByCard = new Map(submissions.map((row) => [row.job_card_id, row.metadata]));
      expect(metadataByCard.get(f.visitId)).toMatchObject({ pair: true, linkedJobCardId: sale.jobCardId });
      expect(metadataByCard.get(sale.jobCardId)).toMatchObject({ pair: true, linkedJobCardId: f.visitId });

      // §4.3 step 7: one SUBMITTED accountability fact per submitted card.
      for (const jobCardId of [f.visitId, sale.jobCardId]) {
        expect(await count(f,
          `SELECT count(*)::int AS n FROM job_card_accountability_facts
            WHERE job_card_id = $1 AND fact_type = 'SUBMITTED'`, [jobCardId])).toBe(1);
      }

      // §4.3 step 4: the JOB-008 proposal is still persisted for the visit.
      expect(visit.follow_up_proposed_at).not.toBeNull();

      // §4.7: the existing realtime row for the submission activity exists for each moved
      // card (the existing mapping emits `job.submitted_for_approval`, not a generic
      // `job.updated`, for a submission activity).
      const realtime = (await f.pool.query<{ entity_id: string; event_type: string }>(
        `SELECT entity_id, event_type FROM realtime_events
          WHERE entity_id = ANY($1::uuid[])`, [[f.visitId, sale.jobCardId]],
      )).rows;
      for (const jobCardId of [f.visitId, sale.jobCardId]) {
        expect(realtime.filter(
          (row) => row.entity_id === jobCardId && row.event_type === 'job.submitted_for_approval',
        )).toHaveLength(1);
      }

      // §4.7: one awaiting-approval notification per submitted card.
      const notifications = (await f.pool.query<{ entity_id: string; kind: string }>(
        `SELECT entity_id, kind FROM in_app_notifications WHERE entity_id = ANY($1::uuid[])`,
        [[f.visitId, sale.jobCardId]],
      )).rows;
      for (const jobCardId of [f.visitId, sale.jobCardId]) {
        expect(notifications.some(
          (row) => row.entity_id === jobCardId && row.kind === 'job.awaiting_approval',
        )).toBe(true);
      }

      // §4.5/§4.6: the visit is the receipt anchor; both intent rows exist and complete.
      const anchorKey = `JOB_SUBMIT_FOR_APPROVAL_PAIR:${f.visitId}`;
      const receipts = (await f.pool.query<{
        operation_key: string;
        status: string;
        response_body: Record<string, unknown>;
      }>(
        `SELECT operation_key, status, response_body FROM processed_actions
          WHERE operation_key LIKE $1`, [`${anchorKey}%`],
      )).rows;
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.operation_key).toBe(anchorKey);
      expect(receipts[0]!.status).toBe('completed');
      expect(receipts[0]!.response_body).toMatchObject({ linkedSaleJobCardId: sale.jobCardId });

      const intents = (await f.pool.query<{
        job_card_id: string;
        operation_key: string;
        command: string;
        state: string;
        request_hash: string;
        expected_version: number;
        reserved_at: Date;
        expires_at: Date;
      }>(
        `SELECT job_card_id, operation_key, command, state, request_hash,
                expected_version, reserved_at, expires_at
           FROM job_card_lifecycle_intents
          WHERE operation_key LIKE $1`, [`${anchorKey}%`],
      )).rows;
      expect(intents).toHaveLength(2);
      const anchor = intents.find((row) => row.job_card_id === f.visitId)!;
      const participant = intents.find((row) => row.job_card_id === sale.jobCardId)!;
      expect(anchor.operation_key).toBe(anchorKey);
      expect(participant.operation_key).toBe(`${anchorKey}:participant`);
      expect([anchor.state, participant.state]).toEqual(['COMPLETED', 'COMPLETED']);
      expect(anchor.command).toBe('SUBMIT_FOR_APPROVAL');
      expect(participant.command).toBe('SUBMIT_FOR_APPROVAL');
      expect(anchor.request_hash).toBe(participant.request_hash);
      expect(anchor.reserved_at.getTime()).toBe(participant.reserved_at.getTime());
      expect(anchor.expires_at.getTime()).toBe(participant.expires_at.getTime());
      expect(anchor.expected_version).toBe(visitVersion);
      expect(participant.expected_version).toBe(sale.version);
      // §4.5: pair keys stay inside the 100-character operation_key limit.
      for (const intent of intents) expect(intent.operation_key.length).toBeLessThanOrEqual(100);
    });
  });

  it('lets a standalone sale submit from ACCEPTED without START (R9 / Q1)', async () => {
    await withSaleFixture(async (f) => {
      const created = await f.service.createStandaloneSale(f.staff, {
        clientActionId: 's2-standalone-r9-create',
        title: 'Telefon siparişi — Matrix set',
        description: null,
        customerId: f.customerId,
        assignedTo: f.staff.id,
        soldAt: saleTime.toISOString(),
        saleContactId: f.metContactId,
        items: [{ productId: f.products[0]!, quantity: 3 }],
      });
      expect(created.version).toBe(1);

      const submitted = await f.service.submitForApproval(f.staff, created.jobCardId, {
        clientActionId: 's2-standalone-r9-submit',
        expectedVersion: 1,
        note: 'Telefon siparişi onaya hazır.',
      });
      expect(submitted).toMatchObject({ status: 'WAITING_APPROVAL', version: 2 });
      // R9 / Q1: nothing about a START is fabricated.
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_STARTED'`, [created.jobCardId])).toBe(0);
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_accountability_facts
          WHERE job_card_id = $1 AND fact_type = 'STARTED'`, [created.jobCardId])).toBe(0);
    });
  });

  it('refuses to submit a visit whose linked sale is NEW, then accepts and submits it together', async () => {
    await withSaleFixture(async (f) => {
      // Management-created sale from an IN_PROGRESS visit is NEW (§4.4 row 2).
      const sale = await f.service.createSaleFromVisit(f.manager, f.visitId, {
        ...f.input,
        clientActionId: 's2-new-sale-create',
      });
      expect((await f.pool.query('SELECT status FROM job_cards WHERE id = $1', [sale.jobCardId])).rows[0])
        .toEqual({ status: 'NEW' });
      const visitVersion = await recordVisitResult(f, f.visitId, f.input.expectedSourceVersion, 's2-new-sale-meeting');

      await withApp(f, () => f.staff, async (app) => {
        const blocked = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-new-sale-submit-blocked',
            expectedVersion: visitVersion,
            expectedSaleVersion: 1,
            note: SUBMIT_NOTE,
          },
        });
        expect(blocked.statusCode).toBe(409);
        expect(blocked.json().code).toBe('SALE_PAIR_STATE_CONFLICT');
        const details = (blocked.json().details ?? {}) as Record<string, unknown>;
        expect(details.allowedSaleCommand ?? blocked.json().allowedSaleCommand).toBe('ACCEPT_ASSIGNMENT');
        // D3 forbids a partial submission: the visit is untouched.
        expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'IN_PROGRESS', version: visitVersion });
        expect(await count(f,
          `SELECT count(*)::int AS n FROM job_card_activity_logs
            WHERE job_card_id = ANY($1::uuid[]) AND event_type = 'JOB_SUBMITTED_FOR_APPROVAL'`,
          [[f.visitId, sale.jobCardId]])).toBe(0);

        // Acceptance is never blocked (§4.2 last bullet).
        const accepted = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${sale.jobCardId}/accept?includeSaleCapability=true`,
          payload: { clientActionId: 's2-new-sale-accept', expectedVersion: 1 },
        });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toMatchObject({ status: 'ACCEPTED', version: 2 });

        const submitted = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-new-sale-submit',
            expectedVersion: visitVersion,
            expectedSaleVersion: 2,
            note: SUBMIT_NOTE,
          },
        });
        expect(submitted.statusCode).toBe(200);
        expect(submitted.json()).toMatchObject({
          status: 'WAITING_APPROVAL',
          linkedSaleJobCardId: sale.jobCardId,
        });
      });

      expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL' });
      expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: 'WAITING_APPROVAL', version: 3 });
    });
  });

  it('blocks a legacy REVISION_REQUESTED sale with RESUME, then resumes it and submits the pair', async () => {
    await withSaleFixture(async (f) => {
      const sale = await createActiveSale(f, 's2-revision-sale-create');
      const saleVersion = await seedLegacySaleState(f, sale.jobCardId, 'REVISION_REQUESTED');
      const visitVersion = await recordVisitResult(f, f.visitId, f.input.expectedSourceVersion, 's2-revision-meeting');

      await withApp(f, () => f.staff, async (app) => {
        const blocked = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-revision-submit-blocked',
            expectedVersion: visitVersion,
            expectedSaleVersion: saleVersion,
            note: SUBMIT_NOTE,
          },
        });
        expect(blocked.statusCode).toBe(409);
        expect(blocked.json().code).toBe('SALE_PAIR_STATE_CONFLICT');
        const details = (blocked.json().details ?? {}) as Record<string, unknown>;
        expect(details.allowedSaleCommand ?? blocked.json().allowedSaleCommand).toBe('RESUME');
        expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'IN_PROGRESS', version: visitVersion });
        expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: 'REVISION_REQUESTED', version: saleVersion });

        // The source visit is IN_PROGRESS, so the sale RESUME is not redirected.
        const resumed = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${sale.jobCardId}/resume?includeSaleCapability=true`,
          payload: { clientActionId: 's2-revision-sale-resume', expectedVersion: saleVersion },
        });
        expect(resumed.statusCode).toBe(200);
        expect(resumed.json()).toMatchObject({ status: 'IN_PROGRESS', version: saleVersion + 1 });

        const submitted = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-revision-submit',
            expectedVersion: visitVersion,
            expectedSaleVersion: saleVersion + 1,
            note: SUBMIT_NOTE,
          },
        });
        expect(submitted.statusCode).toBe(200);
        expect(submitted.json()).toMatchObject({ status: 'WAITING_APPROVAL', linkedSaleJobCardId: sale.jobCardId });
      });

      expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: 'WAITING_APPROVAL' });
    });
  });

  it('returns the linked sale readiness error and writes nothing when the sale is not ready', async () => {
    await withSaleFixture(async (f) => {
      const sale = await createActiveSale(f, 's2-not-ready-sale-create');
      const items = (await f.pool.query<{ id: string }>(
        'SELECT id FROM job_card_sale_items WHERE job_card_id = $1 ORDER BY sort_order',
        [sale.jobCardId],
      )).rows;
      let saleVersion = 1;
      for (const [index, item] of items.entries()) {
        const removed = await f.service.removeSaleItem(f.staff, sale.jobCardId, item.id, {
          clientActionId: `s2-not-ready-remove-${index}`,
          expectedVersion: saleVersion,
        });
        saleVersion = removed.version;
      }
      const visitVersion = await recordVisitResult(f, f.visitId, f.input.expectedSourceVersion, 's2-not-ready-meeting');

      await withApp(f, () => f.staff, async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-not-ready-submit',
            expectedVersion: visitVersion,
            expectedSaleVersion: saleVersion,
            note: SUBMIT_NOTE,
          },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('SALE_NOT_READY');
        // The contract names "readiness items"; the exact envelope is not fixed.
        expect(JSON.stringify(response.json())).toContain('SALE_ITEMS_VALID');
      });

      // D3: no partial submission; the visit and the sale are untouched.
      expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'IN_PROGRESS', version: visitVersion });
      expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: 'ACCEPTED', version: saleVersion });
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_activity_logs
          WHERE job_card_id = ANY($1::uuid[]) AND event_type = 'JOB_SUBMITTED_FOR_APPROVAL'`,
        [[f.visitId, sale.jobCardId]])).toBe(0);
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_lifecycle_intents
          WHERE state = 'PENDING' AND operation_key LIKE $1`, [`JOB_SUBMIT_FOR_APPROVAL_PAIR:${f.visitId}%`],
      )).toBe(0);
    });
  });

  it('leaves an already submitted legacy sale untouched and reports no linked sale id', async () => {
    await withSaleFixture(async (f) => {
      const sale = await createActiveSale(f, 's2-legacy-waiting-sale-create');
      const saleVersion = await seedLegacySaleState(f, sale.jobCardId, 'WAITING_APPROVAL');
      const visitVersion = await recordVisitResult(f, f.visitId, f.input.expectedSourceVersion, 's2-legacy-waiting-meeting');

      await withApp(f, () => f.staff, async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-legacy-waiting-submit',
            expectedVersion: visitVersion,
            expectedSaleVersion: saleVersion,
            note: SUBMIT_NOTE,
          },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as Record<string, unknown>;
        expect(body).toMatchObject({ status: 'WAITING_APPROVAL' });
        // The sale did not move, so the receipt names no linked sale.
        expect(body.linkedSaleJobCardId ?? null).toBeNull();
      });

      expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL', version: visitVersion + 1 });
      // §4.3 step 5/6/7: the legacy sale keeps its own submission facts and event.
      const legacySale = await jobRow(f, sale.jobCardId);
      expect(legacySale).toMatchObject({
        status: 'WAITING_APPROVAL',
        version: saleVersion,
        staff_completion_note: 'Legacy sale submission',
      });
      expect(legacySale.staff_completed_at!.toISOString()).toBe('2026-10-14T07:55:00.000Z');
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_SUBMITTED_FOR_APPROVAL'`, [sale.jobCardId])).toBe(0);
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_accountability_facts
          WHERE job_card_id = $1 AND fact_type = 'SUBMITTED'`, [sale.jobCardId])).toBe(0);
      // The visit's own submission event carries the pair metadata.
      const visitSubmission = (await f.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_SUBMITTED_FOR_APPROVAL'`, [f.visitId],
      )).rows;
      expect(visitSubmission).toHaveLength(1);
      expect(visitSubmission[0]!.metadata).toMatchObject({ pair: true, linkedJobCardId: sale.jobCardId });
    });
  });

  it('rejects a stale expectedSaleVersion and inserts neither intent row', async () => {
    await withSaleFixture(async (f) => {
      const sale = await createActiveSale(f, 's2-stale-sale-create');
      const visitVersion = await recordVisitResult(f, f.visitId, f.input.expectedSourceVersion, 's2-stale-meeting');

      await withApp(f, () => f.staff, async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-stale-submit',
            expectedVersion: visitVersion,
            expectedSaleVersion: sale.version + 7,
            note: SUBMIT_NOTE,
          },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('VERSION_CONFLICT');
      });

      expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'IN_PROGRESS', version: visitVersion });
      expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: 'ACCEPTED', version: sale.version });
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_lifecycle_intents
          WHERE operation_key LIKE $1`, [`JOB_SUBMIT_FOR_APPROVAL_PAIR:${f.visitId}%`])).toBe(0);
      expect(await count(f,
        `SELECT count(*)::int AS n FROM processed_actions
          WHERE operation_key LIKE $1`, [`JOB_SUBMIT_FOR_APPROVAL_PAIR:${f.visitId}%`])).toBe(0);
    });
  });

  it('requires expectedSaleVersion for a coordinated visit submit', async () => {
    await withSaleFixture(async (f) => {
      const sale = await createActiveSale(f, 's2-required-sale-create');
      const visitVersion = await recordVisitResult(f, f.visitId, f.input.expectedSourceVersion, 's2-required-meeting');

      await withApp(f, () => f.staff, async (app) => {
        const missing = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: { clientActionId: 's2-required-missing', expectedVersion: visitVersion, note: SUBMIT_NOTE },
        });
        expect(missing.statusCode).toBe(400);
        expect(missing.json().code).toBe('VALIDATION_ERROR');
        expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'IN_PROGRESS', version: visitVersion });
        expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: 'ACCEPTED', version: sale.version });

        const pair = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-required-pair',
            expectedVersion: visitVersion,
            expectedSaleVersion: sale.version,
            note: SUBMIT_NOTE,
          },
        });
        expect(pair.statusCode).toBe(200);
      });
    });
  });

  it('rejects expectedSaleVersion when no coordinated pair exists', async () => {
    await withSaleFixture(async (f) => {
      // A visit with no linked sale rejects the pair field as a conflict.
      const customerId = await insertCustomer(f, 'S2 bağımsız ziyaret kliniği');
      const plainVisit = await createInProgressVisit(f, customerId, '2026-10-14T09:00:00.000Z');
      await withApp(f, () => f.staff, async (app) => {
        const extra = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${plainVisit.id}/submit-for-approval`,
          payload: {
            clientActionId: 's2-no-pair-extra-field',
            expectedVersion: plainVisit.version,
            expectedSaleVersion: 1,
            note: 'Bağlı satış yok.',
          },
        });
        expect(extra.statusCode).toBe(409);
        expect(extra.json().code).toBe('SALE_PAIR_STATE_CONFLICT');
        expect(extra.json().details).toMatchObject({ reason: 'NO_COORDINATED_PAIR' });
        expect(await jobRow(f, plainVisit.id)).toMatchObject({ status: 'IN_PROGRESS', version: plainVisit.version });

        const plain = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${plainVisit.id}/submit-for-approval`,
          payload: { clientActionId: 's2-no-pair-submit', expectedVersion: plainVisit.version, note: 'Ziyaret tamamlandı.' },
        });
        expect(plain.statusCode).toBe(200);
      });
    });
  });

  it('treats a sale from a terminal visit as independent (pair field rejected)', async () => {    await withSaleFixture(async (f) => {
      await f.pool.query(
        `UPDATE job_cards
            SET status = 'COMPLETED', staff_completed_at = $2, staff_completed_by = $3,
                manager_approved_at = $2, manager_approved_by = $3
          WHERE id = $1`,
        [f.visitId, new Date('2026-10-14T08:30:00.000Z'), f.manager.id],
      );
      const sourceVersion = (await f.pool.query<{ version: number }>(
        'SELECT version FROM job_cards WHERE id = $1', [f.visitId],
      )).rows[0]!.version;
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, {
        ...f.input,
        clientActionId: 's2-terminal-source-sale',
        expectedSourceVersion: sourceVersion,
      });

      await withApp(f, () => f.staff, async (app) => {
        const rejected = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${sale.jobCardId}/submit-for-approval?includeSaleCapability=true`,
          payload: {
            clientActionId: 's2-terminal-source-submit-field',
            expectedVersion: sale.version,
            expectedSaleVersion: sale.version,
            note: 'Terminal kaynaklı satış.',
          },
        });
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json().code).toBe('SALE_PAIR_STATE_CONFLICT');
        expect(rejected.json().details).toMatchObject({ reason: 'NO_COORDINATED_PAIR' });
        expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: 'ACCEPTED', version: sale.version });

        const submitted = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${sale.jobCardId}/submit-for-approval?includeSaleCapability=true`,
          payload: {
            clientActionId: 's2-terminal-source-submit',
            expectedVersion: sale.version,
            note: 'Terminal kaynaklı satış.',
          },
        });
        expect(submitted.statusCode).toBe(200);
        expect(submitted.json()).toMatchObject({ status: 'WAITING_APPROVAL' });
      });
    });
  });

  it.each(['COMPLETED', 'CANCELLED', 'INVALIDATED'] as const)(
    'treats a legacy %s linked sale as not active during the visit lifecycle',
    async (terminalStatus) => {
      await withSaleFixture(async (f) => {
        const sale = await createActiveSale(f, `s2-terminal-linked-sale-${terminalStatus}`);
        const completion = new Date('2026-10-14T08:10:00.000Z');
        await f.pool.query(
          `UPDATE job_cards
              SET status = $2::text,
                  version = version + 1,
                  started_at = COALESCE(started_at, $3::timestamptz),
                  staff_completed_at = COALESCE(staff_completed_at, $3::timestamptz),
                  staff_completed_by = COALESCE(staff_completed_by, $4::uuid),
                  manager_approved_at = CASE WHEN $2::text = 'COMPLETED' THEN $3::timestamptz ELSE manager_approved_at END,
                  manager_approved_by = CASE WHEN $2::text = 'COMPLETED' THEN $4::uuid ELSE manager_approved_by END,
                  cancelled_at = CASE WHEN $2::text = 'CANCELLED' THEN $3::timestamptz ELSE cancelled_at END,
                  cancelled_by = CASE WHEN $2::text = 'CANCELLED' THEN $4::uuid ELSE cancelled_by END,
                  cancel_reason = CASE WHEN $2::text = 'CANCELLED' THEN 'Bağlı satış kapatıldı' ELSE cancel_reason END,
                  invalidated_at = CASE WHEN $2::text = 'INVALIDATED' THEN $3::timestamptz ELSE invalidated_at END,
                  invalidated_by = CASE WHEN $2::text = 'INVALIDATED' THEN $4::uuid ELSE invalidated_by END,
                  invalidation_reason_code = CASE WHEN $2::text = 'INVALIDATED' THEN 'OTHER' ELSE invalidation_reason_code END
            WHERE id = $1`,
          [sale.jobCardId, terminalStatus, completion, f.manager.id],
        );
        const terminalVersion = sale.version + 1;
        const visitVersion = await recordVisitResult(
          f, f.visitId, f.input.expectedSourceVersion, `s2-terminal-linked-meeting-${terminalStatus}`,
        );

        await withApp(f, () => f.staff, async (app) => {
          const submitted = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${f.visitId}/submit-for-approval`,
            payload: {
              clientActionId: `s2-terminal-linked-submit-${terminalStatus}`,
              expectedVersion: visitVersion,
              note: 'Bağlı satış kapanmış; ziyaret tek başına onaya gidiyor.',
            },
          });
          expect(submitted.statusCode).toBe(200);
          const body = submitted.json() as Record<string, unknown>;
          expect(body).toMatchObject({ status: 'WAITING_APPROVAL' });
          expect(body.linkedSaleJobCardId ?? null).toBeNull();
          // The terminal sale is not resubmitted or relabelled.
          expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: terminalStatus, version: terminalVersion });
        });

        await withApp(f, () => f.manager, async (app) => {
          const approved = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${f.visitId}/approve`,
            payload: {
              clientActionId: `s2-terminal-linked-approve-${terminalStatus}`,
              expectedVersion: visitVersion + 1,
              note: 'Ziyaret onaylandı.',
            },
          });
          expect(approved.statusCode).toBe(200);
          expect(approved.json().linkedSaleJobCardId ?? null).toBeNull();
        });
        expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: terminalStatus, version: terminalVersion });
      });
    },
  );
});
