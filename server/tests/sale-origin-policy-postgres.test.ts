import { describe, expect, it } from 'vitest';
import { withSaleFixture } from './support/sale-harness.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Sale V1 source/reference policy', () => {
  it.each(['job_cards', 'customers', 'products'])('rejects DEMO %s without backfilling or mixing records', async (table) => {
    await withSaleFixture(async (f) => {
      const dataset = (await f.pool.query(`INSERT INTO demo_datasets(organization_id,dataset_key,seed_version,created_by)
        VALUES ($1,'sale-policy','v1',$2) RETURNING id`, [f.organizationId, f.admin.id])).rows[0].id;
      const id = table === 'job_cards' ? f.visitId : table === 'customers' ? f.customerId : f.products[0];
      await f.pool.query(`UPDATE ${table} SET data_class='DEMO',demo_dataset_id=$2 WHERE id=$1`, [id, dataset]);
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, f.input)).rejects.toMatchObject({
        code: table === 'job_cards' ? 'SALE_FROM_VISIT_SOURCE_NOT_ELIGIBLE' : 'SALE_REFERENCE_NOT_ELIGIBLE',
      });
      expect((await f.pool.query("SELECT count(*)::int AS n FROM job_cards WHERE type='SALE'")).rows[0].n).toBe(0);
    });
  });
  it.each(['CUSTOMER_VISIT', 'SALES_MEETING', 'PRODUCT_DEMO', 'FOLLOW_UP'])('accepts BUSINESS IN_PROGRESS %s and management creates NEW for source staff', async (kind) => {
    await withSaleFixture(async (f) => {
      await f.pool.query('UPDATE job_cards SET engagement_kind=$2 WHERE id=$1', [f.visitId, kind]);
      const sale = await f.service.createSaleFromVisit(f.manager, f.visitId, { ...f.input, saleContactId: null });
      expect((await f.pool.query('SELECT status,assigned_to,customer_id,created_by,accepted_at,accepted_by FROM job_cards WHERE id=$1', [sale.jobCardId])).rows[0])
        .toEqual({ status: 'NEW', assigned_to: f.staff.id, customer_id: f.customerId, created_by: f.manager.id, accepted_at: null, accepted_by: null });
      await f.service.acceptAssignment(f.staff, sale.jobCardId, { clientActionId: 'sale-accept-manager-assignment', expectedVersion: 1 });
      expect((await f.pool.query('SELECT status FROM job_cards WHERE id=$1', [sale.jobCardId])).rows[0].status).toBe('ACCEPTED');
    });
  });
  it('copies historical inactive met contact while refusing a newly selected inactive sale contact', async () => {
    await withSaleFixture(async (f) => {
      await f.pool.query('UPDATE contacts SET is_active=false WHERE id=$1', [f.metContactId]);
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, f.input)).rejects.toMatchObject({ code: 'CONTACT_INACTIVE' });
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, saleContactId: null });
      expect((await f.pool.query('SELECT source_met_contact_id,source_met_contact_name_snapshot,sale_contact_id FROM job_card_sale_details WHERE job_card_id=$1', [sale.jobCardId])).rows[0])
        .toEqual({ source_met_contact_id: f.metContactId, source_met_contact_name_snapshot: 'Actual doctor', sale_contact_id: null });
    });
  });
  it('rejects stale source versions, future sale time, inactive customer and non-started visits', async () => {
    await withSaleFixture(async (f) => {
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, expectedSourceVersion: 1 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, soldAt: '2026-10-14T08:15:00.001Z' })).rejects.toMatchObject({ code: 'SALE_TIME_INVALID' });
      await f.pool.query("UPDATE customers SET status='inactive' WHERE id=$1", [f.customerId]);
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, f.input)).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE' });
      await f.pool.query("UPDATE customers SET status='active' WHERE id=$1", [f.customerId]);
      await f.pool.query("UPDATE job_cards SET status='ACCEPTED' WHERE id=$1", [f.visitId]);
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, f.input)).rejects.toMatchObject({ code: 'SALE_FROM_VISIT_SOURCE_NOT_ELIGIBLE' });
      expect((await f.pool.query('SELECT count(*)::int AS n FROM job_card_sale_details')).rows[0].n).toBe(0);
    });
  });
});
