import { describe, expect, it } from 'vitest';
import { PostgresSaleTransaction, selectSaleSubmission } from '../src/modules/job-cards/sale-repository.js';
import { withSaleFixture } from './support/sale-harness.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Sale exact SQL integer integrity', () => {
  it('rejects excess-scale fractional INSERT/UPDATE without typmod rounding', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, items: [f.input.items[0]] });
      const before = (await f.pool.query('SELECT *,xmin::text FROM job_card_sale_items ORDER BY id')).rows;
      const third = (await f.pool.query("INSERT INTO products(organization_id,name) VALUES($1,'Third product') RETURNING id", [f.organizationId])).rows[0].id;
      const outcomes: Array<{ operation: string; input: string; result: string }> = [];
      for (const [operation, quantity, productId] of [
        ['INSERT', '1.0001', f.products[1]], ['UPDATE', '2.9999', null],
        ['INSERT', '15.0004', third], ['UPDATE', '999999998.9999', null],
      ]) {
        try {
          const result = operation === 'INSERT'
            ? await f.pool.query(`INSERT INTO job_card_sale_items(organization_id,job_card_id,product_id,quantity,product_name_snapshot,sort_order)
                VALUES($1,$2,$3,$4,'Direct SQL product',2) RETURNING quantity::text`, [f.organizationId, sale.jobCardId, productId, quantity])
            : await f.pool.query('UPDATE job_card_sale_items SET quantity=$2 WHERE id=$1 RETURNING quantity::text', [before[0].id, quantity]);
          outcomes.push({ operation: operation!, input: quantity!, result: 'accepted: ' + result.rows[0].quantity });
        } catch (error) {
          expect(error).toMatchObject({ code: '23514', constraint: 'job_card_sale_items_integer_quantity_check' });
          outcomes.push({ operation: operation!, input: quantity!, result: 'rejected' });
        }
      }
      expect(outcomes).toEqual([
        { operation: 'INSERT', input: '1.0001', result: 'rejected' },
        { operation: 'UPDATE', input: '2.9999', result: 'rejected' },
        { operation: 'INSERT', input: '15.0004', result: 'rejected' },
        { operation: 'UPDATE', input: '999999998.9999', result: 'rejected' },
      ]);
      expect((await f.pool.query('SELECT *,xmin::text FROM job_card_sale_items ORDER BY id')).rows).toEqual(before);
    });
  });
  it('keeps private v1 quantities, noop and readiness independent of valid SQL storage scale', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, items: [f.input.items[0]] });
      const item = (await f.service.getSaleDetails(f.staff, sale.jobCardId)).items[0]!;
      const receipts = (await f.pool.query('SELECT *,xmin::text FROM processed_actions ORDER BY id')).rows;
      const audit = (await f.pool.query('SELECT *,xmin::text FROM job_card_activity_logs ORDER BY id')).rows;
      for (const quantity of ['1', '1.0', '1.0000']) {
        await f.pool.query('UPDATE job_card_sale_items SET quantity=$2 WHERE id=$1', [item.id, quantity]);
        expect((await f.service.getSaleDetails(f.staff, sale.jobCardId)).items[0]!.quantity).toBe('1');
        expect((await new PostgresSaleTransaction(f.pool).getItems(f.organizationId, sale.jobCardId))[0]!.quantity).toBe('1.000');
        expect((await selectSaleSubmission(f.pool, f.organizationId, sale.jobCardId))!.items[0]!.quantity).toBe('1.000');
        await expect(f.service.patchSaleItem(f.staff, sale.jobCardId, item.id, {
          clientActionId: 'sql-scale-noop', expectedVersion: 1, quantity: 1,
        })).rejects.toMatchObject({ code: 'NO_CHANGES' });
      }
      expect((await f.pool.query('SELECT *,xmin::text FROM processed_actions ORDER BY id')).rows).toEqual(receipts);
      expect((await f.pool.query('SELECT *,xmin::text FROM job_card_activity_logs ORDER BY id')).rows).toEqual(audit);
      const started = await f.service.start(f.staff, sale.jobCardId, { clientActionId: 'sql-scale-start', expectedVersion: 1 });
      expect(started.workflowContext.submissionReadiness).toMatchObject({ ready: true });
      await f.service.patchSaleItem(f.staff, sale.jobCardId, item.id, {
        clientActionId: 'sql-scale-correct', expectedVersion: 2, quantity: 2,
      });
      const activity = await f.service.listActivity(f.staff, sale.jobCardId, { limit: 50, offset: 0 }, { includeSaleCapability: true });
      expect(activity.items.map((event) => event.details)).toContainEqual(expect.objectContaining({
        kind: 'SALE_ITEM', quantity: '2', previousQuantity: '1',
      }));
    });
  });
});
