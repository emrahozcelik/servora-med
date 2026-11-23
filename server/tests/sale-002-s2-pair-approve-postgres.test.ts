import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { saleFixture, withSaleFixture } from './support/sale-harness.js';

/**
 * SALE-002 slice S2 acceptance — coordinated visit + sale approval.
 * Owning contract: docs/features/visit-to-sale/sale-002-contract.md
 *   §4.3 visit approve, §4.4 state matrix (approve rows and legacy mixed
 *   states), §4.6 lock order/receipt, §4.7 atomicity/activity, §4.8 edge cases
 *   (cancel never cascades), §9.3 joint approve and legacy mixed states.
 *
 * The pair approval is the visit's existing APPROVE command carrying
 * `expectedSaleVersion`; a legacy sale that is not WAITING_APPROVAL is left
 * untouched and becomes independent once the visit is terminal.
 */

type Fixture = Awaited<ReturnType<typeof saleFixture>>;
type App = ReturnType<typeof Fastify>;

const MEETING_AT = '2026-10-14T07:50:00.000Z';
const APPROVAL_NOTE = 'Ziyaret ve satış kaydı onaylandı.';

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

async function jobRow(fixture: Fixture, jobCardId: string) {
  return (await fixture.pool.query<{
    status: string;
    version: number;
    assigned_to: string;
    staff_completed_at: Date | null;
    manager_approved_at: Date | null;
    manager_approved_by: string | null;
    manager_approval_note: string | null;
  }>(
    `SELECT status, version, assigned_to, staff_completed_at,
            manager_approved_at, manager_approved_by, manager_approval_note
       FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

/** Create the coordinated sale on the fixture visit and submit the pair as staff. */
async function submitPair(fixture: Fixture) {
  const sale = await fixture.service.createSaleFromVisit(fixture.staff, fixture.visitId, {
    ...fixture.input,
    clientActionId: 's2-approve-sale-create',
  });
  const details = await fixture.service.patchMeetingDetails(fixture.staff, fixture.visitId, {
    clientActionId: 's2-approve-meeting',
    expectedVersion: fixture.input.expectedSourceVersion,
    meetingAt: MEETING_AT,
    outcome: 'FOLLOW_UP_REQUIRED',
    unsuccessfulReason: 'REQUESTED_LATER',
    meetingSummary: 'Klinik yetkilisiyle görüşüldü; takip planlandı.',
    nextFollowUpAt: null,
  });
  let submittedBody: Record<string, unknown> = {};
  await withApp(fixture, () => fixture.staff, async (app) => {
    const submitted = await app.inject({
      method: 'POST',
      url: `/api/job-cards/${fixture.visitId}/submit-for-approval`,
      payload: {
        clientActionId: 's2-approve-pair-submit',
        expectedVersion: details.jobCardVersion,
        expectedSaleVersion: sale.version,
        note: 'Ziyaret ve bağlı satış kaydı onaya hazır.',
      },
    });
    expect(submitted.statusCode).toBe(200);
    submittedBody = submitted.json() as Record<string, unknown>;
  });
  expect(submittedBody).toMatchObject({
    status: 'WAITING_APPROVAL',
    linkedSaleJobCardId: sale.jobCardId,
  });
  return {
    sale,
    visitVersion: submittedBody.version as number,
    followUpProposal: submittedBody.followUpProposal as Record<string, unknown>,
  };
}

/** Legacy pre-S2 state: only a manager decision outside the pair could produce it. */
async function demoteSale(fixture: Fixture, saleId: string, status: string): Promise<number> {
  const result = await fixture.pool.query<{ version: number }>(
    `UPDATE job_cards
        SET status = $2::text,
            version = version + 1,
            started_at = CASE WHEN $2::text IN ('IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
                              THEN COALESCE(started_at, $3::timestamptz) ELSE started_at END,
            -- job_cards CHECK: REVISION_REQUESTED needs its revision facts.
            revision_requested_at = CASE WHEN $2::text = 'REVISION_REQUESTED'
                                         THEN $3::timestamptz ELSE revision_requested_at END,
            revision_requested_by = CASE WHEN $2::text = 'REVISION_REQUESTED'
                                         THEN $4::uuid ELSE revision_requested_by END,
            revision_reason = CASE WHEN $2::text = 'REVISION_REQUESTED'
                                   THEN 'Legacy revision' ELSE revision_reason END
      WHERE id = $1
      RETURNING version`,
    [saleId, status, new Date('2026-10-14T07:55:00.000Z'), fixture.manager.id],
  );
  return result.rows[0]!.version;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S2 pair approve', () => {
  it('completes the visit and its coordinated sale with one approval decision', async () => {
    await withSaleFixture(async (f) => {
      await withApp(f, () => f.manager, async (app) => {
        const { sale, visitVersion } = await submitPair(f);
        const saleVersion = (await jobRow(f, sale.jobCardId)).version;

        const approved = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/approve`,
          payload: {
            clientActionId: 's2-pair-approve',
            expectedVersion: visitVersion,
            expectedSaleVersion: saleVersion,
            note: APPROVAL_NOTE,
          },
        });
        expect(approved.statusCode).toBe(200);
        const body = approved.json() as Record<string, unknown>;
        expect(body).toMatchObject({
          status: 'COMPLETED',
          version: visitVersion + 1,
          linkedSaleJobCardId: sale.jobCardId,
        });
        expect(typeof body.followUpJobCardId).toBe('string');

        // §4.3 step 3/4: both cards completed with the same manager decision.
        const visit = await jobRow(f, f.visitId);
        const saleRow = await jobRow(f, sale.jobCardId);
        expect(visit).toMatchObject({
          status: 'COMPLETED',
          version: visitVersion + 1,
          manager_approved_by: f.manager.id,
          manager_approval_note: APPROVAL_NOTE,
        });
        expect(saleRow).toMatchObject({
          status: 'COMPLETED',
          version: saleVersion + 1,
          manager_approved_by: f.manager.id,
          manager_approval_note: APPROVAL_NOTE,
        });
        expect(visit.manager_approved_at!.getTime()).toBe(saleRow.manager_approved_at!.getTime());

        // §4.7: exactly one approval fact per completed card, with pair metadata.
        const approvals = (await f.pool.query<{
          job_card_id: string;
          metadata: Record<string, unknown> | null;
        }>(
          `SELECT job_card_id, metadata FROM job_card_activity_logs
            WHERE job_card_id = ANY($1::uuid[]) AND event_type = 'JOB_APPROVED'`,
          [[f.visitId, sale.jobCardId]],
        )).rows;
        expect(approvals).toHaveLength(2);
        const metadataByCard = new Map(approvals.map((row) => [row.job_card_id, row.metadata]));
        expect(metadataByCard.get(f.visitId)).toMatchObject({ pair: true, linkedJobCardId: sale.jobCardId });
        expect(metadataByCard.get(sale.jobCardId)).toMatchObject({ pair: true, linkedJobCardId: f.visitId });

        // §4.3 step 6: the follow-up child is created before/with the delivery path.
        const children = (await f.pool.query<{ id: string; type: string }>(
          'SELECT id, type FROM job_cards WHERE source_job_card_id = $1',
          [f.visitId],
        )).rows;
        expect(children).toHaveLength(1);
        expect(children[0]!.id).toBe(body.followUpJobCardId);
        expect(children[0]!.type).toBe('SALES_MEETING');

        // §9.3: an approval without a delivery payload writes no delivery.
        expect(await count(f, "SELECT count(*)::int AS n FROM job_cards WHERE type = 'PRODUCT_DELIVERY'")).toBe(0);
        expect(await count(f,
          "SELECT count(*)::int AS n FROM job_card_activity_logs WHERE event_type = 'SALE_DELIVERY_CREATED'")).toBe(0);

        // §4.5/§4.6: the visit receipt is stored and the participant intent completed.
        const anchorKey = `JOB_APPROVE_PAIR:${f.visitId}`;
        const receipts = (await f.pool.query<{
          operation_key: string;
          status: string;
          response_body: Record<string, unknown>;
        }>(
          `SELECT operation_key, status, response_body FROM processed_actions WHERE operation_key LIKE $1`,
          [`${anchorKey}%`],
        )).rows;
        expect(receipts).toHaveLength(1);
        expect(receipts[0]!.operation_key).toBe(anchorKey);
        expect(receipts[0]!.status).toBe('completed');
        expect(receipts[0]!.response_body).toMatchObject({
          linkedSaleJobCardId: sale.jobCardId,
          followUpJobCardId: body.followUpJobCardId,
        });

        const intents = (await f.pool.query<{
          job_card_id: string;
          state: string;
          operation_key: string;
        }>(
          `SELECT job_card_id, state, operation_key FROM job_card_lifecycle_intents
            WHERE operation_key LIKE $1`, [`${anchorKey}%`],
        )).rows;
        expect(intents).toHaveLength(2);
        expect(intents.every((row) => row.state === 'COMPLETED')).toBe(true);
        expect(intents.find((row) => row.job_card_id === f.visitId)!.operation_key).toBe(anchorKey);
        expect(intents.find((row) => row.job_card_id === sale.jobCardId)!.operation_key)
          .toBe(`${anchorKey}:participant`);
      });
    });
  });

  it.each(['NEW', 'ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED'] as const)(
    'completes the visit alone when the legacy sale is %s',
    async (legacyStatus) => {
      await withSaleFixture(async (f) => {
        await withApp(f, () => f.manager, async (app) => {
          const { sale, visitVersion } = await submitPair(f);
          const legacySaleVersion = await demoteSale(f, sale.jobCardId, legacyStatus);

          const approved = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${f.visitId}/approve`,
            payload: {
              clientActionId: `s2-approve-legacy-${legacyStatus}`,
              expectedVersion: visitVersion,
              expectedSaleVersion: legacySaleVersion,
              note: APPROVAL_NOTE,
            },
          });
          expect(approved.statusCode).toBe(200);
          const body = approved.json() as Record<string, unknown>;
          expect(body).toMatchObject({ status: 'COMPLETED' });
          // The sale did not move, so no linked sale id is reported.
          expect(body.linkedSaleJobCardId ?? null).toBeNull();

          const visit = await jobRow(f, f.visitId);
          const saleRow = await jobRow(f, sale.jobCardId);
          expect(visit.status).toBe('COMPLETED');
          expect(saleRow).toMatchObject({
            status: legacyStatus,
            version: legacySaleVersion,
            manager_approved_at: null,
            manager_approved_by: null,
            manager_approval_note: null,
          });
          expect(await count(f,
            `SELECT count(*)::int AS n FROM job_card_activity_logs
              WHERE job_card_id = $1 AND event_type = 'JOB_APPROVED'`, [sale.jobCardId])).toBe(0);
          // One follow-up child still exists for the completed visit.
          expect(await count(f,
            'SELECT count(*)::int AS n FROM job_cards WHERE source_job_card_id = $1', [f.visitId])).toBe(1);
        });
      });
    },
  );

  it('completes both cards when staff submitted the legacy sale on its own card first', async () => {
    await withSaleFixture(async (f) => {
      await withApp(f, () => f.manager, async (app) => {
        const { sale, visitVersion } = await submitPair(f);
        // Legacy pre-S2 data: the sale was submitted while the visit was WAITING.
        const legacyVersion = await demoteSale(f, sale.jobCardId, 'IN_PROGRESS');

        let submittedSaleVersion = 0;
        await withApp(f, () => f.staff, async (staffApp) => {
          const submitted = await staffApp.inject({
            method: 'POST',
            url: `/api/job-cards/${sale.jobCardId}/submit-for-approval?includeSaleCapability=true`,
            payload: {
              clientActionId: 's2-legacy-sale-own-submit',
              expectedVersion: legacyVersion,
              note: 'Satış kaydı ayrı onaya gönderildi.',
            },
          });
          expect(submitted.statusCode).toBe(200);
          submittedSaleVersion = submitted.json().version as number;
          expect(submitted.json()).toMatchObject({ status: 'WAITING_APPROVAL' });
        });
        expect(submittedSaleVersion).toBe(legacyVersion + 1);

        const approved = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/approve`,
          payload: {
            clientActionId: 's2-legacy-sale-approve-pair',
            expectedVersion: visitVersion,
            expectedSaleVersion: submittedSaleVersion,
            note: APPROVAL_NOTE,
          },
        });
        expect(approved.statusCode).toBe(200);
        expect(approved.json()).toMatchObject({
          status: 'COMPLETED',
          linkedSaleJobCardId: sale.jobCardId,
        });
        expect(await jobRow(f, sale.jobCardId)).toMatchObject({
          status: 'COMPLETED',
          version: submittedSaleVersion + 1,
          manager_approved_by: f.manager.id,
          manager_approval_note: APPROVAL_NOTE,
        });
      });
    });
  });

  it('cancels the visit without cascading, then approves the sale on its own card', async () => {
    await withSaleFixture(async (f) => {
      let saleId = '';
      let saleVersion = 0;
      await withApp(f, () => f.staff, async (app) => {
        const pair = await submitPair(f);
        saleId = pair.sale.jobCardId;
        saleVersion = (await jobRow(f, saleId)).version;

        const cancelled = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/cancel`,
          payload: {
            clientActionId: 's2-visit-cancel-no-cascade',
            expectedVersion: pair.visitVersion,
            cancelReason: 'Ziyaret operasyonel olarak kapatıldı.',
          },
        });
        expect(cancelled.statusCode).toBe(200);
        expect(cancelled.json()).toMatchObject({ status: 'CANCELLED' });
        // §4.3 / §4.8: the sale is not cancelled, invalidated or edited.
        expect(await jobRow(f, saleId)).toMatchObject({ status: 'WAITING_APPROVAL', version: saleVersion });
      });

      await withApp(f, () => f.manager, async (app) => {
        // The visit is terminal, so the sale approves on its own card.
        const approved = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${saleId}/approve?includeSaleCapability=true`,
          payload: { clientActionId: 's2-independent-sale-approve', expectedVersion: saleVersion },
        });
        expect(approved.statusCode).toBe(200);
        expect(approved.json()).toMatchObject({ status: 'COMPLETED' });
        expect(await jobRow(f, saleId)).toMatchObject({ status: 'COMPLETED', manager_approved_by: f.manager.id });
        expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'CANCELLED' });
      });
    });
  });
});
