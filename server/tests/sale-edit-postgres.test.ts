import { describe, expect, it } from 'vitest';
import { withSaleFixture } from './support/sale-harness.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Sale corrections', () => {
  it('enforces per-action ownership, item identity, request hash and strict correction fields', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const itemId = (await f.pool.query('SELECT id FROM job_card_sale_items WHERE job_card_id=$1', [sale.jobCardId])).rows[0].id;
      const input = { clientActionId: 'guarded-edit', expectedVersion: 1, quantity: 2 };
      await expect(f.service.patchSaleItem(f.otherStaff, sale.jobCardId, itemId, input)).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      await expect(f.service.patchSaleItem(f.staff, sale.jobCardId, f.products[0]!, input)).rejects.toMatchObject({ code: 'SALE_ITEM_NOT_FOUND', statusCode: 404 });
      for (const quantity of [0, -1, NaN, Infinity, 0.0001, 1.2345, 1_000_000_000]) {
        await expect(f.service.patchSaleItem(f.staff, sale.jobCardId, itemId, { ...input, quantity })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      }
      await expect(f.service.patchSaleItem(f.staff, sale.jobCardId, itemId, { ...input, productId: f.products[1] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await f.service.patchSaleItem(f.staff, sale.jobCardId, itemId, input);
      await expect(f.service.patchSaleItem(f.staff, sale.jobCardId, itemId, { ...input, quantity: 3 })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED' });
      expect((await f.pool.query('SELECT version FROM job_cards WHERE id=$1', [sale.jobCardId])).rows[0].version).toBe(2);
    });
  });
  it('serializes additions against the 25-line maximum', async () => {
    await withSaleFixture(async (f) => {
      const products = (await f.pool.query(`INSERT INTO products(organization_id,name)
        SELECT $1,'Product '||n FROM generate_series(1,25) n RETURNING id`, [f.organizationId])).rows;
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input,
        items: products.slice(0,24).map((product) => ({ productId: product.id, quantity: 1 })) });
      const results = await Promise.allSettled([products[24].id, f.products[0]!].map((productId, index) =>
        f.service.addSaleItem(f.staff, sale.jobCardId, { clientActionId: `last-line-${index}`, expectedVersion: 1, productId, quantity: 1 })));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((result) => result.status === 'rejected');
      expect(loser?.status === 'rejected' && loser.reason).toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(f.service.addSaleItem(f.staff, sale.jobCardId, { clientActionId: 'over-limit', expectedVersion: 2, productId: f.products[1]!, quantity: 1 }))
        .rejects.toMatchObject({ code: 'SALE_ITEM_LIMIT' });
      expect((await f.pool.query('SELECT count(*)::int AS n FROM job_card_sale_items WHERE job_card_id=$1', [sale.jobCardId])).rows[0].n).toBe(25);
    });
  });
  it('corrects sale time/contact without rewriting visit-origin snapshots', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const before = (await f.pool.query('SELECT * FROM job_card_sale_details WHERE job_card_id=$1', [sale.jobCardId])).rows[0];
      const input = { clientActionId: 'details-correct', expectedVersion: 1,
        soldAt: '2026-10-14T07:55:00Z', saleContactId: null };
      expect(await f.service.patchSaleDetails(f.manager, sale.jobCardId, input)).toMatchObject({ version: 2 });
      expect(await f.service.patchSaleDetails(f.manager, sale.jobCardId, input)).toMatchObject({ version: 2 });
      const after = (await f.pool.query('SELECT * FROM job_card_sale_details WHERE job_card_id=$1', [sale.jobCardId])).rows[0];
      expect(after.sale_contact_id).toBeNull();
      expect(after.sale_contact_name_snapshot).toBeNull();
      expect(after.sold_at.toISOString()).toBe('2026-10-14T07:55:00.000Z');
      for (const key of Object.keys(before).filter((key) => key.startsWith('source_'))) expect(after[key]).toEqual(before[key]);
      await expect(f.service.patchSaleDetails(f.staff, sale.jobCardId, { clientActionId: 'forged-origin', expectedVersion: 2,
        sourceVisitVersion: 99 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });
  it('adds a distinct active product with its snapshot and rejects duplicates', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, items: [f.input.items[0]] });
      const input = { clientActionId: 'add-second', expectedVersion: 1, ...f.input.items[1] };
      expect(await f.service.addSaleItem(f.staff, sale.jobCardId, input)).toMatchObject({ version: 2 });
      expect(await f.service.addSaleItem(f.staff, sale.jobCardId, input)).toMatchObject({ version: 2 });
      await expect(f.service.addSaleItem(f.staff, sale.jobCardId, { ...input, clientActionId: 'duplicate', expectedVersion: 2 }))
        .rejects.toMatchObject({ code: 'SALE_PRODUCT_DUPLICATE', statusCode: 409 });
      const rows = (await f.pool.query('SELECT product_id,quantity,product_name_snapshot,sort_order FROM job_card_sale_items WHERE job_card_id=$1 ORDER BY sort_order', [sale.jobCardId])).rows;
      expect(rows).toEqual([
        { product_id: f.products[0], quantity: '0.500', product_name_snapshot: 'Matrix set', sort_order: 0 },
        { product_id: f.products[1], quantity: '0.001', product_name_snapshot: 'Bonding liquid', sort_order: 1 },
      ]);
    });
  });
  it('removes all draft lines atomically, replays removal and blocks empty submission', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const items = (await f.pool.query('SELECT id FROM job_card_sale_items WHERE job_card_id=$1 ORDER BY sort_order', [sale.jobCardId])).rows;
      const input = { clientActionId: 'remove-first', expectedVersion: 1 };
      expect(await f.service.removeSaleItem(f.staff, sale.jobCardId, items[0].id, input)).toMatchObject({ version: 2 });
      expect(await f.service.removeSaleItem(f.staff, sale.jobCardId, items[0].id, input)).toMatchObject({ version: 2 });
      await f.service.removeSaleItem(f.staff, sale.jobCardId, items[1].id, { clientActionId: 'remove-last', expectedVersion: 2 });
      const started = await f.service.start(f.staff, sale.jobCardId, { clientActionId: 'start-empty', expectedVersion: 3 });
      expect(started.workflowContext.submissionReadiness!.ready).toBe(false);
      await expect(f.service.submitForApproval(f.staff, sale.jobCardId, {
        clientActionId: 'submit-empty', expectedVersion: 4, note: 'Empty agreement',
      })).rejects.toMatchObject({ code: 'SALE_NOT_READY' });
      expect((await f.pool.query("SELECT count(*)::int AS count FROM job_card_activity_logs WHERE job_card_id=$1 AND event_type='SALE_ITEM_REMOVED'", [sale.jobCardId])).rows[0].count).toBe(2);
    });
  });
  it('changes only quantity with a versioned receipt and keeps historical metadata', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const item = (await f.pool.query('SELECT * FROM job_card_sale_items WHERE job_card_id=$1 AND product_id=$2',
        [sale.jobCardId, f.products[0]])).rows[0];
      await f.pool.query("UPDATE products SET name='Renamed',brand='Changed',is_active=false WHERE id=$1", [item.product_id]);
      const input = { clientActionId: 'sale-quantity', expectedVersion: 1, quantity: 0.001 };
      const result = await f.service.patchSaleItem(f.staff, sale.jobCardId, item.id, input);
      expect(result).toEqual({ jobCardId: sale.jobCardId, version: 2 });
      expect(await f.service.patchSaleItem(f.staff, sale.jobCardId, item.id, input)).toEqual(result);
      const after = (await f.pool.query('SELECT * FROM job_card_sale_items WHERE id=$1', [item.id])).rows[0];
      expect(after).toMatchObject({ quantity: '0.001', product_id: item.product_id,
        product_name_snapshot: item.product_name_snapshot, product_brand_snapshot: item.product_brand_snapshot });
      expect((await f.pool.query("SELECT count(*)::int AS count FROM job_card_activity_logs WHERE job_card_id=$1 AND event_type='SALE_ITEM_UPDATED'", [sale.jobCardId])).rows[0].count).toBe(1);
    });
  });
});
