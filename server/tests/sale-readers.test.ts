import { describe, expect, it } from 'vitest';
import { withSaleFixture } from './support/sale-harness.js';
import { PostgresSaleReader } from '../src/modules/job-cards/sale-reader.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { mapSourceWorkRow } from '../src/modules/weekly-reports/source-work.js';
import { validateSourceWorkSnapshot } from '../src/modules/weekly-reports/validation.js';

describe('Sale read projections', () => {
  it('preserves product/contact snapshots after rename/deactivation and source closure', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      await f.pool.query("UPDATE products SET name='Renamed',brand='New brand',unit='Changed',is_active=FALSE WHERE id=ANY($1::uuid[])", [f.products]);
      await f.pool.query("UPDATE contacts SET name='Renamed contact',is_active=FALSE WHERE customer_id=$1", [f.customerId]);
      await f.service.cancel(f.manager, f.visitId, { clientActionId: 'read-source-close',
        expectedVersion: f.input.expectedSourceVersion, cancelReason: 'Independent source closure' });
      const detail = await f.service.getSaleDetails(f.staff, sale.jobCardId);
      expect(detail.items[0]).toMatchObject({ name: 'Matrix set', brand: 'Brand A', unit: null, quantity: '0.500' });
      expect(detail.saleContact?.name).toBe('Actual doctor');
      expect(detail.sourceVisit).toMatchObject({ access: 'FULL', status: 'CANCELLED',
        plannedContact: { name: 'Planned doctor' }, metContact: { name: 'Actual doctor' } });
      const foreign = await f.pool.query<{ id: string }>("INSERT INTO organizations(name) VALUES ('Other tenant') RETURNING id");
      await expect(f.service.getSaleDetails({ ...f.manager, organizationId: foreign.rows[0]!.id }, sale.jobCardId))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('bounds and scopes pagination in one query per read, including empty offset pages', async () => {
    await withSaleFixture(async (f) => {
      for (let index = 0; index < 3; index++) {
        const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, clientActionId: 'page-sale-' + index });
        await f.service.cancel(f.manager, sale.jobCardId, { clientActionId: 'page-close-' + index,
          expectedVersion: 1, cancelReason: 'Historical agreement' });
      }
      let queries = 0;
      const reader = new PostgresSaleReader({ query: (...args: Parameters<typeof f.pool.query>) => {
        queries++; return f.pool.query(...args);
      } } as never);
      const first = await reader.related(f.manager, f.visitId, { limit: 1, offset: 0 });
      const second = await reader.related(f.manager, f.visitId, { limit: 1, offset: 1 });
      const empty = await reader.related(f.manager, f.visitId, { limit: 1, offset: 10 });
      expect(first?.total).toBe(3);
      expect(second?.total).toBe(3);
      expect(first?.items[0]?.id).not.toBe(second?.items[0]?.id);
      expect(empty).toMatchObject({ total: 3, items: [] });
      expect(queries).toBe(3);
      await expect(f.service.listRelatedSales(f.otherStaff, f.visitId, { limit: 1, offset: 0 })).rejects.toMatchObject({ statusCode: 404 });
      await expect(f.service.listRelatedSales(f.staff, f.visitId, { limit: 101, offset: 0 })).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it('counts Sale as operational work without delivery/outcome effects and preserves legacy buckets', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      await f.service.start(f.staff, sale.jobCardId, { clientActionId: 'report-start', expectedVersion: 1 });
      await f.service.submitForApproval(f.staff, sale.jobCardId, { clientActionId: 'report-submit', expectedVersion: 2, note: 'Ready' });
      const reports = new PostgresReportsRepository(f.pool);
      const input = { organizationId: f.organizationId, requestedRange: { from: '2026-10-14', to: '2026-10-14' },
        requestTime: new Date('2026-10-14T23:00:00Z') };
      expect(await reports.getApprovalSummary({ ...input, includeSaleCapability: true })).toMatchObject({ pendingCount: 1 });
      expect(await reports.getApprovalSummary({ ...input, includeSaleCapability: false })).toMatchObject({ pendingCount: 0 });
      const current = await reports.getDashboard({ ...input, includeSaleCapability: true });
      const legacy = await reports.getDashboard({ ...input, includeSaleCapability: false });
      expect(current.createdWorkTypeDistribution.find((item) => item.type === 'SALE')?.count).toBe(1);
      expect(legacy.createdWorkTypeDistribution.some((item) => item.type === 'SALE')).toBe(false);
      const customerReport = await reports.getCustomerReport({ ...input, includeSaleCapability: true,
        search: null, status: null, customerType: null, limit: 20, offset: 0 });
      expect(customerReport.items[0]?.activity.period.createdWorkTypes.SALE).toBe(1);
      expect(await reports.getStaffDeliveriesByPurpose({ ...input, staffUserId: f.staff.id })).toEqual([]);
      expect((await reports.getStaffMeetingsByOutcome({ ...input, staffUserId: f.staff.id })).every((item) => item.count === 0)).toBe(true);
      const source = mapSourceWorkRow({ jobCardId: sale.jobCardId, type: 'SALE', title: f.input.title,
        customerName: 'Dental Klinik', staffCompletedAt: new Date('2026-10-14T08:00:00Z'), status: 'WAITING_APPROVAL' });
      expect(validateSourceWorkSnapshot([source])[0]?.type).toBe('SALE');
      expect((await f.pool.query('SELECT status,version FROM job_cards WHERE id=$1', [f.visitId])).rows[0])
        .toEqual({ status: 'IN_PROGRESS', version: f.input.expectedSourceVersion });
    });
  });
  it('shows advisory create context, then scopes its active link independently', async () => {
    await withSaleFixture(async (f) => {
      expect(await f.service.getSaleCreateContext(f.staff, f.visitId)).toMatchObject({
        eligible: true, sourceVersion: f.input.expectedSourceVersion, activeSale: null,
        plannedContact: { id: f.plannedContactId }, metContact: { id: f.metContactId },
      });
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      await f.pool.query('UPDATE job_cards SET assigned_to=$1 WHERE id=$2', [f.otherStaff.id, sale.jobCardId]);
      expect(await f.service.getSaleCreateContext(f.staff, f.visitId)).toMatchObject({
        eligible: false, blockedReason: 'ACTIVE_SALE_EXISTS', activeSale: { access: 'RESTRICTED' },
      });
      const related = await f.service.listRelatedSales(f.staff, f.visitId, { limit: 1, offset: 0 });
      expect(related).toMatchObject({ total: 0, items: [], limit: 1, offset: 0 });
      const detail = await f.service.getSaleDetails(f.otherStaff, sale.jobCardId);
      expect(detail.sourceVisit).toEqual({ access: 'RESTRICTED', kind: 'SALE_FROM_VISIT' });
      expect(JSON.stringify(detail)).not.toContain(f.visitId);
      expect(JSON.stringify(detail)).not.toContain('Planned doctor');
      await expect(f.service.getSaleDetails(f.staff, sale.jobCardId)).rejects.toMatchObject({ statusCode: 404 });
    });
  });
  it('reads exact historical lines and distinct contact provenance', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const detail = await f.service.getSaleDetails(f.staff, sale.jobCardId);
      expect(detail.soldAt).toBe(f.input.soldAt);
      expect(detail.items.map((item) => [item.productId, item.quantity])).toEqual([
        [f.products[0], '0.500'], [f.products[1], '0.001'],
      ]);
      expect(detail.items[0]).toMatchObject({ name: 'Matrix set', brand: 'Brand A', unit: null });
      expect(detail.sourceVisit).toMatchObject({ access: 'FULL', id: f.visitId,
        plannedContact: { id: f.plannedContactId }, metContact: { id: f.metContactId } });
      expect(detail.saleContact).toMatchObject({ id: f.metContactId, name: 'Actual doctor' });
    });
  });
});
