import { describe, expect, it } from 'vitest';
import { withSaleFixture } from './support/sale-harness.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Sale independent approval lifecycle', () => {
  it('freezes review edits, permits withdraw/revision corrections and rejects stale versions', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const itemId = (await f.pool.query('SELECT id FROM job_card_sale_items WHERE job_card_id=$1 ORDER BY sort_order', [sale.jobCardId])).rows[0].id;
      await f.service.start(f.staff, sale.jobCardId, { clientActionId: 'correction-start', expectedVersion: 1 });
      await f.service.submitForApproval(f.staff, sale.jobCardId, { clientActionId: 'correction-submit', expectedVersion: 2, note: 'Ready' });
      const edit = { clientActionId: 'review-edit', expectedVersion: 3, quantity: 2 };
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
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      let version = 1;
      if (terminal === 'COMPLETED') {
        await f.service.start(f.staff, sale.jobCardId, { clientActionId: 'terminal-start', expectedVersion: 1 });
        await f.service.submitForApproval(f.staff, sale.jobCardId, { clientActionId: 'terminal-submit', expectedVersion: 2, note: 'Recorded' });
        await f.service.approve(f.manager, sale.jobCardId, { clientActionId: 'terminal-approve', expectedVersion: 3 });
        version = 4;
      } else if (terminal === 'CANCELLED') {
        await f.service.cancel(f.staff, sale.jobCardId, { clientActionId: 'terminal-cancel', expectedVersion: 1, cancelReason: 'Customer changed agreement' });
        version = 2;
      } else {
        await f.service.invalidate(f.admin, sale.jobCardId, { clientActionId: 'terminal-invalidate', expectedVersion: 1, reasonCode: 'CREATED_BY_MISTAKE', note: null });
        version = 2;
      }
      const itemId = (await f.pool.query('SELECT id FROM job_card_sale_items WHERE job_card_id=$1', [sale.jobCardId])).rows[0].id;
      await expect(f.service.removeSaleItem(f.manager, sale.jobCardId, itemId, { clientActionId: 'terminal-edit', expectedVersion: version }))
        .rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE' });
      const next = await f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, clientActionId: 'second-independent-agreement' });
      expect(next.jobCardId).not.toBe(sale.jobCardId);
      expect((await f.pool.query('SELECT status,version FROM job_cards WHERE id=$1', [f.visitId])).rows[0])
        .toEqual({ status: 'IN_PROGRESS', version: f.input.expectedSourceVersion });
      expect((await f.pool.query('SELECT count(*)::int AS n FROM job_card_sale_items')).rows[0].n).toBe(4);
    });
  });
  it('starts and submits using explicit sale readiness, then requires management approval', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
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
