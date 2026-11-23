import Fastify from 'fastify';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { gatePoolStatements, waitFor } from './support/lifecycle-intent-harness.js';
import { saleFixture, saleTime, withSaleFixture } from './support/sale-harness.js';

/**
 * SALE-002 slice S2 acceptance — pair locking, both intents and deadlock
 * avoidance.
 * Owning contract: docs/features/visit-to-sale/sale-002-contract.md §4.6
 * (canonical lock order, reservation/finalization symmetry, two intent rows,
 * R19/R20) and §9.3 reservation/locking rows.
 *
 * Evidence style: a statement gate observes a real in-flight pair transaction;
 * a second connection proves both JobCard rows are locked; a bounded poll waits
 * for the gate and always releases it.
 */

type Fixture = Awaited<ReturnType<typeof saleFixture>>;
type App = ReturnType<typeof Fastify>;

const databaseUrl = process.env.TEST_DATABASE_URL;
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

async function insertCustomer(fixture: Fixture, name: string): Promise<string> {
  return (await fixture.pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [fixture.organizationId, name],
  )).rows[0]!.id;
}

async function createInProgressVisit(
  fixture: Fixture,
  customerId: string,
  scheduledAt: string,
  label: string,
): Promise<{ id: string; version: number }> {
  const created = await fixture.service.create(fixture.staff, {
    clientActionId: `s2-lock-visit-create-${label}`,
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
    clientActionId: `s2-lock-visit-start-${label}`,
    expectedVersion: created.version,
  });
  const details = await fixture.service.patchMeetingDetails(fixture.staff, created.id, {
    clientActionId: `s2-lock-visit-meeting-${label}`,
    expectedVersion: started.version,
    meetingAt: new Date(Date.parse(scheduledAt) + 40 * 60 * 1000).toISOString(),
    outcome: 'FOLLOW_UP_REQUIRED',
    unsuccessfulReason: 'REQUESTED_LATER',
    meetingSummary: 'Ziyaret tamamlandı.',
    nextFollowUpAt: null,
  });
  return { id: created.id, version: details.jobCardVersion };
}

async function createPair(
  fixture: Fixture,
  customerId: string,
  scheduledAt: string,
  label: string,
): Promise<{ visitId: string; visitVersion: number; saleId: string; saleVersion: number }> {
  const visit = await createInProgressVisit(fixture, customerId, scheduledAt, label);
  const sale = await fixture.service.createSaleFromVisit(fixture.staff, visit.id, {
    clientActionId: `s2-lock-pair-sale-${label}`,
    expectedSourceVersion: visit.version,
    title: 'Ürün anlaşması',
    soldAt: saleTime.toISOString(),
    saleContactId: null,
    items: [{ productId: fixture.products[0]!, quantity: 1 }, { productId: fixture.products[1]!, quantity: 2 }],
  });
  return { visitId: visit.id, visitVersion: visit.version, saleId: sale.jobCardId, saleVersion: sale.version };
}

function pairSubmitPayload(pair: { visitVersion: number; saleVersion: number }, clientActionId: string) {
  return {
    clientActionId,
    expectedVersion: pair.visitVersion,
    expectedSaleVersion: pair.saleVersion,
    note: 'Eşleşen ziyaret ve satış kaydı onaya hazır.',
  };
}

