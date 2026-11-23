import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { saleFixture, withSaleFixture } from './support/sale-harness.js';

/**
 * SALE-002 slice S2 acceptance — coordinated revision, withdraw and resume.
 * Owning contract: docs/features/visit-to-sale/sale-002-contract.md
 *   §4.3 REQUEST_REVISION / WITHDRAW_FROM_APPROVAL / RESUME, §4.4 state matrix,
 *   §4.5 pair operation keys, §4.6 two intents, §4.8 legacy mixed states.
 *
 * A card that is not in the matching state (legacy data) is never forced into
 * a state it never had; the sale then runs its own lifecycle after the visit
 * leaves the pair.
 */

type Fixture = Awaited<ReturnType<typeof saleFixture>>;
type App = ReturnType<typeof Fastify>;

const MEETING_AT = '2026-10-14T07:50:00.000Z';
const REVISION_REASON = 'Ürün miktarını ve teslim notunu düzeltin.';

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
    staff_completed_at: Date | null;
    staff_completion_note: string | null;
    revision_requested_at: Date | null;
    revision_requested_by: string | null;
    revision_reason: string | null;
  }>(
    `SELECT status, version, staff_completed_at, staff_completion_note,
            revision_requested_at, revision_requested_by, revision_reason
       FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

async function submitPair(fixture: Fixture) {
  const sale = await fixture.service.createSaleFromVisit(fixture.staff, fixture.visitId, {
    ...fixture.input,
    clientActionId: 's2-rwr-sale-create',
  });
  const details = await fixture.service.patchMeetingDetails(fixture.staff, fixture.visitId, {
    clientActionId: 's2-rwr-meeting',
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
        clientActionId: 's2-rwr-pair-submit',
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
  return { sale, visitVersion: submittedBody.version as number, saleVersion: sale.version + 1 };
}

async function demoteSale(fixture: Fixture, saleId: string, status: string): Promise<number> {
  const result = await fixture.pool.query<{ version: number }>(
    `UPDATE job_cards
        SET status = $2::text,
            version = version + 1,
            started_at = CASE WHEN $2::text IN ('IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
                              THEN COALESCE(started_at, $3::timestamptz) ELSE started_at END
      WHERE id = $1
      RETURNING version`,
    [saleId, status, new Date('2026-10-14T07:55:00.000Z')],
  );
  return result.rows[0]!.version;
}

async function receipt(fixture: Fixture, operationKey: string) {
  return (await fixture.pool.query<{
    status: string;
    response_body: Record<string, unknown>;
  }>(
    'SELECT status, response_body FROM processed_actions WHERE operation_key = $1',
    [operationKey],
  )).rows[0];
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S2 pair revision, withdraw and resume', () => {
  it('moves both cards through revision, resume and a second joint submission', async () => {
    await withSaleFixture(async (f) => {
      const pair = await submitPair(f);
      const submittedVisit = await jobRow(f, f.visitId);
      const submittedSale = await jobRow(f, pair.sale.jobCardId);

      await withApp(f, () => f.manager, async (app) => {
        const revised = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/request-revision`,
          payload: {
            clientActionId: 's2-pair-revision',
            expectedVersion: pair.visitVersion,
            expectedSaleVersion: pair.saleVersion,
            revisionReason: REVISION_REASON,
          },
        });
        expect(revised.statusCode).toBe(200);
        expect(revised.json()).toMatchObject({
          status: 'REVISION_REQUESTED',
          version: pair.visitVersion + 1,
          linkedSaleJobCardId: pair.sale.jobCardId,
        });
      });

      // §4.3: both cards carry the same reason, timestamp and actor.
      const revisedVisit = await jobRow(f, f.visitId);
      const revisedSale = await jobRow(f, pair.sale.jobCardId);
      expect(revisedVisit).toMatchObject({
        status: 'REVISION_REQUESTED',
        version: pair.visitVersion + 1,
        revision_reason: REVISION_REASON,
      });
      expect(revisedSale).toMatchObject({
        status: 'REVISION_REQUESTED',
        version: pair.saleVersion + 1,
        revision_reason: REVISION_REASON,
      });
      expect(revisedVisit.revision_requested_by).toBe(f.manager.id);
      expect(revisedSale.revision_requested_by).toBe(f.manager.id);
      expect(revisedVisit.revision_requested_at!.getTime()).toBe(revisedSale.revision_requested_at!.getTime());
      // Prior submission facts stay append-only evidence.
      expect(revisedVisit.staff_completed_at!.getTime()).toBe(submittedVisit.staff_completed_at!.getTime());
      expect(revisedSale.staff_completed_at!.getTime()).toBe(submittedSale.staff_completed_at!.getTime());
      expect(revisedSale.staff_completion_note).toBe(submittedSale.staff_completion_note);

      for (const jobCardId of [f.visitId, pair.sale.jobCardId]) {
        expect(await count(f,
          `SELECT count(*)::int AS n FROM job_card_activity_logs
            WHERE job_card_id = $1 AND event_type = 'JOB_REVISION_REQUESTED'`, [jobCardId])).toBe(1);
      }
      expect((await receipt(f, `JOB_REQUEST_REVISION_PAIR:${f.visitId}`))?.status).toBe('completed');
      expect((await receipt(f, `JOB_REQUEST_REVISION_PAIR:${f.visitId}`))?.response_body)
        .toMatchObject({ linkedSaleJobCardId: pair.sale.jobCardId });
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_lifecycle_intents WHERE operation_key LIKE $1`,
        [`JOB_REQUEST_REVISION_PAIR:${f.visitId}%`])).toBe(2);

      await withApp(f, () => f.staff, async (app) => {
        const resumed = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/resume`,
          payload: {
            clientActionId: 's2-pair-resume',
            expectedVersion: pair.visitVersion + 1,
            expectedSaleVersion: pair.saleVersion + 1,
          },
        });
        expect(resumed.statusCode).toBe(200);
        expect(resumed.json()).toMatchObject({
          status: 'IN_PROGRESS',
          version: pair.visitVersion + 2,
          linkedSaleJobCardId: pair.sale.jobCardId,
        });
      });

      expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'IN_PROGRESS', version: pair.visitVersion + 2 });
      expect(await jobRow(f, pair.sale.jobCardId)).toMatchObject({ status: 'IN_PROGRESS', version: pair.saleVersion + 2 });
      for (const jobCardId of [f.visitId, pair.sale.jobCardId]) {
        expect(await count(f,
          `SELECT count(*)::int AS n FROM job_card_activity_logs
            WHERE job_card_id = $1 AND event_type = 'JOB_RESUMED'`, [jobCardId])).toBe(1);
      }
      expect((await receipt(f, `JOB_RESUME_PAIR:${f.visitId}`))?.status).toBe('completed');

      // §4.4: after a joint resume both cards submit together again.
      await withApp(f, () => f.staff, async (app) => {
        const resubmitted = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-pair-resubmit',
            expectedVersion: pair.visitVersion + 2,
            expectedSaleVersion: pair.saleVersion + 2,
            note: 'Düzeltmeler tamamlandı.',
          },
        });
        expect(resubmitted.statusCode).toBe(200);
        expect(resubmitted.json()).toMatchObject({
          status: 'WAITING_APPROVAL',
          linkedSaleJobCardId: pair.sale.jobCardId,
        });
      });
      expect(await jobRow(f, pair.sale.jobCardId)).toMatchObject({ status: 'WAITING_APPROVAL' });
    });
  });

  it('returns both cards to IN_PROGRESS on withdraw while keeping submission evidence', async () => {
    await withSaleFixture(async (f) => {
      const pair = await submitPair(f);
      const submittedSale = await jobRow(f, pair.sale.jobCardId);

      await withApp(f, () => f.staff, async (app) => {
        const withdrawn = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/withdraw-from-approval`,
          payload: {
            clientActionId: 's2-pair-withdraw',
            expectedVersion: pair.visitVersion,
            expectedSaleVersion: pair.saleVersion,
          },
        });
        expect(withdrawn.statusCode).toBe(200);
        expect(withdrawn.json()).toMatchObject({
          status: 'IN_PROGRESS',
          version: pair.visitVersion + 1,
          linkedSaleJobCardId: pair.sale.jobCardId,
        });
      });

      const visit = await jobRow(f, f.visitId);
      const sale = await jobRow(f, pair.sale.jobCardId);
      expect(visit).toMatchObject({ status: 'IN_PROGRESS', version: pair.visitVersion + 1 });
      expect(sale).toMatchObject({ status: 'IN_PROGRESS', version: pair.saleVersion + 1 });
      // §4.3: the sale's staff_completed_* facts stay as historical evidence.
      expect(sale.staff_completed_at!.getTime()).toBe(submittedSale.staff_completed_at!.getTime());
      expect(sale.staff_completion_note).toBe(submittedSale.staff_completion_note);
      for (const jobCardId of [f.visitId, pair.sale.jobCardId]) {
        expect(await count(f,
          `SELECT count(*)::int AS n FROM job_card_activity_logs
            WHERE job_card_id = $1 AND event_type = 'JOB_APPROVAL_WITHDRAWN'`, [jobCardId])).toBe(1);
      }
      expect((await receipt(f, `JOB_WITHDRAW_FROM_APPROVAL_PAIR:${f.visitId}`))?.status).toBe('completed');

      await withApp(f, () => f.staff, async (app) => {
        const resubmitted = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-pair-withdraw-resubmit',
            expectedVersion: pair.visitVersion + 1,
            expectedSaleVersion: pair.saleVersion + 1,
            note: 'Geri çekildikten sonra tekrar onaya gönderildi.',
          },
        });
        expect(resubmitted.statusCode).toBe(200);
        expect(resubmitted.json()).toMatchObject({
          status: 'WAITING_APPROVAL',
          linkedSaleJobCardId: pair.sale.jobCardId,
        });
      });
    });
  });

  it.each(['NEW', 'ACCEPTED', 'IN_PROGRESS'] as const)(
    'does not force a legacy %s sale into revision',
    async (legacyStatus) => {
      await withSaleFixture(async (f) => {
        const pair = await submitPair(f);
        const legacySaleVersion = await demoteSale(f, pair.sale.jobCardId, legacyStatus);

        await withApp(f, () => f.manager, async (app) => {
          const revised = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${f.visitId}/request-revision`,
            payload: {
              clientActionId: `s2-legacy-revision-${legacyStatus}`,
              expectedVersion: pair.visitVersion,
              expectedSaleVersion: legacySaleVersion,
              revisionReason: REVISION_REASON,
            },
          });
          expect(revised.statusCode).toBe(200);
          const body = revised.json() as Record<string, unknown>;
          expect(body).toMatchObject({ status: 'REVISION_REQUESTED' });
          expect(body.linkedSaleJobCardId ?? null).toBeNull();
        });

        expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'REVISION_REQUESTED' });
        expect(await jobRow(f, pair.sale.jobCardId)).toMatchObject({
          status: legacyStatus,
          version: legacySaleVersion,
          revision_reason: null,
        });
        expect(await count(f,
          `SELECT count(*)::int AS n FROM job_card_activity_logs
            WHERE job_card_id = $1 AND event_type = 'JOB_REVISION_REQUESTED'`, [pair.sale.jobCardId])).toBe(0);

        // The visit resumes alone; the legacy sale is still untouched.
        await withApp(f, () => f.staff, async (app) => {
          const resumed = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${f.visitId}/resume`,
            payload: {
              clientActionId: `s2-legacy-resume-${legacyStatus}`,
              expectedVersion: pair.visitVersion + 1,
              expectedSaleVersion: legacySaleVersion,
            },
          });
          expect(resumed.statusCode).toBe(200);
          expect(resumed.json()).toMatchObject({ status: 'IN_PROGRESS' });
          expect((resumed.json() as Record<string, unknown>).linkedSaleJobCardId ?? null).toBeNull();
        });
        expect(await jobRow(f, pair.sale.jobCardId)).toMatchObject({ status: legacyStatus, version: legacySaleVersion });
      });
    },
  );

  it.each(['NEW', 'IN_PROGRESS'] as const)(
    'does not jump a legacy %s sale back to IN_PROGRESS on withdraw',
    async (legacyStatus) => {
      await withSaleFixture(async (f) => {
        const pair = await submitPair(f);
        const legacySaleVersion = await demoteSale(f, pair.sale.jobCardId, legacyStatus);

        await withApp(f, () => f.staff, async (app) => {
          const withdrawn = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${f.visitId}/withdraw-from-approval`,
            payload: {
              clientActionId: `s2-legacy-withdraw-${legacyStatus}`,
              expectedVersion: pair.visitVersion,
              expectedSaleVersion: legacySaleVersion,
            },
          });
          expect(withdrawn.statusCode).toBe(200);
          const body = withdrawn.json() as Record<string, unknown>;
          expect(body).toMatchObject({ status: 'IN_PROGRESS' });
          expect(body.linkedSaleJobCardId ?? null).toBeNull();
        });

        expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'IN_PROGRESS' });
        expect(await jobRow(f, pair.sale.jobCardId)).toMatchObject({
          status: legacyStatus,
          version: legacySaleVersion,
        });
        expect(await count(f,
          `SELECT count(*)::int AS n FROM job_card_activity_logs
            WHERE job_card_id = $1 AND event_type = 'JOB_APPROVAL_WITHDRAWN'`, [pair.sale.jobCardId])).toBe(0);
      });
    },
  );
});
