import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { saleFixture, withSaleFixture } from './support/sale-harness.js';

/**
 * SALE-002 slice S2 acceptance — single-card redirects (R15) and the live-pair
 * ownership invariant (R17).
 * Owning contract: docs/features/visit-to-sale/sale-002-contract.md
 *   §4.2 coordinating predicates and redirect table, §4.3 last item
 *   (assignment changes) and CANCEL/INVALIDATE, §4.8 decoupled legacy pair.
 *
 * While the source visit is in the coordinating status for a command, the
 * sale-side command is redirected with a coded 409. A pair whose assignees
 * diverge is decoupled: no redirect, no shared ids, per-card lifecycles.
 */

type Fixture = Awaited<ReturnType<typeof saleFixture>>;
type App = ReturnType<typeof Fastify>;

const MEETING_AT = '2026-10-14T07:50:00.000Z';

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
  return (await fixture.pool.query<{ status: string; version: number; assigned_to: string }>(
    'SELECT status, version, assigned_to FROM job_cards WHERE id = $1',
    [jobCardId],
  )).rows[0]!;
}

async function recordVisitResult(fixture: Fixture, expectedVersion: number, clientActionId: string) {
  const details = await fixture.service.patchMeetingDetails(fixture.staff, fixture.visitId, {
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

async function createActiveSale(fixture: Fixture, clientActionId = 's2-redirect-sale-create') {
  return fixture.service.createSaleFromVisit(fixture.staff, fixture.visitId, {
    ...fixture.input,
    clientActionId,
  });
}

async function submitPair(fixture: Fixture) {
  const sale = await createActiveSale(fixture);
  const visitVersion = await recordVisitResult(fixture, fixture.input.expectedSourceVersion, 's2-redirect-meeting');
  let body: Record<string, unknown> = {};
  await withApp(fixture, () => fixture.staff, async (app) => {
    const submitted = await app.inject({
      method: 'POST',
      url: `/api/job-cards/${fixture.visitId}/submit-for-approval`,
      payload: {
        clientActionId: 's2-redirect-pair-submit',
        expectedVersion: visitVersion,
        expectedSaleVersion: sale.version,
        note: 'Ziyaret ve bağlı satış kaydı onaya hazır.',
      },
    });
    expect(submitted.statusCode).toBe(200);
    body = submitted.json() as Record<string, unknown>;
  });
  return { sale, visitVersion: body.version as number, saleVersion: sale.version + 1 };
}

function redirectDetails(response: { json: () => Record<string, unknown> }): Record<string, unknown> {
  return (response.json().details ?? {}) as Record<string, unknown>;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S2 sale-side redirects', () => {
  it('redirects a coordinated sale submission to the visit and writes nothing', async () => {
    await withSaleFixture(async (f) => {
      const sale = await createActiveSale(f);
      await recordVisitResult(f, f.input.expectedSourceVersion, 's2-redirect-submit-meeting');
      const before = await jobRow(f, sale.jobCardId);
      const receiptsBefore = await count(f,
        "SELECT count(*)::int AS n FROM processed_actions WHERE status = 'completed'");

      await withApp(f, () => f.staff, async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${sale.jobCardId}/submit-for-approval?includeSaleCapability=true`,
          payload: {
            clientActionId: 's2-sale-side-submit',
            expectedVersion: sale.version,
            expectedSaleVersion: sale.version,
            note: 'Satışı tek başına gönderme denemesi.',
          },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('SALE_SUBMIT_VIA_VISIT_REQUIRED');
        const details = redirectDetails(response);
        expect(details).toMatchObject({
          visitId: f.visitId,
          saleId: sale.jobCardId,
          saleStatus: 'ACCEPTED',
          allowedSaleCommand: 'SUBMIT_FOR_APPROVAL',
        });
      });

      expect(await jobRow(f, sale.jobCardId)).toEqual(before);
      expect(await count(f,
        "SELECT count(*)::int AS n FROM processed_actions WHERE status = 'completed'")).toBe(receiptsBefore);
    });
  });

  it('redirects sale approval, revision, withdraw and resume to the coordinated visit', async () => {
    await withSaleFixture(async (f) => {
      const pair = await submitPair(f);
      const before = await jobRow(f, pair.sale.jobCardId);

      const cases: Array<[string, string, string, Record<string, unknown>]> = [
        ['approve', 'SALE_APPROVE_VIA_VISIT_REQUIRED', 'APPROVE', { note: 'Tek kart onayı.' }],
        ['request-revision', 'SALE_REVISION_VIA_VISIT_REQUIRED', 'REQUEST_REVISION', { revisionReason: 'Tek kart revizyonu.' }],
        ['withdraw-from-approval', 'SALE_WITHDRAW_VIA_VISIT_REQUIRED', 'WITHDRAW_FROM_APPROVAL', {}],
      ];

      await withApp(f, () => f.manager, async (app) => {
        for (const [command, code, allowedSaleCommand, extra] of cases) {
          const response = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${pair.sale.jobCardId}/${command}?includeSaleCapability=true`,
            payload: {
              clientActionId: `s2-sale-side-${command}`,
              expectedVersion: pair.saleVersion,
              expectedSaleVersion: pair.saleVersion,
              ...extra,
            },
          });
          expect.soft(response.statusCode, command).toBe(409);
          expect.soft(response.json().code, command).toBe(code);
          expect.soft(redirectDetails(response), command).toMatchObject({
            visitId: f.visitId,
            saleId: pair.sale.jobCardId,
            saleStatus: 'WAITING_APPROVAL',
            allowedSaleCommand,
          });
        }

        // Move the pair into revision through the visit, then prove the sale
        // resume is redirected as well.
        const revised = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/request-revision`,
          payload: {
            clientActionId: 's2-redirect-pair-revision',
            expectedVersion: pair.visitVersion,
            expectedSaleVersion: pair.saleVersion,
            revisionReason: 'Onay öncesi düzeltme.',
          },
        });
        expect(revised.statusCode).toBe(200);

        const resume = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${pair.sale.jobCardId}/resume?includeSaleCapability=true`,
          payload: {
            clientActionId: 's2-sale-side-resume',
            expectedVersion: pair.saleVersion + 1,
            expectedSaleVersion: pair.saleVersion + 1,
          },
        });
        expect(resume.statusCode).toBe(409);
        expect(resume.json().code).toBe('SALE_RESUME_VIA_VISIT_REQUIRED');
        expect(redirectDetails(resume)).toMatchObject({
          visitId: f.visitId,
          saleId: pair.sale.jobCardId,
          saleStatus: 'REVISION_REQUESTED',
          allowedSaleCommand: 'RESUME',
        });
      });

      // The rejected attempts never moved the sale.
      expect((await jobRow(f, pair.sale.jobCardId)).status).toBe('REVISION_REQUESTED');
      expect(before.status).toBe('WAITING_APPROVAL');
    });
  });

  it('never redirects ACCEPT_ASSIGNMENT on a NEW sale', async () => {
    await withSaleFixture(async (f) => {
      // ACCEPT_ASSIGNMENT on a NEW sale stays a per-card command (§4.2).
      const managerSale = await f.service.createSaleFromVisit(f.manager, f.visitId, {
        ...f.input,
        clientActionId: 's2-redirect-new-sale',
      });
      await withApp(f, () => f.staff, async (app) => {
        const accepted = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${managerSale.jobCardId}/accept?includeSaleCapability=true`,
          payload: { clientActionId: 's2-redirect-accept', expectedVersion: 1 },
        });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toMatchObject({ status: 'ACCEPTED' });
      });
    });
  });

  it('never redirects CANCEL and never cascades to the visit', async () => {
    await withSaleFixture(async (f) => {
      const pair = await submitPair(f);
      await withApp(f, () => f.manager, async (app) => {
        const cancelled = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${pair.sale.jobCardId}/cancel?includeSaleCapability=true`,
          payload: {
            clientActionId: 's2-sale-side-cancel',
            expectedVersion: pair.saleVersion,
            cancelReason: 'Satış kaydı iptal edildi.',
          },
        });
        expect(cancelled.statusCode).toBe(200);
        expect(cancelled.json()).toMatchObject({ status: 'CANCELLED' });
      });
      // The visit keeps waiting; no cascade.
      expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL' });
      expect(await jobRow(f, pair.sale.jobCardId)).toMatchObject({ status: 'CANCELLED' });
    });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S2 live-pair assignee invariant (R17)', () => {
  it('rejects a reassignment that would diverge a live pair', async () => {
    await withSaleFixture(async (f) => {
      const sale = await createActiveSale(f);
      const visit = await jobRow(f, f.visitId);

      const failure = await f.service
        .patch(f.manager, sale.jobCardId, { expectedVersion: sale.version, assignedTo: f.otherStaff.id })
        .then(() => null, (error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'SALE_PAIR_ASSIGNEE_CONFLICT',
        statusCode: 409,
        details: { visitAssignee: visit.assigned_to, requestedAssignee: f.otherStaff.id },
      });
      expect(await jobRow(f, sale.jobCardId)).toMatchObject({
        assigned_to: f.staff.id,
        version: sale.version,
        status: 'ACCEPTED',
      });
    });
  });

  it('allows reassignment once the source visit is terminal', async () => {
    await withSaleFixture(async (f) => {
      const sale = await createActiveSale(f);
      // Terminal source: the live-pair invariant no longer applies.
      await f.pool.query(
        `UPDATE job_cards
            SET status = 'CANCELLED', cancelled_at = $2, cancelled_by = $3,
                cancel_reason = 'Kaynak ziyaret kapatıldı.'
          WHERE id = $1`,
        [f.visitId, new Date('2026-10-14T08:05:00.000Z'), f.manager.id],
      );

      const reassigned = await f.service.patch(f.manager, sale.jobCardId, {
        expectedVersion: sale.version,
        assignedTo: f.otherStaff.id,
      });
      expect(reassigned).toMatchObject({ assignedTo: f.otherStaff.id });
      // Reassignment resets acceptance (existing behavior, not specified by SALE-002), so
      // only the new owner is asserted.
      expect(await jobRow(f, sale.jobCardId)).toMatchObject({ assigned_to: f.otherStaff.id });
    });
  });

  it('runs a legacy divergent pair per card without leaking the other card id', async () => {
    await withSaleFixture(async (f) => {
      const sale = await createActiveSale(f);
      // Legacy pre-S2 data: management had already reassigned the sale.
      await f.pool.query(
        'UPDATE job_cards SET assigned_to = $2, version = version + 1 WHERE id = $1',
        [sale.jobCardId, f.otherStaff.id],
      );
      const saleVersion = sale.version + 1;
      const visitVersion = await recordVisitResult(f, f.input.expectedSourceVersion, 's2-decoupled-meeting');

      // The visit owner submits the visit alone: no coordination, no pair receipt.
      await withApp(f, () => f.staff, async (app) => {
        const submitted = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-decoupled-visit-submit',
            expectedVersion: visitVersion,
            note: 'Ziyaret tek başına onaya gönderildi.',
          },
        });
        expect(submitted.statusCode, submitted.body).toBe(200);
        const body = submitted.json() as Record<string, unknown>;
        expect(body).toMatchObject({ status: 'WAITING_APPROVAL' });
        expect(body.linkedSaleJobCardId ?? null).toBeNull();
        // A Staff member who can read only the visit never receives the sale id.
        expect(JSON.stringify(body)).not.toContain(sale.jobCardId);
      });

      expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL' });
      expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: 'ACCEPTED', version: saleVersion });

      // The sale's own owner submits it on its own card (START first so the
      // test isolates decoupling from the R9 ACCEPTED-submit rule).
      await withApp(f, () => f.otherStaff, async (app) => {
        const started = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${sale.jobCardId}/start?includeSaleCapability=true`,
          payload: { clientActionId: 's2-decoupled-sale-start', expectedVersion: saleVersion },
        });
        expect(started.statusCode, started.body).toBe(200);
        const submitted = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${sale.jobCardId}/submit-for-approval?includeSaleCapability=true`,
          payload: {
            clientActionId: 's2-decoupled-sale-submit',
            expectedVersion: started.json().version as number,
            note: 'Satış kaydı tek başına onaya gönderildi.',
          },
        });
        expect(submitted.statusCode, submitted.body).toBe(200);
        const body = submitted.json() as Record<string, unknown>;
        expect(body).toMatchObject({ status: 'WAITING_APPROVAL' });
        expect(body.linkedSaleJobCardId ?? null).toBeNull();
        // The unreadable source visit id never reaches the sale owner.
        expect(JSON.stringify(body)).not.toContain(f.visitId);
      });

      expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: 'WAITING_APPROVAL', version: saleVersion + 2 });
      // §4.5: a decoupled pair never writes a pair receipt or participant intent.
      expect(await count(f,
        `SELECT count(*)::int AS n FROM processed_actions WHERE operation_key LIKE '%_PAIR:%'`)).toBe(0);
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_lifecycle_intents
          WHERE operation_key LIKE '%_PAIR:%' OR operation_key LIKE '%:participant'`)).toBe(0);
    });
  });

  it('restores coordination when management re-aligns the sale to the visit owner', async () => {
    await withSaleFixture(async (f) => {
      const sale = await createActiveSale(f);
      await f.pool.query(
        'UPDATE job_cards SET assigned_to = $2, version = version + 1 WHERE id = $1',
        [sale.jobCardId, f.otherStaff.id],
      );
      const divergentVersion = sale.version + 1;

      const realigned = await f.service.patch(f.manager, sale.jobCardId, {
        expectedVersion: divergentVersion,
        assignedTo: f.staff.id,
      });
      expect(realigned).toMatchObject({ assignedTo: f.staff.id });
      // Reassignment resets acceptance (existing behavior): the sale is NEW again, and §4.4
      // makes a NEW linked sale conflict until its owner accepts it.
      let saleVersion = divergentVersion + 1;
      await withApp(f, () => f.staff, async (app) => {
        const accepted = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${sale.jobCardId}/accept?includeSaleCapability=true`,
          payload: { clientActionId: 's2-realigned-sale-accept', expectedVersion: saleVersion },
        });
        expect(accepted.statusCode, accepted.body).toBe(200);
        saleVersion = accepted.json().version as number;
      });
      const visitVersion = await recordVisitResult(f, f.input.expectedSourceVersion, 's2-realigned-meeting');

      await withApp(f, () => f.staff, async (app) => {
        const submitted = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-realigned-pair-submit',
            expectedVersion: visitVersion,
            expectedSaleVersion: saleVersion,
            note: 'Hizalama sonrası ortak gönderim.',
          },
        });
        expect(submitted.statusCode).toBe(200);
        expect(submitted.json()).toMatchObject({
          status: 'WAITING_APPROVAL',
          linkedSaleJobCardId: sale.jobCardId,
        });
      });
      expect(await jobRow(f, sale.jobCardId)).toMatchObject({ status: 'WAITING_APPROVAL', version: saleVersion + 1 });
    });
  });
});
