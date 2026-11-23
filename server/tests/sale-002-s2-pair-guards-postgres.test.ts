import { describe, expect, it } from 'vitest';

import {
  readyVisit,
  saleTime,
  withSaleFixture,
  type saleFixture,
} from './support/sale-harness.js';

type Fixture = Awaited<ReturnType<typeof saleFixture>>;

async function cardRow(f: Fixture, id: string) {
  return (await f.pool.query(
    'SELECT status, version, assigned_to FROM job_cards WHERE id=$1', [id],
  )).rows[0] as { status: string; version: number; assigned_to: string };
}

async function activityEvents(f: Fixture, id: string) {
  return (await f.pool.query<{ event_type: string; metadata: Record<string, unknown> | null }>(
    'SELECT event_type, metadata FROM job_card_activity_logs WHERE job_card_id=$1 ORDER BY created_at, id',
    [id],
  )).rows;
}

async function pairReadyForSubmit(f: Fixture) {
  const visitVersion = await readyVisit(f, { expectedVersion: f.input.expectedSourceVersion });
  const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, {
    ...f.input, clientActionId: 'guards-sale-create', expectedSourceVersion: visitVersion,
  });
  return { visitVersion, saleId: sale.jobCardId, saleVersion: sale.version };
}

async function submitPair(f: Fixture, ids: { visitVersion: number; saleVersion: number }) {
  return f.service.submitForApproval(f.staff, f.visitId, {
    clientActionId: 'guards-pair-submit',
    expectedVersion: ids.visitVersion,
    note: 'Ziyaret ve bağlı satış onaya gönderildi.',
    expectedSaleVersion: ids.saleVersion,
  });
}

