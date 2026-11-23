import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { JobCardService } from '../src/modules/job-cards/service.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { gatePoolStatements, waitFor } from './support/lifecycle-intent-harness.js';
import {
  readyVisit,
  saleFixture,
  saleTime,
  withSaleFixture,
} from './support/sale-harness.js';

type Fixture = Awaited<ReturnType<typeof saleFixture>>;

const FUTURE_VISIT = '2027-01-15T08:00:00.000Z';

function followUpProposal(f: Fixture) {
  return {
    scheduledAt: FUTURE_VISIT,
    type: 'SALES_MEETING' as const,
    assignedTo: f.staff.id,
    followUpInstructions: 'Kontrol ziyareti planlandı.',
  };
}

/** Visit ready + one ACCEPTED linked sale: the pair is submit-ready. */
async function pairReadyForSubmit(
  f: Fixture,
  options: { outcome?: 'POSITIVE' | 'NO_DECISION' } = {},
) {
  const visitVersion = await readyVisit(f, {
    expectedVersion: f.input.expectedSourceVersion,
    ...(options.outcome ? { outcome: options.outcome } : {}),
  });
  const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, {
    ...f.input,
    clientActionId: 'pair-sale-create',
    expectedSourceVersion: visitVersion,
  });
  return { visitVersion, saleId: sale.jobCardId, saleVersion: sale.version };
}

async function cardRow(pool: Pool, id: string) {
  return (await pool.query(
    `SELECT status, version, staff_completed_at, staff_completion_note,
            manager_approved_at, manager_approved_by, manager_approval_note,
            revision_requested_at, assigned_to
       FROM job_cards WHERE id=$1`,
    [id],
  )).rows[0] as Record<string, unknown>;
}

async function activityEvents(pool: Pool, id: string) {
  return (await pool.query<{ event_type: string; metadata: Record<string, unknown> | null }>(
    'SELECT event_type, metadata FROM job_card_activity_logs WHERE job_card_id=$1 ORDER BY created_at, id',
    [id],
  )).rows;
}

async function pairIntents(pool: Pool, clientActionId: string) {
  return (await pool.query(
    `SELECT job_card_id, operation_key, state, reserved_at, request_hash, expected_version, failure_code
       FROM job_card_lifecycle_intents
      WHERE client_action_id=$1
      ORDER BY operation_key`,
    [clientActionId],
  )).rows as Array<Record<string, unknown>>;
}

