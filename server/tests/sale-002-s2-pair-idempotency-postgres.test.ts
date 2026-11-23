import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { saleFixture, withSaleFixture } from './support/sale-harness.js';

/**
 * SALE-002 slice S2 acceptance — pair request identity, replay and definitive
 * failures.
 * Owning contract: docs/features/visit-to-sale/sale-002-contract.md
 *   §4.5 idempotency/request identity (client action keys, request hash,
 *   `expectedSaleVersion` required iff coordinated), §4.6 FAILED-together
 *   intents, §5.4 retry contract, §9.3 idempotency rows.
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
  return (await fixture.pool.query<{ status: string; version: number }>(
    'SELECT status, version FROM job_cards WHERE id = $1',
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

async function readyPair(fixture: Fixture) {
  const sale = await fixture.service.createSaleFromVisit(fixture.staff, fixture.visitId, {
    ...fixture.input,
    clientActionId: 's2-idem-sale-create',
  });
  const visitVersion = await recordVisitResult(fixture, fixture.input.expectedSourceVersion, 's2-idem-meeting');
  return { sale, visitVersion, saleVersion: sale.version };
}

async function submitPair(fixture: Fixture, app: App, clientActionId = 's2-idem-pair-submit') {
  const pair = await readyPair(fixture);
  const response = await app.inject({
    method: 'POST',
    url: `/api/job-cards/${fixture.visitId}/submit-for-approval`,
    payload: {
      clientActionId,
      expectedVersion: pair.visitVersion,
      expectedSaleVersion: pair.saleVersion,
      note: 'Ziyaret ve bağlı satış kaydı onaya hazır.',
    },
  });
  expect(response.statusCode).toBe(200);
  return { ...pair, response };
}

async function sideEffectCounts(fixture: Fixture) {
  return (await fixture.pool.query<{
    activities: number;
    intents: number;
    receipts: number;
    realtime: number;
    facts: number;
  }>(
    `SELECT (SELECT count(*)::int FROM job_card_activity_logs) AS activities,
            (SELECT count(*)::int FROM job_card_lifecycle_intents) AS intents,
            (SELECT count(*)::int FROM processed_actions) AS receipts,
            (SELECT count(*)::int FROM realtime_events) AS realtime,
            (SELECT count(*)::int FROM job_card_accountability_facts) AS facts`,
  )).rows[0]!;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S2 pair idempotency', () => {
  it('replays an exact pair submit with the stored receipt and publishes nothing new', async () => {
    await withSaleFixture(async (f) => {
      await withApp(f, () => f.staff, async (app) => {
        const pair = await readyPair(f);
        const payload = {
          clientActionId: 's2-pair-replay-submit',
          expectedVersion: pair.visitVersion,
          expectedSaleVersion: pair.saleVersion,
          note: 'Ziyaret ve bağlı satış kaydı onaya hazır.',
        };
        const first = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload,
        });
        expect(first.statusCode).toBe(200);
        const before = await sideEffectCounts(f);

        const replay = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload,
        });
        expect([200, 201]).toContain(replay.statusCode);
        expect(replay.json()).toEqual(first.json());
        expect(await sideEffectCounts(f)).toEqual(before);
      });
    });
  });

  it('rejects the same client action key with a changed expectedSaleVersion', async () => {
    await withSaleFixture(async (f) => {
      await withApp(f, () => f.staff, async (app) => {
        const pair = await readyPair(f);
        const first = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-pair-reuse-submit',
            expectedVersion: pair.visitVersion,
            expectedSaleVersion: pair.saleVersion,
            note: 'Ziyaret ve bağlı satış kaydı onaya hazır.',
          },
        });
        expect(first.statusCode).toBe(200);
        const before = await sideEffectCounts(f);

        const reused = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-pair-reuse-submit',
            expectedVersion: pair.visitVersion,
            expectedSaleVersion: pair.saleVersion + 1,
            note: 'Ziyaret ve bağlı satış kaydı onaya hazır.',
          },
        });
        expect(reused.statusCode).toBe(409);
        expect(reused.json().code).toBe('CLIENT_ACTION_REUSED');
        expect(await sideEffectCounts(f)).toEqual(before);
      });
    });
  });

  it('rejects the same client action key applied to a different linked sale', async () => {
    await withSaleFixture(async (f) => {
      await withApp(f, () => f.staff, async (app) => {
        const pair = await submitPair(f, app, 's2-pair-other-sale-key');

        // Close the first sale (never redirected) and release the visit slot.
        await withApp(f, () => f.manager, async (managerApp) => {
          const cancelled = await managerApp.inject({
            method: 'POST',
            url: `/api/job-cards/${pair.sale.jobCardId}/cancel?includeSaleCapability=true`,
            payload: {
              clientActionId: 's2-pair-other-sale-cancel',
              expectedVersion: pair.saleVersion + 1,
              cancelReason: 'Satış kaydı kapatıldı.',
            },
          });
          expect(cancelled.statusCode).toBe(200);
        });
        // The sale is CANCELLED, so no coordinated pair exists: §4.5 rejects expectedSaleVersion.
        const withdrawn = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/withdraw-from-approval`,
          payload: {
            clientActionId: 's2-pair-other-sale-withdraw',
            expectedVersion: pair.visitVersion + 1,
          },
        });
        expect(withdrawn.statusCode).toBe(200);
        const visitVersion = withdrawn.json().version as number;

        const replacement = await f.service.createSaleFromVisit(f.staff, f.visitId, {
          ...f.input,
          clientActionId: 's2-pair-other-sale-create',
          expectedSourceVersion: visitVersion,
        });
        expect(replacement.jobCardId).not.toBe(pair.sale.jobCardId);

        const reused = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-pair-other-sale-key',
            expectedVersion: visitVersion,
            expectedSaleVersion: replacement.version,
            note: 'Başka bir satış kaydı için aynı anahtar.',
          },
        });
        expect(reused.statusCode).toBe(409);
        expect(reused.json().code).toBe('CLIENT_ACTION_REUSED');
        expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'IN_PROGRESS', version: visitVersion });
        expect(await jobRow(f, replacement.jobCardId)).toMatchObject({ status: 'ACCEPTED', version: 1 });
      });
    });
  });

  it('marks both intents FAILED after a definitive approval failure and refuses the same key', async () => {
    await withSaleFixture(async (f) => {
      const pair = await readyPair(f);
      let submitted: Record<string, unknown> = {};
      await withApp(f, () => f.staff, async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-failed-pair-submit',
            expectedVersion: pair.visitVersion,
            expectedSaleVersion: pair.saleVersion,
            note: 'Ziyaret ve bağlı satış kaydı onaya hazır.',
            // A human-chosen slot is persisted verbatim; a SYSTEM-origin proposal would be
            // re-slotted automatically at approval and never fail (existing JOB-008 rule).
            followUpProposal: {
              scheduledAt: '2026-11-30T07:00:00.000Z',
              type: 'SALES_MEETING',
              assignedTo: f.staff.id,
              followUpInstructions: 'Takip: Clinic visit',
            },
          },
        });
        expect(response.statusCode).toBe(200);
        submitted = response.json() as Record<string, unknown>;
      });
      const visitVersion = submitted.version as number;
      const saleVersion = (await jobRow(f, pair.sale.jobCardId)).version;
      const proposal = submitted.followUpProposal as { scheduledAt: string };
      expect(typeof proposal.scheduledAt).toBe('string');

      // A conflicting follow-up visit appears after submission (§5.4 CSI-10 shape).
      await f.pool.query(
        `INSERT INTO job_cards
           (organization_id, type, status, title, customer_id, assigned_to, created_by,
            scheduled_at, scheduled_ends_at, engagement_kind)
         VALUES ($1, 'SALES_MEETING', 'NEW', 'Çakışan takip ziyareti', $2, $3, $4,
                 $5, $5::timestamptz + interval '1 hour', 'FOLLOW_UP')`,
        [f.organizationId, f.customerId, f.staff.id, f.manager.id, proposal.scheduledAt],
      );

      const approvalPayload = {
        clientActionId: 's2-failed-pair-approve',
        expectedVersion: visitVersion,
        expectedSaleVersion: saleVersion,
        note: 'Onay denemesi.',
      };
      const failure = await f.service
        .approve(f.manager, f.visitId, approvalPayload)
        .then(() => null, (error: unknown) => error);
      expect(failure).toMatchObject({ code: 'CUSTOMER_VISIT_DUPLICATE', statusCode: 409 });

      // No partial approval and no half-failed pair (§4.6).
      expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL', version: visitVersion });
      expect(await jobRow(f, pair.sale.jobCardId)).toMatchObject({ status: 'WAITING_APPROVAL', version: saleVersion });
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_activity_logs
          WHERE job_card_id = ANY($1::uuid[]) AND event_type = 'JOB_APPROVED'`,
        [[f.visitId, pair.sale.jobCardId]])).toBe(0);
      expect(await count(f,
        'SELECT count(*)::int AS n FROM job_cards WHERE source_job_card_id = $1', [f.visitId])).toBe(0);

      const anchorKey = `JOB_APPROVE_PAIR:${f.visitId}`;
      const intents = (await f.pool.query<{
        job_card_id: string;
        state: string;
        failure_code: string | null;
        failed_at: Date | null;
      }>(
        `SELECT job_card_id, state, failure_code, failed_at FROM job_card_lifecycle_intents
          WHERE operation_key LIKE $1`, [`${anchorKey}%`],
      )).rows;
      expect(intents).toHaveLength(2);
      expect(intents.every((row) => row.state === 'FAILED')).toBe(true);
      expect(new Set(intents.map((row) => row.failure_code))).toEqual(new Set(['CUSTOMER_VISIT_DUPLICATE']));
      const failedTimes = intents.map((row) => row.failed_at!.getTime());
      expect(failedTimes[0]).toBe(failedTimes[1]);
      // A definitively failed attempt leaves no receipt at all.
      expect(await count(f,
        'SELECT count(*)::int AS n FROM processed_actions WHERE operation_key = $1', [anchorKey])).toBe(0);

      // The same key is terminal: retrying it cannot run the approval again.
      const retried = await f.service
        .approve(f.manager, f.visitId, approvalPayload)
        .then(() => null, (error: unknown) => error);
      expect(retried).toMatchObject({ code: 'CUSTOMER_VISIT_DUPLICATE' });
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_lifecycle_intents
          WHERE operation_key LIKE $1`, [`${anchorKey}%`])).toBe(2);

      // A corrected attempt uses a new key and an explicit follow-up override.
      const retryAt = new Date(Date.parse(proposal.scheduledAt) + 2 * 60 * 60 * 1000).toISOString();
      let approvedBody: Record<string, unknown> = {};
      await withApp(f, () => f.manager, async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/approve`,
          payload: {
            clientActionId: 's2-corrected-pair-approve',
            expectedVersion: visitVersion,
            expectedSaleVersion: saleVersion,
            note: 'Çakışma giderildi.',
            followUp: {
              scheduledAt: retryAt,
              type: 'SALES_MEETING',
              assignedTo: f.staff.id,
              followUpInstructions: 'Takip: yeni tarihte görüşün.',
            },
          },
        });
        expect(response.statusCode).toBe(200);
        approvedBody = response.json() as Record<string, unknown>;
      });
      expect(approvedBody).toMatchObject({ status: 'COMPLETED', linkedSaleJobCardId: pair.sale.jobCardId });
      expect(await jobRow(f, pair.sale.jobCardId)).toMatchObject({ status: 'COMPLETED' });
    });
  });

  it('rejects the same approve key with a changed approval follow-up override and replays an identical one', async () => {
    await withSaleFixture(async (f) => {
      const pair = await readyPair(f);
      let submitted: Record<string, unknown> = {};
      await withApp(f, () => f.staff, async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/job-cards/${f.visitId}/submit-for-approval`,
          payload: {
            clientActionId: 's2-override-submit',
            expectedVersion: pair.visitVersion,
            expectedSaleVersion: pair.saleVersion,
            note: 'Ziyaret ve bağlı satış kaydı onaya hazır.',
            followUpProposal: {
              scheduledAt: '2026-11-30T07:00:00.000Z',
              type: 'SALES_MEETING',
              assignedTo: f.staff.id,
              followUpInstructions: 'Takip: Clinic visit',
            },
          },
        });
        expect(response.statusCode).toBe(200);
        submitted = response.json() as Record<string, unknown>;
      });
      const payload = {
        clientActionId: 's2-override-approve',
        expectedVersion: submitted.version as number,
        expectedSaleVersion: (await jobRow(f, pair.sale.jobCardId)).version,
        followUp: {
          scheduledAt: '2026-12-02T07:00:00.000Z',
          type: 'SALES_MEETING',
          assignedTo: f.staff.id,
          followUpInstructions: 'Takip: yeni tarihte görüşün.',
        },
      };
      await withApp(f, () => f.manager, async (app) => {
        const first = await app.inject({
          method: 'POST', url: `/api/job-cards/${f.visitId}/approve`, payload,
        });
        expect(first.statusCode).toBe(200);
        const before = await sideEffectCounts(f);

        const replay = await app.inject({
          method: 'POST', url: `/api/job-cards/${f.visitId}/approve`, payload,
        });
        expect([200, 201]).toContain(replay.statusCode);
        expect(replay.json()).toEqual(first.json());
        expect(await sideEffectCounts(f)).toEqual(before);

        for (const followUp of [
          { ...payload.followUp, scheduledAt: '2026-12-03T07:00:00.000Z' },
          { ...payload.followUp, priority: 'high' },
          { ...payload.followUp, followUpInstructions: 'Takip: başka talimat.' },
        ]) {
          const reused = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${f.visitId}/approve`,
            payload: { ...payload, followUp },
          });
          expect(reused.statusCode).toBe(409);
          expect(reused.json().code).toBe('CLIENT_ACTION_REUSED');
        }
        expect(await sideEffectCounts(f)).toEqual(before);
      });
    });
  });

  it('rejects the same request-revision key with a changed correctionDueAt and replays an identical one', async () => {
    await withSaleFixture(async (f) => {
      let submitted: Awaited<ReturnType<typeof submitPair>> | null = null;
      await withApp(f, () => f.staff, async (app) => {
        submitted = await submitPair(f, app, 's2-correction-submit');
      });
      const pair = submitted!;
      const payload = {
        clientActionId: 's2-correction-revision',
        expectedVersion: (pair.response.json() as { version: number }).version,
        expectedSaleVersion: (await jobRow(f, pair.sale.jobCardId)).version,
        revisionReason: 'Ürün miktarını düzeltin.',
        correctionDueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      };
      await withApp(f, () => f.manager, async (app) => {
        const first = await app.inject({
          method: 'POST', url: `/api/job-cards/${f.visitId}/request-revision`, payload,
        });
        expect(first.statusCode).toBe(200);
        const before = await sideEffectCounts(f);

        const replay = await app.inject({
          method: 'POST', url: `/api/job-cards/${f.visitId}/request-revision`, payload,
        });
        expect([200, 201]).toContain(replay.statusCode);
        expect(replay.json()).toEqual(first.json());
        expect(await sideEffectCounts(f)).toEqual(before);

        const { correctionDueAt: _omitted, ...withoutDeadline } = payload;
        for (const changed of [
          { ...payload, correctionDueAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
          withoutDeadline,
        ]) {
          const reused = await app.inject({
            method: 'POST', url: `/api/job-cards/${f.visitId}/request-revision`, payload: changed,
          });
          expect(reused.statusCode).toBe(409);
          expect(reused.json().code).toBe('CLIENT_ACTION_REUSED');
        }
        expect(await sideEffectCounts(f)).toEqual(before);
      });
    });
  });

  it('rejects expectedSaleVersion on commands that are not pair-capable', async () => {
    await withSaleFixture(async (f) => {
      const pair = await readyPair(f);
      await withApp(f, () => f.staff, async (app) => {
        for (const [command, extra] of [
          ['accept', {}],
          ['start', {}],
          ['cancel', { cancelReason: 'Alan dışı.' }],
        ] as const) {
          const response = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${f.visitId}/${command}`,
            payload: {
              clientActionId: `s2-field-not-pair-capable-${command}`,
              expectedVersion: pair.visitVersion,
              expectedSaleVersion: pair.saleVersion,
              ...extra,
            },
          });
          expect.soft(response.statusCode, command).toBe(400);
          expect.soft(response.json().code, command).toBe('VALIDATION_ERROR');
        }
      });
      // Nothing moved.
      expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'IN_PROGRESS', version: pair.visitVersion });
    });
  });

  it('returns NO_COORDINATED_PAIR when a pair-only command carries the field without a pair', async () => {
    await withSaleFixture(async (f) => {
      const customerId = (await f.pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'S2 eşleşmesiz klinik', 'clinic', 'active') RETURNING id`,
        [f.organizationId],
      )).rows[0]!.id;
      const visit = await f.service.create(f.staff, {
        clientActionId: 's2-no-pair-visit-create',
        type: 'SALES_MEETING',
        title: 'Eşleşmesiz ziyaret',
        description: null,
        customerId,
        contactId: null,
        assignedTo: f.staff.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: '2026-10-14T10:00:00.000Z',
        scheduledEndsAt: '2026-10-14T11:00:00.000Z',
        engagementKind: 'CUSTOMER_VISIT',
      } as never);
      const started = await f.service.start(f.staff, visit.id, {
        clientActionId: 's2-no-pair-visit-start',
        expectedVersion: visit.version,
      });
      // Reuse the fixture's meeting details endpoint for the second visit.
      const details = await f.service.patchMeetingDetails(f.staff, visit.id, {
        clientActionId: 's2-no-pair-visit-meeting',
        expectedVersion: started.version,
        meetingAt: '2026-10-14T10:40:00.000Z',
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: 'REQUESTED_LATER',
        meetingSummary: 'Ziyaret tamamlandı.',
        nextFollowUpAt: null,
      });
      const submitted = await f.service.submitForApproval(f.staff, visit.id, {
        clientActionId: 's2-no-pair-visit-submit',
        expectedVersion: details.jobCardVersion,
        note: 'Ziyaret tamamlandı.',
      });
      const submittedVersion = submitted.version;

      await withApp(f, () => f.manager, async (app) => {
        const cases: Array<[string, Record<string, unknown>]> = [
          ['approve', {}],
          ['request-revision', { revisionReason: 'Düzeltme.' }],
          ['withdraw-from-approval', {}],
        ];
        for (const [command, extra] of cases) {
          const response = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${visit.id}/${command}`,
            payload: {
              clientActionId: `s2-no-pair-${command}`,
              expectedVersion: submittedVersion,
              expectedSaleVersion: 1,
              ...extra,
            },
          });
          expect.soft(response.statusCode, command).toBe(409);
          expect.soft(response.json().code, command).toBe('SALE_PAIR_STATE_CONFLICT');
          expect.soft(response.json().details, command).toMatchObject({ reason: 'NO_COORDINATED_PAIR' });
        }
      });
      expect(await jobRow(f, visit.id)).toMatchObject({ status: 'WAITING_APPROVAL', version: submittedVersion });
    });
  });

  it('serializes two concurrent pair submissions into one commit and one conflict', async () => {
    await withSaleFixture(async (f) => {
      const pair = await readyPair(f);
      await withApp(f, () => f.staff, async (app) => {
        const responses = await Promise.all([
          app.inject({
            method: 'POST',
            url: `/api/job-cards/${f.visitId}/submit-for-approval`,
            payload: {
              clientActionId: 's2-concurrent-pair-submit-a',
              expectedVersion: pair.visitVersion,
              expectedSaleVersion: pair.saleVersion,
              note: 'Eşzamanlı gönderim A.',
            },
          }),
          app.inject({
            method: 'POST',
            url: `/api/job-cards/${f.visitId}/submit-for-approval`,
            payload: {
              clientActionId: 's2-concurrent-pair-submit-b',
              expectedVersion: pair.visitVersion,
              expectedSaleVersion: pair.saleVersion,
              note: 'Eşzamanlı gönderim B.',
            },
          }),
        ]);
        const statuses = responses.map((response) => response.statusCode).sort();
        expect(statuses).toEqual([200, 409]);
        const loser = responses.find((response) => response.statusCode === 409)!;
        expect(['ACTION_IN_PROGRESS', 'VERSION_CONFLICT', 'CLIENT_ACTION_REUSED'])
          .toContain(loser.json().code);
      });

      // One business mutation, one anchor receipt, one submission event per card.
      expect(await jobRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL' });
      expect(await jobRow(f, pair.sale.jobCardId)).toMatchObject({ status: 'WAITING_APPROVAL' });
      expect(await count(f,
        `SELECT count(*)::int AS n FROM processed_actions WHERE operation_key = $1`,
        [`JOB_SUBMIT_FOR_APPROVAL_PAIR:${f.visitId}`])).toBe(1);
      for (const jobCardId of [f.visitId, pair.sale.jobCardId]) {
        expect(await count(f,
          `SELECT count(*)::int AS n FROM job_card_activity_logs
            WHERE job_card_id = $1 AND event_type = 'JOB_SUBMITTED_FOR_APPROVAL'`, [jobCardId])).toBe(1);
      }
      // Winner: exactly two COMPLETED intents. The loser either failed the version fence at
      // reservation (no rows) or reserved first and failed finalization (§4.6: both rows
      // FAILED together); which one happens is a race, so only "no live row, no half-failed
      // pair" is asserted for it.
      const intentCount = (state: string) => count(f,
        `SELECT count(*)::int AS n FROM job_card_lifecycle_intents
          WHERE operation_key LIKE $1 AND state = $2`,
        [`JOB_SUBMIT_FOR_APPROVAL_PAIR:${f.visitId}%`, state]);
      expect(await intentCount('COMPLETED')).toBe(2);
      expect(await intentCount('PENDING')).toBe(0);
      expect([0, 2]).toContain(await intentCount('FAILED'));
    });
  });
});
