import { describe, expect, it } from 'vitest';
import { withSaleFixture } from './support/sale-harness.js';
import { PostgresRealtimeEventRepository } from '../src/modules/realtime/repository.js';
import { presentRealtimeEvent } from '../src/modules/realtime/types.js';

describe('Sale scoped invalidation', () => {
  it('refreshes the source with its own event and hides old Sale events after reassignment', async () => {
    await withSaleFixture(async (f) => {
      const events = new PostgresRealtimeEventRepository(f.pool);
      const viewer = { ...f.staff, userId: f.staff.id };
      const cursor = await events.visibleHighWater(viewer);
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const before = await events.replayVisible(viewer, cursor, 100);
      expect(before.some((event) => event.entityId === f.visitId && event.resourceKeys.includes('job-detail:' + f.visitId)
        && event.type === 'job.updated')).toBe(true);
      const counts = (await f.pool.query("SELECT (SELECT count(*)::int FROM realtime_events) AS events, (SELECT count(*)::int FROM in_app_notifications) AS notifications")).rows[0];
      await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      expect((await f.pool.query("SELECT (SELECT count(*)::int FROM realtime_events) AS events, (SELECT count(*)::int FROM in_app_notifications) AS notifications")).rows[0]).toEqual(counts);
      await f.service.patch(f.manager, sale.jobCardId, { expectedVersion: 1, assignedTo: f.otherStaff.id });
      const after = await events.replayVisible(viewer, 0n, 100);
      expect(after.some((event) => event.entityId === sale.jobCardId)).toBe(false);
      const sourceEvents = after.filter((event) => event.entityId === f.visitId);
      expect(JSON.stringify(sourceEvents.map((event) => event.resourceKeys))).not.toContain(sale.jobCardId);
      const items = (await f.service.getSaleDetails(f.otherStaff, sale.jobCardId)).items;
      await f.service.patchSaleItem(f.otherStaff, sale.jobCardId, items[0]!.id, {
        clientActionId: 'realtime-quantity', expectedVersion: 2, quantity: 1,
      });
      const childViewer = { ...f.otherStaff, userId: f.otherStaff.id };
      const childEvents = (await events.replayVisible(childViewer, cursor, 100)).map(presentRealtimeEvent);
      expect(childEvents.some((event) => event.entity.id === sale.jobCardId)).toBe(true);
      expect(JSON.stringify(childEvents)).not.toContain(f.visitId);
      expect(JSON.stringify(childEvents)).not.toContain('Brand A');
      const sourceOnly = (await events.replayVisible(viewer, cursor, 100)).map(presentRealtimeEvent);
      expect(JSON.stringify(sourceOnly)).not.toContain(sale.jobCardId);
      expect(sourceOnly.some((event) => event.resourceKeys.includes('job-detail:' + f.visitId))).toBe(true);
    });
  });
});