async function submitPair(
  f: Fixture,
  ids: { visitVersion: number; saleVersion: number },
  overrides: Record<string, unknown> = {},
) {
  return f.service.submitForApproval(f.staff, f.visitId, {
    clientActionId: 'pair-submit',
    expectedVersion: ids.visitVersion,
    note: 'Ziyaret ve bağlı satış onaya gönderildi.',
    expectedSaleVersion: ids.saleVersion,
    ...overrides,
  });
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 §4.3 joint submit', () => {
  it('submits the visit and its linked sale in one transaction with one submission fact each', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      const result = await submitPair(f, ids);
      expect(result).toMatchObject({
        id: f.visitId,
        status: 'WAITING_APPROVAL',
        linkedSaleJobCardId: ids.saleId,
      });
      const visit = await cardRow(f.pool, f.visitId);
      const sale = await cardRow(f.pool, ids.saleId);
      expect(visit).toMatchObject({
        status: 'WAITING_APPROVAL',
        staff_completion_note: 'Ziyaret ve bağlı satış onaya gönderildi.',
      });
      // §4.3 step 5: the sale ACCEPTED -> WAITING_APPROVAL, same instant, same
      // note, without an extra START.
      expect(sale).toMatchObject({
        status: 'WAITING_APPROVAL',
        staff_completion_note: 'Ziyaret ve bağlı satış onaya gönderildi.',
      });
      expect(sale.staff_completed_at).toEqual(visit.staff_completed_at);
      // One lifecycle activity per card, each naming the other.
      const visitSubmit = (await activityEvents(f.pool, f.visitId))
        .filter((row) => row.event_type === 'JOB_SUBMITTED_FOR_APPROVAL');
      const saleSubmit = (await activityEvents(f.pool, ids.saleId))
        .filter((row) => row.event_type === 'JOB_SUBMITTED_FOR_APPROVAL');
      expect(visitSubmit).toHaveLength(1);
      expect(saleSubmit).toHaveLength(1);
      expect(visitSubmit[0]!.metadata).toMatchObject({ pair: true, linkedJobCardId: ids.saleId });
      expect(saleSubmit[0]!.metadata).toMatchObject({ pair: true, linkedJobCardId: f.visitId });
      // R9/Q1: no fabricated STARTED fact on the sale; one SUBMITTED fact each.
      const facts = (await f.pool.query<{ job_card_id: string; fact_type: string; seq_no: number }>(
        `SELECT job_card_id, fact_type, seq_no FROM job_card_accountability_facts
          WHERE job_card_id = ANY($1::uuid[]) ORDER BY job_card_id, fact_type`,
        [[f.visitId, ids.saleId]],
      )).rows;
      expect(facts.filter((row) => row.job_card_id === ids.saleId))
        .toEqual([{ job_card_id: ids.saleId, fact_type: 'SUBMITTED', seq_no: 1 }]);
      expect(facts.some((row) => row.job_card_id === f.visitId && row.fact_type === 'STARTED')).toBe(true);
      expect(facts.some((row) => row.job_card_id === f.visitId && row.fact_type === 'SUBMITTED')).toBe(true);
    });
  });

  it('reserves both cards as two intents with one identity and completes both', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      await submitPair(f, ids);
      const intents = await pairIntents(f.pool, 'pair-submit');
      expect(intents).toHaveLength(2);
      const [anchor, participant] = intents as Array<Record<string, unknown>>;
      // §4.5: the visit is the receipt anchor; the sale owns the participant row.
      expect(anchor).toMatchObject({
        job_card_id: f.visitId,
        operation_key: `JOB_SUBMIT_FOR_APPROVAL_PAIR:${f.visitId}`,
        state: 'COMPLETED',
        expected_version: ids.visitVersion,
      });
      expect(participant).toMatchObject({
        job_card_id: ids.saleId,
        operation_key: `JOB_SUBMIT_FOR_APPROVAL_PAIR:${f.visitId}:participant`,
        state: 'COMPLETED',
        expected_version: ids.saleVersion,
      });
      expect(participant.reserved_at).toEqual(anchor.reserved_at);
      expect(participant.request_hash).toBe(anchor.request_hash);
      // Only the anchor owns the receipt.
      expect((await f.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM processed_actions WHERE operation_key=$1`,
        [`JOB_SUBMIT_FOR_APPROVAL_PAIR:${f.visitId}`],
      )).rows[0]!.n).toBe(1);
      expect((await f.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM processed_actions WHERE operation_key LIKE '%:participant'`,
      )).rows[0]!.n).toBe(0);
    });
  });

  it('persists the JOB-008 follow-up proposal of the visit (POSITIVE outcome)', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f, { outcome: 'POSITIVE' });
      const result = await submitPair(f, ids, { followUpProposal: followUpProposal(f) });
      expect(result.linkedSaleJobCardId).toBe(ids.saleId);
      const visit = (await f.pool.query(
        `SELECT follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
                follow_up_proposal_origin
           FROM job_cards WHERE id=$1`,
        [f.visitId],
      )).rows[0] as Record<string, unknown>;
      expect(visit).toMatchObject({
        follow_up_proposed_type: 'SALES_MEETING',
        follow_up_proposed_assignee: f.staff.id,
        follow_up_proposal_origin: 'STAFF_ADJUSTED',
      });
      expect(visit.follow_up_proposed_at).not.toBeNull();
    });
  });

  it('writes nothing when the linked sale is not ready', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      const items = (await f.pool.query<{ id: string }>(
        'SELECT id FROM job_card_sale_items WHERE job_card_id=$1 ORDER BY sort_order',
        [ids.saleId],
      )).rows;
      await f.service.removeSaleItem(f.staff, ids.saleId, items[0]!.id, {
        clientActionId: 'empty-sale-1', expectedVersion: ids.saleVersion,
      });
      await f.service.removeSaleItem(f.staff, ids.saleId, items[1]!.id, {
        clientActionId: 'empty-sale-2', expectedVersion: ids.saleVersion + 1,
      });
      const before = {
        visit: await cardRow(f.pool, f.visitId),
        sale: await cardRow(f.pool, ids.saleId),
      };
      const emptied = { ...ids, saleVersion: Number(before.sale.version) };
      await expect(submitPair(f, emptied)).rejects.toMatchObject({
        code: 'SALE_NOT_READY', statusCode: 400,
      });
      expect(await cardRow(f.pool, f.visitId)).toEqual(before.visit);
      expect(await cardRow(f.pool, ids.saleId)).toEqual(before.sale);
      expect((await activityEvents(f.pool, f.visitId))
        .filter((row) => row.event_type === 'JOB_SUBMITTED_FOR_APPROVAL')).toHaveLength(0);
      // §4.6: the definitive failure marks BOTH intents FAILED, never one.
      const intents = await pairIntents(f.pool, 'pair-submit');
      expect(intents.map((row) => row.state)).toEqual(['FAILED', 'FAILED']);
      expect(intents.every((row) => row.failure_code === 'SALE_NOT_READY')).toBe(true);
      // 049 §5.4: the corrected attempt needs a new client action key.
      await expect(submitPair(f, emptied)).rejects.toMatchObject({
        code: 'SALE_NOT_READY', statusCode: 409,
      });
    });
  });

  it('reports the exact next single-card action for a NEW or REVISION_REQUESTED sale', async () => {
    await withSaleFixture(async (f) => {
      const visitVersion = await readyVisit(f, { expectedVersion: f.input.expectedSourceVersion });
      // Management creates the sale, so it starts in NEW.
      const sale = await f.service.createSaleFromVisit(f.manager, f.visitId, {
        ...f.input, clientActionId: 'pair-sale-new', expectedSourceVersion: visitVersion,
      });
      await expect(submitPair(f, { visitVersion, saleVersion: sale.version }))
        .rejects.toMatchObject({
          code: 'SALE_PAIR_STATE_CONFLICT',
          statusCode: 409,
          details: {
            visitId: f.visitId, saleId: sale.jobCardId, saleStatus: 'NEW',
            allowedSaleCommand: 'ACCEPT_ASSIGNMENT',
          },
        });
      // Nothing was written by the rejected submit.
      expect(await cardRow(f.pool, f.visitId)).toMatchObject({ status: 'IN_PROGRESS' });
      expect(await pairIntents(f.pool, 'pair-submit')).toHaveLength(0);
      // After the staff member accepts, the same pair submit succeeds.
      const accepted = await f.service.acceptAssignment(f.staff, sale.jobCardId, {
        clientActionId: 'pair-sale-accept', expectedVersion: sale.version,
      });
      expect(accepted).toBeDefined();
      const sent = await submitPair(f, { visitVersion, saleVersion: sale.version + 1 });
      expect(sent.linkedSaleJobCardId).toBe(sale.jobCardId);
    });
  });

  it('rejects a stale expectedSaleVersion without writing anything', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      const before = {
        visit: await cardRow(f.pool, f.visitId),
        sale: await cardRow(f.pool, ids.saleId),
      };
      await expect(submitPair(f, { ...ids, saleVersion: 9 })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', statusCode: 409,
      });
      expect(await cardRow(f.pool, f.visitId)).toEqual(before.visit);
      expect(await cardRow(f.pool, ids.saleId)).toEqual(before.sale);
    });
  });

  it('requires expectedSaleVersion on a coordinated pair and rejects it without one', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      await expect(submitPair(f, ids, { expectedSaleVersion: undefined }))
        .rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
          statusCode: 400,
          details: { fieldErrors: { expectedSaleVersion: expect.any(String) } },
        });
      // A standalone sale has no coordinated pair: the field is a conflict.
      const standalone = await f.service.createStandaloneSale(f.staff, {
        clientActionId: 'guards-standalone',
        title: 'Telefon siparişi',
        description: null,
        customerId: f.customerId,
        assignedTo: f.staff.id,
        soldAt: saleTime.toISOString(),
        saleContactId: f.metContactId,
        items: [{ productId: f.products[0]!, quantity: 1 }],
      });
      await expect(f.service.submitForApproval(f.staff, standalone.jobCardId, {
        clientActionId: 'guards-standalone-submit',
        expectedVersion: standalone.version,
        note: 'Bağımsız satış',
        expectedSaleVersion: standalone.version,
      })).rejects.toMatchObject({
        code: 'SALE_PAIR_STATE_CONFLICT',
        statusCode: 409,
        details: { reason: 'NO_COORDINATED_PAIR' },
      });
      expect(await cardRow(f.pool, standalone.jobCardId)).toMatchObject({ status: 'ACCEPTED' });
    });
  });

  it('replays the pair submit byte-identically without a second write', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      const first = await submitPair(f, ids);
      const activityBefore = (await f.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM job_card_activity_logs',
      )).rows[0]!.n;
      const replay = await submitPair(f, ids);
      expect(replay).toEqual(first);
      expect((await f.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM job_card_activity_logs',
      )).rows[0]!.n).toBe(activityBefore);
      // The same key with a different sale version is a different request.
      await expect(submitPair(f, ids, { expectedSaleVersion: ids.saleVersion + 1 }))
        .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
    });
  });

  it('reports the in-flight pair command on both cards while it runs', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      const gate = gatePoolStatements(f.pool, 'INSERT INTO job_card_activity_logs');
      const service = new JobCardService(new PostgresJobCardRepository(gate.pool), () => saleTime);
      const pending = service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 'pair-submit',
        expectedVersion: ids.visitVersion,
        note: 'Ziyaret ve bağlı satış onaya gönderildi.',
        expectedSaleVersion: ids.saleVersion,
      });
      const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
      try {
        await gate.arrived;
        const live = (await f.pool.query<{ job_card_id: string; state: string }>(
          `SELECT job_card_id, state FROM job_card_lifecycle_intents
            WHERE client_action_id='pair-submit' ORDER BY job_card_id`,
        )).rows;
        expect(live.map((row) => row.job_card_id).sort())
          .toEqual([f.visitId, ids.saleId].sort());
        expect(live.every((row) => row.state === 'PENDING')).toBe(true);
      } finally {
        gate.release();
      }
      expect(await outcome).toHaveProperty('value');
    });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 §4.3 joint approve', () => {
  it('completes both cards atomically with one approval instant, actor and note', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      await submitPair(f, ids);
      const visitWaiting = await cardRow(f.pool, f.visitId);
      const saleWaiting = await cardRow(f.pool, ids.saleId);
      const approved = await f.service.approve(f.manager, f.visitId, {
        clientActionId: 'pair-approve',
        expectedVersion: Number(visitWaiting.version),
        note: 'Onaylandı, teslim planlanacak.',
        expectedSaleVersion: Number(saleWaiting.version),
      });
      expect(approved).toMatchObject({
        id: f.visitId, status: 'COMPLETED', linkedSaleJobCardId: ids.saleId,
      });
      expect(approved).not.toHaveProperty('followUpJobCardId');
      const visit = await cardRow(f.pool, f.visitId);
      const sale = await cardRow(f.pool, ids.saleId);
      expect(visit.status).toBe('COMPLETED');
      expect(sale.status).toBe('COMPLETED');
      expect(sale.manager_approved_at).toEqual(visit.manager_approved_at);
      expect(visit.manager_approved_by).toBe(f.manager.id);
      expect(sale.manager_approved_by).toBe(f.manager.id);
      expect(visit.manager_approval_note).toBe('Onaylandı, teslim planlanacak.');
      expect(sale.manager_approval_note).toBe('Onaylandı, teslim planlanacak.');
      const visitApproved = (await activityEvents(f.pool, f.visitId))
        .filter((row) => row.event_type === 'JOB_APPROVED');
      const saleApproved = (await activityEvents(f.pool, ids.saleId))
        .filter((row) => row.event_type === 'JOB_APPROVED');
      expect(visitApproved).toHaveLength(1);
      expect(saleApproved).toHaveLength(1);
      expect(saleApproved[0]!.metadata).toMatchObject({ pair: true, linkedJobCardId: f.visitId });
      // S2 ships no delivery payload: no delivery row, no fact.
      expect((await f.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_cards WHERE type='PRODUCT_DELIVERY'`,
      )).rows[0]!.n).toBe(0);
      expect((await f.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_card_activity_logs WHERE event_type='SALE_DELIVERY_CREATED'`,
      )).rows[0]!.n).toBe(0);
      // Both intents completed together.
      const intents = await pairIntents(f.pool, 'pair-approve');
      expect(intents.map((row) => row.state)).toEqual(['COMPLETED', 'COMPLETED']);
      // The replay returns the identical presented detail.
      const replay = await f.service.approve(f.manager, f.visitId, {
        clientActionId: 'pair-approve',
        expectedVersion: Number(visitWaiting.version),
        note: 'Onaylandı, teslim planlanacak.',
        expectedSaleVersion: Number(saleWaiting.version),
      });
      expect(replay).toEqual(approved);
    });
  });

  it('still creates the JOB-008 mandatory follow-up child on a joint approve', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f, { outcome: 'POSITIVE' });
      await submitPair(f, ids, { followUpProposal: followUpProposal(f) });
      const visitWaiting = await cardRow(f.pool, f.visitId);
      const saleWaiting = await cardRow(f.pool, ids.saleId);
      const approved = await f.service.approve(f.manager, f.visitId, {
        clientActionId: 'pair-approve-follow-up',
        expectedVersion: Number(visitWaiting.version),
        expectedSaleVersion: Number(saleWaiting.version),
        followUp: followUpProposal(f),
      });
      const childId = (approved as { followUpJobCardId?: string }).followUpJobCardId;
      expect(childId).toBeTruthy();
      const child = (await f.pool.query(
        `SELECT type, status, source_job_card_id, customer_id, assigned_to, engagement_kind
           FROM job_cards WHERE id=$1`,
        [childId],
      )).rows[0];
      expect(child).toMatchObject({
        // The proposal was made by the assignee, so the approval-created child
        // carries the existing self-acceptance (JOB-008, unchanged by S2).
        type: 'SALES_MEETING', status: 'ACCEPTED', source_job_card_id: f.visitId,
        customer_id: f.customerId, assigned_to: f.staff.id, engagement_kind: 'FOLLOW_UP',
      });
      expect(await cardRow(f.pool, ids.saleId)).toMatchObject({ status: 'COMPLETED' });
    });
  });

  it('leaves a legacy sale untouched when it is not WAITING_APPROVAL', async () => {
    await withSaleFixture(async (f) => {
      // Legacy shape: the visit was submitted alone, the sale stayed ACCEPTED.
      const ids = await pairReadyForSubmit(f);
      const visitVersion = ids.visitVersion;
      // Submit the visit through the pair, then withdraw the sale alone is not
      // possible; instead emulate pre-S2 data with a single-card visit submit.
      await f.pool.query(
        `UPDATE job_cards SET sale_source_visit_id=NULL WHERE id=$1`,
        [ids.saleId],
      );
      // Detach so the visit submits alone, then re-attach the sale as legacy.
      await f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 'legacy-visit-submit', expectedVersion: visitVersion,
        note: 'Ziyaret onaya gönderildi.',
      });
      await f.pool.query(
        `UPDATE job_cards SET sale_source_visit_id=$2 WHERE id=$1`,
        [ids.saleId, f.visitId],
      );
      const visitWaiting = await cardRow(f.pool, f.visitId);
      const saleBefore = await cardRow(f.pool, ids.saleId);
      expect(saleBefore.status).toBe('ACCEPTED');
      // §4.3/§4.4: the coupled pair still owns the approval surface, but a
      // legacy sale that is not WAITING_APPROVAL is left untouched.
      const approved = await f.service.approve(f.manager, f.visitId, {
        clientActionId: 'legacy-visit-approve',
        expectedVersion: Number(visitWaiting.version),
        expectedSaleVersion: Number(saleBefore.version),
      });
      expect(approved).not.toHaveProperty('linkedSaleJobCardId');
      expect(await cardRow(f.pool, f.visitId)).toMatchObject({ status: 'COMPLETED' });
      expect(await cardRow(f.pool, ids.saleId)).toEqual(saleBefore);
      // §4.4: the sale is now independent and runs its own lifecycle.
      const sale = await cardRow(f.pool, ids.saleId);
      const submitted = await f.service.submitForApproval(f.staff, ids.saleId, {
        clientActionId: 'legacy-sale-submit',
        expectedVersion: Number(sale.version),
        note: 'Satış kaydı onaya gönderildi.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      const saleApproved = await f.service.approve(f.manager, ids.saleId, {
        clientActionId: 'legacy-sale-approve', expectedVersion: submitted.version,
      });
      expect(saleApproved.status).toBe('COMPLETED');
    });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 §4.3 joint revision / withdraw / resume', () => {
  it('moves both cards on revision, withdraw and resume and keeps prior facts', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      await submitPair(f, ids);
      const waitingVisit = await cardRow(f.pool, f.visitId);
      const waitingSale = await cardRow(f.pool, ids.saleId);

      await f.service.requestRevision(f.manager, f.visitId, {
        clientActionId: 'pair-revision',
        expectedVersion: Number(waitingVisit.version),
        revisionReason: 'Ürün miktarını kontrol edin.',
        expectedSaleVersion: Number(waitingSale.version),
      });
      const revisedVisit = await cardRow(f.pool, f.visitId);
      const revisedSale = await cardRow(f.pool, ids.saleId);
      expect(revisedVisit.status).toBe('REVISION_REQUESTED');
      expect(revisedSale.status).toBe('REVISION_REQUESTED');
      expect(revisedSale.revision_requested_at).toEqual(revisedVisit.revision_requested_at);
      // The prior submission facts stay append-only history.
      expect(revisedVisit.staff_completed_at).toEqual(waitingVisit.staff_completed_at);
      expect(revisedSale.staff_completed_at).toEqual(waitingSale.staff_completed_at);
      const visitRevision = (await activityEvents(f.pool, f.visitId))
        .filter((row) => row.event_type === 'JOB_REVISION_REQUESTED');
      const saleRevision = (await activityEvents(f.pool, ids.saleId))
        .filter((row) => row.event_type === 'JOB_REVISION_REQUESTED');
      expect(visitRevision).toHaveLength(1);
      expect(saleRevision).toHaveLength(1);
      // OVR-5b: the correction deadline stays visit-only.
      expect(visitRevision[0]!.metadata).toHaveProperty('correctionDueAt');
      expect(saleRevision[0]!.metadata).toMatchObject({ correctionDueAt: null });

      await f.service.resume(f.staff, f.visitId, {
        clientActionId: 'pair-resume',
        expectedVersion: Number(revisedVisit.version),
        expectedSaleVersion: Number(revisedSale.version),
      });
      const resumedVisit = await cardRow(f.pool, f.visitId);
      const resumedSale = await cardRow(f.pool, ids.saleId);
      expect(resumedVisit.status).toBe('IN_PROGRESS');
      expect(resumedSale.status).toBe('IN_PROGRESS');

      // Resubmit as a pair, then withdraw both together.
      const resubmitted = await f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 'pair-resubmit',
        expectedVersion: Number(resumedVisit.version),
        note: 'Düzeltildi.',
        expectedSaleVersion: Number(resumedSale.version),
      });
      expect(resubmitted.linkedSaleJobCardId).toBe(ids.saleId);
      const waitingAgainVisit = await cardRow(f.pool, f.visitId);
      const waitingAgainSale = await cardRow(f.pool, ids.saleId);
      await f.service.withdrawFromApproval(f.staff, f.visitId, {
        clientActionId: 'pair-withdraw',
        expectedVersion: Number(waitingAgainVisit.version),
        expectedSaleVersion: Number(waitingAgainSale.version),
      });
      const withdrawnVisit = await cardRow(f.pool, f.visitId);
      const withdrawnSale = await cardRow(f.pool, ids.saleId);
      expect(withdrawnVisit.status).toBe('IN_PROGRESS');
      expect(withdrawnSale.status).toBe('IN_PROGRESS');
      // Historic submission facts survive the withdraw.
      expect(withdrawnVisit.staff_completed_at).not.toBeNull();
      expect(withdrawnSale.staff_completed_at).not.toBeNull();
      expect((await activityEvents(f.pool, ids.saleId))
        .filter((row) => row.event_type === 'JOB_APPROVAL_WITHDRAWN')).toHaveLength(1);
    });
  });

  it('replays every pair command byte-identically and rejects a changed body', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      await submitPair(f, ids);
      const waitingVisit = await cardRow(f.pool, f.visitId);
      const waitingSale = await cardRow(f.pool, ids.saleId);
      const revisionInput = {
        clientActionId: 'pair-revision',
        expectedVersion: Number(waitingVisit.version),
        revisionReason: 'Miktar düzeltilmeli.',
        expectedSaleVersion: Number(waitingSale.version),
      };
      const revised = await f.service.requestRevision(f.manager, f.visitId, revisionInput);
      expect(await f.service.requestRevision(f.manager, f.visitId, revisionInput)).toEqual(revised);
      await expect(f.service.requestRevision(f.manager, f.visitId, {
        ...revisionInput, revisionReason: 'Başka bir neden.',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      const revisedVisit = await cardRow(f.pool, f.visitId);
      const revisedSale = await cardRow(f.pool, ids.saleId);
      const resumeInput = {
        clientActionId: 'pair-resume',
        expectedVersion: Number(revisedVisit.version),
        expectedSaleVersion: Number(revisedSale.version),
      };
      const resumed = await f.service.resume(f.staff, f.visitId, resumeInput);
      expect(await f.service.resume(f.staff, f.visitId, resumeInput)).toEqual(resumed);

      const resumedVisit = await cardRow(f.pool, f.visitId);
      const resumedSale = await cardRow(f.pool, ids.saleId);
      const resubmitted = await f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 'pair-resubmit-replay',
        expectedVersion: Number(resumedVisit.version),
        note: 'Düzeltildi.',
        expectedSaleVersion: Number(resumedSale.version),
      });
      const waitingAgain = await cardRow(f.pool, f.visitId);
      const waitingAgainSale = await cardRow(f.pool, ids.saleId);
      const withdrawInput = {
        clientActionId: 'pair-withdraw',
        expectedVersion: Number(waitingAgain.version),
        expectedSaleVersion: Number(waitingAgainSale.version),
      };
      const withdrawn = await f.service.withdrawFromApproval(f.staff, f.visitId, withdrawInput);
      expect(await f.service.withdrawFromApproval(f.staff, f.visitId, withdrawInput))
        .toEqual(withdrawn);
      expect(resubmitted.linkedSaleJobCardId).toBe(ids.saleId);
    });
  });

  it('closes each completed card\'s open JOB-010 change request on a joint approve', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      await f.service.createChangeRequest(f.staff, f.visitId, {
        clientActionId: 'pair-visit-change',
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Müşteri görüşmeyi erteledi.',
      });
      await f.service.createChangeRequest(f.staff, ids.saleId, {
        clientActionId: 'pair-sale-change',
        reasonCode: 'CUSTOMER_CHANGED_MIND',
        reasonText: 'Müşteri ürün listesini değiştirdi.',
      });
      await submitPair(f, ids);
      const visitWaiting = await cardRow(f.pool, f.visitId);
      const saleWaiting = await cardRow(f.pool, ids.saleId);
      await f.service.approve(f.manager, f.visitId, {
        clientActionId: 'pair-approve-change',
        expectedVersion: Number(visitWaiting.version),
        expectedSaleVersion: Number(saleWaiting.version),
      });
      for (const id of [f.visitId, ids.saleId]) {
        const resolved = (await activityEvents(f.pool, id))
          .filter((row) => row.event_type === 'JOB_CHANGE_REQUEST_RESOLVED');
        expect(resolved).toHaveLength(1);
        expect(resolved[0]!.metadata).toMatchObject({ resolution: 'SUPERSEDED' });
      }
      expect((await f.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_card_change_requests WHERE resolution IS NULL`,
      )).rows[0]!.n).toBe(0);
    });
  });

  it('moves only the card that is in the matching state (legacy data)', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      await submitPair(f, ids);
      // Legacy shape: the visit is WAITING_APPROVAL, the sale was pushed out of
      // WAITING_APPROVAL before S2 existed.
      const waitingVisit = await cardRow(f.pool, f.visitId);
      await f.pool.query(`UPDATE job_cards SET status='IN_PROGRESS' WHERE id=$1`, [ids.saleId]);
      const sale = await cardRow(f.pool, ids.saleId);
      await f.service.requestRevision(f.manager, f.visitId, {
        clientActionId: 'legacy-revision',
        expectedVersion: Number(waitingVisit.version),
        revisionReason: 'Ziyaret sonucu düzeltilmeli.',
        expectedSaleVersion: Number(sale.version),
      });
      expect(await cardRow(f.pool, f.visitId)).toMatchObject({ status: 'REVISION_REQUESTED' });
      expect(await cardRow(f.pool, ids.saleId)).toMatchObject({ status: 'IN_PROGRESS' });
      expect((await activityEvents(f.pool, ids.saleId))
        .filter((row) => row.event_type === 'JOB_REVISION_REQUESTED')).toHaveLength(0);
      // Resume moves the visit only; the sale already is IN_PROGRESS.
      const revisedVisit = await cardRow(f.pool, f.visitId);
      await f.service.resume(f.staff, f.visitId, {
        clientActionId: 'legacy-resume',
        expectedVersion: Number(revisedVisit.version),
        expectedSaleVersion: Number(sale.version),
      });
      expect(await cardRow(f.pool, f.visitId)).toMatchObject({ status: 'IN_PROGRESS' });
      expect(await cardRow(f.pool, ids.saleId)).toMatchObject({ status: 'IN_PROGRESS' });
    });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 §4.6 lock order', () => {
  it('takes the approve customer lock before any JobCard row lock (R20)', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      await submitPair(f, ids);
      const visitWaiting = await cardRow(f.pool, f.visitId);
      const saleWaiting = await cardRow(f.pool, ids.saleId);
      const holder = await f.pool.connect();
      const probe = await f.pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [f.customerId]);
        pending = f.service.approve(f.manager, f.visitId, {
          clientActionId: 'pair-approve-lock',
          expectedVersion: Number(visitWaiting.version),
          expectedSaleVersion: Number(saleWaiting.version),
        });
        const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
        const holderPid = (await holder.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;
        await waitFor(async () => (await f.pool.query<{ blocked: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',
          [holderPid],
        )).rows[0]!.blocked, 5_000, 'pair approve waiting on the customer lock');
        // While the approve waits for the customer, neither JobCard row is
        // held: a NOWAIT lock of the visit succeeds. A `job_cards -> customers`
        // order would have locked the visit first and this would fail.
        await probe.query('BEGIN');
        const visitLock = await probe.query(
          'SELECT id FROM job_cards WHERE id=$1 FOR UPDATE NOWAIT', [f.visitId],
        );
        expect(visitLock.rowCount).toBe(1);
        const saleLock = await probe.query(
          'SELECT id FROM job_cards WHERE id=$1 FOR UPDATE NOWAIT', [ids.saleId],
        );
        expect(saleLock.rowCount).toBe(1);
        await probe.query('ROLLBACK');
        await holder.query('COMMIT');
        expect(await outcome).toHaveProperty('value');
      } finally {
        await probe.query('ROLLBACK').catch(() => undefined);
        probe.release();
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
        await pending?.catch(() => undefined);
      }
    });
  });

  it('runs a concurrent note write against a pair approve without a deadlock', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      await submitPair(f, ids);
      const visitWaiting = await cardRow(f.pool, f.visitId);
      const saleWaiting = await cardRow(f.pool, ids.saleId);
      const gate = gatePoolStatements(f.pool, 'INSERT INTO job_card_activity_logs');
      const service = new JobCardService(new PostgresJobCardRepository(gate.pool), () => saleTime);
      const approving = service.approve(f.manager, f.visitId, {
        clientActionId: 'pair-approve-concurrent',
        expectedVersion: Number(visitWaiting.version),
        expectedSaleVersion: Number(saleWaiting.version),
      });
      const approval = approving.then((value) => ({ value }), (error: unknown) => ({ error }));
      try {
        await gate.arrived;
        // The pair approve holds both JobCard locks; a legal note write on the
        // sale waits for it and then succeeds. No 40P01 is possible because
        // both paths take only `job_cards` in one step and no shared reference
        // row afterwards.
        const note = f.service.addNote(f.manager, ids.saleId, {
          clientActionId: 'pair-approve-note',
          note: 'Onay sırasında not.',
        });
        gate.release();
        expect(await approval).toHaveProperty('value');
        await expect(note).resolves.toBeDefined();
      } finally {
        gate.release();
      }
      expect(await cardRow(f.pool, ids.saleId)).toMatchObject({ status: 'COMPLETED' });
    });
  });
});
