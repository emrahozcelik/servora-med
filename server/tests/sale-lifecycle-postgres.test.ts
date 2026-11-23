import { describe, expect, it } from 'vitest';
import { readyVisit, standaloneSale, withSaleFixture } from './support/sale-harness.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Sale independent approval lifecycle', () => {
  it('freezes review edits, permits withdraw/revision corrections and rejects stale versions', async () => {
    await withSaleFixture(async (f) => {
      // SALE-002 §4.2: a visit-origin sale is submitted through its visit, so
      // this independent-lifecycle suite uses a standalone sale.
      const sale = await standaloneSale(f, {
        clientActionId: 'correction-create',
        items: [{ productId: f.products[0]!, quantity: 1 }, { productId: f.products[1]!, quantity: 15 }],
      });
      const itemId = (await f.pool.query('SELECT id FROM job_card_sale_items WHERE job_card_id=$1 ORDER BY sort_order', [sale.jobCardId])).rows[0].id;
      await f.service.start(f.staff, sale.jobCardId, { clientActionId: 'correction-start', expectedVersion: sale.version });
      await f.service.submitForApproval(f.staff, sale.jobCardId, { clientActionId: 'correction-submit', expectedVersion: sale.version + 1, note: 'Ready' });
      const edit = { clientActionId: 'review-edit', expectedVersion: sale.version + 2, quantity: 2 };
      await expect(f.service.patchSaleItem(f.manager, sale.jobCardId, itemId, edit)).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE' });
      await f.service.withdrawFromApproval(f.staff, sale.jobCardId, { clientActionId: 'correction-withdraw', expectedVersion: 3 });
      expect(await f.service.patchSaleItem(f.staff, sale.jobCardId, itemId, { ...edit, expectedVersion: 4 })).toMatchObject({ version: 5 });
      await expect(f.service.patchSaleItem(f.staff, sale.jobCardId, itemId, { ...edit, clientActionId: 'stale-edit', expectedVersion: 4 }))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await f.service.submitForApproval(f.staff, sale.jobCardId, { clientActionId: 'correction-resubmit', expectedVersion: 5, note: 'Corrected' });
      await f.service.requestRevision(f.manager, sale.jobCardId, { clientActionId: 'correction-revision', expectedVersion: 6, revisionReason: 'Check buyer' });
      await f.service.patchSaleDetails(f.staff, sale.jobCardId, { clientActionId: 'revision-contact', expectedVersion: 7, saleContactId: null });
      await f.service.resume(f.staff, sale.jobCardId, { clientActionId: 'revision-resume', expectedVersion: 8 });
      expect((await f.pool.query('SELECT status,version FROM job_cards WHERE id=$1', [sale.jobCardId])).rows[0]).toEqual({ status: 'IN_PROGRESS', version: 9 });
    });
  });
  it.each(['COMPLETED', 'CANCELLED', 'INVALIDATED'] as const)('keeps %s immutable and releases only its active slot', async (terminal) => {
    await withSaleFixture(async (f) => {
      // The source visit is completed first, so the retro sale owns its own
      // lifecycle (SALE-002 §4.2/§6.2) and the visit's active-sale slot behaves
      // exactly as SALE-001 defined it.
      const visitVersion = await readyVisit(f, { expectedVersion: f.input.expectedSourceVersion });
      await f.service.submitForApproval(f.staff, f.visitId, {
        clientActionId: 'terminal-visit-submit', expectedVersion: visitVersion, note: 'Ziyaret tamamlandı.',
      });
      const waitingVisit = (await f.pool.query('SELECT version FROM job_cards WHERE id=$1', [f.visitId])).rows[0];
      await f.service.approve(f.manager, f.visitId, {
        clientActionId: 'terminal-visit-approve', expectedVersion: waitingVisit.version,
      });
      const completedVisit = (await f.pool.query('SELECT version FROM job_cards WHERE id=$1', [f.visitId])).rows[0];
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, {
        ...f.input, clientActionId: 'terminal-sale-create', expectedSourceVersion: completedVisit.version,
      });
      let version = sale.version;
      if (terminal === 'COMPLETED') {
        await f.service.start(f.staff, sale.jobCardId, { clientActionId: 'terminal-start', expectedVersion: sale.version });
        await f.service.submitForApproval(f.staff, sale.jobCardId, { clientActionId: 'terminal-submit', expectedVersion: sale.version + 1, note: 'Recorded' });
        await f.service.approve(f.manager, sale.jobCardId, { clientActionId: 'terminal-approve', expectedVersion: sale.version + 2 });
        version = sale.version + 3;
      } else if (terminal === 'CANCELLED') {
        await f.service.cancel(f.staff, sale.jobCardId, { clientActionId: 'terminal-cancel', expectedVersion: sale.version, cancelReason: 'Customer changed agreement' });
        version = sale.version + 1;
      } else {
        await f.service.invalidate(f.admin, sale.jobCardId, { clientActionId: 'terminal-invalidate', expectedVersion: sale.version, reasonCode: 'CREATED_BY_MISTAKE', note: null });
        version = sale.version + 1;
      }
      const itemId = (await f.pool.query('SELECT id FROM job_card_sale_items WHERE job_card_id=$1', [sale.jobCardId])).rows[0].id;
      await expect(f.service.removeSaleItem(f.manager, sale.jobCardId, itemId, { clientActionId: 'terminal-edit', expectedVersion: version }))
        .rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE' });
      const next = await f.service.createSaleFromVisit(f.staff, f.visitId, {
        ...f.input, clientActionId: 'second-independent-agreement',
        expectedSourceVersion: completedVisit.version,
      });
      expect(next.jobCardId).not.toBe(sale.jobCardId);
      expect((await f.pool.query('SELECT status,version FROM job_cards WHERE id=$1', [f.visitId])).rows[0])
        .toEqual({ status: 'COMPLETED', version: completedVisit.version });
      expect((await f.pool.query('SELECT count(*)::int AS n FROM job_card_sale_items')).rows[0].n).toBe(4);
    });
  });
  it('starts and submits using explicit sale readiness, then requires management approval', async () => {
    await withSaleFixture(async (f) => {
      // Standalone: the independent submit path this test covers belongs to a
      // sale with no live source visit (SALE-002 §4.2).
      const sale = await standaloneSale(f, { clientActionId: 'readiness-sale-create' });
      const started = await f.service.start(f.staff, sale.jobCardId, { clientActionId: 'sale-start', expectedVersion: sale.version });
      expect(started.workflowContext.submissionReadiness).toMatchObject({ ready: true });
      expect(started.workflowContext.submissionReadiness!.items.map((item) => item.code)).toContain('SALE_ITEMS_VALID');
      const submitted = await f.service.submitForApproval(f.staff, sale.jobCardId, {
        clientActionId: 'sale-submit', expectedVersion: started.version, note: 'Product agreement recorded.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      await expect(f.service.approve(f.staff, sale.jobCardId, { clientActionId: 'sale-staff-approve', expectedVersion: submitted.version }))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      const approved = await f.service.approve(f.manager, sale.jobCardId, {
        clientActionId: 'sale-manager-approve', expectedVersion: submitted.version,
      });
      expect(approved.status).toBe('COMPLETED');
      expect((await f.pool.query('SELECT status,version FROM job_cards WHERE id=$1', [f.visitId])).rows[0])
        .toEqual({ status: 'IN_PROGRESS', version: f.input.expectedSourceVersion });
    });
  });
});