/** Visit + sale both WAITING_APPROVAL, coupled. */
async function waitingPair(f: Fixture) {
  const ids = await pairReadyForSubmit(f);
  await submitPair(f, ids);
  const visit = await cardRow(f, f.visitId);
  const sale = await cardRow(f, ids.saleId);
  return { ids, visit, sale };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 §4.2 redirect guards', () => {
  it('redirects a single-card sale submit while the source visit is IN_PROGRESS', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      const before = await cardRow(f, ids.saleId);
      await expect(f.service.submitForApproval(f.staff, ids.saleId, {
        clientActionId: 'redirect-sale-submit',
        expectedVersion: ids.saleVersion,
        note: 'Satışı tek başına gönder.',
        expectedSaleVersion: ids.saleVersion,
      })).rejects.toMatchObject({
        code: 'SALE_SUBMIT_VIA_VISIT_REQUIRED',
        statusCode: 409,
        details: {
          visitId: f.visitId,
          saleId: ids.saleId,
          saleStatus: 'ACCEPTED',
          allowedSaleCommand: 'SUBMIT_FOR_APPROVAL',
        },
      });
      expect(await cardRow(f, ids.saleId)).toEqual(before);
    });
  });

  it.each([
    ['approve', 'SALE_APPROVE_VIA_VISIT_REQUIRED', 'APPROVE'],
    ['requestRevision', 'SALE_REVISION_VIA_VISIT_REQUIRED', 'REQUEST_REVISION'],
    ['withdraw', 'SALE_WITHDRAW_VIA_VISIT_REQUIRED', 'WITHDRAW_FROM_APPROVAL'],
  ] as const)('redirects sale %s while the source visit is WAITING_APPROVAL', async (fn, code, allowed) => {
    await withSaleFixture(async (f) => {
      const { ids, sale } = await waitingPair(f);
      const call = fn === 'approve'
        ? f.service.approve(f.manager, ids.saleId, {
          clientActionId: `redirect-${fn}`, expectedVersion: sale.version,
          expectedSaleVersion: sale.version,
        })
        : fn === 'requestRevision'
          ? f.service.requestRevision(f.manager, ids.saleId, {
            clientActionId: `redirect-${fn}`, expectedVersion: sale.version,
            revisionReason: 'Kontrol.', expectedSaleVersion: sale.version,
          })
          : f.service.withdrawFromApproval(f.staff, ids.saleId, {
            clientActionId: `redirect-${fn}`, expectedVersion: sale.version,
            expectedSaleVersion: sale.version,
          });
      await expect(call).rejects.toMatchObject({
        code,
        statusCode: 409,
        details: {
          visitId: f.visitId,
          saleId: ids.saleId,
          saleStatus: 'WAITING_APPROVAL',
          allowedSaleCommand: allowed,
        },
      });
      expect(await cardRow(f, ids.saleId)).toMatchObject({ status: 'WAITING_APPROVAL' });
    });
  });

  it('redirects sale resume while the source visit is REVISION_REQUESTED', async () => {
    await withSaleFixture(async (f) => {
      const { ids, visit, sale } = await waitingPair(f);
      await f.service.requestRevision(f.manager, f.visitId, {
        clientActionId: 'guards-pair-revision',
        expectedVersion: visit.version,
        revisionReason: 'Miktar düzeltilmeli.',
        expectedSaleVersion: sale.version,
      });
      const revised = await cardRow(f, ids.saleId);
      expect(revised.status).toBe('REVISION_REQUESTED');
      await expect(f.service.resume(f.staff, ids.saleId, {
        clientActionId: 'redirect-sale-resume',
        expectedVersion: revised.version,
        expectedSaleVersion: revised.version,
      })).rejects.toMatchObject({
        code: 'SALE_RESUME_VIA_VISIT_REQUIRED',
        statusCode: 409,
        details: { visitId: f.visitId, allowedSaleCommand: 'RESUME' },
      });
    });
  });

  it('never redirects a standalone sale or a sale from a terminal visit', async () => {
    await withSaleFixture(async (f) => {
      const standalone = await f.service.createStandaloneSale(f.staff, {
        clientActionId: 'guards-standalone',
        title: 'Telefon siparişi',
        description: null,
        customerId: f.customerId,
        assignedTo: f.staff.id,
        soldAt: saleTime.toISOString(),
        saleContactId: null,
        items: [{ productId: f.products[0]!, quantity: 2 }],
      });
      // R9 / accepted Q1: submit straight from ACCEPTED, no START.
      const submitted = await f.service.submitForApproval(f.staff, standalone.jobCardId, {
        clientActionId: 'guards-standalone-submit',
        expectedVersion: standalone.version,
        note: 'Telefon siparişi kaydı.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      expect((await f.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_card_accountability_facts
          WHERE job_card_id=$1 AND fact_type='STARTED'`, [standalone.jobCardId],
      )).rows[0]!.n).toBe(0);
      const approved = await f.service.approve(f.manager, standalone.jobCardId, {
        clientActionId: 'guards-standalone-approve', expectedVersion: submitted.version,
      });
      expect(approved.status).toBe('COMPLETED');
      // The visit was never touched by an independent sale.
      expect(await cardRow(f, f.visitId)).toMatchObject({ status: 'IN_PROGRESS' });
    });
  });

  it('keeps a sale created from a COMPLETED visit fully independent', async () => {
    await withSaleFixture(async (f) => {
      const visitVersion = await readyVisit(f, { expectedVersion: f.input.expectedSourceVersion });
      await f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 'guards-complete-visit-submit',
        expectedVersion: visitVersion,
        note: 'Ziyaret tamamlandı.',
      });
      const visitWaiting = await cardRow(f, f.visitId);
      await f.service.approve(f.manager, f.visitId, {
        clientActionId: 'guards-complete-visit-approve',
        expectedVersion: visitWaiting.version,
      });
      const completedVisit = await cardRow(f, f.visitId);
      expect(completedVisit.status).toBe('COMPLETED');
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, {
        ...f.input, clientActionId: 'guards-retro-sale', expectedSourceVersion: completedVisit.version,
      });
      const submitted = await f.service.submitForApproval(f.staff, sale.jobCardId, {
        clientActionId: 'guards-retro-submit',
        expectedVersion: sale.version,
        note: 'Satış sonradan kaydedildi.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      const approved = await f.service.approve(f.manager, sale.jobCardId, {
        clientActionId: 'guards-retro-approve', expectedVersion: submitted.version,
      });
      expect(approved.status).toBe('COMPLETED');
      expect(approved).not.toHaveProperty('linkedSaleJobCardId');
      // The terminal source was never re-opened or re-versioned by the sale.
      expect(await cardRow(f, f.visitId)).toEqual(completedVisit);
    });
  });

  it('submits the visit alone when the linked sale is cancelled', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      await f.service.cancel(f.manager, ids.saleId, {
        clientActionId: 'guards-sale-cancel',
        expectedVersion: ids.saleVersion,
        cancelReason: 'Anlaşma iptal edildi.',
      });
      // §4.8: a cancelled sale is not active, so no pair exists.
      const submitted = await f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 'guards-visit-alone',
        expectedVersion: ids.visitVersion,
        note: 'Ziyaret tek başına onaya gönderildi.',
      });
      expect(submitted).not.toHaveProperty('linkedSaleJobCardId');
      expect(await cardRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL' });
      expect(await cardRow(f, ids.saleId)).toMatchObject({ status: 'CANCELLED' });
    });
  });

  it('does not re-submit a legacy sale that is already WAITING_APPROVAL', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      // Pre-S2 shape: the sale was submitted alone before the pair existed.
      const completedAt = new Date('2026-11-01T08:00:00.000Z');
      await f.pool.query(
        `UPDATE job_cards SET status='WAITING_APPROVAL', staff_completed_at=$2,
           staff_completed_by=$3, started_at=COALESCE(started_at,$2)
         WHERE id=$1`,
        [ids.saleId, completedAt, f.staff.id],
      );
      const saleBefore = await cardRow(f, ids.saleId);
      const saleActivitiesBefore = (await activityEvents(f, ids.saleId)).length;
      const submitted = await f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 'guards-legacy-sale-submit',
        expectedVersion: ids.visitVersion,
        note: 'Ziyaret ve mevcut satış onaya gönderildi.',
        expectedSaleVersion: Number(saleBefore.version),
      });
      // §4.3 step 5/6: the legacy sale keeps its own submission facts and gets
      // no second submission event.
      expect(submitted).not.toHaveProperty('linkedSaleJobCardId');
      expect(await cardRow(f, ids.saleId)).toEqual(saleBefore);
      expect((await activityEvents(f, ids.saleId)).length).toBe(saleActivitiesBefore);
      expect(await cardRow(f, f.visitId)).toMatchObject({ status: 'WAITING_APPROVAL' });
      // The pair approval then completes both.
      const visitWaiting = await cardRow(f, f.visitId);
      const approved = await f.service.approve(f.manager, f.visitId, {
        clientActionId: 'guards-legacy-pair-approve',
        expectedVersion: Number(visitWaiting.version),
        expectedSaleVersion: Number(saleBefore.version),
      });
      expect(approved).toMatchObject({ linkedSaleJobCardId: ids.saleId });
      expect(await cardRow(f, ids.saleId)).toMatchObject({ status: 'COMPLETED' });
    });
  });

  it('rejects expectedSaleVersion on a sale card and when no pair is coordinated', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      await expect(f.service.submitForApproval(f.staff, ids.saleId, {
        clientActionId: 'guards-sale-version',
        expectedVersion: ids.saleVersion,
        note: 'Satış.',
        expectedSaleVersion: ids.saleVersion,
      })).rejects.toMatchObject({ code: 'SALE_SUBMIT_VIA_VISIT_REQUIRED' });
      // A visit with no linked sale cannot be a pair anchor.
      await expect(f.service.approve(f.manager, f.visitId, {
        clientActionId: 'guards-no-pair-approve',
        expectedVersion: (await cardRow(f, f.visitId)).version,
        expectedSaleVersion: 1,
      })).rejects.toMatchObject({
        code: 'SALE_PAIR_STATE_CONFLICT',
        details: { reason: 'NO_COORDINATED_PAIR' },
      });
    });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 §4.2 one owner per live pair (R17)', () => {
  it('rejects reassigning either side of a live pair', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      const sale = await cardRow(f, ids.saleId);
      await expect(f.service.patch(f.manager, ids.saleId, {
        expectedVersion: sale.version,
        assignedTo: f.otherStaff.id,
      })).rejects.toMatchObject({
        code: 'SALE_PAIR_ASSIGNEE_CONFLICT',
        statusCode: 409,
        details: { visitAssignee: f.staff.id, requestedAssignee: f.otherStaff.id },
      });
      const visit = await cardRow(f, f.visitId);
      await expect(f.service.patch(f.manager, f.visitId, {
        expectedVersion: visit.version,
        assignedTo: f.otherStaff.id,
      })).rejects.toMatchObject({
        code: 'SALE_PAIR_ASSIGNEE_CONFLICT',
        statusCode: 409,
        details: { visitAssignee: f.staff.id, requestedAssignee: f.otherStaff.id },
      });
      // The supported alternative: the delivery assignee at approval (S3), and
      // re-aligning by reassigning both is never needed.
      expect(await cardRow(f, ids.saleId)).toMatchObject({ assigned_to: f.staff.id });
      expect(await cardRow(f, f.visitId)).toMatchObject({ assigned_to: f.staff.id });
    });
  });

  it('allows reassignment once the source is terminal', async () => {
    await withSaleFixture(async (f) => {
      const visitVersion = await readyVisit(f, { expectedVersion: f.input.expectedSourceVersion });
      await f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 'r17-visit-submit', expectedVersion: visitVersion, note: 'Ziyaret tamamlandı.',
      });
      const waiting = await cardRow(f, f.visitId);
      await f.service.approve(f.manager, f.visitId, {
        clientActionId: 'r17-visit-approve', expectedVersion: waiting.version,
      });
      const completed = await cardRow(f, f.visitId);
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, {
        ...f.input, clientActionId: 'r17-retro-sale', expectedSourceVersion: completed.version,
      });
      const patched = await f.service.patch(f.manager, sale.jobCardId, {
        expectedVersion: sale.version,
        assignedTo: f.otherStaff.id,
      });
      expect(patched).toBeDefined();
      expect(await cardRow(f, sale.jobCardId)).toMatchObject({ assigned_to: f.otherStaff.id });
    });
  });

  it('treats a legacy divergent pair as decoupled in both directions', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      // Pre-S2 data: management reassigned the sale while the visit continued.
      await f.pool.query('UPDATE job_cards SET assigned_to=$2 WHERE id=$1', [
        ids.saleId, f.otherStaff.id,
      ]);
      const decoupledSale = await cardRow(f, ids.saleId);
      expect(decoupledSale.assigned_to).toBe(f.otherStaff.id);
      // The visit submits alone: no redirect, no shared id.
      const visit = await f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 'decoupled-visit-submit',
        expectedVersion: ids.visitVersion,
        note: 'Ziyaret tek başına gönderildi.',
      });
      expect(visit).not.toHaveProperty('linkedSaleJobCardId');
      expect((await activityEvents(f, f.visitId))
        .find((row) => row.event_type === 'JOB_SUBMITTED_FOR_APPROVAL')?.metadata)
        .not.toMatchObject({ pair: true });
      // The sale submits alone on its own card: ACCEPTED -> WAITING_APPROVAL.
      const saleSubmit = await f.service.submitForApproval(f.otherStaff, ids.saleId, {
        clientActionId: 'decoupled-sale-submit',
        expectedVersion: decoupledSale.version,
        note: 'Satış tek başına gönderildi.',
      });
      expect(saleSubmit.status).toBe('WAITING_APPROVAL');
      expect(saleSubmit).not.toHaveProperty('linkedSaleJobCardId');
      expect((await activityEvents(f, ids.saleId))
        .find((row) => row.event_type === 'JOB_SUBMITTED_FOR_APPROVAL')?.metadata)
        .not.toMatchObject({ pair: true });
      // Management re-aligns the pair owner: coordination is restored.
      await f.pool.query('UPDATE job_cards SET assigned_to=$2 WHERE id=$1', [
        ids.saleId, f.staff.id,
      ]);
      const visitWaiting = await cardRow(f, f.visitId);
      const saleWaiting = await cardRow(f, ids.saleId);
      const approved = await f.service.approve(f.manager, f.visitId, {
        clientActionId: 'decoupled-visit-approve',
        expectedVersion: visitWaiting.version,
        expectedSaleVersion: saleWaiting.version,
      });
      expect(approved).toMatchObject({ linkedSaleJobCardId: ids.saleId });
      expect(await cardRow(f, ids.saleId)).toMatchObject({ status: 'COMPLETED' });
    });
  });

  it('reports the exact next action for a legacy REVISION_REQUESTED sale', async () => {
    await withSaleFixture(async (f) => {
      const ids = await pairReadyForSubmit(f);
      // Direct SQL keeps the row shape the 009 CHECKs require (the service
      // would need a real revision episode to reach this legacy state).
      await f.pool.query(
        `UPDATE job_cards SET status='REVISION_REQUESTED',
           staff_completed_at=NOW(), staff_completed_by=$2,
           revision_requested_at=NOW(), revision_requested_by=$3, revision_reason='Kontrol.'
         WHERE id=$1`,
        [ids.saleId, f.staff.id, f.manager.id],
      );
      const sale = await cardRow(f, ids.saleId);
      await expect(f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 'legacy-revision-submit',
        expectedVersion: ids.visitVersion,
        note: 'Ziyaret onaya gönderildi.',
        expectedSaleVersion: sale.version,
      })).rejects.toMatchObject({
        code: 'SALE_PAIR_STATE_CONFLICT',
        statusCode: 409,
        details: {
          saleId: ids.saleId, saleStatus: 'REVISION_REQUESTED', allowedSaleCommand: 'RESUME',
        },
      });
    });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 §4.5 expectedSaleVersion handler contract', () => {
  it('keeps the pair field out of the non-pair command allowlists', async () => {
    // The handler allowlists are the single source of truth; a direct service
    // call cannot prove the HTTP rejection, so the constants are asserted in
    // the route-level suite (sale-write-routes) and here by refusing the
    // command for a sale card with no coordinated pair.
    await withSaleFixture(async (f) => {
      const standalone = await f.service.createStandaloneSale(f.staff, {
        clientActionId: 'allowlist-standalone',
        title: 'Telefon siparişi',
        description: null,
        customerId: f.customerId,
        assignedTo: f.staff.id,
        soldAt: saleTime.toISOString(),
        saleContactId: null,
        items: [{ productId: f.products[0]!, quantity: 1 }],
      });
      const submitted = await f.service.submitForApproval(f.staff, standalone.jobCardId, {
        clientActionId: 'allowlist-submit',
        expectedVersion: standalone.version,
        note: 'Sipariş.',
      });
      await expect(f.service.requestRevision(f.manager, standalone.jobCardId, {
        clientActionId: 'allowlist-revision',
        expectedVersion: submitted.version,
        revisionReason: 'Kontrol.',
        expectedSaleVersion: submitted.version,
      })).rejects.toMatchObject({
        code: 'SALE_PAIR_STATE_CONFLICT',
        details: { reason: 'NO_COORDINATED_PAIR' },
      });
    });
  });
});
