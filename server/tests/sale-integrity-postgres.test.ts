import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresSaleTransaction } from '../src/modules/job-cards/sale-repository.js';
import { withSaleFixture } from './support/sale-harness.js';

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!process.env.TEST_DATABASE_URL)('Sale receipts and atomicity', () => {
  it('serializes same-key retries and rejects changed intent without extra business effects', async () => {
    await withSaleFixture(async (f) => {
      const [first, retry] = await Promise.all([
        f.service.createSaleFromVisit(f.staff, f.visitId, f.input),
        f.service.createSaleFromVisit(f.staff, f.visitId, f.input),
      ]);
      expect(retry).toEqual(first);
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, items: [f.input.items[0]] }))
        .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect((await f.pool.query(`SELECT
        (SELECT count(*)::int FROM job_cards WHERE type='SALE') AS roots,
        (SELECT count(*)::int FROM job_card_sale_details) AS details,
        (SELECT count(*)::int FROM job_card_sale_items) AS items,
        (SELECT count(*)::int FROM processed_actions WHERE operation_key='SALE_FROM_VISIT_CREATE') AS receipts,
        (SELECT count(*)::int FROM job_card_activity_logs WHERE event_type='SALE_FROM_VISIT_CREATED') AS links,
        (SELECT count(*)::int FROM job_card_delivery_items) AS deliveries,
        (SELECT count(*)::int FROM job_cards WHERE source_job_card_id IS NOT NULL) AS followups,
        (SELECT count(*)::int FROM calendar_events) AS calendar,
        (SELECT count(*)::int FROM backup_runs) AS backups,
        (SELECT count(*)::int FROM restore_runs) AS restores`)).rows[0])
        .toEqual({ roots: 1, details: 1, items: 2, receipts: 1, links: 1, deliveries: 0, followups: 0, calendar: 0, backups: 0, restores: 0 });
    });
  });
  it('replays a committed result after the response is lost', async () => {
    await withSaleFixture(async (f) => {
      vi.spyOn(f.repository, 'findJobCard').mockRejectedValueOnce(new Error('simulated response loss after COMMIT'));
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, f.input)).rejects.toThrow('response loss');
      const result = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      expect(result.version).toBe(1);
      expect((await f.pool.query("SELECT id FROM job_cards WHERE type='SALE'")).rows).toEqual([{ id: result.jobCardId }]);
      expect((await f.pool.query("SELECT count(*)::int AS n FROM job_card_activity_logs WHERE event_type='SALE_FROM_VISIT_CREATED'")).rows[0].n).toBe(1);
    });
  });
  it('rolls back root, details, earlier items, audit and claim when a later item fails', async () => {
    await withSaleFixture(async (f) => {
      const original = PostgresSaleTransaction.prototype.createItem;
      vi.spyOn(PostgresSaleTransaction.prototype, 'createItem')
        .mockImplementationOnce(function (item) { return original.call(this, item); })
        .mockRejectedValueOnce(new Error('injected second item failure'));
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, f.input)).rejects.toThrow('second item failure');
      expect((await f.pool.query(`SELECT
        (SELECT count(*)::int FROM job_cards WHERE type='SALE') AS roots,
        (SELECT count(*)::int FROM job_card_sale_details) AS details,
        (SELECT count(*)::int FROM job_card_sale_items) AS items,
        (SELECT count(*)::int FROM processed_actions WHERE operation_key='SALE_FROM_VISIT_CREATE') AS receipts,
        (SELECT count(*)::int FROM job_card_activity_logs WHERE event_type LIKE 'SALE_%') AS audit`)).rows[0])
        .toEqual({ roots: 0, details: 0, items: 0, receipts: 0, audit: 0 });
      vi.restoreAllMocks();
      expect(await f.service.createSaleFromVisit(f.staff, f.visitId, f.input)).toMatchObject({ version: 1 });
    });
  });
});
