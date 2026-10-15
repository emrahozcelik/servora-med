import { describe, expect, it, vi } from 'vitest';
import { saleTime, withSaleFixture } from './support/sale-harness.js';
import { PostgresRealtimeEventRepository } from '../src/modules/realtime/repository.js';
import { presentRealtimeEvent, type RealtimeEventEnvelope } from '../src/modules/realtime/types.js';
import { InMemoryRealtimeEventBus } from '../src/modules/realtime/event-bus.js';
import { RealtimeService } from '../src/modules/realtime/service.js';
import { JobCardService } from '../src/modules/job-cards/service.js';

describe('Source visit → Sale invalidation', () => {
  it('revokes an old Sale-only owner with a personal, identity-free invalidation', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      await f.pool.query("UPDATE job_cards SET status='ACCEPTED' WHERE id=$1", [f.visitId]);
      await f.service.patch(f.manager, f.visitId, { expectedVersion: f.input.expectedSourceVersion, assignedTo: f.otherStaff.id });
      const events = new PostgresRealtimeEventRepository(f.pool);
      const viewer = { ...f.staff, userId: f.staff.id };
      const cursor = await events.visibleHighWater(viewer);
      await f.service.patch(f.manager, sale.jobCardId, { expectedVersion: 1, assignedTo: f.otherStaff.id });
      const replay = (await events.replayVisible(viewer, cursor, 100)).map(presentRealtimeEvent);
      expect(replay).toHaveLength(1);
      expect(replay[0]).toMatchObject({ type: 'job.updated', entity: { type: 'notification-center', id: f.staff.id },
        resourceKeys: expect.arrayContaining(['sale-origin-context:' + f.staff.id]) });
      expect(JSON.stringify(replay)).not.toContain(sale.jobCardId);
      expect(JSON.stringify(replay)).not.toContain(f.visitId);
      await expect(f.service.getSaleDetails(f.staff, sale.jobCardId)).rejects.toMatchObject({ statusCode: 404 });
      expect(await events.visibleHighWater(viewer)).toBe(BigInt(replay[0]!.id));
    });
  });
  it('scopes historical relations, replay and high-water by current assignment in two bounded queries', async () => {
    await withSaleFixture(async (f) => {
      const first = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      await f.service.cancel(f.manager, first.jobCardId, {
        clientActionId: 'close-first', expectedVersion: 1, cancelReason: 'First independent agreement closed',
      });
      const second = await f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, clientActionId: 'second-sale' });
      const reassignedSale = await f.service.patch(f.manager, second.jobCardId, { expectedVersion: 1, assignedTo: f.otherStaff.id });
      await f.service.cancel(f.manager, second.jobCardId, {
        clientActionId: 'close-second', expectedVersion: reassignedSale.version, cancelReason: 'Second independent agreement closed',
      });
      const third = await f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, clientActionId: 'third-sale' });
      const sourceOwner = await f.user('STAFF');
      await f.pool.query('INSERT INTO staff_profiles(organization_id,user_id,manager_user_id) VALUES($1,$2,$3)',
        [f.organizationId, sourceOwner.id, f.manager.id]);
      await f.pool.query("UPDATE job_cards SET status='ACCEPTED' WHERE id=$1", [f.visitId]);
      const events = new PostgresRealtimeEventRepository(f.pool);
      const cursor = await events.visibleHighWater({ ...f.manager, userId: f.manager.id });
      const source = await f.service.patch(f.manager, f.visitId, {
        expectedVersion: f.input.expectedSourceVersion, assignedTo: sourceOwner.id,
      });
      for (const actor of [f.staff, f.otherStaff, f.manager, f.admin, sourceOwner]) {
        const viewer = { ...actor, userId: actor.id };
        const query = vi.fn(f.pool.query.bind(f.pool));
        const reader = new PostgresRealtimeEventRepository({ query } as never);
        const replay = (await reader.replayVisible(viewer, cursor, 1)).map(presentRealtimeEvent);
        expect(replay).toHaveLength(1);
        expect(await reader.visibleHighWater(viewer)).toBeGreaterThanOrEqual(BigInt(replay[0]!.id));
        expect(query).toHaveBeenCalledTimes(2);
        const ownSale = actor.id === f.staff.id ? [first.jobCardId, third.jobCardId] : [second.jobCardId];
        if (actor.id === f.staff.id || actor.id === f.otherStaff.id) {
          expect(ownSale).toContain(replay[0]!.entity.id);
          expect(JSON.stringify(replay)).not.toContain(f.visitId);
          expect(replay[0]!.resourceKeys).toContain('sale-origin-context:' + actor.id);
        } else {
          expect(replay[0]!.entity.id).toBe(f.visitId);
          expect(JSON.stringify(replay)).not.toContain(first.jobCardId);
          expect(JSON.stringify(replay)).not.toContain(second.jobCardId);
          expect(JSON.stringify(replay)).not.toContain(third.jobCardId);
          expect(replay[0]!.resourceKeys.includes('sale-origin-context:' + actor.id)).toBe(actor.role !== 'STAFF');
        }
        expect(replay[0]!.resourceKeys).not.toContain('sale-origin-context');
      }
      const unrelated = await f.user('STAFF');
      const foreignOrg = (await f.pool.query("INSERT INTO organizations(name) VALUES ('Foreign org') RETURNING id")).rows[0].id;
      for (const actor of [unrelated, await f.user('STAFF', foreignOrg), await f.user('MANAGER', foreignOrg)]) {
        const viewer = { ...actor, userId: actor.id };
        expect(await events.replayVisible(viewer, cursor, 100)).toEqual([]);
        expect(await events.visibleHighWater(viewer)).toBe(0n);
      }
      expect((await f.service.getSaleDetails(f.staff, third.jobCardId)).sourceVisit.access).toBe('RESTRICTED');
      const restored = await f.service.patch(f.manager, f.visitId, { expectedVersion: source.version, assignedTo: f.staff.id,
        title: 'Restored current source title' });
      expect((await f.service.getSaleDetails(f.staff, third.jobCardId)).sourceVisit).toMatchObject({ access: 'FULL',
        title: 'Restored current source title', status: restored.status });
      const cancelled = await f.service.cancel(f.manager, f.visitId, {
        clientActionId: 'source-terminal', expectedVersion: restored.version, cancelReason: 'Visit closed independently',
      });
      const invalidationCursor = await events.visibleHighWater({ ...f.otherStaff, userId: f.otherStaff.id });
      await f.service.invalidate(f.admin, f.visitId, { clientActionId: 'source-invalidated', expectedVersion: cancelled.version,
        reasonCode: 'OTHER', note: 'Historical source corrected' });
      const afterInvalidation = await events.replayVisible({ ...f.otherStaff, userId: f.otherStaff.id }, invalidationCursor, 100);
      expect(afterInvalidation).toHaveLength(1);
      expect(afterInvalidation[0]!.entityId).toBe(second.jobCardId);
      expect((await f.service.getSaleDetails(f.otherStaff, second.jobCardId)).sourceVisit.access).toBe('RESTRICTED');
      expect((await f.service.getSaleDetails(f.staff, third.jobCardId)).sourceVisit).toMatchObject({ access: 'FULL', status: 'INVALIDATED' });
      await expect(f.service.getSaleDetails(f.staff, second.jobCardId)).rejects.toMatchObject({ statusCode: 404 });
    });
  });
  it('wakes a connected Sale-only owner through scoped replay, without a second durable event', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      await f.pool.query("UPDATE job_cards SET status='ACCEPTED' WHERE id=$1", [f.visitId]);
      const source = await f.service.patch(f.manager, f.visitId, {
        expectedVersion: f.input.expectedSourceVersion, assignedTo: f.otherStaff.id,
      });
      const bus = new InMemoryRealtimeEventBus();
      const jobs = new JobCardService(f.repository, () => saleTime, bus);
      const realtime = new RealtimeService(new PostgresRealtimeEventRepository(f.pool), bus);
      const sent: RealtimeEventEnvelope[] = [];
      const subscription = await realtime.open({ ...f.staff, userId: f.staff.id }, null,
        { send: async (value) => { sent.push(value); } });
      try {
        sent.length = 0;
        const before = (await f.pool.query('SELECT count(*)::int AS count FROM realtime_events')).rows[0].count;
        await jobs.patch(f.manager, f.visitId, { expectedVersion: source.version, title: 'Private renamed source' });
        await expect.poll(() => sent.length).toBe(1);
        expect(sent[0]).toMatchObject({ type: 'job.updated', entity: { type: 'job-card', id: sale.jobCardId },
          resourceKeys: expect.arrayContaining(['sale-origin-context:' + f.staff.id]) });
        expect(JSON.stringify(sent)).not.toContain(f.visitId);
        expect((await f.pool.query('SELECT count(*)::int AS count FROM realtime_events')).rows[0].count).toBe(before + 1);
      } finally { subscription.close(); }
    });
  });
  it('replays source assignment/title/status changes to the Sale owner without exposing the source', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      // Historical sale remains independent when its visit is again assignable.
      await f.pool.query("UPDATE job_cards SET status='ACCEPTED' WHERE id=$1", [f.visitId]);
      const sourceB = await f.service.patch(f.manager, f.visitId, {
        expectedVersion: f.input.expectedSourceVersion, assignedTo: f.otherStaff.id,
      });
      const c = await f.user('STAFF');
      await f.pool.query('INSERT INTO staff_profiles(organization_id,user_id,manager_user_id) VALUES($1,$2,$3)',
        [f.organizationId, c.id, f.manager.id]);
      const events = new PostgresRealtimeEventRepository(f.pool);
      const a = { ...f.staff, userId: f.staff.id };
      const cursor = await events.visibleHighWater(a);
      expect((await f.service.getSaleDetails(f.staff, sale.jobCardId)).sourceVisit.access).toBe('RESTRICTED');
      const reassigned = await f.service.patch(f.manager, f.visitId, { expectedVersion: sourceB.version, assignedTo: c.id });
      const renamed = await f.service.patch(f.manager, f.visitId, { expectedVersion: reassigned.version, title: 'Private current visit title' });
      const accepted = await f.service.acceptAssignment(c, f.visitId, { clientActionId: 'source-c-accept', expectedVersion: renamed.version });
      const cancelInput = { clientActionId: 'source-cancel-once', expectedVersion: accepted.version, cancelReason: 'Independent closure' };
      await f.service.cancel(f.manager, f.visitId, cancelInput);
      const replay = (await events.replayVisible(a, cursor, 100)).map(presentRealtimeEvent);
      expect(replay.length).toBeGreaterThanOrEqual(4);
      expect(replay.every((event) => event.resourceKeys.includes('sale-origin-context:' + a.userId))).toBe(true);
      expect(replay.every((event) => event.entity.id === sale.jobCardId && event.type === 'job.updated')).toBe(true);
      expect(JSON.stringify(replay)).not.toContain(f.visitId);
      expect(JSON.stringify(replay)).not.toContain('Private current visit title');
      expect(JSON.stringify(replay)).not.toContain('Brand A');
      expect(await events.visibleHighWater(a)).toBe(BigInt(replay.at(-1)!.id));
      for (const actor of [f.otherStaff, c]) {
        const sourceOnly = (await events.replayVisible({ ...actor, userId: actor.id }, cursor, 100)).map(presentRealtimeEvent);
        expect(JSON.stringify(sourceOnly)).not.toContain(sale.jobCardId);
        expect(sourceOnly.some((event) => event.resourceKeys.includes('sale-origin-context:' + actor.id))).toBe(false);
      }
      const counts = async () => (await f.pool.query('SELECT (SELECT count(*)::int FROM realtime_events) AS events, '
        + '(SELECT count(*)::int FROM in_app_notifications) AS notifications')).rows[0];
      const beforeRetry = await counts();
      await f.service.cancel(f.manager, f.visitId, cancelInput);
      expect(await counts()).toEqual(beforeRetry);
    });
  });
});
