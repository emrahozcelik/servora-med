import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { withIntentSchema, insertProofOrg, insertProofUser } from './support/lifecycle-intent-harness.js';

async function fixture(pool: Pool, timezone = 'Europe/Istanbul') {
  const organizationId = await insertProofOrg(pool, 'Trend fixture');
  await pool.query('UPDATE organizations SET timezone=$2 WHERE id=$1', [organizationId, timezone]);
  const userId = await insertProofUser(pool, organizationId, 'MANAGER');
  const customerId = (await pool.query<{ id: string }>(`INSERT INTO customers (organization_id,name,customer_type)
    VALUES ($1,'Dental clinic','clinic') RETURNING id`, [organizationId])).rows[0]!.id;
  async function card(type: 'SALES_MEETING' | 'SALE' | 'PRODUCT_DELIVERY', at: string, source: string | null = null, status = 'COMPLETED') {
    const id = (await pool.query<{ id: string }>(`INSERT INTO job_cards
      (organization_id,type,title,status,customer_id,created_by,assigned_to,engagement_kind,
       source_job_card_id,follow_up_instructions,sale_source_visit_id,started_at,
       staff_completed_at,staff_completed_by,manager_approved_at,manager_approved_by,
       cancelled_at,cancelled_by,cancel_reason,created_at)
      VALUES ($1,$2,'Trend record',$3,$4,$5,$5,$6,$7,$8,$9,$10,$10,$5,$10,$5,$10,$5,'Fixture','2025-01-01') RETURNING id`,
    [organizationId, type, status, customerId, userId, type === 'SALES_MEETING' ? 'CUSTOMER_VISIT' : null,
      type === 'SALES_MEETING' ? source : null, type === 'SALES_MEETING' && source ? 'Visit again' : null,
      type === 'SALE' ? source : null, at])).rows[0]!.id;
    if (type === 'SALES_MEETING') await pool.query(`INSERT INTO job_card_meeting_details
      (organization_id,job_card_id,meeting_at,outcome) VALUES ($1,$2,$3,'POSITIVE')`, [organizationId, id, at]);
    if (type === 'SALE') await pool.query(`INSERT INTO job_card_sale_details
      (organization_id,job_card_id,sold_at,source_visit_version,source_visit_title_snapshot,source_customer_name_snapshot)
      VALUES ($1,$2,$3,1,'Source visit','Dental clinic')`, [organizationId, id, at]);
    return id;
  }
  const reports = new PostgresReportsRepository(pool);
  const read = (from: string, to: string, now = '2026-10-10T12:00:00Z', includeSaleCapability = true) =>
    reports.getBusinessTrend({ organizationId, requestedRange: { from, to }, requestTime: new Date(now), includeSaleCapability });
  return { organizationId, userId, customerId, card, read, reports };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('Business trend PostgreSQL contract', () => {
  it('counts approved event dates, explicit distinct links and company sales without delivery or organization leakage', async () => {
    await withIntentSchema(process.env.TEST_DATABASE_URL, async (pool) => {
      const f = await fixture(pool);
      await f.card('SALES_MEETING', '2026-09-30T20:59:59Z');
      const visit = await f.card('SALES_MEETING', '2026-09-30T21:00:00Z');
      const followUp = await f.card('SALES_MEETING', '2026-10-02T09:00:00Z', visit);
      await f.card('SALES_MEETING', '2026-10-03T09:00:00Z', visit);
      await f.card('SALE', '2026-10-02T09:00:00Z', visit);
      await f.card('SALE', '2026-10-02T10:00:00Z', visit);
      await f.card('SALE', '2026-10-05T09:00:00Z', followUp);
      await f.card('SALE', '2026-10-03T09:00:00Z', visit, 'WAITING_APPROVAL');
      await f.card('SALES_MEETING', '2026-10-02T10:00:00Z', null, 'CANCELLED');
      await f.card('PRODUCT_DELIVERY', '2026-10-02T09:00:00Z');
      const invalid = await f.card('SALES_MEETING', '2026-10-02T10:00:00Z');
      await pool.query(`UPDATE job_cards SET status='INVALIDATED', invalidated_at='2026-10-03',
        invalidated_by=$2, invalidation_reason_code='DUPLICATE' WHERE id=$1`, [invalid, f.userId]);
      const other = await fixture(pool);
      const otherVisit = await other.card('SALES_MEETING', '2026-10-02T09:00:00Z');
      await other.card('SALE', '2026-10-02T09:00:00Z', otherVisit);
      const result = await f.read('2026-10-01', '2026-10-03');
      expect(result.totals).toEqual({ visits: 3, followUps: 2, sales: 2 });
      expect(result.points).toEqual([
        { date: '2026-10-01', visits: 1, followUps: 0, sales: 0 },
        { date: '2026-10-02', visits: 1, followUps: 1, sales: 2 },
        { date: '2026-10-03', visits: 1, followUps: 1, sales: 0 },
      ]);
      expect(result.comparison?.totals).toEqual({ visits: 1, followUps: 0, sales: 0 });
      expect(result.relationships).toEqual({ visitsWithFollowUp: 1, visitsWithSale: 2, followUpsWithSale: 1 });
      const withoutSale = await f.read('2026-10-01', '2026-10-03', undefined, false);
      expect(withoutSale.totals.sales).toBe(0);
      expect(withoutSale.relationships.visitsWithSale).toBe(0);
    });
  });

  it('truncates future days and compares the same elapsed calendar days and local cutoff', async () => {
    await withIntentSchema(process.env.TEST_DATABASE_URL, async (pool) => {
      const f = await fixture(pool);
      for (const at of ['2026-09-30T08:59:59Z', '2026-09-30T09:00:00Z', '2026-10-01T21:00:00Z', '2026-10-02T09:00:00Z', '2026-10-03T09:00:00Z']) {
        await f.card('SALES_MEETING', at);
      }
      const result = await f.read('2026-10-01', '2026-10-31', '2026-10-02T09:00:00Z');
      expect(result.observedThrough).toBe('2026-10-02');
      expect(result.partialDay).toBe(true);
      expect(result.points).toHaveLength(2);
      expect(result.totals.visits).toBe(1);
      expect(result.comparison).toEqual({ range: { from: '2026-09-29', to: '2026-09-30', timezone: 'Europe/Istanbul' }, totals: { visits: 1, followUps: 0, sales: 0 } });
      const future = await f.read('2026-11-01', '2026-11-30');
      expect(future.points).toEqual([]);
      expect(future.observedThrough).toBeNull();
      expect(future.comparison).toBeNull();
      expect(future.totals).toEqual({ visits: 0, followUps: 0, sales: 0 });
    });
  });

  it('uses organization calendar days across DST and returns bounded zero-filled dates', async () => {
    await withIntentSchema(process.env.TEST_DATABASE_URL, async (pool) => {
      const f = await fixture(pool, 'Europe/Berlin');
      for (const at of ['2026-03-27T10:59:59Z', '2026-03-27T11:00:00Z', '2026-03-28T23:00:00Z']) await f.card('SALES_MEETING', at);
      const result = await f.read('2026-03-28', '2026-03-29', '2026-03-29T10:00:00Z');
      expect(result.points).toEqual([{ date: '2026-03-28', visits: 0, followUps: 0, sales: 0 }, { date: '2026-03-29', visits: 1, followUps: 0, sales: 0 }]);
      expect(result.comparison?.totals.visits).toBe(1);
      expect((await f.read('2024-01-01', '2024-12-31')).points).toHaveLength(366);
    });
  });
});
