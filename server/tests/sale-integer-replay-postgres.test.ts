import { describe, expect, it } from 'vitest';
import { hashRequestIdentity } from '../src/modules/job-cards/critical-action-request-hash.js';
import { withSaleFixture } from './support/sale-harness.js';

// Reconstruct the reviewed pre-SALE-QTY-001 v1 hashes independently of today's parser.
describe.skipIf(!process.env.TEST_DATABASE_URL)('Sale integer receipt compatibility', () => {
  it('replays v1 create/add/correction receipts and preserves 1→2→1/noop semantics', async () => {
    await withSaleFixture(async (f) => {
      const input = { ...f.input, items: [f.input.items[0]] };
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, input);
      async function oldReceipt(operation: string, key: string, identity: Record<string, unknown>) {
        const oldHash = hashRequestIdentity(identity);
        const row = (await f.pool.query(`SELECT request_hash FROM processed_actions
          WHERE organization_id=$1 AND user_id=$2 AND operation_key=$3 AND client_action_id=$4`,
        [f.organizationId, f.staff.id, operation, key])).rows[0];
        expect(row.request_hash).toBe(oldHash);
        // Pin the durable receipt to the independently reconstructed old digest before retry.
        await f.pool.query(`UPDATE processed_actions SET request_hash=$5
          WHERE organization_id=$1 AND user_id=$2 AND operation_key=$3 AND client_action_id=$4`,
        [f.organizationId, f.staff.id, operation, key, oldHash]);
      }
      await oldReceipt('SALE_FROM_VISIT_CREATE', input.clientActionId, {
        operation: 'SALE_FROM_VISIT_CREATE:v1', sourceVisitId: f.visitId,
        expectedSourceVersion: input.expectedSourceVersion, title: input.title, description: null,
        soldAt: input.soldAt, saleContactId: input.saleContactId,
        items: [{ productId: f.products[0], quantity: '1.000' }],
      });
      expect(await f.service.createSaleFromVisit(f.staff, f.visitId, input)).toEqual(sale);
      const add = { clientActionId: 'integer-add-v1', expectedVersion: 1, productId: f.products[1], quantity: 15 };
      const added = await f.service.addSaleItem(f.staff, sale.jobCardId, add);
      await oldReceipt('SALE_ITEM_ADD', add.clientActionId, {
        operation: 'SALE_ITEM_ADD:v1', jobCardId: sale.jobCardId, expectedVersion: 1,
        productId: f.products[1], quantity: '15.000',
      });
      expect(await f.service.addSaleItem(f.staff, sale.jobCardId, add)).toEqual(added);
      const item = (await f.service.getSaleDetails(f.staff, sale.jobCardId)).items[0]!;
      const patch = { clientActionId: 'integer-update-v1', expectedVersion: 2, quantity: 2 };
      const updated = await f.service.patchSaleItem(f.staff, sale.jobCardId, item.id, patch);
      await oldReceipt('SALE_ITEM_UPDATE', patch.clientActionId, {
        operation: 'SALE_ITEM_UPDATE:v1', jobCardId: sale.jobCardId, expectedVersion: 2,
        itemId: item.id, quantity: '2.000',
      });
      const effects = async () => (await f.pool.query(`SELECT
        (SELECT count(*)::int FROM processed_actions) AS receipts,
        (SELECT count(*)::int FROM job_card_activity_logs) AS audit,
        (SELECT count(*)::int FROM realtime_events) AS realtime,
        (SELECT count(*)::int FROM in_app_notifications) AS notifications`)).rows[0];
      const before = await effects();
      expect(await f.service.patchSaleItem(f.staff, sale.jobCardId, item.id, patch)).toEqual(updated);
      await expect(f.service.patchSaleItem(f.staff, sale.jobCardId, item.id, { ...patch, quantity: 1 }))
        .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED' });
      await expect(f.service.patchSaleItem(f.staff, sale.jobCardId, item.id, {
        clientActionId: 'integer-noop', expectedVersion: 3, quantity: 2,
      })).rejects.toMatchObject({ code: 'NO_CHANGES' });
      expect(await effects()).toEqual(before);
      expect((await f.service.getSaleDetails(f.staff, sale.jobCardId)).jobCardVersion).toBe(3);
      await f.service.patchSaleItem(f.staff, sale.jobCardId, item.id, {
        clientActionId: 'integer-back-to-one', expectedVersion: 3, quantity: 1,
      });
      const detail = await f.service.getSaleDetails(f.staff, sale.jobCardId);
      expect(detail.jobCardVersion).toBe(4);
      expect(detail.items.map(({ productId, quantity }) => ({ productId, quantity }))).toEqual([
        { productId: f.products[0], quantity: '1' }, { productId: f.products[1], quantity: '15' },
      ]);
      const activity = await f.service.listActivity(f.staff, sale.jobCardId, { limit: 50, offset: 0 }, { includeSaleCapability: true });
      expect(activity.items.filter((event) => event.details.kind === 'SALE_ITEM').map((event) => event.details))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ quantity: '2', previousQuantity: '1' }),
          expect.objectContaining({ quantity: '1', previousQuantity: '2' }),
          expect.objectContaining({ quantity: '15', previousQuantity: null }),
        ]));
    });
  });
});
