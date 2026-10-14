import { describe, expect, it } from 'vitest';
import { withSaleFixture } from './support/sale-harness.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Transactional visit-to-sale creation', () => {
  it('creates a separate sale with historical product/contact snapshots and leaves the visit unchanged', async () => {
    await withSaleFixture(async (f) => {
      const before = (await f.pool.query('SELECT * FROM job_cards WHERE id=$1', [f.visitId])).rows[0];
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      expect(sale.version).toBe(1);
      const root = (await f.pool.query('SELECT * FROM job_cards WHERE id=$1', [sale.jobCardId])).rows[0];
      expect(root).toMatchObject({ type: 'SALE', status: 'ACCEPTED', customer_id: f.customerId,
        assigned_to: f.staff.id, sale_source_visit_id: f.visitId, source_job_card_id: null,
        contact_id: null, scheduled_at: null, scheduled_ends_at: null, due_date: null });
      const lines = (await f.pool.query(
        `SELECT product_id,quantity::text,product_name_snapshot,product_brand_snapshot,unit_snapshot
         FROM job_card_sale_items WHERE job_card_id=$1 ORDER BY sort_order`, [sale.jobCardId],
      )).rows;
      expect(lines).toEqual([
        { product_id: f.products[0], quantity: '0.500', product_name_snapshot: 'Matrix set', product_brand_snapshot: 'Brand A', unit_snapshot: null },
        { product_id: f.products[1], quantity: '0.001', product_name_snapshot: 'Bonding liquid', product_brand_snapshot: null, unit_snapshot: 'ml' },
      ]);
      const details = (await f.pool.query('SELECT * FROM job_card_sale_details WHERE job_card_id=$1', [sale.jobCardId])).rows[0];
      expect(details).toMatchObject({ source_visit_version: f.input.expectedSourceVersion,
        source_planned_contact_id: f.plannedContactId, source_met_contact_id: f.metContactId,
        sale_contact_id: f.metContactId, source_planned_contact_name_snapshot: 'Planned doctor',
        source_met_contact_name_snapshot: 'Actual doctor', sale_contact_name_snapshot: 'Actual doctor' });
      expect((await f.pool.query('SELECT * FROM job_cards WHERE id=$1', [f.visitId])).rows[0]).toEqual(before);
      expect((await f.pool.query('SELECT COUNT(*)::int AS n FROM job_card_delivery_items')).rows[0].n).toBe(0);
      expect((await f.pool.query('SELECT COUNT(*)::int AS n FROM job_cards WHERE source_job_card_id IS NOT NULL')).rows[0].n).toBe(0);
      expect((await f.pool.query(`SELECT COUNT(*)::int AS n FROM job_card_activity_logs
        WHERE job_card_id=$1 AND event_type='SALE_FROM_VISIT_CREATED'`, [f.visitId])).rows[0].n).toBe(1);
    });
  });
  it('rejects a training visit as a sale source without leaving any sale receipt', async () => {
    await withSaleFixture(async (f) => {
      await f.pool.query(`UPDATE job_cards SET engagement_kind='TRAINING' WHERE id=$1`, [f.visitId]);
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, f.input))
        .rejects.toMatchObject({ code: 'SALE_FROM_VISIT_SOURCE_NOT_ELIGIBLE', statusCode: 409 });
      expect((await f.pool.query(`SELECT COUNT(*)::int AS n FROM job_cards WHERE type='SALE'`)).rows[0].n).toBe(0);
      expect((await f.pool.query(`SELECT COUNT(*)::int AS n FROM processed_actions
        WHERE operation_key='SALE_FROM_VISIT_CREATE'`)).rows[0].n).toBe(0);
    });
  });
  it('commits exactly one active sale when distinct action keys race for the same visit', async () => {
    await withSaleFixture(async (f) => {
      const results = await Promise.allSettled(['race-a', 'race-b'].map((clientActionId) =>
        f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, clientActionId })));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason)
        .toMatchObject({ code: 'SALE_FROM_VISIT_ACTIVE_EXISTS', statusCode: 409 });
      const counts = (await f.pool.query(`SELECT
        (SELECT COUNT(*)::int FROM job_cards WHERE type='SALE') AS jobs,
        (SELECT COUNT(*)::int FROM job_card_sale_details) AS details,
        (SELECT COUNT(*)::int FROM job_card_sale_items) AS items,
        (SELECT COUNT(*)::int FROM processed_actions WHERE operation_key='SALE_FROM_VISIT_CREATE') AS receipts,
        (SELECT COUNT(*)::int FROM job_card_activity_logs WHERE event_type='SALE_FROM_VISIT_CREATED') AS links`)).rows[0];
      expect(counts).toEqual({ jobs: 1, details: 1, items: 2, receipts: 1, links: 1 });
    });
  });
  it('conceals a replay result after the original staff user loses access to the sale', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      await f.service.patch(f.manager, sale.jobCardId, { expectedVersion: 1, assignedTo: f.otherStaff.id });
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, f.input))
        .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      expect((await f.pool.query(`SELECT COUNT(*)::int AS n FROM job_cards WHERE type='SALE'`)).rows[0].n).toBe(1);
    });
  });
});