describe.skipIf(!databaseUrl)('SALE-002 S2 pair locking and intents', () => {
  it('locks both JobCard rows and publishes both PENDING intents during a slow pair submit', async () => {
    await withSaleFixture(async (f) => {
      const customerId = await insertCustomer(f, 'S2 kilit kliniği');
      const pair = await createPair(f, customerId, '2026-10-14T09:00:00.000Z', 'in-flight');

      const gate = gatePoolStatements(f.pool, 'UPDATE job_cards');
      const gatedService = new JobCardService(new PostgresJobCardRepository(gate.pool), () => saleTime);
      const schema = (await f.pool.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]!.schema;
      const observer = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      const running = gatedService.submitForApproval(
        f.staff,
        pair.visitId,
        pairSubmitPayload(pair, 's2-lock-in-flight-submit'),
      );
      void running.catch(() => undefined);
      try {
        await waitFor(() => Promise.resolve(gate.arrivalCount() > 0), 10_000, 'pair finalization UPDATE job_cards');
        expect(gate.arrivalCount()).toBeGreaterThan(0);

        // Both intents are committed by the reservation before finalization.
        const intents = (await observer.query<{
          job_card_id: string;
          state: string;
          operation_key: string;
        }>(
          `SELECT job_card_id, state, operation_key FROM job_card_lifecycle_intents
            WHERE operation_key LIKE $1`, [`JOB_SUBMIT_FOR_APPROVAL_PAIR:${pair.visitId}%`],
        )).rows;
        expect(intents).toHaveLength(2);
        expect(intents.every((row) => row.state === 'PENDING')).toBe(true);
        expect(intents.find((row) => row.job_card_id === pair.visitId)!.operation_key)
          .toBe(`JOB_SUBMIT_FOR_APPROVAL_PAIR:${pair.visitId}`);
        expect(intents.find((row) => row.job_card_id === pair.saleId)!.operation_key)
          .toBe(`JOB_SUBMIT_FOR_APPROVAL_PAIR:${pair.visitId}:participant`);

        // Both rows are already locked before the work-phase statement runs.
        for (const jobCardId of [pair.visitId, pair.saleId]) {
          const failure = await observer.query(
            'SELECT 1 FROM job_cards WHERE id = $1 FOR UPDATE NOWAIT',
            [jobCardId],
          ).then(() => null, (error: unknown) => error);
          expect(failure).toMatchObject({ code: '55P03' });
        }
      } finally {
        gate.release();
        await observer.end();
      }

      const submitted = await running;
      expect(submitted).toMatchObject({ status: 'WAITING_APPROVAL' });
      const anchorKey = `JOB_SUBMIT_FOR_APPROVAL_PAIR:${pair.visitId}`;
      expect(await count(f,
        `SELECT count(*)::int AS n FROM job_card_lifecycle_intents
          WHERE operation_key LIKE $1 AND state = 'COMPLETED'`, [`${anchorKey}%`])).toBe(2);
      expect(await count(f,
        'SELECT count(*)::int AS n FROM processed_actions WHERE operation_key = $1', [anchorKey])).toBe(1);
    });
  });

  it('submits pairs whose visit id is smaller and larger than the sale id', async () => {
    await withSaleFixture(async (f) => {
      const orderings: string[] = [];
      await withApp(f, () => f.staff, async (app) => {
        for (let index = 0; index < 10 && new Set(orderings).size < 2; index += 1) {
          const customerId = await insertCustomer(f, `S2 sıralama kliniği ${index}`);
          const pair = await createPair(f, customerId, '2026-10-14T09:00:00.000Z', `order-${index}`);
          const response = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${pair.visitId}/submit-for-approval`,
            payload: pairSubmitPayload(pair, `s2-order-submit-${index}`),
          });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toMatchObject({ status: 'WAITING_APPROVAL', linkedSaleJobCardId: pair.saleId });
          orderings.push(pair.visitId < pair.saleId ? 'visit-first' : 'sale-first');
        }
      });
      // Both sorted-lock orders are exercised: neither deadlocks nor misbehaves.
      expect(new Set(orderings)).toEqual(new Set(['visit-first', 'sale-first']));
    });
  });

  it('approves a pair and a single visit of the same customer concurrently without deadlock', async () => {
    await withSaleFixture(async (f) => {
      await withApp(f, () => f.manager, async (app) => {
        for (const [index, pairAt] of ['2026-10-14T09:00:00.000Z', '2026-10-14T11:00:00.000Z'].entries()) {
          const pair = await createPair(f, f.customerId, pairAt, `approve-${index}`);
          const pairSubmit = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${pair.visitId}/submit-for-approval`,
            payload: pairSubmitPayload(pair, `s2-approve-order-pair-${index}`),
          });
          expect.soft(pairSubmit.statusCode, `pair submit ${index}`).toBe(200);

          const singleAt = index === 0 ? '2026-10-14T10:00:00.000Z' : '2026-10-14T12:00:00.000Z';
          const single = await createInProgressVisit(f, f.customerId, singleAt, `single-${index}`);
          const singleSubmit = await app.inject({
            method: 'POST',
            url: `/api/job-cards/${single.id}/submit-for-approval`,
            payload: {
              clientActionId: `s2-approve-order-single-submit-${index}`,
              expectedVersion: single.version,
              note: 'Tek ziyaret onaya hazır.',
            },
          });
          expect.soft(singleSubmit.statusCode, `single submit ${index}`).toBe(200);

          const [pairApproved, singleApproved] = await Promise.all([
            app.inject({
              method: 'POST',
              url: `/api/job-cards/${pair.visitId}/approve`,
              payload: {
                clientActionId: `s2-approve-order-pair-approve-${index}`,
                expectedVersion: pair.visitVersion + 1,
                expectedSaleVersion: pair.saleVersion + 1,
                note: 'Eşleşen onay.',
              },
            }),
            app.inject({
              method: 'POST',
              url: `/api/job-cards/${single.id}/approve`,
              payload: {
                clientActionId: `s2-approve-order-single-approve-${index}`,
                expectedVersion: single.version + 1,
                note: 'Tek ziyaret onayı.',
              },
            }),
          ]);
          expect.soft(pairApproved.statusCode, `pair approve ${index}`).toBe(200);
          expect.soft(singleApproved.statusCode, `single approve ${index}`).toBe(200);
          expect.soft(pairApproved.json().code, `pair approve code ${index}`).not.toBe('ACTION_IN_PROGRESS');
          expect.soft(singleApproved.json().code, `single approve code ${index}`).not.toBe('ACTION_IN_PROGRESS');
        }
      });

      // Both loops completed their approvals: no deadlock rollback survived.
      expect(await count(f,
        "SELECT count(*)::int AS n FROM job_cards WHERE status = 'COMPLETED'")).toBeGreaterThanOrEqual(4);
    });
  });
});
